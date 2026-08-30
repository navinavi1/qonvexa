import crypto from 'node:crypto';

const DEFAULT_ASSETS = Object.freeze([
  { network:'eip155:8453', networkName:'Base Mainnet', symbol:'USDC', asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals:6, live:true, scheme:'exact' }
]);

export function createX402Gateway({ ownerWallet, siteUrl, env=process.env, onSettlement=()=>{}, idempotency=null }={}) {
  const enabled=/^(1|true|yes|on)$/i.test(String(env.AUTONOMOS_X402_ENABLED||'false'));
  const facilitatorUrl=String(env.AUTONOMOS_X402_FACILITATOR_URL||'').replace(/\/$/,'');
  const authHeaders=parseHeaders(env.AUTONOMOS_X402_FACILITATOR_HEADERS_JSON||'');
  const assets=parseAssets(env.AUTONOMOS_X402_ACCEPTS_JSON);
  const configured=enabled&&/^0x[a-fA-F0-9]{40}$/.test(String(ownerWallet||''))&&Boolean(facilitatorUrl)&&assets.length>0;
  return {
    status(){return{enabled,configured,network:assets[0]?.network||'',networkName:assets[0]?.networkName||'',live:assets.some(x=>x.live),payTo:ownerWallet,facilitatorConfigured:Boolean(facilitatorUrl),facilitatorAuthConfigured:Object.keys(authHeaders).length>0,mode:!enabled?'disabled':configured?(assets.some(x=>x.live)?'mainnet':'testnet'):'needs_configuration',acceptedAssets:assets.map(({network,networkName,symbol,asset,decimals,scheme})=>({network,networkName,symbol,asset,decimals,scheme}))};},
    async protect({req,res,product,handler}){
      if(!configured)return res.status(503).json({error:'Machine payment rail is not configured.',code:'x402_not_configured',product:product.id,paymentMode:enabled?'needs_configuration':'disabled'});
      const requirements=assets.map(meta=>paymentRequirements(product.priceUsd,ownerWallet,meta));
      const resource={url:new URL(product.path,siteUrl).toString(),description:product.description,mimeType:'application/json',serviceName:'AutonomOS',tags:product.tags.slice(0,5)};
      const extensions=bazaarExtension(product); const paymentRequired={x402Version:2,error:'PAYMENT-SIGNATURE header is required',resource,accepts:requirements,extensions};
      const rawPayment=req.get('PAYMENT-SIGNATURE')||req.get('payment-signature')||'';if(!rawPayment)return sendPaymentRequired(res,paymentRequired);
      const replayKey=crypto.createHash('sha256').update(String(rawPayment)).digest('hex');
      const cached=await idempotency?.get?.(replayKey);
      if(cached){if(cached.paymentResponse)res.setHeader('PAYMENT-RESPONSE',cached.paymentResponse);return res.json(cached.result);}
      let paymentPayload;try{paymentPayload=decodeHeaderJson(rawPayment)}catch{return sendPaymentRequired(res,{...paymentRequired,error:'Invalid PAYMENT-SIGNATURE header'});}
      const accepted=requirements.find(r=>sameRequirements(paymentPayload?.accepted,r));if(!accepted)return sendPaymentRequired(res,{...paymentRequired,error:'Payment requirements mismatch'});
      if(!extensionsContain(paymentPayload?.extensions,extensions))return sendPaymentRequired(res,{...paymentRequired,error:'Required x402 extensions were not echoed by the client'});
      const envelope={x402Version:2,paymentPayload,paymentRequirements:accepted};
      const verification=await facilitatorPost(facilitatorUrl,'/verify',envelope,authHeaders);const valid=verification.body?.isValid===true||verification.body?.valid===true;
      if(!verification.ok||!valid)return sendPaymentRequired(res,{...paymentRequired,error:verification.body?.invalidReason||verification.body?.reason||verification.error||'Payment verification failed'});
      let result;try{result=await handler()}catch(error){return res.status(Number(error?.status||500)).json({error:String(error?.code||error?.message||'product_execution_failed')});}
      const settlement=await facilitatorPost(facilitatorUrl,'/settle',envelope,authHeaders);const success=settlement.body?.success===true||settlement.body?.settled===true;if(!settlement.ok||!success)return res.status(502).json({error:'Payment settlement failed.',detail:settlement.body?.errorReason||settlement.body?.reason||settlement.error||''});
      const paymentResponse=Buffer.from(JSON.stringify(settlement.body)).toString('base64');res.setHeader('PAYMENT-RESPONSE',paymentResponse);
      const assetMeta=assets.find(a=>a.network===accepted.network&&a.asset.toLowerCase()===String(accepted.asset).toLowerCase())||assets[0];
      try{await onSettlement({product,amountUsd:product.priceUsd,network:accepted.network,asset:accepted.asset,assetSymbol:assetMeta.symbol,live:Boolean(assetMeta.live),payer:settlement.body?.payer||verification.body?.payer||'',transaction:settlement.body?.transaction||settlement.body?.txHash||'',settledAt:new Date().toISOString()})}catch{}
      await idempotency?.set?.(replayKey,{result,paymentResponse,at:new Date().toISOString()});
      return res.json(result);
    }
  };
}

// P0 fix (external audit): paymentRequirements() below does `priceUsd × 10^decimals`,
// which is only correct for an asset that trades ~1:1 with USD. That's true for USDC/
// USDT/PYUSD/DAI, but NOT for ETH, SOL, BTC, or even EURC (a different currency, not a
// conversion-free peg) — configuring one of those via AUTONOMOS_X402_ACCEPTS_JSON would
// silently charge e.g. "0.03 ETH" for a $0.03 product, ~1000x overcharging a payer. Until
// there's a real USD→asset oracle/FX quote with slippage+expiry validation, only accept
// assets whose symbol is a known USD-pegged stablecoin.
const USD_PEGGED_SYMBOLS = new Set(['USDC','USDT','PYUSD','DAI','USDP','GUSD','FDUSD']);
function parseAssets(raw){
  if(!raw)return DEFAULT_ASSETS.map(x=>({...x}));
  try{
    const rows=JSON.parse(String(raw));
    if(!Array.isArray(rows))return DEFAULT_ASSETS.map(x=>({...x}));
    const parsed=rows.filter(x=>/^eip155:\d+$|^solana:/.test(String(x.network||''))&&String(x.asset||'').length>10&&Number(x.decimals)>=0&&Number(x.decimals)<=30)
      .map(x=>({network:String(x.network),networkName:String(x.networkName||x.network),symbol:String(x.symbol||'TOKEN').toUpperCase().slice(0,16),asset:String(x.asset),decimals:Number(x.decimals),live:x.live!==false,scheme:String(x.scheme||'exact')}));
    const safe=parsed.filter(x=>USD_PEGGED_SYMBOLS.has(x.symbol));
    // If every configured asset got filtered out (e.g. someone tried to add ETH/SOL/BTC
    // only), fail back to the known-safe default rather than silently accepting nothing
    // AND rather than silently accepting the unsafe asset.
    return safe.length?safe:DEFAULT_ASSETS.map(x=>({...x}));
  }catch{return DEFAULT_ASSETS.map(x=>({...x}));}
}
function paymentRequirements(priceUsd,payTo,meta){const atomic=BigInt(Math.max(1,Math.round(Number(priceUsd||0)*(10**meta.decimals))));return{scheme:meta.scheme||'exact',network:meta.network,amount:atomic.toString(),asset:meta.asset,payTo,maxTimeoutSeconds:60,extra:{name:meta.symbol,version:'2'}};}
function bazaarExtension(product){const info={input:{type:'http',method:'GET',discoverable:true,queryParams:{url:'https://example.com'}},inputSchema:{type:'object',properties:{url:{type:'string',format:'uri',description:'Public http(s) website URL to analyze.'}},required:['url'],additionalProperties:false},output:{type:'json',example:{product:product.id,target:'https://example.com',generatedAt:'2026-01-01T00:00:00.000Z'}}};return{bazaar:{info,schema:{type:'object',properties:{input:{type:'object'},inputSchema:{type:'object'},output:{type:'object'}},required:['input','inputSchema','output'],additionalProperties:true}}};}
function extensionsContain(candidate,expected){if(!expected||!Object.keys(expected).length)return true;if(!candidate||typeof candidate!=='object')return false;for(const key of Object.keys(expected)){if(!candidate[key]||typeof candidate[key]!=='object')return false;if(JSON.stringify(expected[key].info||{})!==JSON.stringify(candidate[key].info||{}))return false;}return true;}
function sendPaymentRequired(res,payload){const encoded=Buffer.from(JSON.stringify(payload)).toString('base64');res.setHeader('PAYMENT-REQUIRED',encoded);res.setHeader('Access-Control-Expose-Headers','PAYMENT-REQUIRED,PAYMENT-RESPONSE');return res.status(402).json(payload);}
function decodeHeaderJson(value){return JSON.parse(Buffer.from(String(value).trim(),'base64').toString('utf8'));}
async function facilitatorPost(baseUrl,endpoint,body,headers){try{const response=await fetch(`${baseUrl}${endpoint}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});let payload={};try{payload=await response.json()}catch{}return{ok:response.ok,status:response.status,body:payload,error:response.ok?'':`facilitator_http_${response.status}`}}catch(error){return{ok:false,status:0,body:null,error:String(error?.message||error).slice(0,300)}}}
function sameRequirements(candidate,expected){if(!candidate)return false;for(const key of ['scheme','network','amount','asset','payTo','maxTimeoutSeconds'])if(String(candidate[key]??'')!==String(expected[key]??''))return false;return true;}
function parseHeaders(raw){if(!raw)return{};try{const value=JSON.parse(String(raw));if(!value||typeof value!=='object'||Array.isArray(value))return{};const out={};for(const[k,v]of Object.entries(value))if(/^[A-Za-z0-9-]{1,80}$/.test(k)&&typeof v==='string'&&v.length<4000)out[k]=v;return out}catch{return{}}}

const CRYPTO_CODES=new Set(['USDC','USDT','ETH','BTC','SOL','DAI']);
const MANAGED_METHOD=/escrow|platform(?:_balance)?|marketplace|seller_balance|internal_balance/;

export function paymentDestinations(env=process.env){
  const cryptoWallet=String(env.AUTONOMOS_OWNER_WALLET||'').trim();
  const accounts=fopAccounts(env);
  const now=Date.now();const maxAgeDays=Math.max(1,Number(env.AUTONOMOS_PAYOUT_VERIFICATION_MAX_AGE_DAYS||180));
  const intermediaries=parseJson(env.AUTONOMOS_VERIFIED_PAYOUT_INTERMEDIARIES_JSON,[]);
  return{
    crypto:{configured:Boolean(cryptoWallet),wallet:cryptoWallet,networks:arrayJson(env.AUTONOMOS_PAYOUT_NETWORKS_JSON,['base']),currencies:arrayJson(env.AUTONOMOS_PAYOUT_CRYPTO_JSON,['USDC','USDT']).map(x=>String(x).toUpperCase())},
    fop:{configured:accounts.length>0,accounts},
    intermediaries:Array.isArray(intermediaries)?intermediaries.filter(x=>isVerifiedIntermediary(x,{now,maxAgeDays})):[]
  };
}

export function marketplacePayoutMethods(marketplace='',env=process.env){
  const map=parseJson(env.AUTONOMOS_MARKET_PAYOUT_METHODS_JSON,{});const key=String(marketplace||'').toLowerCase();
  const value=map?.[marketplace]??map?.[key]??[];return Array.isArray(value)?value.map(x=>String(x).toLowerCase()).filter(Boolean):[];
}

export function selectPayoutRoute({currency='USD',marketplace='',supportedMethods=[],amountUsd=0}={},env=process.env){
  const dest=paymentDestinations(env);const code=String(currency||'USD').toUpperCase();
  const methods=[...(Array.isArray(supportedMethods)?supportedMethods:[]),...marketplacePayoutMethods(marketplace,env)].map(x=>String(x).toLowerCase());
  const unique=[...new Set(methods)];

  if(unique.some(x=>MANAGED_METHOD.test(x))){
    return{ok:true,rail:'marketplace_managed',currency:code,marketplace,amountUsd,requiresPayoutSetup:true,reason:'marketplace_holds_or_releases_funds; downstream withdrawal must be configured separately'};
  }
  if((CRYPTO_CODES.has(code)&&unique.some(x=>/crypto|wallet|usdc|usdt|stablecoin|onchain/.test(x)))&&dest.crypto.configured&&dest.crypto.currencies.includes(code)){
    return{ok:true,rail:'crypto',currency:code,destination:dest.crypto.wallet,marketplace,amountUsd};
  }
  if(unique.some(x=>/swift|iban|wire|bank_transfer|bank/.test(x))&&dest.fop.configured){
    const account=dest.fop.accounts.find(x=>x.currency===code)||null;
    if(account)return{ok:true,rail:'fop_swift',currency:account.currency,destination:account.iban,swift:account.swift,beneficiary:account.beneficiary,bank:account.bank,note:account.note,marketplace,amountUsd};
  }
  const mediator=dest.intermediaries.find(x=>intermediarySupports(x,{marketplace,currency:code,methods:unique}));
  if(mediator)return{ok:true,rail:'verified_intermediary',provider:mediator.name||mediator.id,destination:mediator.destination||'',currency:code,marketplace,amountUsd,verifiedAt:mediator.verifiedAt,officialSourceUrl:mediator.officialSourceUrl};
  return{ok:false,reason:unique.length?'no_verified_supported_payout_route':'marketplace_payout_methods_unknown',marketplace,currency:code,supportedMethods:unique};
}

function fopAccounts(env){
  const configured=parseJson(env.AUTONOMOS_FOP_ACCOUNTS_JSON,[]);
  const rows=Array.isArray(configured)?configured:[];
  const legacy={beneficiary:String(env.BANK_BENEFICIARY||'').trim(),bank:String(env.BANK_NAME||'').trim(),iban:String(env.BANK_IBAN||'').trim(),swift:String(env.BANK_SWIFT||'').trim(),currency:String(env.BANK_CURRENCY||'USD').trim().toUpperCase(),note:String(env.BANK_PAYMENT_NOTE||'').trim()};
  if(legacy.iban&&legacy.swift&&legacy.beneficiary)rows.push(legacy);
  const unique=new Map();
  for(const raw of rows){
    const row={beneficiary:String(raw?.beneficiary||'').trim(),bank:String(raw?.bank||'').trim(),iban:String(raw?.iban||'').replace(/\s+/g,'').trim(),swift:String(raw?.swift||'').replace(/\s+/g,'').trim().toUpperCase(),currency:String(raw?.currency||'USD').trim().toUpperCase(),note:String(raw?.note||'').trim()};
    if(!row.beneficiary||!row.iban||!row.swift||!/^[A-Z]{3}$/.test(row.currency))continue;
    unique.set(`${row.currency}:${row.iban}`,row);
  }
  return [...unique.values()];
}
function isVerifiedIntermediary(x,{now,maxAgeDays}){
  if(!x||x.verifiedForUkraineFop!==true)return false;
  const source=String(x.officialSourceUrl||'');if(!/^https:\/\//i.test(source))return false;
  const verified=Date.parse(String(x.verifiedAt||''));if(!Number.isFinite(verified))return false;
  return now-verified<=maxAgeDays*86400000;
}
function intermediarySupports(x,{marketplace,currency,methods}){
  const markets=Array.isArray(x.marketplaces)?x.marketplaces.map(v=>String(v).toLowerCase()):[];
  const currencies=Array.isArray(x.currencies)?x.currencies.map(v=>String(v).toUpperCase()):[];
  const supported=Array.isArray(x.methods)?x.methods.map(v=>String(v).toLowerCase()):[];
  if(markets.length&&marketplace&&!markets.includes(String(marketplace).toLowerCase()))return false;
  if(currencies.length&&!currencies.includes(currency))return false;
  if(supported.length&&methods.length&&!methods.some(m=>supported.includes(m)))return false;
  return true;
}
function arrayJson(value,fallback){const v=parseJson(value,fallback);return Array.isArray(v)?v:fallback;}
function parseJson(value,fallback){try{return JSON.parse(String(value||''))}catch{return fallback}}

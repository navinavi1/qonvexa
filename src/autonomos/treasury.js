const BALANCE_OF_SELECTOR = '70a08231';
const DEFAULT_CHAINS = Object.freeze([
  {
    id:'eip155:8453', name:'Base', chainId:8453, symbol:'ETH', rpcEnv:'AUTONOMOS_BASE_RPC_URL', rpc:'https://mainnet.base.org',
    tokens:[
      {symbol:'USDC',address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',decimals:6},
      {symbol:'USDT',address:'0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',decimals:6}
    ]
  },
  {
    id:'eip155:42161', name:'Arbitrum One', chainId:42161, symbol:'ETH', rpcEnv:'AUTONOMOS_ARBITRUM_RPC_URL', rpc:'https://arb1.arbitrum.io/rpc',
    tokens:[
      {symbol:'USDC',address:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',decimals:6},
      {symbol:'USDT',address:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',decimals:6}
    ]
  },
  {
    id:'eip155:137', name:'Polygon', chainId:137, symbol:'POL', rpcEnv:'AUTONOMOS_POLYGON_RPC_URL', rpc:'https://polygon-rpc.com',
    tokens:[
      {symbol:'USDC',address:'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',decimals:6},
      {symbol:'USDT',address:'0xc2132D05D31c914a87C6611C10748AaCbC53250',decimals:6}
    ]
  }
]);

export function isEvmAddress(value){return /^0x[a-fA-F0-9]{40}$/.test(String(value||''));}

export function configuredEvmChains(env=process.env){
  const custom=parseJson(env.AUTONOMOS_EVM_CHAINS_JSON,[]);
  if(Array.isArray(custom)&&custom.length) return custom.filter(validChain);
  const base=DEFAULT_CHAINS.map(chain=>({...chain,rpc:String(env[chain.rpcEnv]||chain.rpc),tokens:[...chain.tokens]}));
  // AUTONOMOS_EXTRA_TOKENS_JSON lets you add tokens (EURC, DAI, etc.) per chain WITHOUT
  // touching code — deliberately not hardcoded here, because a wrong stablecoin contract
  // address is a real-money risk (silently monitoring/trusting the wrong token). Copy the
  // exact address from the token issuer's own docs or a block explorer (Basescan/Arbiscan/
  // Polygonscan) before adding it. Format:
  // AUTONOMOS_EXTRA_TOKENS_JSON='{"eip155:8453":[{"symbol":"EURC","address":"0x...","decimals":6}]}'
  const extra=parseJson(env.AUTONOMOS_EXTRA_TOKENS_JSON,{});
  if(extra&&typeof extra==='object'){
    for(const chain of base){
      const additions=Array.isArray(extra[chain.id])?extra[chain.id]:[];
      for(const token of additions){
        if(token&&/^0x[a-fA-F0-9]{40}$/.test(String(token.address||''))&&token.symbol&&Number.isInteger(Number(token.decimals))){
          if(!chain.tokens.some(t=>t.address.toLowerCase()===String(token.address).toLowerCase())){
            chain.tokens.push({symbol:String(token.symbol).toUpperCase().slice(0,12),address:token.address,decimals:Number(token.decimals)});
          }
        }
      }
    }
  }
  return base;
}

export async function readTreasuryBalances({address,env=process.env,timeoutMs=8000}={}){
  if(!isEvmAddress(address)) return {ok:false,error:'invalid_owner_wallet',address,checkedAt:new Date().toISOString()};
  const chains=configuredEvmChains(env);
  const results=await Promise.all(chains.map(chain=>readChain({address,chain,timeoutMs})));
  const assets=[];
  for(const chain of results){
    if(chain.native)assets.push({network:chain.name,chainId:chain.chainId,symbol:chain.native.symbol,balance:chain.native.balance,kind:'native'});
    for(const token of chain.tokens||[])assets.push({network:chain.name,chainId:chain.chainId,symbol:token.symbol,balance:token.balance,address:token.address,kind:'erc20'});
  }
  const base=results.find(x=>x.chainId===8453)||{};
  const baseTokenBalances=Object.fromEntries((base.tokens||[]).map(t=>[t.symbol.toLowerCase(),Number(t.balance||0)]));
  return {
    ok:results.some(x=>x.ok), address, chains:results, assets,
    network:'Base',chainId:8453,eth:Number(base.native?.balance||0),
    usdc:baseTokenBalances.usdc||0,usdt:baseTokenBalances.usdt||0,
    tokenBalances:baseTokenBalances,
    checkedAt:new Date().toISOString(), errors:results.filter(x=>!x.ok).map(x=>({network:x.name,error:x.error}))
  };
}

export async function readBaseBalances({address,rpcUrl='https://mainnet.base.org',timeoutMs=8000}={}){
  const env={...process.env,AUTONOMOS_BASE_RPC_URL:rpcUrl,AUTONOMOS_EVM_CHAINS_JSON:''};
  return readTreasuryBalances({address,env,timeoutMs});
}

async function readChain({address,chain,timeoutMs}){
  try{
    const nativeHex=await rpc(chain.rpc,'eth_getBalance',[address,'latest'],timeoutMs);
    const tokenRows=await Promise.all((chain.tokens||[]).map(async token=>{
      try{const hex=await rpc(chain.rpc,'eth_call',[{to:token.address,data:encodeBalanceOf(address)},'latest'],timeoutMs);return{...token,balance:hexUnits(hex,token.decimals)}}
      catch(error){return{...token,balance:0,error:String(error?.message||error).slice(0,160)}}
    }));
    return {ok:true,id:chain.id,name:chain.name,chainId:Number(chain.chainId),rpc:chain.rpc,native:{symbol:chain.symbol||'ETH',balance:hexUnits(nativeHex,18)},tokens:tokenRows};
  }catch(error){return{ok:false,id:chain.id,name:chain.name,chainId:Number(chain.chainId),error:String(error?.message||error).slice(0,240),native:null,tokens:[]}}
}

async function rpc(url,method,params,timeoutMs){
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error(`rpc_${response.status}`); const body=await response.json(); if(body.error)throw new Error(body.error.message||'rpc_error'); return body.result;
}
function encodeBalanceOf(address){return`0x${BALANCE_OF_SELECTOR}${address.toLowerCase().replace(/^0x/,'').padStart(64,'0')}`}
function hexUnits(hex,decimals){const value=BigInt(hex||'0x0');const base=10n**BigInt(decimals);const whole=value/base;const fraction=(value%base).toString().padStart(decimals,'0').replace(/0+$/,'');return Number(`${whole}${fraction?`.${fraction}`:''}`)}
function parseJson(raw,fallback){try{return JSON.parse(String(raw||''))}catch{return fallback}}
function validChain(x){return x&&/^eip155:\d+$/.test(String(x.id||''))&&/^https?:\/\//.test(String(x.rpc||''))&&Number.isInteger(Number(x.chainId));}

const CRYPTO_CODES=new Set(['USDC','USDT','ETH','BTC','SOL','DAI']);
const MANAGED_METHOD=/escrow|platform(?:_balance)?|marketplace|seller_balance|internal_balance/;
const DIRECT_CRYPTO_METHOD=/direct_crypto|direct_wallet|owner_wallet/;
const EVM_NETWORKS=new Set(['ethereum','mainnet','base','arbitrum','optimism','polygon','matic']);
const SOLANA_NETWORKS=new Set(['solana','sol','spl']);

export function paymentDestinations(env=process.env){
  const evm=String(env.AUTONOMOS_RABBY_WALLET||env.AUTONOMOS_OWNER_WALLET||'').trim();
  const solana=String(env.AUTONOMOS_PHANTOM_WALLET||env.AUTONOMOS_SOLANA_WALLET||'').trim();
  const bitcoin=String(env.AUTONOMOS_BITCOIN_WALLET||'').trim();
  const accounts=fopAccounts(env);
  const now=Date.now();const maxAgeDays=Math.max(1,Number(env.AUTONOMOS_PAYOUT_VERIFICATION_MAX_AGE_DAYS||180));
  const intermediaries=parseJson(env.AUTONOMOS_VERIFIED_PAYOUT_INTERMEDIARIES_JSON,[]);
  const wallets={
    // AUTONOMOS_PAYOUT_NETWORKS_JSON is the name documented in .env.example and set in
    // render.yaml; only AUTONOMOS_EVM_PAYOUT_NETWORKS_JSON was ever read, so an owner who
    // restricted payouts to one network got the four-network default instead. Both names
    // are accepted now, the EVM-specific one first so existing setups do not change.
    evm:{id:'rabby',configured:isEvmAddress(evm),wallet:evm,networks:arrayJson(env.AUTONOMOS_EVM_PAYOUT_NETWORKS_JSON??env.AUTONOMOS_PAYOUT_NETWORKS_JSON,['base','ethereum','arbitrum','polygon']).map(norm),currencies:['USDC','USDT','DAI','ETH']},
    solana:{id:'phantom',configured:isSolanaAddress(solana),wallet:solana,networks:['solana'],currencies:['USDC','USDT','SOL']},
    bitcoin:{id:'bitcoin',configured:isBitcoinAddress(bitcoin),wallet:bitcoin,networks:['bitcoin'],currencies:['BTC']}
  };
  return{
    // Legacy fields retained so old UI/tests still have one primary crypto destination.
    crypto:{configured:Object.values(wallets).some(x=>x.configured),wallet:wallets.evm.configured?evm:wallets.solana.configured?solana:bitcoin,networks:[...new Set(Object.values(wallets).filter(x=>x.configured).flatMap(x=>x.networks))],currencies:[...new Set(Object.values(wallets).filter(x=>x.configured).flatMap(x=>x.currencies))],wallets},
    fop:{configured:accounts.length>0,accounts},
    intermediaries:Array.isArray(intermediaries)?intermediaries.filter(x=>isVerifiedIntermediary(x,{now,maxAgeDays})):[]
  };
}

export function marketplacePayoutMethods(marketplace='',env=process.env){
  const map=parseJson(env.AUTONOMOS_MARKET_PAYOUT_METHODS_JSON,{});const key=String(marketplace||'').toLowerCase();
  const value=map?.[marketplace]??map?.[key]??[];return Array.isArray(value)?value.map(x=>String(x).toLowerCase()).filter(Boolean):[];
}

export function selectPayoutRoute({currency='USD',marketplace='',supportedMethods=[],amountUsd=0,network=''}={},env=process.env){
  const dest=paymentDestinations(env);const code=String(currency||'USD').toUpperCase();
  const methods=[...(Array.isArray(supportedMethods)?supportedMethods:[]),...marketplacePayoutMethods(marketplace,env)].map(x=>String(x).toLowerCase());
  const unique=[...new Set(methods)];
  const networkHint=norm(network||networkFromMethods(unique));
  const wallet=selectWallet(dest.crypto.wallets,{currency:code,network:networkHint});

  if(CRYPTO_CODES.has(code)&&unique.some(x=>DIRECT_CRYPTO_METHOD.test(x))&&wallet){
    return{ok:true,rail:'crypto',currency:code,destination:wallet.wallet,destinationWallet:wallet.id,network:networkHint||wallet.networks[0]||'',marketplace,amountUsd,direct:true};
  }
  if(unique.some(x=>MANAGED_METHOD.test(x))){
    return{ok:true,rail:'marketplace_managed',currency:code,marketplace,amountUsd,requiresPayoutSetup:true,reason:'marketplace_holds_or_releases_funds; downstream withdrawal must be verified separately'};
  }
  if(CRYPTO_CODES.has(code)&&unique.some(x=>/crypto|wallet|usdc|usdt|stablecoin|onchain|solana|spl|evm|base/.test(x))&&wallet){
    return{ok:true,rail:'crypto',currency:code,destination:wallet.wallet,destinationWallet:wallet.id,network:networkHint||wallet.networks[0]||'',marketplace,amountUsd};
  }
  if(unique.some(x=>/swift|iban|wire|bank_transfer|bank/.test(x))&&dest.fop.configured){
    const account=dest.fop.accounts.find(x=>x.currency===code)||null;
    if(account)return{ok:true,rail:'fop_swift',currency:account.currency,destination:account.iban,swift:account.swift,beneficiary:account.beneficiary,bank:account.bank,note:account.note,marketplace,amountUsd};
  }
  const mediator=dest.intermediaries.find(x=>intermediarySupports(x,{marketplace,currency:code,methods:unique}));
  if(mediator)return{ok:true,rail:'verified_intermediary',provider:mediator.name||mediator.id,destination:mediator.destination||'',currency:code,marketplace,amountUsd,verifiedAt:mediator.verifiedAt,officialSourceUrl:mediator.officialSourceUrl};
  return{ok:false,reason:CRYPTO_CODES.has(code)&&dest.crypto.configured?'no_compatible_wallet_for_currency_or_network':unique.length?'no_verified_supported_payout_route':'marketplace_payout_methods_unknown',marketplace,currency:code,network:networkHint,supportedMethods:unique};
}

// Split planning is intentionally non-custodial. It tells settlement code how much belongs
// to owner vs agent treasury and which PUBLIC destination fits the asset. It never signs,
// exports keys, or invents a bridge. A provider that cannot split at source stays a single
// receipt plus ledger allocation until an explicitly verified transfer rail exists.
export function planRevenueSplit({amountUsd=0,currency='USDC',network='',marketplace=''}={},config={},env=process.env){
  const amount=Math.max(0,Number(amountUsd||0));
  const ownerPct=Number(config.ownerRevenuePercent??50),treasuryPct=Number(config.agentTreasuryPercent??50);
  const total=ownerPct+treasuryPct||100;
  const ownerUsd=round(amount*ownerPct/total),treasuryUsd=round(Math.max(0,amount-ownerUsd));
  const wallet=selectWallet(paymentDestinations(env).crypto.wallets,{currency:String(currency).toUpperCase(),network:norm(network)});
  return{mode:'survival_50_50',amountUsd:amount,ownerUsd,treasuryUsd,currency:String(currency).toUpperCase(),network:norm(network),marketplace,destination:wallet?{wallet:wallet.id,address:wallet.wallet}:null,transferReady:Boolean(wallet)};
}

function selectWallet(wallets,{currency,network}){
  const code=String(currency||'').toUpperCase();const n=norm(network);
  if(code==='SOL'||SOLANA_NETWORKS.has(n))return wallets.solana.configured&&wallets.solana.currencies.includes(code)?wallets.solana:null;
  if(code==='BTC'||n==='bitcoin')return wallets.bitcoin.configured&&wallets.bitcoin.currencies.includes(code)?wallets.bitcoin:null;
  if(code==='ETH'||EVM_NETWORKS.has(n))return wallets.evm.configured&&wallets.evm.currencies.includes(code)?wallets.evm:null;
  // Stablecoins are multi-chain. With no network proof prefer the existing EVM/Rabby
  // owner rail; never send SPL tokens to EVM or vice versa merely because the symbol matches.
  if(['USDC','USDT','DAI'].includes(code)){
    if(SOLANA_NETWORKS.has(n))return wallets.solana.configured&&wallets.solana.currencies.includes(code)?wallets.solana:null;
    if(n&&EVM_NETWORKS.has(n))return wallets.evm.configured&&wallets.evm.currencies.includes(code)?wallets.evm:null;
    if(!n&&wallets.evm.configured&&wallets.evm.currencies.includes(code))return wallets.evm;
    if(!n&&wallets.solana.configured&&wallets.solana.currencies.includes(code))return wallets.solana;
  }
  return null;
}
function networkFromMethods(methods){const text=methods.join(' ');if(/solana|\bspl\b/.test(text))return'solana';if(/base|ethereum|evm|arbitrum|polygon|optimism/.test(text))return (text.match(/base|ethereum|arbitrum|polygon|optimism/)||[])[0]||'';if(/bitcoin|\bbtc\b/.test(text))return'bitcoin';return'';}
function norm(v){return String(v||'').toLowerCase().trim();}
function isEvmAddress(v){return /^0x[a-fA-F0-9]{40}$/.test(String(v||''));}
function isSolanaAddress(v){return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(v||''));}
function isBitcoinAddress(v){return /^(?:bc1[ac-hj-np-z02-9]{20,80}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(String(v||''));}
function fopAccounts(env){
  const configured=parseJson(env.AUTONOMOS_FOP_ACCOUNTS_JSON,[]);const rows=Array.isArray(configured)?configured:[];
  const legacy={beneficiary:String(env.BANK_BENEFICIARY||'').trim(),bank:String(env.BANK_NAME||'').trim(),iban:String(env.BANK_IBAN||'').trim(),swift:String(env.BANK_SWIFT||'').trim(),currency:String(env.BANK_CURRENCY||'USD').trim().toUpperCase(),note:String(env.BANK_PAYMENT_NOTE||'').trim()};
  if(legacy.iban&&legacy.swift&&legacy.beneficiary)rows.push(legacy);
  const unique=new Map();for(const raw of rows){const row={beneficiary:String(raw?.beneficiary||'').trim(),bank:String(raw?.bank||'').trim(),iban:String(raw?.iban||'').replace(/\s+/g,'').trim(),swift:String(raw?.swift||'').replace(/\s+/g,'').trim().toUpperCase(),currency:String(raw?.currency||'USD').trim().toUpperCase(),note:String(raw?.note||'').trim()};if(!row.beneficiary||!row.iban||!row.swift||!/^[A-Z]{3}$/.test(row.currency))continue;unique.set(`${row.currency}:${row.iban}`,row);}return[...unique.values()];
}
function isVerifiedIntermediary(x,{now,maxAgeDays}){if(!x||x.verifiedForUkraineFop!==true)return false;const source=String(x.officialSourceUrl||'');if(!/^https:\/\//i.test(source))return false;const verified=Date.parse(String(x.verifiedAt||''));if(!Number.isFinite(verified))return false;return now-verified<=maxAgeDays*86400000;}
function intermediarySupports(x,{marketplace,currency,methods}){const markets=Array.isArray(x.marketplaces)?x.marketplaces.map(v=>String(v).toLowerCase()):[];const currencies=Array.isArray(x.currencies)?x.currencies.map(v=>String(v).toUpperCase()):[];const supported=Array.isArray(x.methods)?x.methods.map(v=>String(v).toLowerCase()):[];if(markets.length&&marketplace&&!markets.includes(String(marketplace).toLowerCase()))return false;if(currencies.length&&!currencies.includes(currency))return false;if(supported.length&&methods.length&&!methods.some(m=>supported.includes(m)))return false;return true;}
function arrayJson(value,fallback){const v=parseJson(value,fallback);return Array.isArray(v)?v:fallback;}
function parseJson(value,fallback){try{return JSON.parse(String(value||''))}catch{return fallback}}
function round(v){return Math.round((Number(v||0)+Number.EPSILON)*1e6)/1e6;}

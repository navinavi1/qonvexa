export function ledgerEntry({id='',type,jobId='',externalId='',externalTransactionId='',registryIdentity='',source='',grossUsd=0,amountUsd=null,feeUsd=0,apiCostUsd=0,networkFeeUsd=0,currency='USD',rail='',network='',txId='',status='recorded',estimated=false,note='',allocation=null,testnet=false,productId='',displayAmountUsd=null}={}){
  const kind=String(type||'').toLowerCase();
  const canonicalAmount=amountUsd===null||amountUsd===undefined?Number(grossUsd||0):Number(amountUsd||0);
  const gross=Math.max(0,Number(grossUsd||canonicalAmount||0));
  const fees=Math.max(0,Number(feeUsd||0))+Math.max(0,Number(apiCostUsd||0))+Math.max(0,Number(networkFeeUsd||0));
  const net=kind==='cost'?-Math.max(0,canonicalAmount):gross-fees;
  return{
    id:id||'',at:new Date().toISOString(),type:kind,jobId,externalId,externalTransactionId,registryIdentity,source,
    amountUsd:round6(Math.max(0,canonicalAmount)),grossUsd:round6(gross),feeUsd:round6(feeUsd),apiCostUsd:round6(apiCostUsd),networkFeeUsd:round6(networkFeeUsd),netUsd:round6(net),
    currency:String(currency||'USD').toUpperCase(),rail,network,txId,status,estimated:Boolean(estimated),note:String(note||''),allocation,testnet:Boolean(testnet),productId,
    ...(displayAmountUsd===null||displayAmountUsd===undefined?{}:{displayAmountUsd:Number(displayAmountUsd)})
  };
}
function round6(value){return Math.round((Number(value||0)+Number.EPSILON)*1e6)/1e6;}

// The outbox may replay after a crash between ledger append and outbox removal.
// -1 explicitly reads the full journal; a limit of 0 means no rows in this store.
export function appendUniqueLedgerEntry(store, record) {
  if (!record?.id) throw new Error('ledger_id_required');
  if (store.readNdjson('ledger.ndjson', -1).some(row => row.id === record.id || record.type==='revenue'&&row.type==='revenue'&&receiptIdentity(record)&&receiptIdentity(record)===receiptIdentity(row))) return false;
  store.append('ledger.ndjson', record);
  return true;
}

// Marketplace-local numeric receipt IDs are not globally unique. Chain hashes are.
export function receiptIdentity(row){
 const id=String(row.externalTransactionId||row.txId||'');if(!id)return '';
 if(/^0x[0-9a-f]{64}$/i.test(id))return 'chain:'+String(row.network||'evm')+':'+id.toLowerCase();
 if(row.network&&row.rail==='crypto')return 'chain:'+row.network+':'+id;
 return 'market:'+String(row.source||'unknown')+':'+id;
}

// Which settlement currencies are crypto by definition. Same set the payout router uses to
// decide whether a job can be paid into one of the owner's wallets at all.
const CRYPTO_CURRENCIES=new Set(['USDC','USDT','DAI','ETH','BTC','SOL','WETH','WBTC']);
// Chain identifiers as the various writers actually spell them. x402 uses CAIP-2
// ('eip155:8453'), treasury.js the same, the TaskForce worker writes plain 'solana', and
// the payout router speaks in names like 'base' and 'arbitrum'.
const CRYPTO_NETWORKS=new Set(['ethereum','mainnet','base','arbitrum','optimism','polygon','matic','solana','sol','spl','bitcoin']);

// Did this revenue arrive in one of the owner's crypto wallets?
//
// The dashboard tile "Надійшло у крипто" asked `rail === 'crypto' || /^eip155:/.test(network)`.
// Only inbound-receipt.js writes rail 'crypto' and only x402 writes an eip155 network, so
// every other crypto rail was reported as zero. The TaskForce worker settles USDC on Solana
// into the Phantom wallet and writes rail 'taskforce_solana_wallet' with network 'solana':
// real money in the owner's wallet, counted as $0. Fiat rails must still be excluded —
// agrenting escrow and the Stripe card checkout are both USD with no chain.
export function isCryptoRevenue(row={}){
  const rail=String(row.rail||'').toLowerCase();
  if(rail==='crypto')return true;
  const network=String(row.network||'').toLowerCase();
  if(/^(?:eip155|solana|bip122|cosmos):/.test(network))return true;
  if(CRYPTO_NETWORKS.has(network))return true;
  // A USDC or SOL receipt is on-chain whatever the rail is called. USD is not, which is
  // what keeps card and escrow settlements out.
  return CRYPTO_CURRENCIES.has(String(row.currency||'').toUpperCase());
}

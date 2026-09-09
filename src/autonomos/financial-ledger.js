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

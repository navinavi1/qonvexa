import { configuredEvmChains, isEvmAddress } from './treasury.js';
import { ledgerEntry, appendUniqueLedgerEntry } from './financial-ledger.js';
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Read-only settlement verification. A client email is only a transaction pointer.
// Neither a balance change, a pending transaction nor a token with the same ticker is proof.
export async function verifyInboundReceipt({txHash,address,acceptedAt,env=process.env,fetchImpl=fetch}){
 if(!/^0x[\da-f]{64}$/i.test(txHash)||!isEvmAddress(address)||!Number.isFinite(Date.parse(acceptedAt)))return {ok:false,reason:'receipt_identity_missing'};
 for(const chain of configuredEvmChains(env)){
  try{
   const rpc=async(method,params)=>{const r=await fetchImpl(chain.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'error',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('rpc_unavailable');const body=await r.json();if(body.error)throw Error('rpc_error');return body.result;};
   if(Number(BigInt(await rpc('eth_chainId',[])))!==Number(chain.chainId))continue;
   const receipt=await rpc('eth_getTransactionReceipt',[txHash]);
   if(!receipt||String(receipt.transactionHash).toLowerCase()!==txHash.toLowerCase()||BigInt(receipt.status||0)!==1n)continue;
   const [head,block]=await Promise.all([rpc('eth_blockNumber',[]),rpc('eth_getBlockByHash',[receipt.blockHash,false])]);
   if(!block||block.hash!==receipt.blockHash||BigInt(head)-BigInt(receipt.blockNumber)<12n||Number(BigInt(block.timestamp))*1000<Date.parse(acceptedAt))continue;
   let amountUsd=0;
   for(const log of receipt.logs||[]){
    const token=chain.tokens?.find(t=>t.address.toLowerCase()===String(log.address).toLowerCase()&&['USDC','USDT','DAI'].includes(t.symbol));
    if(!token||log.removed||log.topics?.length!==3||log.topics[0].toLowerCase()!==TRANSFER||'0x'+log.topics[2].slice(-40).toLowerCase()!==address.toLowerCase())continue;
    const amount=Number(BigInt(log.data))/10**Number(token.decimals);if(Number.isFinite(amount)&&amount>0)amountUsd+=amount;
   }
   if(amountUsd>0)return {ok:true,txHash:txHash.toLowerCase(),network:chain.id,amountUsd,confirmedAt:new Date(Number(BigInt(block.timestamp))*1000).toISOString(),address};
  }catch{}
 }
 return {ok:false,reason:'confirmed_inbound_stablecoin_receipt_not_found'};
}

export async function reconcileClientPayments({store,jobId,action,env=process.env,verify=verifyInboundReceipt}){
 const address=env.AUTONOMOS_OWNER_WALLET;
 for(const txHash of (action.paymentClaims||[]).slice(0,5)){
  const records=store.readNdjson('ledger.ndjson',-1);
  if(records.some(r=>String(r.externalTransactionId||r.txId).toLowerCase()===txHash.toLowerCase()))continue;
  const proof=await verify({txHash,address,acceptedAt:action.acceptedAt,env});if(!proof.ok)continue;
  appendUniqueLedgerEntry(store,ledgerEntry({id:'inbound_'+proof.network+'_'+proof.txHash,type:'revenue',jobId,source:'direct-client',externalTransactionId:proof.txHash,txId:proof.txHash,amountUsd:proof.amountUsd,network:proof.network,rail:'crypto',status:'confirmed',note:'Client-linked transaction verified against configured stablecoin contract and owner wallet'}));
 }
 const receipts=store.readNdjson('ledger.ndjson',-1).filter(r=>r.jobId===jobId&&r.type==='revenue'&&r.status==='confirmed'&&r.externalTransactionId);
 const receivedUsd=receipts.reduce((n,r)=>n+Number(r.amountUsd||0),0),expected=Number(action.payout?.amountUsd||0);
 return {receivedUsd,paid:expected>0&&receivedUsd>=expected};
}

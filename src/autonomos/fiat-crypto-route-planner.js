import fs from 'node:fs';
import path from 'node:path';

const CRYPTO=new Set(['USDC','USDT','DAI','ETH','SOL','BTC']);
const FIAT=new Set(['USD','EUR','GBP','UAH','CAD','AUD']);

export class FiatCryptoRoutePlanner{
  constructor({env=process.env,storageDir='',logger=console}={}){this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'fiat-crypto-routes.json');this.hunterFile=path.join(this.root,'global-work-hunter.json');this.timer=null;}
  start(){if(this.timer)return;const every=Math.max(30*60_000,Number(this.env.AUTONOMOS_FIAT_ROUTE_PLANNER_MS||6*60*60_000));this.refresh();this.timer=setInterval(()=>this.refresh(),every);this.timer.unref?.();try{this.logger.info?.('[FiatCryptoRoutePlanner] '+JSON.stringify({type:'planner_started',intervalMs:every,autoTransfer:false}));}catch{}}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  refresh(){try{
    const hunter=readJson(this.hunterFile,{leads:{}});const configured=parseRoutes(this.env.AUTONOMOS_FIAT_ROUTES_JSON);const rows=[];
    for(const lead of Object.values(hunter.leads||{})){
      const currency=String(lead.payoutCurrency||lead.currency||'').toUpperCase();if(!currency)continue;
      if(CRYPTO.has(currency)){rows.push({leadId:lead.id,title:lead.title,currency,mode:'direct_crypto_preferred',route:'marketplace_or_client -> supported crypto rail -> owner wallet',requiresOwnerAction:false,autoTransferAllowed:false});continue;}
      if(!FIAT.has(currency))continue;
      const matching=configured.filter(r=>String(r.currency||'').toUpperCase()===currency&&r.enabled!==false);
      rows.push({leadId:lead.id,title:lead.title,currency,mode:matching.length?'configured_fiat_conversion_route':'fiat_conversion_research_required',routes:matching.length?matching.map(safeRoute):[defaultRoute(currency)],requiresOwnerAction:true,autoTransferAllowed:false,reason:'AutonomOS may research and select a lawful route, but it does not initiate bank/exchange trades or request/store private keys.'});
    }
    const payload={generatedAt:new Date().toISOString(),policy:{preferDirectCrypto:true,autoBankTransfer:false,autoExchangeTrade:false,privateKeysStored:false,ownerApprovalRequiredForFinancialTransfer:true},routes:rows.slice(0,1000)};writeJson(this.file,payload);try{this.logger.info?.('[FiatCryptoRoutePlanner] '+JSON.stringify({type:'routes_refreshed',count:payload.routes.length,fiat:payload.routes.filter(x=>x.mode!=='direct_crypto_preferred').length}));}catch{}
  }catch(error){try{this.logger.warn?.('[FiatCryptoRoutePlanner] '+String(error?.message||error).slice(0,180));}catch{}}}
}
function defaultRoute(currency){return{currency,steps:['receive payout through marketplace-supported lawful fiat rail','move funds through an owner-configured regulated exchange/on-ramp that supports the jurisdiction','convert to a supported stablecoin such as USDC/USDT where lawful and available','withdraw to the configured owner wallet on a verified compatible network'],status:'needs_verified_owner_financial_rail'};}
function safeRoute(r){return{currency:String(r.currency||''),provider:String(r.provider||''),receiveMethod:String(r.receiveMethod||''),asset:String(r.asset||'USDC'),network:String(r.network||''),status:String(r.status||'configured'),requiresOwnerAction:true};}
function parseRoutes(v){try{const x=JSON.parse(String(v||'[]'));return Array.isArray(x)?x:[];}catch{return[];}}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return structuredClone(fallback);}}
function writeJson(file,value){const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}

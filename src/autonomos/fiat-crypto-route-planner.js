import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './util.js';

const CRYPTO=new Set(['USDC','USDT','DAI','ETH','SOL','BTC']);
const FIAT=new Set(['USD','EUR','GBP','UAH','CAD','AUD']);

export class FiatCryptoRoutePlanner{
  constructor({env=process.env,storageDir='',logger=console}={}){this.env=env;this.logger=logger;this.root=path.join(storageDir||env.STORAGE_DIR||'data','autonomos');fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'fiat-crypto-routes.json');this.hunterFile=path.join(this.root,'global-work-hunter.json');this.timer=null;}
  start(){if(this.timer)return;const every=Math.max(30*60_000,Number(this.env.AUTONOMOS_FIAT_ROUTE_PLANNER_MS||6*60*60_000));this.refresh();this.timer=setInterval(()=>this.refresh(),every);this.timer.unref?.();try{this.logger.info?.('[FiatCryptoRoutePlanner] '+JSON.stringify({type:'planner_started',intervalMs:every,autoTransfer:false}));}catch{}}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  refresh(){try{
    const hunter=readJson(this.hunterFile,{leads:{}});const configured=parseRoutes(this.env.AUTONOMOS_FIAT_ROUTES_JSON);const rows=[];
    // Every lead gets a row. Two `continue`s used to drop leads silently, and between them
    // they discarded the common case: global-work-hunter writes payoutCurrency 'UNKNOWN'
    // whenever it cannot read a currency off the posting, and FIAT lists six currencies, so
    // JPY, PLN, CHF, INR and most of the world fell through as well. This document exists to
    // tell the owner which earnings need a decision before they can become crypto — a lead
    // dropped from it is money the owner is never told about. Measured on five leads worth
    // $2300, three worth $1800 vanished without a trace.
    const notice='AutonomOS may research and select a lawful route, but it does not initiate bank/exchange trades or request/store private keys.';
    for(const lead of Object.values(hunter.leads||{})){
      const currency=String(lead.payoutCurrency||lead.currency||'').toUpperCase();
      const amountUsd=Number(lead.amountUsd||lead.payoutUsd||0)||0;
      const base={leadId:lead.id,title:lead.title,currency,amountUsd,autoTransferAllowed:false};
      if(CRYPTO.has(currency)){rows.push({...base,mode:'direct_crypto_preferred',route:'marketplace_or_client -> supported crypto rail -> owner wallet',requiresOwnerAction:false});continue;}
      // 'UNKNOWN' is the hunter's own placeholder, not a currency. No route can be planned
      // until someone establishes what the job actually pays in, and that is owner work.
      if(!currency||currency==='UNKNOWN'||!/^[A-Z]{3}$/.test(currency)){
        rows.push({...base,currency:currency||'UNKNOWN',mode:'payout_currency_undetermined',requiresOwnerAction:true,reason:'The posting did not state a payout currency, so no conversion route can be planned yet.'});
        continue;
      }
      const matching=configured.filter(r=>String(r.currency||'').toUpperCase()===currency&&r.enabled!==false);
      const known=FIAT.has(currency);
      rows.push({...base,mode:matching.length?'configured_fiat_conversion_route':known?'fiat_conversion_research_required':'unsupported_currency_needs_owner_rail',routes:matching.length?matching.map(safeRoute):[defaultRoute(currency)],requiresOwnerAction:true,reason:notice});
    }
    rows.sort((a,b)=>b.amountUsd-a.amountUsd);
    const needsOwner=rows.filter(r=>r.requiresOwnerAction);
    const byMode={};for(const r of rows)byMode[r.mode]=(byMode[r.mode]||0)+1;
    const summary={leads:rows.length,byMode,needingOwnerAction:needsOwner.length,valueNeedingOwnerActionUsd:Math.round(needsOwner.reduce((n,r)=>n+r.amountUsd,0)*100)/100};
    const payload={generatedAt:new Date().toISOString(),summary,policy:{preferDirectCrypto:true,autoBankTransfer:false,autoExchangeTrade:false,privateKeysStored:false,ownerApprovalRequiredForFinancialTransfer:true},routes:rows.slice(0,1000)};writeJson(this.file,payload);try{this.logger.info?.('[FiatCryptoRoutePlanner] '+JSON.stringify({type:'routes_refreshed',count:payload.routes.length,fiat:payload.routes.filter(x=>x.mode!=='direct_crypto_preferred').length,needingOwnerAction:summary.needingOwnerAction,valueNeedingOwnerActionUsd:summary.valueNeedingOwnerActionUsd}));}catch{}
  }catch(error){try{this.logger.warn?.('[FiatCryptoRoutePlanner] '+String(error?.message||error).slice(0,180));}catch{}}}
}
function defaultRoute(currency){return{currency,steps:['receive payout through marketplace-supported lawful fiat rail','move funds through an owner-configured regulated exchange/on-ramp that supports the jurisdiction','convert to a supported stablecoin such as USDC/USDT where lawful and available','withdraw to the configured owner wallet on a verified compatible network'],status:'needs_verified_owner_financial_rail'};}
function safeRoute(r){return{currency:String(r.currency||''),provider:String(r.provider||''),receiveMethod:String(r.receiveMethod||''),asset:String(r.asset||'USDC'),network:String(r.network||''),status:String(r.status||'configured'),requiresOwnerAction:true};}
function parseRoutes(v){try{const x=JSON.parse(String(v||'[]'));return Array.isArray(x)?x:[];}catch{return[];}}



import { isRetiredMarket } from '../retired-markets.js';
// Retained native markets are polled by their provider adapters. This registry exposes
// capability diagnostics; a credential alone is never evidence of a claimable job.
const DEFS=[
 {id:'x402-bazaar',name:'x402 / Bazaar',kind:'seller+discovery',requiredEnv:[]},
 {id:'e2b',name:'E2B',kind:'tool',requiredEnv:['E2B_API_KEY']},
 {id:'github-pr',name:'GitHub PR',kind:'tool',requiredEnv:['GITHUB_TOKEN']}
];
export function connectorDefinitions(){return DEFS.map(x=>({...x}));}
export function connectorStatuses(env=process.env,x402={}){return DEFS.map(d=>{const missing=d.requiredEnv.filter(k=>!env[k]);if(d.id==='x402-bazaar')return{...d,configured:Boolean(x402.configured),status:x402.configured?'ready':'available',mode:x402.mode||'disabled',missing:[]};return{...d,configured:!missing.length,status:missing.length?'needs_credentials':'ready',missing};});}
export async function bootstrapMarketCredentials({credentials={}}={}){return{credentials,health:{}};}
// A directory of APIs for sale is not a list of paid jobs for an agent.
export async function discoverMarketOpportunities(){return{signals:[],health:{}};}
export const discoverPublicSignals=discoverMarketOpportunities;
export async function claimMarketplaceJob(op){return{ok:false,reason:isRetiredMarket(op)?'marketplace_retired':'connector_claim_not_available'};}
export async function deliverMarketplaceJob(op){return{ok:false,reason:isRetiredMarket(op)?'marketplace_retired':'connector_delivery_not_available'};}
export async function readMarketplaceWallets(){return{};}
export async function syncMarketplaceTransactions(){return{transactions:[],health:{}};}
export async function reconcileMarketplaceDelivery(op){return{ok:false,reason:isRetiredMarket(op)?'marketplace_retired':'connector_status_not_available'};}

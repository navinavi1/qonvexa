import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://local.example/admin',runScripts:'outside-only'});
const {window}=dom;
window.fetch=async url=>{
  if(String(url).includes('autonomos-global-feed.json'))return{ok:true,json:async()=>({generatedAt:new Date().toISOString(),counts:{applied:1,working:1,done:0,paid:0,archive:0},rows:[
    {id:'live1',source:'freelancer-public-api',title:'Python automation',category:'automation',amountUsd:100,currency:'USD',status:'applied_email',bucket:'applied',appliedAt:new Date().toISOString()}
  ]})};
  return{ok:true,json:async()=>({})};
};
window.eval(fs.readFileSync(new URL('../public/marketplaces.js',import.meta.url),'utf8'));
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise(r=>setTimeout(r,20));
assert.equal(window.document.querySelectorAll('[data-market]').length,0,'legacy marketplace control cards are gone');
assert.equal(window.document.querySelector('.autonomos-t2000-card'),null,'legacy T2000 card is removed from owner UI');
assert.equal(window.document.querySelector('section[aria-label="AgentHansa and TaskBounty"]'),null,'old marketplace compatibility section is removed');
const feed=window.document.getElementById('autonomos-global-work-feed');
assert(feed,'global paid-work feed must exist');
assert.match(feed.textContent,/Реальний робочий потік/);
const ids=[...window.document.querySelectorAll('[id]')].map(e=>e.id);
assert.equal(new Set(ids).size,ids.length,'admin IDs must remain unique');
console.log('PASS UI cleanup: legacy marketplace controls removed; live global work feed retained');
dom.window.close();

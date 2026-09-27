const key=location.hash.slice(1);
// Keep the bearer only in this page's memory. No token in requests' URLs/storage.
history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=null,services=[];let polling=null;
const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100);
async function api(path,body){const r=await fetch('/api/next'+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${key}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d;}
function findings(report){return (report.findings||[]).map(f=>`<article><span class="badge">${esc(f.category)} · ${esc(f.severity)} · ${esc(f.confidence)} CONFIDENCE</span><h3>${esc(f.title)}</h3><p>${esc(f.description)}</p><pre>${esc(f.evidence.map(e=>e.observation).join('\n'))}</pre><small>Observed ${esc(f.evidence[0]?.observedAt)} · ${esc(f.url)}</small><p>${esc(f.businessImpact.description)}</p><p><b>Recommended action:</b> ${esc(f.recommendedFix)}</p></article>`).join('');}
async function load(){
 try{
   [state,{services}]=await Promise.all([api('/portal'),api('/catalog')]);
   const cfg=await api('/config');
   $('status').textContent='Private workspace loaded. Save the original link to return; it is your access key.';
   $('audits').innerHTML=state.audits.map(a=>`<article><h3>${esc(a.url)}</h3><span class="badge">${esc(a.status)}</span>${a.failureCode?`<p>Review needed: ${esc(a.failureCode)}. Audit ID ${esc(a.id)}.</p>${a.reviewRequestedAt?'<p>Your staff review request is recorded.</p>':`<button data-audit-review="${esc(a.id)}">Request staff review</button>`}`:''}${a.report?`<p>Observed ${esc(a.report.observedAt)}. Freshness expires ${esc(a.report.expiresAt)}.</p>${findings(a.report)}${!a.paid?`<p>We found ${esc(a.report.additionalIssues)} additional issues in the sampled pages.</p><a class="button" href="/#pricing">Unlock Full Growth Audit — ${money(cfg.priceCents)}</a>`:`<details><summary>Coverage and limits</summary><pre>${esc(JSON.stringify(a.report.coverage,null,2))}</pre></details>`}`:'<p>There is no completed scan yet. This status will not be presented as a finished audit.</p>'}</article>`).join('');
   $('recommendations').innerHTML=state.audits.filter(a=>a.paid&&a.report).flatMap(a=>(a.report.recommendations||[]).map(r=>{const s=services.find(s=>s.id===r.serviceId);return `<article><h3>${esc(s.name)}</h3><p>From ${money(s.basePrice)} one-time; scope review required.</p><p>${esc(s.estimatedCustomerRecurringCost.description)}</p><button data-quote="${esc(r.serviceId)}" data-audit="${esc(a.id)}">Request scope &amp; preflight</button></article>`;})).join('')||'<p>Available after a full paid audit is ready.</p>';
   $('quote-list').innerHTML=state.quotes.map(q=>`<article><h3>${esc(services.find(s=>s.id===q.serviceId)?.name)}</h3><span class="badge">${esc(q.status)}</span><p>${money(q.oneTimeCents)} Qonvexa one-time estimate · valid until ${esc(new Date(q.validUntil).toLocaleDateString())}</p><p>${esc(q.disclosure)}</p><p>External costs: not yet verified. Billing owner: CUSTOMER.</p><b>Customer requirements</b><ul>${q.customerActions.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><b>Scope / Definition of Done</b><ul>${q.included.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p>Excluded: ${esc(q.excluded.join(', '))}.</p><p>Preflight: ${esc(q.preflight.status)}. ${esc(q.preflight.reasons.join(', '))}</p><p>Implementation checkout is blocked until supported execution and access are verified.</p><button data-plan="${esc(q.id)}">Generate dry-run plan</button>${q.reviewRequestedAt?'<p>Your scope review request is recorded.</p>':`<button data-quote-review="${esc(q.id)}">Request staff scope review</button>`}</article>`).join('')||'<p>No quote requested yet.</p>';
   $('connection-list').innerHTML=state.connections.map(c=>`<article><h3>${esc(c.provider)}</h3><p>${esc(c.status)}</p><pre>${esc(JSON.stringify(c.permissions,null,2))}</pre>${c.status!=='DISCONNECTED'?`<button data-disconnect="${esc(c.id)}">Disconnect local access</button>`:`<p>${esc(c.remoteRevocation)}</p>`}</article>`).join('')||'<p>No accounts connected.</p>';
   $('integration-list').innerHTML=Object.entries(state.integrations).map(([p,s])=>`<small>${esc(p.toUpperCase())}: ${esc(s.status)}</small>`).join('');
   $('plans').innerHTML=state.implementations.map(p=>`<article><h3>Implementation plan</h3><span class="badge">${esc(p.status)}</span><ol>${p.steps.map(x=>`<li>${esc(x)}</li>`).join('')}</ol><p>QA required: ${esc(p.definitionOfDone.join(', '))}</p><p>External actions performed: 0. No verified results or handoff yet.</p>${state.approvals.some(a=>a.id===p.id)?'<p>Plan approval recorded. No execution authorized in this release.</p>':`<button data-approve="${esc(p.id)}">Approve this plan for review</button>`}</article>`).join('')||'<p>No implementation plan yet.</p>';
   clearTimeout(polling);if(state.jobs.some(j=>['QUEUED','RUNNING'].includes(j.status)))polling=setTimeout(load,5000);
 }catch(e){$('status').textContent=e.message;}
}
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b||b.id==='refresh')return;b.disabled=true;
 try{
   if(b.dataset.auditReview)await api(`/audits/${b.dataset.auditReview}/request-review`,{});
   if(b.dataset.quoteReview)await api(`/quotes/${b.dataset.quoteReview}/request-review`,{});
   if(b.dataset.quote){const a=state.audits.find(x=>x.id===b.dataset.audit),r=a.report.recommendations.find(x=>x.serviceId===b.dataset.quote);await api('/quotes',{auditId:a.id,serviceId:r.serviceId,findingIds:r.findingIds.slice(0,10)});}
   if(b.dataset.plan)await api(`/quotes/${b.dataset.plan}/plan`,{});
   if(b.dataset.approve){const p=state.implementations.find(x=>x.id===b.dataset.approve);await api(`/implementations/${p.id}/approve`,{scopeHash:p.scopeHash});}
   if(b.dataset.disconnect)await api(`/connections/${b.dataset.disconnect}/disconnect`,{});
   await load();
 }catch(e){$('status').textContent=e.message;}finally{b.disabled=false;}
});
$('refresh').addEventListener('click',load);load();

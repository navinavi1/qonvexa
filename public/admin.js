const el = (s) => document.querySelector(s);
const els = (s) => [...document.querySelectorAll(s)];
const loginView = el('#login-view');
const dashboardView = el('#dashboard-view');
const loginForm = el('#admin-login-form');
const loginStatus = el('#login-status');
const editDialog = el('#edit-dialog');

let data = { counts:{}, previews:[], orders:[], clients:[], events:[], settings:{}, system:{} };
let currentUser = '';
let autonomosData = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials:'same-origin',
    headers:{ ...(options.body ? {'content-type':'application/json'} : {}), ...(options.headers || {}) },
    ...options
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}
function showDashboard(){ loginView.hidden=true; dashboardView.hidden=false; el('#admin-user').textContent=currentUser; }
function showLogin(){ dashboardView.hidden=true; loginView.hidden=false; }
function switchView(name){
  els('.admin-tab').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  els('.admin-view').forEach(p=>p.classList.toggle('active',p.dataset.panel===name));
  location.hash = name === 'overview' ? '' : name;
}
els('.admin-tab').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
els('[data-go]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.go)));

loginForm?.addEventListener('submit',async e=>{
  e.preventDefault(); loginStatus.textContent='Signing in…';
  try{
    const payload=Object.fromEntries(new FormData(loginForm).entries());
    const result=await api('/api/admin/login',{method:'POST',body:JSON.stringify(payload)});
    currentUser=result.username||payload.username; loginStatus.textContent=''; showDashboard(); await loadDashboard();
  }catch(err){ loginStatus.textContent=err.message; }
});
el('#logout-btn')?.addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST',body:'{}'})}catch{} showLogin();});
el('#refresh-btn')?.addEventListener('click',loadDashboard);
el('#dialog-close')?.addEventListener('click',()=>editDialog.close());

async function loadDashboard(){
  try{
    data=await api('/api/admin/dashboard');
    try{autonomosData=await api('/api/admin/autonomos')}catch(err){console.error('AutonomOS dashboard:',err);autonomosData=null}
    renderAll();
  }catch(err){ if(String(err.message).includes('Unauthorized'))showLogin(); else console.error(err); }
}
function renderAll(){
  el('#preview-count').textContent=data.counts.previews??0;
  el('#open-lead-count').textContent=data.counts.openLeads??0;
  el('#order-count').textContent=data.counts.paidOrders??0;
  el('#active-order-count').textContent=data.counts.activeOrders??0;
  el('#client-count').textContent=data.counts.clients??0;
  renderRecent();
  renderLeads();
  renderOrders();
  renderClients();
  renderActivity();
  renderSettings();
  renderReadiness();
  renderAutonomOS();
}
function renderRecent(){
  el('#recent-leads').innerHTML=data.previews.slice(0,5).map(x=>miniCard(x.email,x.websiteUrl,x.status,x.receivedAt)).join('')||emptyCard('No leads yet.');
  el('#recent-orders').innerHTML=data.orders.slice(0,5).map(x=>miniCard(x.customerEmail,x.websiteUrl,x.status,x.receivedAt)).join('')||emptyCard('No orders yet.');
}
function miniCard(title,url,status,date){return `<article class="mini-card"><div><b>${esc(title)}</b><span>${esc(url)}</span></div><div><span class="status s-${esc(status)}">${pretty(status)}</span><small>${esc(formatDate(date))}</small></div></article>`}
function emptyCard(text){return `<p class="empty-state">${esc(text)}</p>`}

function renderLeads(){
  const q=valueFor('leads','.table-search'); const status=valueFor('leads','.status-filter');
  const rows=data.previews.filter(x=>matches(x,q)&&(!status||x.status===status));
  el('#preview-rows').innerHTML=rows.length?rows.map(x=>`<tr data-edit="lead" data-id="${esc(x.id)}">
    <td>${esc(formatDate(x.receivedAt))}</td><td>${esc(x.email)}</td><td>${link(x.websiteUrl)}</td><td>${esc(x.businessType)}</td>
    <td><button class="status-button s-${esc(x.status)}" data-edit="lead" data-id="${esc(x.id)}">${pretty(x.status)}</button>${x.miniAuditSummary?'<span class="status s-ready">Mini audit ready</span>':''}${x.preparedAuditUrl?'<span class="status s-ready">Full audit prepared</span>':''}</td>
    <td class="muted-cell">${esc(x.note)}</td><td class="muted-cell">${esc(x.adminNote)}</td></tr>`).join(''):emptyRow(7,'No leads found.');
}
function renderOrders(){
  const q=valueFor('orders','.table-search'); const status=valueFor('orders','.status-filter');
  const rows=data.orders.filter(x=>matches(x,q)&&(!status||x.status===status));
  el('#order-rows').innerHTML=rows.length?rows.map(x=>`<tr>
    <td>${esc(formatDate(x.receivedAt))}</td><td>${esc(x.customerEmail)}</td><td>${link(x.websiteUrl)}</td><td>${esc(x.businessType)}</td><td>${esc(x.primaryGoal)}</td>
    <td>${esc(formatMoney(x.amountTotal,x.currency))}</td><td>${esc(pretty(x.paymentMethod || 'card'))}</td><td><button class="status-button s-${esc(x.status)}" data-edit="order" data-id="${esc(x.sessionId)}">${pretty(x.status)}</button></td>
    <td class="muted-cell">${esc(x.adminNote)}</td></tr>`).join(''):emptyRow(9,'No orders found.');
}
function renderClients(){
  const q=valueFor('clients','.table-search');
  const clients=data.clients.filter(x=>matches(x,q));
  el('#client-cards').innerHTML=clients.length?clients.map(x=>`<article class="client-card">
    <div class="client-avatar">${esc((x.email||'?')[0].toUpperCase())}</div>
    <div class="client-main"><b>${esc(x.email)}</b><span>${link(x.websiteUrl)}</span><small>${esc(x.businessType)}</small></div>
    <div class="client-metrics"><div><small>PREVIEWS</small><b>${x.previewCount}</b></div><div><small>ORDERS</small><b>${x.orderCount}</b></div><div><small>PAID</small><b>${esc(formatMoney(x.totalPaidCents,x.currency))}</b></div></div>
    <div class="client-statuses">${x.latestLeadStatus?`<span class="status s-${esc(x.latestLeadStatus)}">Lead: ${pretty(x.latestLeadStatus)}</span>`:''}${x.latestOrderStatus?`<span class="status s-${esc(x.latestOrderStatus)}">Order: ${pretty(x.latestOrderStatus)}</span>`:''}</div>
    <small class="client-date">Last activity: ${esc(formatDate(x.lastSeenAt))}</small>
  </article>`).join(''):emptyCard('No clients yet.');
}
function renderActivity(){
  el('#activity-list').innerHTML=data.events.length?data.events.map(x=>`<article class="activity-item"><i></i><div><b>${pretty(x.type)}</b><p>${esc(eventSummary(x))}</p></div><small>${esc(formatDate(x.at))}</small></article>`).join(''):emptyCard('No activity recorded yet.');
}
function eventSummary(x){
  const parts=[x.email,x.websiteUrl,x.status,x.entityId].filter(Boolean); return parts.join(' · ')||'Owner dashboard event';
}
function renderSettings(){
  const f=el('#settings-form'); if(!f)return;
  for(const [k,v] of Object.entries(data.settings||{})){if(f.elements[k])f.elements[k].value=v??''}
  el('#system-settings').innerHTML=[
    settingRow('Site URL',data.system.siteUrl),
    settingRow('Server contact email',data.system.contactEmail||'Not configured'),
    settingRow('Card checkout',data.system.stripeConfigured?'Configured':'Not configured',data.system.stripeConfigured),
    settingRow('Bank-transfer fallback',data.system.manualPaymentConfigured?'Configured':'Not configured',data.system.manualPaymentConfigured),
    settingRow('Payment mode',data.system.paymentMode||'Not configured'),
    settingRow('Sales gate',data.system.salesEnabled?'Enabled':'Disabled',data.system.salesEnabled),
    settingRow('Notification webhook',data.system.notificationWebhookConfigured?'Configured':'Not configured',data.system.notificationWebhookConfigured),
    settingRow('Domain email',data.system.domainEmailConfigured?'Configured':'Not configured',data.system.domainEmailConfigured),
    settingRow('Storage',data.system.persistentStorage?'Persistent':(data.system.storageDir?'Ephemeral':'Not configured'),data.system.persistentStorage)
  ].join('');
}
function settingRow(label,value,ok){return `<div class="system-row"><span>${esc(label)}</span><b>${esc(value)}</b>${typeof ok==='boolean'?`<i class="${ok?'ok':'warn'}">${ok?'READY':'TODO'}</i>`:''}</div>`}
function renderReadiness(){
  const items=[
    ['Payment method',Boolean(data.system.stripeConfigured || data.system.manualPaymentConfigured)],
    ['Persistent storage',data.system.persistentStorage],
    ['Domain email',data.system.domainEmailConfigured],
    ['Notification automation',data.system.notificationWebhookConfigured]
  ];
  el('#system-readiness').innerHTML=items.map(([label,ok])=>`<article><i class="${ok?'ready-dot':'todo-dot'}"></i><div><b>${esc(label)}</b><span>${ok?'Configured':'Needs setup'}</span></div></article>`).join('');
}


function renderAutonomOS(){
  if(!autonomosData)return;
  const a=autonomosData;
  const status=a.runtime?.status||'stopped';
  const badge=el('#autonomos-runtime-badge');
  if(badge){badge.textContent=pretty(status);badge.className=`autonomos-badge ${esc(status)}`}
  const treasuryUsdc=Number(a.treasury?.usdc||0);
  setText('#auto-treasury',a.treasury?.ok?`${treasuryUsdc.toFixed(4)}`:'—');
  setText('#auto-revenue24',usd(a.metrics?.revenue24hUsd));
  setText('#auto-cost24',usd(a.metrics?.cost24hUsd));
  setText('#auto-net',usd(a.metrics?.netProfitUsd));
  setText('#auto-agents',String(a.metrics?.activeAgents??20));
  setText('#auto-children',String(a.metrics?.activeChildren??0));
  setText('#auto-opportunities',String(a.metrics?.opportunitiesFound??0));
  setText('#auto-claimed',String(a.metrics?.claimedJobs??0));
  setText('#auto-delivered',String(a.metrics?.deliveredJobs??0));
  setText('#auto-paid',String(a.metrics?.paidJobs??0));
  setText('#auto-jobs',String(a.metrics?.completedJobs??0));
  setText('#auto-cycles',String(a.runtime?.cycles??0));
  setText('#autonomos-llm',a.runtime?.llm?.enabled?`LLM · ${a.runtime.llm.model}`:'Deterministic · no paid LLM');

  const radar=el('#autonomos-market-radar');
  if(radar){ const m=a.runtime?.marketSummary||{}; const health=a.runtime?.connectorHealth||{}; radar.innerHTML=`<article class="autonomos-event"><div class="event-row"><b>Latest cycle</b><span class="status s-ready">${Number(m.observed||0)} seen</span></div><p>${Number(m.escrowedJobs||0)} escrowed · ${Number(m.executable||0)} executable · ${Number(m.profitable||0)} profitable · median ${usd(m.medianPayoutUsd||0)}</p></article>`+Object.entries(health).map(([name,h])=>`<article class="autonomos-event"><div class="event-row"><b>${esc(pretty(name))}</b><span class="connector-${h?.ok?'ready':'needs_credentials'}">${h?.ok?'Healthy':'Unavailable'}</span></div><p>${esc(h?.count!==undefined?`${h.count} signals`:h?.error||h?.status||'')}</p></article>`).join(''); }
  const marketJobs=el('#autonomos-market-jobs');
  if(marketJobs){ marketJobs.innerHTML=(a.jobs||[]).filter(j=>j.source&&j.source!=='x402'&&j.source!=='admin_preview').slice(0,12).map(j=>`<article class="autonomos-event"><div class="event-row"><b>${esc(j.title||j.externalId||j.id)}</b><span class="status ${String(j.status||'').includes('fail')?'s-error':'s-ready'}">${esc(pretty(j.status||'unknown'))}</span></div><p>${esc(pretty(j.source))} · ${j.budgetUsd!==undefined?usd(j.budgetUsd):''} ${esc(j.currency||'')}${j.reason?` · <span class="job-fail-reason">${esc(j.reason)}</span>`:''}${j.error?` · <span class="job-fail-reason">${esc(j.error)}</span>`:''}</p></article>`).join('')||emptyCard('No marketplace jobs claimed yet. Discovery can be active while claims remain zero.'); }

  const wallet=el('#autonomos-wallet');
  if(wallet){ const assets=(a.treasury?.assets||[]).filter(x=>Number(x.balance||0)>0).slice(0,12).map(x=>`${x.network}: ${Number(x.balance||0).toFixed(6)} ${x.symbol}`).join(' · '); wallet.innerHTML=`<b>${esc(a.treasury?.ownerWallet||'Not configured')}</b><span>${a.treasury?.ok?`${esc(assets||'No non-zero EVM balances detected')} · checked ${esc(formatDate(a.treasury.checkedAt))}`:`Balance check: ${esc(a.treasury?.error||'not checked yet')}`}</span>`; }
  const allocations=el('#autonomos-allocations');
  if(allocations){
    const al=a.treasury?.allocations||{};
    allocations.innerHTML=[['Reserve',al.reserveUsd],['Growth',al.growthUsd],['Experiments',al.experimentUsd],['Earned spend budget',a.runtime?.earnedSpendBudgetUsd]].map(([k,v])=>`<article><small>${esc(k.toUpperCase())}</small><b>${usd(v)}</b></article>`).join('');
  }

  const form=el('#autonomos-config-form');
  if(form){for(const [k,v] of Object.entries(a.config||{})){if(form.elements[k]){if(form.elements[k].type==='checkbox')form.elements[k].checked=Boolean(v);else form.elements[k].value=v??''}}}

  const agentGrid=el('#autonomos-agent-grid');
  if(agentGrid) agentGrid.innerHTML=(a.agents||[]).map(agent=>`<article class="autonomos-agent"><div class="autonomos-agent-top"><b title="${esc(agent.name)}">${esc(agent.name)}</b><i class="agent-dot ${esc(agent.status)}" title="${esc(agent.status)}"></i></div><p>${esc(agent.purpose)}</p><small>${esc(pretty(agent.swarm))} · ${Number(agent.tasksCompleted||0)} tasks · ${usd(agent.revenueUsd)}</small></article>`).join('')||emptyCard('No agents loaded.');

  const products=el('#autonomos-products');
  if(products) products.innerHTML=(a.products||[]).map(product=>`<article class="autonomos-product"><div class="autonomos-product-head"><b>${esc(product.name)}</b><span class="autonomos-price">$${Number(product.priceUsd||0).toFixed(3)}</span></div><p>${esc(product.description)}</p><p class="autonomos-code">${esc(product.path)}</p><p>Payment: <span class="connector-${esc(product.payment?.configured?'ready':'needs_configuration')}">${esc(pretty(product.payment?.mode||'disabled'))}</span></p></article>`).join('')||emptyCard('No machine products.');

  const connectors=el('#autonomos-connectors');
  if(connectors) connectors.innerHTML=(a.connectors||[]).map(c=>`<article class="autonomos-connector"><div class="autonomos-connector-head"><b>${esc(c.name)}</b><span class="connector-${esc(c.status)}">${esc(pretty(c.status))}</span></div><p>${esc(c.description)}</p>${c.missing?.length?`<p>Needs: <span class="autonomos-code">${esc(c.missing.join(', '))}</span></p>`:''}</article>`).join('')||emptyCard('No connectors.');

  const children=el('#autonomos-children');
  if(children) children.innerHTML=(a.children||[]).filter(x=>x.status==='alive').map(child=>`<article class="autonomos-event"><div class="event-row"><b>${esc(child.id)}</b><span class="status s-ready">${esc(child.status)}</span></div><p>${esc(pretty(child.specialization))} · budget $${Number(child.budgetUsd||0).toFixed(2)} · expires ${esc(formatDate(child.expiresAt))}</p></article>`).join('')||emptyCard('No active child agents. They are spawned only when real concurrent demand justifies them.');

  const missing=el('#autonomos-missing');
  if(missing) missing.innerHTML=(a.missing||[]).map(item=>`<article class="autonomos-event"><div class="event-row"><b>${esc(item.item)}</b><span class="connector-needs_credentials">${esc(pretty(item.status))}</span></div><p>${esc(item.detail)}</p></article>`).join('')||'<p class="empty-state">All configured.</p>';

  const events=el('#autonomos-events');
  if(events) events.innerHTML=(a.events||[]).slice(0,120).map(x=>`<article class="activity-item"><i></i><div><b>${esc(pretty(x.type))}</b><p>${esc(autonomosEventSummary(x))}</p></div><small>${esc(formatDate(x.at))}</small></article>`).join('')||emptyCard('AutonomOS has not produced events yet.');
}
function autonomosEventSummary(x){return [x.productId,x.jobId,x.workerId,x.childId,x.amountUsd!==undefined?`$${Number(x.amountUsd).toFixed(4)}`:'',x.error].filter(Boolean).join(' · ')||'Runtime event'}
function setText(selector,value){const node=el(selector);if(node)node.textContent=value}
function usd(value){const n=Number(value||0);return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(Number.isFinite(n)?n:0)}

async function autonomosCommand(path,statusText){
  const badge=el('#autonomos-runtime-badge'); if(badge)badge.textContent=statusText||'Working…';
  try{await api(path,{method:'POST',body:'{}'});await loadDashboard()}catch(err){if(badge)badge.textContent=err.message;throw err}
}
el('#autonomos-start')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/start','Starting…'));
el('#autonomos-stop')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/stop','Stopping…'));
el('#autonomos-cycle')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/cycle','Running cycle…'));
el('#autonomos-reset-claims')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/reset-claim-history','Resetting claim history…'));
el('#autonomos-refresh-wallet')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/treasury/refresh','Checking wallet…'));
el('#autonomos-emergency')?.addEventListener('click',async()=>{
  if(!confirm('Emergency stop AutonomOS? This disables the runtime and all external spending permissions.'))return;
  await autonomosCommand('/api/admin/autonomos/emergency-stop','Emergency stop…');
});
el('#autonomos-runtime-badge')?.addEventListener('dblclick',async()=>{
  if(autonomosData?.runtime?.status!=='emergency_stopped')return;
  if(!confirm('Clear emergency-stop latch? Runtime will remain stopped until you press Start.'))return;
  await autonomosCommand('/api/admin/autonomos/clear-emergency','Clearing…');
});
el('#autonomos-config-form')?.addEventListener('submit',async e=>{
  e.preventDefault();const f=e.currentTarget;const status=el('#autonomos-config-status');status.textContent='Saving…';
  const raw=Object.fromEntries(new FormData(f).entries());
  const payload={...raw,autoReplication:f.elements.autoReplication.checked,autoClaimJobs:f.elements.autoClaimJobs.checked,requireEscrowForAutoClaim:f.elements.requireEscrowForAutoClaim.checked,zeroSpendMode:f.elements.zeroSpendMode.checked,earnedFundsOnly:f.elements.earnedFundsOnly.checked,allowExternalSpending:f.elements.allowExternalSpending.checked};
  for(const key of ['heartbeatSeconds','fastClaimPollSeconds','minMarginPercent','reservePercent','growthPercent','experimentPercent','maxChildren','maxJobsPerCycle','minJobPayoutUsd','maxApiCostPercentOfPayout','seedSpendBudgetUsd','maxPaidProcurementUsd'])payload[key]=Number(payload[key]);
  try{await api('/api/admin/autonomos/config',{method:'PATCH',body:JSON.stringify(payload)});status.textContent='Saved.';await loadDashboard()}catch(err){status.textContent=err.message}
});

els('.table-search,.status-filter').forEach(x=>x.addEventListener('input',()=>{renderLeads();renderOrders();renderClients()}));
document.addEventListener('click',e=>{
  const btn=e.target.closest('[data-edit]');
  if(!btn)return;
  const type=btn.dataset.edit,id=btn.dataset.id;
  const source=type==='lead'?data.previews.find(x=>x.id===id):data.orders.find(x=>x.sessionId===id);
  if(source)openEdit(type,id,source);
});
function openEdit(type,id,item){
  const form=el('#edit-form'); form.reset(); form.elements.entityType.value=type; form.elements.entityId.value=id; form.elements.adminNote.value=item.adminNote||'';
  const invitedFields=el('#invited-audit-fields');
  const orderDeliveryFields=el('#order-delivery-fields');
  if(invitedFields) invitedFields.hidden=type!=='lead';
  if(orderDeliveryFields) orderDeliveryFields.hidden=type!=='order';

  if(type==='lead'){
    if(form.elements.miniAuditTitle) form.elements.miniAuditTitle.value=item.miniAuditTitle||'';
    if(form.elements.miniAuditSummary) form.elements.miniAuditSummary.value=item.miniAuditSummary||'';
    if(form.elements.miniAuditFindings) form.elements.miniAuditFindings.value=item.miniAuditFindings||'';
    if(form.elements.preparedAuditUrl) form.elements.preparedAuditUrl.value=item.preparedAuditUrl||'';
  }
  if(type==='order' && form.elements.deliveryUrl) form.elements.deliveryUrl.value=item.deliveryUrl||'';

  el('#dialog-kind').textContent=type==='lead'?'LEAD':'ORDER';
  el('#dialog-title').textContent=type==='lead'?(item.email||'Lead'):(item.customerEmail||'Order');
  const opts=type==='lead'?['new','reviewing','preview_sent','follow_up','won','lost','closed']:['awaiting_payment','paid','queued','in_progress','ready','delivered','refunded','cancelled'];
  el('#dialog-status').innerHTML=opts.map(x=>`<option ${x===item.status?'selected':''}>${x}</option>`).join('');
  el('#edit-status').textContent=''; editDialog.showModal();
}
el('#edit-form')?.addEventListener('submit',async e=>{
  e.preventDefault(); const f=e.currentTarget; const type=f.elements.entityType.value,id=f.elements.entityId.value;
  el('#edit-status').textContent='Saving…';
  try{
    const body={status:f.elements.status.value,adminNote:f.elements.adminNote.value};
    if(type==='lead'){
      body.miniAuditTitle=f.elements.miniAuditTitle?.value||'';
      body.miniAuditSummary=f.elements.miniAuditSummary?.value||'';
      body.miniAuditFindings=f.elements.miniAuditFindings?.value||'';
      body.preparedAuditUrl=f.elements.preparedAuditUrl?.value||'';
    }
    if(type==='order' && f.elements.deliveryUrl) body.deliveryUrl=f.elements.deliveryUrl.value;
    await api(`/api/admin/${type==='lead'?'leads':'orders'}/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(body)});
    editDialog.close(); await loadDashboard();
  }catch(err){el('#edit-status').textContent=err.message}
});
el('#settings-form')?.addEventListener('submit',async e=>{
  e.preventDefault(); const payload=Object.fromEntries(new FormData(e.currentTarget).entries()); el('#settings-status').textContent='Saving…';
  try{await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify(payload)});el('#settings-status').textContent='Saved.';await loadDashboard()}catch(err){el('#settings-status').textContent=err.message}
});

function valueFor(target,selector){return document.querySelector(`${selector}[data-target="${target}"]`)?.value.trim().toLowerCase()||''}
function matches(item,q){return !q||JSON.stringify(item).toLowerCase().includes(q)}
function pretty(v=''){return String(v).replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}
function esc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function link(url=''){return /^https?:\/\//i.test(String(url))?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`:esc(url)}
function formatDate(v){if(!v)return'';const d=new Date(v);return Number.isNaN(d.getTime())?v:d.toLocaleString()}
function formatMoney(amount,currency='usd'){if(typeof amount!=='number')return'';try{return new Intl.NumberFormat('en-US',{style:'currency',currency:String(currency||'usd').toUpperCase()}).format(amount/100)}catch{return`${amount/100} ${currency}`}}
function emptyRow(cols,text){return `<tr class="empty-row"><td colspan="${cols}">${esc(text)}</td></tr>`}

(async()=>{
  try{
    const session=await api('/api/admin/session'); currentUser=session.username||'admin';
    if(session.authenticated){showDashboard();const hash=location.hash.slice(1);switchView(['leads','orders','clients','autonomos','activity','settings'].includes(hash)?hash:'overview');await loadDashboard()}else showLogin();
  }catch{showLogin()}
})();

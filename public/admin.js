const el = (s) => document.querySelector(s);
const els = (s) => [...document.querySelectorAll(s)];
const loginView = el('#login-view');
const dashboardView = el('#dashboard-view');
const loginForm = el('#admin-login-form');
const loginStatus = el('#login-status');
const editDialog = el('#edit-dialog');

let data = { counts:{}, previews:[], orders:[], clients:[], events:[], settings:{}, system:{} };
let currentUser = '';

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
function showDashboard(){ loginView.hidden=true; dashboardView.hidden=false; el('#admin-user').textContent=currentUser; startAutoRefresh(); }
function showLogin(){ dashboardView.hidden=true; loginView.hidden=false; }
function switchView(name){
  els('.admin-tab').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  els('.admin-view').forEach(p=>p.classList.toggle('active',p.dataset.panel===name));
  // Assigning the hash fires hashchange, whose handler calls switchView again. Harmless but
  // real re-entry on every tab click; skip the write when the hash already says this view.
  const next = name === 'overview' ? '' : name;
  if ((location.hash.slice(1) || '') !== next) location.hash = next;
}
els('.admin-tab').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1)||'overview';if(els('.admin-tab').some(b=>b.dataset.view===view))switchView(view);});
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

// A failed refresh used to be swallowed to the console: the panels kept rendering the
// previous snapshot with no visible signal, which is indistinguishable from data that
// never updates. Every load now reports when it last succeeded, or why it did not.
let loadInFlight=false;
let refreshTimer=null;
function setRefreshStatus(text,isError){
  const node=el('#refresh-status');
  if(!node)return;
  node.textContent=text;
  node.classList.toggle('s-error',Boolean(isError));
}
async function loadDashboard(){
  // Overlapping loads raced and whichever response landed last won, so the view could go
  // backwards. A refresh while one is already running is simply skipped.
  if(loadInFlight)return;
  loadInFlight=true;
  const button=el('#refresh-btn');
  if(button)button.disabled=true;
  try{
    data=await api('/api/admin/dashboard');
    renderAll();
    setRefreshStatus(`Updated ${new Date().toLocaleTimeString()}`,false);
  }catch(err){
    if(String(err.message).includes('Unauthorized')){showLogin();setRefreshStatus('Session expired. Sign in again.',true);}
    else{console.error(err);setRefreshStatus(`Refresh failed at ${new Date().toLocaleTimeString()}: ${err.message}`,true);}
  }finally{
    loadInFlight=false;
    if(button)button.disabled=false;
  }
}
// Refreshes on its own cadence, pauses while the tab is hidden, and refreshes once on return.
function startAutoRefresh(){
  if(refreshTimer)return;
  const every=Math.max(5000,Number(window.QONVEXA_ADMIN_REFRESH_MS||20000));
  refreshTimer=setInterval(()=>{if(!document.hidden&&!dashboardView.hidden)loadDashboard();},every);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!dashboardView.hidden)loadDashboard();});
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
    ['Payment method',Boolean(data.system.manualPaymentConfigured)],
    ['Persistent storage',data.system.persistentStorage],
    ['Domain email',data.system.domainEmailConfigured],
    ['Notification automation',data.system.notificationWebhookConfigured]
  ];
  el('#system-readiness').innerHTML=items.map(([label,ok])=>`<article><i class="${ok?'ready-dot':'todo-dot'}"></i><div><b>${esc(label)}</b><span>${ok?'Configured':'Needs setup'}</span></div></article>`).join('');
}

const RENDER_BY_TARGET={leads:renderLeads,orders:renderOrders,clients:renderClients};
els('.table-search,.status-filter').forEach(x=>x.addEventListener('input',()=>{
  // Typing in the leads box used to rebuild orders and clients too, discarding their
  // scroll position and any hover state on every keystroke.
  const render=RENDER_BY_TARGET[x.dataset.target];
  if(render)render(); else {renderLeads();renderOrders();renderClients();}
}));
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
function matches(item,q){
  if(!q)return true;
  const haystack=[];
  const walk=(value,depth)=>{
    if(value===null||value===undefined||depth>2)return;
    if(Array.isArray(value)){for(const entry of value)walk(entry,depth+1);return;}
    if(typeof value==='object'){for(const entry of Object.values(value))walk(entry,depth+1);return;}
    if(typeof value==='function')return;
    haystack.push(String(value));
  };
  walk(item,0);
  return haystack.join(' ').toLowerCase().includes(q);
}
// Interpolated straight into innerHTML in six places. Every value that reaches it today is
// set by the server or checked against an allowlist, so nothing is exploitable now -- but a
// helper that looks like a formatter and behaves like an HTML sink is a trap for whoever adds
// the next field. It only ever produces display text, so escaping costs nothing.
function formatDuration(ms){const m=Math.floor(ms/60000);if(m<1)return'<1m';const d=Math.floor(m/1440),h=Math.floor((m%1440)/60),mm=m%60;const parts=[];if(d)parts.push(`${d}d`);if(h)parts.push(`${h}h`);if(!d&&mm)parts.push(`${mm}m`);return parts.join(' ')||'<1m'}
function emptyRow(cols,text){return `<tr class="empty-row"><td colspan="${cols}">${esc(text)}</td></tr>`}

(async()=>{
  try{
    const session=await api('/api/admin/session'); currentUser=session.username||'admin';
    if(session.authenticated){
      showDashboard();const hash=location.hash.slice(1);switchView(['leads','orders','clients','activity','settings'].includes(hash)?hash:'overview');await loadDashboard();
          }else showLogin();
  }catch{showLogin()}
})();

document.addEventListener('marketplace-updated',loadDashboard);


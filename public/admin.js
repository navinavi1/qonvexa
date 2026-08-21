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
    <td><button class="status-button s-${esc(x.status)}" data-edit="lead" data-id="${esc(x.id)}">${pretty(x.status)}</button></td>
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
    settingRow('Notification webhook',data.system.notificationWebhookConfigured?'Configured':'Not configured',data.system.notificationWebhookConfigured),
    settingRow('Domain email',data.system.domainEmailConfigured?'Configured':'Not configured',data.system.domainEmailConfigured),
    settingRow('Storage',data.system.storageDir?'Configured':'Not configured',Boolean(data.system.storageDir))
  ].join('');
}
function settingRow(label,value,ok){return `<div class="system-row"><span>${esc(label)}</span><b>${esc(value)}</b>${typeof ok==='boolean'?`<i class="${ok?'ok':'warn'}">${ok?'READY':'TODO'}</i>`:''}</div>`}
function renderReadiness(){
  const items=[
    ['Payment method',Boolean(data.system.stripeConfigured || data.system.manualPaymentConfigured)],
    ['Persistent storage path',Boolean(data.system.storageDir)],
    ['Domain email',data.system.domainEmailConfigured],
    ['Notification automation',data.system.notificationWebhookConfigured]
  ];
  el('#system-readiness').innerHTML=items.map(([label,ok])=>`<article><i class="${ok?'ready-dot':'todo-dot'}"></i><div><b>${esc(label)}</b><span>${ok?'Configured':'Needs setup'}</span></div></article>`).join('');
}

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
    await api(`/api/admin/${type==='lead'?'leads':'orders'}/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({status:f.elements.status.value,adminNote:f.elements.adminNote.value})});
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
    if(session.authenticated){showDashboard();const hash=location.hash.slice(1);switchView(['leads','orders','clients','activity','settings'].includes(hash)?hash:'overview');await loadDashboard()}else showLogin();
  }catch{showLogin()}
})();
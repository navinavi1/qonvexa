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
let autonomosJobTab = 'ready';

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
    let autonomosError='';
    try{autonomosData=await api('/api/admin/autonomos')}
    catch(err){autonomosError=err.message;console.error('AutonomOS dashboard:',err);autonomosData=null}
    renderAll();
    setRefreshStatus(autonomosError
      ?`Updated ${new Date().toLocaleTimeString()} · AutonomOS panel unavailable: ${autonomosError}`
      :`Updated ${new Date().toLocaleTimeString()}`,Boolean(autonomosError));
  }catch(err){
    if(String(err.message).includes('Unauthorized')){showLogin();setRefreshStatus('Session expired. Sign in again.',true);}
    else{console.error(err);setRefreshStatus(`Refresh failed at ${new Date().toLocaleTimeString()}: ${err.message}`,true);}
  }finally{
    loadInFlight=false;
    if(button)button.disabled=false;
  }
}
// Mission Control had no timer of its own: the only thing refreshing it was marketplaces.js
// synthesising a click on the Refresh button every 10s. This owns its own cadence, pauses
// while the tab is hidden, and refreshes once on return.
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
  window.renderNewMarketplaces?.(a.newMarketplaces);
  const status=a.runtime?.status||'stopped';
  const badge=el('#autonomos-runtime-badge');
  if(badge){badge.textContent=pretty(status);badge.className=`autonomos-badge ${esc(status)}`}
  const treasuryUsdc=Number(a.treasury?.usdc||0);
  setText('#auto-treasury',a.treasury?.ok?`${treasuryUsdc.toFixed(4)}`:'—');
  setText('#auto-net',usd(a.metrics?.netProfitUsd));
  { const diag=el('#auto-net-diag'); if(diag){ const n=Number(a.metrics?.costEntriesCount||0); const last=a.metrics?.lastCostEntryAt; diag.textContent=n?`${n} cost entries${formatDate(last)?` · last ${formatDate(last)}`:''}`:'no cost entries recorded yet'; } }
  const registry=a.runtime?.jobRegistry||a.jobRegistry||{};
  const registrySummary=registry.summary||{};
  setText('#auto-ready',String(registrySummary.ready??0));
  setText('#auto-policy-hold',String(registrySummary.policyHold??0));
  setText('#auto-agents',String(a.runtime?.taskAgents?.active??0));
  setText('#auto-opportunities',String(a.metrics?.opportunitiesFound??0));
  setText('#auto-claimed',String(a.metrics?.claimedJobs??0));
  setText('#auto-delivered',String(registrySummary.delivered??a.metrics?.deliveredJobs??0));
  setText('#auto-paid',String(registrySummary.paid??a.metrics?.paidJobs??0));
  renderAutonomosJobQueue(a);
  const funnel=el('#autonomos-funnel');
  if(funnel){const f=a.runtime?.marketFunnel||{};funnel.innerHTML=[['Raw jobs',f.rawSignals],['Priced',f.pricedJobs??f.paidJobs],['≥ Floor',f.aboveFloor],['Executable',f.executable],['Profitable',f.profitable],['Claimable',f.claimable],['Ready',f.ready??registrySummary.ready]].map(([label,value])=>`<span><b>${Number(value||0)}</b>${esc(label)}</span>`).join('')}
  if(a.business){const b=a.business,c=b.counts||{};if(funnel)funnel.innerHTML=[['Знайдено',c.discovered],['Маршрут',c.routable],['Придатні',c.eligible],['Заявки',c.applications],['Прийнято',c.accepted],['Виконуються',c.executing],['QA',c.qa],['Правки',c.revisions],['Доставлено',c.delivered],['Схвалено клієнтом',c.clientAccepted],['Очікують оплату',c.payoutPending],['Оплачено',c.paid]].map(([label,value])=>`<span><b>${Number(value||0)}</b>${esc(label)}</span>`).join('');setText('#auto-opportunities',String(c.discovered||0));setText('#auto-claimed',String(c.accepted||0));setText('#auto-delivered',String(c.delivered||0));setText('#auto-paid',String(c.paid||0));setText('#auto-agents',String(b.workforce?.active||0));}
  const businessMoney=el('#autonomos-business-money');if(businessMoney&&a.business){const m=a.business.money||{};businessMoney.innerHTML=[['Дохід за весь час',m.grossRevenueUsd],['Очікується оплата',m.pendingPayoutUsd],['Витрати',m.costUsd],['Комісії',m.feesUsd],['Чистий результат',m.netProfitUsd],['Надійшло у крипто',m.cryptoRevenueUsd]].map(([label,value])=>`<span><b>${usd(value)}</b>${esc(label)}</span>`).join('');}
  const startButton=el('#autonomos-start'),stopButton=el('#autonomos-stop');
  if(startButton){startButton.disabled=['running','working'].includes(status);startButton.textContent=['running','working'].includes(status)?'✓ Running':'▶ Start 24/7';}
  if(stopButton)stopButton.disabled=!['running','working'].includes(status);
  const llmState=a.runtime?.llm||{};


  const radar=el('#autonomos-market-radar');
  if(radar){ const m=a.runtime?.marketSummary||{}; const f=a.runtime?.marketFunnel||{}; const cp=a.runtime?.commissioningProof||{}; const er=a.runtime?.earningReadiness||{}; const health=a.runtime?.connectorHealth||{}; const defs=new Map((a.connectors||[]).map(x=>[x.id,x])); const yieldBySource=new Map((a.runtime?.marketplaceYield||[]).map(x=>[x.source,x])); const blockers=Object.entries(f.blockers||{}).sort((a,b)=>b[1]-a[1]);const erClass=er.severity==='critical'?'s-error':er.severity==='ready'?'s-ready':er.severity==='working'?'s-in_progress':'s-warning';radar.innerHTML=`<article class="autonomos-event"><div class="event-row"><b>Why AutonomOS is / is not earning now</b><span class="status ${erClass}">${esc(pretty(er.code||'waiting_for_scan'))}</span></div><p><b>${esc(er.headline||'Waiting for first market scan')}</b></p><p>${esc(er.detail||'Mission Control will name the single primary operational reason after the next cycle.')}</p>${er.action?`<p class="job-fail-reason">Next: ${esc(er.action)}</p>`:''}${er.primaryBlocker?`<p class="job-fail-reason">Primary blocker: ${esc(pretty(er.primaryBlocker))} · ${Number(er.primaryBlockerCount||0)} job(s)</p>`:''}${Array.isArray(er.fullAutoSources)&&er.fullAutoSources.length?`<p>FULL AUTO sources: ${er.fullAutoSources.map(esc).join(' · ')}</p>`:''}</article><article class="autonomos-event"><div class="event-row"><b>Latest scan funnel</b><span class="status ${Number(f.ready||0)>0?'s-ready':'s-warning'}">${Number(f.ready||0)} ready</span></div><p>${Number(f.rawSignals??m.observed??0)} raw jobs → ${Number(f.pricedJobs??f.paidJobs??m.paidJobs??0)} priced → ${Number(f.aboveFloor||0)} ≥ floor → ${Number(f.executable??m.executable??0)} executable → ${Number(f.profitable??m.profitable??0)} profitable → ${Number(f.claimable||0)} claimable → ${Number(f.ready||0)} ready</p>${blockers.length?`<p class="job-fail-reason">Top blockers: ${blockers.slice(0,5).map(([k,v])=>`${esc(pretty(k))} ${Number(v)}`).join(' · ')}</p>`:''}</article><article class="autonomos-event"><div class="event-row"><b>Commissioning proof</b><span class="status ${String(cp.status||'').startsWith('proved_')?'s-ready':cp.ready>0?'s-ready':'s-warning'}">${esc(pretty(cp.status||'waiting_for_job'))}</span></div><p>Crypto canary floor ${usd(cp.floorUsd||0.5)} · ${Number(cp.eligibleSeen||0)} eligible seen · ${Number(cp.ready||0)} ready · ${Number(cp.delivered||0)} delivered · ${Number(cp.paid||0)} marketplace paid · ${Number(cp.ownerWalletPaid||0)} owner-wallet paid · ${Number(cp.withdrawalPending||0)} withdrawal pending</p>${cp.lastPayoutTruth?`<p class="job-fail-reason">Last payout: ${esc(pretty(cp.lastPayoutTruth.fundsLocation||'unknown'))} · ${cp.lastPayoutTruth.ownerWalletReached?'owner wallet reached':cp.lastPayoutTruth.withdrawalRequired?'withdrawal required':'custody unverified'}${cp.lastPayoutTruth.address?` · ${esc(String(cp.lastPayoutTruth.address).slice(0,22))}`:''}</p>`:''}${Object.keys(cp.blockers||{}).length?`<p class="job-fail-reason">Canary blockers: ${Object.entries(cp.blockers).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>`${esc(pretty(k))} ${Number(v)}`).join(' · ')}</p>`:''}</article>`+Object.entries(health).filter(([name])=>Boolean(name)).map(([name,h])=>{const def=defs.get(name)||{};const y=yieldBySource.get(name)||{};const disabled=Boolean(h?.disabled)||/discovery_only|watch/i.test(String(h?.mode||def.mode||''));const configuredStatus=String(def.status||'');const lifecycle=def.lifecycle||a.runtime?.marketplaceLifecycle?.[name]||null;const lifecycleIncomplete=lifecycle&&lifecycle.discover===true&&lifecycle.autoReady===false;const baseStatus=!h?.ok?'Unavailable':disabled?'Watch only':configuredStatus==='certification_check_required'?'Certification required':configuredStatus==='needs_credentials'||def.missing?.length?'Needs credentials':configuredStatus==='connect_required'?'Connect required':configuredStatus==='discovery_ready_claim_gated'||lifecycleIncomplete?'Discovery only':lifecycle?.fullAutoReady?'FULL AUTO':lifecycle?.workAutoReady?'Auto work · cashout action':'Ready';const statusLabel=baseStatus;const cls=statusLabel==='FULL AUTO'||statusLabel==='Ready'?'ready':statusLabel==='Unavailable'?'needs_credentials':'optional';const cashout=lifecycle?.cashoutState?` · cashout ${esc(pretty(lifecycle.cashoutState))}`:'';return `<article class="autonomos-event"><div class="event-row"><b>${esc(def.name||pretty(name))}</b><span class="connector-${cls}">${esc(statusLabel)}</span></div><p>${esc(def.kind||'market')} · ${esc(h?.mode||def.mode||'')} · ${Number(y.signals??h?.count??0)} signals · ${Number(y.ready||0)} ready · ${Number(y.paidCount||0)} paid · net ${usd(y.netUsd||0)}${cashout}</p>${lifecycle?.cashoutReason&&statusLabel==='Auto work · cashout action'?`<p class="job-fail-reason">${esc(pretty(lifecycle.cashoutReason))}</p>`:''}</article>`}).join(''); }

  const candidacy=el('#autonomos-candidacy');
  if(candidacy){
    // P1 fix: this used to show the first 30 opportunities regardless of source. Since
    // discovery runs x402-bazaar first and it alone returns ~50 signals, those 30 slots
    // were always 100% x402-bazaar (an API-buying price feed, not a job we can earn from —
    // it's correctly excluded from auto-claim) which buried the real Clawlancer/Dealwork/
    const rows=(a.runtime?.opportunityEconomics||[]).filter(x=>['clawlancer','dealwork','workprotocol'].includes(x.source));
    candidacy.innerHTML=rows.slice(0,30).map(x=>{
      const isCandidate=x.candidacy?.isCandidate;
      const reasons=(x.candidacy?.reasons||[]);
      return `<article class="autonomos-event"><div class="event-row"><b>${esc(x.title||x.externalId||'Untitled')}</b><span class="status ${isCandidate?'s-ready':'s-error'}">${isCandidate?'Would auto-claim':'Blocked'}</span></div><p>${esc(pretty(x.source))} · ${usd(x.budgetUsd)}${reasons.length?` · <span class="job-fail-reason">${esc(reasons.join(' · '))}</span>`:''}</p></article>`;
    }).join('')||emptyCard('No current earning opportunities observed yet this cycle');
  }

  // runtime.incidents is sent on every snapshot (runtime.js buildIncidents) and had no
  // renderer, so the "Needs attention" panel was permanently blank.


  const wallet=el('#autonomos-wallet');
  if(wallet){
    const assets=(a.treasury?.assets||[]).filter(x=>Number(x.balance||0)>0).slice(0,12).map(x=>`${x.network}: ${Number(x.balance||0).toFixed(6)} ${x.symbol}`).join(' · ');
    // "No non-zero balances" and "the RPC did not answer" used to render identically, so a
    // broken lookup looked exactly like an empty wallet.
    const unavailable=Array.isArray(a.treasury?.unavailable)?a.treasury.unavailable:[];
    const incomplete=a.treasury?.balancesComplete===false||unavailable.length>0;
    const detail=!a.treasury?.ok
      ?`Balance check: ${esc(a.treasury?.error||'not checked yet')}`
      :`${esc(assets||(incomplete?'Balances unavailable':'No non-zero EVM balances detected'))} · checked ${esc(formatDate(a.treasury.checkedAt))}${incomplete?` · <i class="s-error">unavailable: ${esc(unavailable.map(x=>x.network||x.symbol||'chain').join(', '))}</i>`:''}`;
    wallet.innerHTML=`<b>${esc(a.treasury?.ownerWallet||'Not configured')}</b><span>${detail}</span>`;
  }
  const allocations=el('#autonomos-allocations');
  if(allocations){
    const al=a.treasury?.allocations||{};
    allocations.innerHTML=[['Reserve',al.reserveUsd],['Growth',al.growthUsd],['Experiments',al.experimentUsd],['Earned spend budget',a.runtime?.earnedSpendBudgetUsd]].map(([k,v])=>`<article><small>${esc(k.toUpperCase())}</small><b>${usd(v)}</b></article>`).join('');
  }

  const form=el('#autonomos-config-form');
  if(form){
    const forced=a.config?.envForced||{};
    for(const [k,v] of Object.entries(a.config||{})){
      const field=form.elements[k];
      if(!field||typeof field.type!=='string')continue;
      if(field.type==='checkbox')field.checked=Boolean(v);else field.value=v??'';
      // A field an environment variable overrules is not editable here: saving it stores a
      // value that normalizeConfig immediately overwrites. Unticking Zero-spend mode did
      // exactly that -- stored false, ran as true -- so the control looked live and changed
      // nothing. Lock it and name the variable that actually decides.
      const hold=forced[k];
      const label=field.closest('label')||field.parentElement;
      field.disabled=Boolean(hold);
      if(label){
        label.classList.toggle('env-locked',Boolean(hold));
        const existing=label.querySelector('.env-lock-note');
        if(existing)existing.remove();
        if(hold){
          const note=document.createElement('small');
          note.className='env-lock-note';
          note.textContent=`set by ${hold.variable}=${hold.value} — change it in Render, not here`;
          label.appendChild(note);
        }
      }
    }
  }






  const missing=el('#autonomos-missing');
  if(missing) missing.innerHTML=(a.missing||[]).map(item=>`<article class="autonomos-event"><div class="event-row"><b>${esc(item.item)}</b><span class="connector-needs_credentials">${esc(pretty(item.status))}</span></div><p>${esc(item.detail)}</p></article>`).join('')||'<p class="empty-state">All configured.</p>';

}
function renderAutonomosJobQueue(a){
  const body=el('#autonomos-job-queue');if(!body)return;
  const queues=(a.runtime?.jobRegistry||a.jobRegistry||{}).queues||{};
  let rows=[];
  if(autonomosJobTab==='ready')rows=(queues.new||[]).filter(x=>x.status==='ready');
  else if(autonomosJobTab==='new')rows=(queues.new||[]).filter(x=>x.status==='new');
  else rows=queues[autonomosJobTab]||[];
  const query=String(el('#autonomos-job-search')?.value||'').trim().toLowerCase();
  if(query)rows=rows.filter(row=>[row.title,row.externalId,row.source,row.reason,row.reasonCode,row.status,row.claimMode].some(v=>String(v||'').toLowerCase().includes(query)));
  body.innerHTML=rows.slice(0,50).map(row=>`<tr class="autonomos-job-row" data-job-identity="${esc(row.identity||`${row.source}:${row.externalId}`)}"><td><b>${esc(row.title||row.externalId||'Untitled')}</b><small>${esc(row.externalId||'')}</small></td><td>${esc(pretty(row.source||''))}</td><td>${usd(row.budgetUsd)} <small>${esc(row.currency||'')}</small></td><td><span class="autonomos-mode">${esc(pretty(row.claimMode||'unknown'))}</span></td><td><span class="status ${row.status==='graveyard'?'s-error':row.status==='stale_check'||row.status==='archived'||row.status==='policy_hold'||row.status==='not_eligible'||row.status==='system_blocked'||row.status==='capability_hold'||row.status==='manual_attention'?'s-warning':row.status==='retry'?'s-in_progress':'s-ready'}">${esc(pretty(row.status||'new'))}</span></td><td><small>${esc(formatDate(row.firstSeenAt||row.lastSeenAt))}${row.deadline?`<br>Due ${esc(formatDate(row.deadline))}`:''}</small></td><td><small class="${row.status==='graveyard'?'job-fail-reason':''}">${esc(row.reason||row.reasonCode||'—')}</small></td></tr>`).join('')||`<tr><td colspan="7" class="empty-state">No jobs in ${esc(pretty(autonomosJobTab))}.</td></tr>`;
}
function openAutonomosJobDetail(identity){
  const dialog=el('#autonomos-job-dialog'),body=el('#autonomos-job-dialog-body');if(!dialog||!body)return;
  const registry=autonomosData?.runtime?.jobRegistry||autonomosData?.jobRegistry||{};
  const rows=Object.values(registry.queues||{}).flat();
  const row=rows.find(x=>String(x.identity||`${x.source}:${x.externalId}`)===String(identity));if(!row)return;
  const history=(autonomosData?.jobs||[]).filter(j=>`${j.source}:${j.externalId}`===identity).sort((a,b)=>Date.parse(a.at||a.startedAt||0)-Date.parse(b.at||b.startedAt||0));
  const active=(autonomosData?.runtime?.activeJobs||[]).find(j=>`${j.source}:${j.externalId}`===identity);
  setText('#autonomos-job-dialog-title',row.title||row.externalId||'Job detail');
  const fields=[['Identity',identity],['Market',pretty(row.source)],['Payout',`${usd(row.budgetUsd)} ${row.currency||''}`],['Mode',pretty(row.claimMode||'')],['Status',pretty(row.status||'')],['Failure owner',pretty(row.failureOwner||'—')],['Reason',row.reason||row.reasonCode||'—'],['First seen',formatDate(row.firstSeenAt)],['Last seen',formatDate(row.lastSeenAt)],['Deadline',formatDate(row.deadline)],['Active agent',active?.workerId||'—'],['ETA',formatDate(active?.etaAt)]];
  body.innerHTML=`<div class="autonomos-job-detail-grid">${fields.map(([k,v])=>`<article><small>${esc(k)}</small><b>${esc(v||'—')}</b></article>`).join('')}</div><h3>State history</h3><div class="autonomos-event-list">${history.map(h=>`<article class="autonomos-event"><div class="event-row"><b>${esc(pretty(h.status||'event'))}</b><small>${esc(formatDate(h.at||h.startedAt))}</small></div><p>${esc(h.error||h.reason||h.transactionId||'')}</p></article>`).join('')||emptyCard('No historical state rows.')}</div>`;
  dialog.showModal();
}

function jobProgress(job){
  const start=Date.parse(job?.startedAt||0),eta=Date.parse(job?.etaAt||0);if(!start||!eta||eta<=start)return 5;
  return Math.max(3,Math.min(98,Math.round(((Date.now()-start)/(eta-start))*100)));
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
el('#autonomos-retry-transient')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/retry-transient','Releasing transient retries…'));
el('#autonomos-inspect-blockers')?.addEventListener('click',()=>{el('#autonomos-market-radar')?.scrollIntoView({behavior:'smooth',block:'center'});});
el('#autonomos-live-self-test')?.addEventListener('click',async()=>{
  const badge=el('#autonomos-runtime-badge');if(badge)badge.textContent='Live self-test…';
  try{const result=await api('/api/admin/autonomos/live-self-test',{method:'POST',body:'{}'});alert(`Live self-test: ${result.autonomousReady?'AUTONOMOUS RAIL READY':result.ok?'DISCOVERY ONLY / SETUP NEEDED':'ATTENTION'}\nSignals: ${Number(result.signals||0)}\nClaim-ready crypto sources: ${(result.claimReadySources||[]).join(', ')||'none'}\nCurrent Ready jobs: ${Number(result.currentReadyJobs||0)}\nNo claims were performed.`);await loadDashboard()}catch(err){if(badge)badge.textContent=err.message}
});
el('#autonomos-reconcile-payments')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/reconcile-payments','Reconciling payments…'));

// These four had no listener at all. Emergency stop — the kill switch — did nothing when
// pressed, and there was no way to clear it again from the interface once it was set.
el('#autonomos-emergency')?.addEventListener('click',()=>{
  if(!confirm('Emergency stop halts the runtime, aborts running jobs and blocks all spending. Continue?'))return;
  autonomosCommand('/api/admin/autonomos/emergency-stop','Emergency stop…').catch(()=>{});
});
el('#autonomos-clear-emergency')?.addEventListener('click',()=>{
  if(!confirm('Clear the emergency latch? The runtime stays paused until you press Start.'))return;
  autonomosCommand('/api/admin/autonomos/clear-emergency','Clearing emergency latch…').catch(()=>{});
});
el('#autonomos-reset-claim-history')?.addEventListener('click',()=>{
  if(!confirm('Clear transient claim retry timers? Permanent graveyard entries stay blocked.'))return;
  autonomosCommand('/api/admin/autonomos/reset-claim-history','Clearing retry timers…').catch(()=>{});
});
el('#autonomos-archive-legacy')?.addEventListener('click',async()=>{
  if(!confirm('Retire job rows from marketplaces you no longer work? Financial history is untouched.'))return;
  const status=el('#autonomos-maintenance-status');
  if(status)status.textContent='Archiving…';
  try{
    const result=await api('/api/admin/autonomos/archive-legacy-history',{method:'POST',body:'{}'});
    if(status)status.textContent=`Archived ${Number(result.archived?.length||0)} registry rows and ${Number(result.inFlightRetired||0)} in-flight jobs. Ledger untouched.`;
    await loadDashboard();
  }catch(err){ if(status)status.textContent=err.message; }
});
// Records working capital the owner provided, so the agents' spend pool can leave zero.
el('#autonomos-fund-treasury')?.addEventListener('click',async(event)=>{
  // Each call records a separate funding row on purpose — an owner can top up twice — so a
  // double click would book the amount twice. Hold the button for the round trip.
  const button=event.currentTarget;
  if(button.disabled)return;
  const raw=prompt('Record working capital for the agent treasury, in USD.\nThis writes an auditable owner_funding row; it does not move money.');
  if(raw===null)return;
  const amountUsd=Number(raw);
  const status=el('#refresh-status');
  if(!Number.isFinite(amountUsd)||amountUsd<=0){ if(status)status.textContent='Enter a positive amount in USD.'; return; }
  button.disabled=true;
  if(status)status.textContent='Recording…';
  try{
    // One id per click, so a retry of this exact request cannot book the amount twice.
    const requestId=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random());
    const result=await api('/api/admin/autonomos/treasury/fund',{method:'POST',body:JSON.stringify({amountUsd,note:'Recorded from admin dashboard',requestId})});
    // After the refresh, not before: loadDashboard() rewrites this line with its own
    // "Updated ..." stamp and the result would never be readable.
    await loadDashboard();
    if(status)status.textContent=`Agent spend pool is now $${Number(result.availableUsd||0).toFixed(2)}.`;
  }catch(err){ if(status)status.textContent=err.message; }
  finally{ button.disabled=false; }
});
els('.autonomos-queue-tab').forEach(button=>button.addEventListener('click',()=>{autonomosJobTab=button.dataset.jobTab||'ready';els('.autonomos-queue-tab').forEach(x=>x.classList.toggle('active',x===button));if(autonomosData)renderAutonomosJobQueue(autonomosData)}));
el('#autonomos-job-search')?.addEventListener('input',()=>{if(autonomosData)renderAutonomosJobQueue(autonomosData)});
el('#autonomos-job-dialog-close')?.addEventListener('click',()=>el('#autonomos-job-dialog')?.close());
el('#autonomos-refresh-wallet')?.addEventListener('click',()=>autonomosCommand('/api/admin/autonomos/treasury/refresh','Checking wallet…'));
el('#autonomos-config-form')?.addEventListener('submit',async e=>{
  e.preventDefault();const f=e.currentTarget;const status=el('#autonomos-config-status');status.textContent='Saving…';
  const raw=Object.fromEntries(new FormData(f).entries());
  // reservePercent and growthPercent are derived server-side from the owner/agent split;
  // sending them back only invited the round trip that made them look editable.
  delete raw.reservePercent; delete raw.growthPercent;
  // Fields the environment holds are rendered disabled, but the checkbox values below are read
  // off f.elements directly, so a disabled control still travelled in the payload. The server
  // then stored what was sent and normalizeConfig overrode it from the environment a moment
  // later -- so config.json disagreed with what actually ran, which is the exact confusion the
  // disabled state exists to end. Do not send what we already know will be ignored.
  const envHeld=new Set(Object.keys(autonomosData?.config?.envForced||{}));
  const payload={...raw,autoReplication:f.elements.autoReplication.checked,autoClaimJobs:f.elements.autoClaimJobs.checked,autoCompetitiveSubmissions:f.elements.autoCompetitiveSubmissions.checked,commissioningMode:f.elements.commissioningMode.checked,cryptoOnlyEarnings:f.elements.cryptoOnlyEarnings.checked,requireEscrowForAutoClaim:f.elements.requireEscrowForAutoClaim.checked,rejectDemoAndTestJobs:f.elements.rejectDemoAndTestJobs.checked,zeroSpendMode:f.elements.zeroSpendMode.checked,earnedFundsOnly:f.elements.earnedFundsOnly.checked,allowExternalSpending:f.elements.allowExternalSpending.checked};
  // Only coerce fields the form actually submitted. experimentPercent,
  // maxApiCostPercentOfPayout and commissioningMinPayoutUsd have no inputs, so
  // Number(undefined) produced NaN, JSON.stringify turned it into null, and
  // normalizeConfig read Number(null) as a valid 0 — every save quietly zeroed them.
  // clawlancerMinJobPayoutUsd/dealworkMinJobPayoutUsd are not accepted by updateConfig
  // at all and were silently discarded while the UI reported success.
  for(const key of ['heartbeatSeconds','fastClaimPollSeconds','minMarginPercent','maxChildren','maxJobsPerCycle','minJobPayoutUsd','seedSpendBudgetUsd','maxPaidProcurementUsd']){
    if(!(key in raw)||String(raw[key]).trim()==='')  { delete payload[key]; continue; }
    const value=Number(raw[key]);
    if(Number.isFinite(value))payload[key]=value; else delete payload[key];
  }
  for(const key of envHeld) delete payload[key];
  try{await api('/api/admin/autonomos/config',{method:'PATCH',body:JSON.stringify(payload)});status.textContent='Saved.';await loadDashboard()}catch(err){status.textContent=err.message}
});

const RENDER_BY_TARGET={leads:renderLeads,orders:renderOrders,clients:renderClients};
els('.table-search,.status-filter').forEach(x=>x.addEventListener('input',()=>{
  // Typing in the leads box used to rebuild orders and clients too, discarding their
  // scroll position and any hover state on every keystroke.
  const render=RENDER_BY_TARGET[x.dataset.target];
  if(render)render(); else {renderLeads();renderOrders();renderClients();}
}));
document.addEventListener('click',e=>{
  const row=e.target.closest('.autonomos-job-row');
  if(row&&autonomosData){openAutonomosJobDetail(row.dataset.jobIdentity);return;}
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
function pretty(v=''){return String(v).replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}
function esc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function link(url=''){return /^https?:\/\//i.test(String(url))?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`:esc(url)}
function formatDate(v){if(!v)return'';const d=new Date(v);return Number.isNaN(d.getTime())?v:d.toLocaleString()}
function formatDuration(ms){const m=Math.floor(ms/60000);if(m<1)return'<1m';const d=Math.floor(m/1440),h=Math.floor((m%1440)/60),mm=m%60;const parts=[];if(d)parts.push(`${d}d`);if(h)parts.push(`${h}h`);if(!d&&mm)parts.push(`${mm}m`);return parts.join(' ')||'<1m'}
function formatMoney(amount,currency='usd'){if(typeof amount!=='number')return'';try{return new Intl.NumberFormat('en-US',{style:'currency',currency:String(currency||'usd').toUpperCase()}).format(amount/100)}catch{return`${amount/100} ${currency}`}}
function emptyRow(cols,text){return `<tr class="empty-row"><td colspan="${cols}">${esc(text)}</td></tr>`}

(async()=>{
  try{
    const session=await api('/api/admin/session'); currentUser=session.username||'admin';
    if(session.authenticated){
      showDashboard();const hash=location.hash.slice(1);switchView(['leads','orders','clients','autonomos','activity','settings'].includes(hash)?hash:'overview');await loadDashboard();
          }else showLogin();
  }catch{showLogin()}
})();

document.addEventListener('marketplace-updated',loadDashboard);


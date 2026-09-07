// Owner-facing AutonomOS work pipeline.
// Legacy per-market controls are intentionally hidden: the worldwide feed is the source of
// truth for discovery, applications, accepted work, delivery and paid outcomes.
let globalFeedData={rows:[],counts:{},actioner:{},generatedAt:''};
let globalFeedFilter='live';

function htmlEsc(v){return String(v??'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':'&quot;',"'":"&#39;"})[c]);}
function time(v){const n=Date.parse(String(v||''));return Number.isFinite(n)?n:0;}
function statusLabel(row){
  const s=String(row?.status||row?.bucket||'').toLowerCase();
  if(['applied','applied_email'].includes(s))return'Заявку відправлено';
  if(s==='email_rate_limited')return'У черзі на подачу';
  if(['accepted','accepted_email'].includes(s))return'Прийнято';
  if(['accepted_waiting_treasury'].includes(s))return'Прийнято · резерв бюджету';
  if(['accepted_needs_capability'].includes(s))return'Прийнято · готується інструмент';
  if(['executing','executing_email','delivery_email_in_progress'].includes(s))return'Виконується';
  if(['submitted','submitted_email'].includes(s))return'Здано';
  if(s==='paid')return'Оплачено';
  if(s==='payout_unverified')return'Ціна не підтверджена';
  if(s==='needs_capability')return'Готується можливість';
  if(s==='no_direct_route')return'Немає каналу подачі';
  if(['new','ready',''].includes(s))return'Знайдено';
  return s.replaceAll('_',' ');
}
function rowTime(row,filter){
  if(filter==='applied')return time(row.appliedAt||row.lastSeenAt||row.firstSeenAt);
  if(filter==='working')return time(row.acceptedAt||row.lastSeenAt||row.firstSeenAt);
  if(filter==='done'||filter==='paid')return time(row.submittedAt||row.lastSeenAt||row.firstSeenAt);
  // Main list stays stable: repeated scans do not move old jobs back to the top.
  return time(row.firstSeenAt||row.appliedAt||row.lastSeenAt);
}
function isActive(row){return row?.bucket!=='archive';}
function availableCount(rows){return rows.filter(r=>['new','ready'].includes(String(r.bucket||''))||String(r.status||'')==='email_rate_limited').length;}

function ensureGlobalFeedPanel(){
  const legacy=document.querySelector('.autonomos-command-panel');
  if(!legacy)return;
  legacy.style.display='none';
  document.querySelector('.autonomos-t2000-card')?.style.setProperty('display','none');
  const legacyMarkets=document.querySelector('section[aria-label="AgentHansa and TaskBounty"]');
  if(legacyMarkets)legacyMarkets.style.display='none';
  if(document.getElementById('autonomos-global-work-feed'))return;

  const panel=document.createElement('section');
  panel.id='autonomos-global-work-feed';
  panel.className='admin-panel autonomos-panel global-work-feed';
  const tabs=[
    ['live','Усі активні'],
    ['applied','Подано'],
    ['working','В роботі'],
    ['done','Здано'],
    ['paid','Оплачено'],
    ['archive','Архів']
  ];
  panel.innerHTML=`
    <div class="admin-panel-head">
      <div><small>ПО ВСЬОМУ СВІТУ · НАЖИВО</small><h2>Усі вакансії</h2><p class="settings-note">Нові роботи завжди зверху. Одна вакансія — одна заявка. Відхилені, застарілі та непридатні записи не повертаються в чергу агентів.</p></div>
      <div id="global-feed-meta"></div>
    </div>
    <div id="global-feed-summary" class="global-feed-summary"></div>
    <div class="global-feed-tabs" role="tablist">${tabs.map(([k,l])=>`<button class="admin-secondary global-feed-tab${k==='live'?' active':''}" data-global-feed="${k}" type="button">${l} <b data-global-count="${k}">0</b></button>`).join('')}</div>
    <div class="autonomos-job-toolbar"><input id="global-feed-search" type="search" placeholder="Шукати роботу, джерело або категорію…"></div>
    <div class="autonomos-job-table-wrap"><table class="autonomos-job-table"><thead><tr><th>Робота</th><th>Джерело</th><th>Категорія</th><th>Виплата</th><th>Статус</th><th>Знайдено / дія</th></tr></thead><tbody id="global-feed-body"></tbody></table></div>`;
  legacy.parentNode.insertBefore(panel,legacy);

  if(!document.getElementById('global-feed-style')){
    const style=document.createElement('style');style.id='global-feed-style';style.textContent=`
      .global-feed-tabs{display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0}
      .global-feed-tab.active{outline:2px solid currentColor}
      .global-feed-tab b{margin-left:.35rem}
      .global-work-feed{border:1px solid rgba(120,140,255,.28)}
      #global-feed-meta{font-size:.82rem;opacity:.8;max-width:390px;text-align:right}
      .global-feed-summary{display:flex;gap:.7rem;flex-wrap:wrap;margin:.75rem 0 1rem}
      .global-feed-summary span{padding:.5rem .75rem;border:1px solid rgba(120,140,255,.22);border-radius:10px;font-size:.82rem}
      .global-feed-summary b{font-size:1rem;margin-left:.35rem}
      .global-feed-archive{opacity:.48}.global-feed-working{font-weight:600}
      .global-feed-applied td:nth-child(5){font-weight:700}
    `;document.head.appendChild(style);
  }
  panel.addEventListener('click',e=>{const b=e.target.closest('[data-global-feed]');if(!b)return;globalFeedFilter=b.dataset.globalFeed;panel.querySelectorAll('.global-feed-tab').forEach(x=>x.classList.toggle('active',x===b));renderGlobalFeed();});
  panel.querySelector('#global-feed-search')?.addEventListener('input',renderGlobalFeed);
}

async function loadGlobalFeed(){
  ensureGlobalFeedPanel();
  try{const r=await fetch(`/autonomos-global-feed.json?t=${Date.now()}`,{cache:'no-store'});if(r.ok)globalFeedData=await r.json();}catch{}
  renderGlobalFeed();
}

function renderGlobalFeed(){
  const body=document.getElementById('global-feed-body');if(!body)return;
  const search=String(document.getElementById('global-feed-search')?.value||'').trim().toLowerCase();
  const rows=Array.isArray(globalFeedData.rows)?globalFeedData.rows:[];
  let visible=rows.filter(row=>{
    if(globalFeedFilter==='live'&&!isActive(row))return false;
    if(globalFeedFilter!=='live'&&row.bucket!==globalFeedFilter)return false;
    if(!search)return true;
    return `${row.title} ${row.source} ${row.category} ${row.status}`.toLowerCase().includes(search);
  });
  visible=visible.sort((a,b)=>rowTime(b,globalFeedFilter)-rowTime(a,globalFeedFilter)||String(a.id||'').localeCompare(String(b.id||''))).slice(0,400);

  body.innerHTML=visible.length?visible.map(row=>{
    const payout=Number(row.amountUsd||0)>0?`$${Number(row.amountUsd).toFixed(2)} ${htmlEsc(row.currency||'')}`:'не підтверджено';
    const when=globalFeedFilter==='applied'&&row.appliedAt?row.appliedAt:globalFeedFilter==='working'&&row.acceptedAt?row.acceptedAt:row.firstSeenAt||row.lastSeenAt;
    return `<tr class="global-feed-${htmlEsc(row.bucket)}"><td>${row.url?`<a href="${htmlEsc(row.url)}" target="_blank" rel="noopener noreferrer">${htmlEsc(row.title)}</a>`:htmlEsc(row.title)}</td><td>${htmlEsc(row.source)}</td><td>${htmlEsc(row.category)}</td><td>${payout}</td><td>${htmlEsc(statusLabel(row))}</td><td>${htmlEsc(when?new Date(when).toLocaleString():'—')}</td></tr>`;
  }).join(''):'<tr><td colspan="6">У цьому розділі поки немає записів.</td></tr>';

  const c=globalFeedData.counts||{};
  const live=rows.filter(isActive).length;
  const applied=Number(c.applied||0);
  const working=Number(c.working||0);
  const done=Number(c.done||0);
  const paid=Number(c.paid||0);
  const archive=Number(c.archive||0);
  for(const node of document.querySelectorAll('[data-global-count]')){
    const key=node.dataset.globalCount;
    node.textContent=key==='live'?live:Number(c[key]||0);
  }
  const summary=document.getElementById('global-feed-summary');
  if(summary)summary.innerHTML=`<span>Доступно до подачі <b>${availableCount(rows)}</b></span><span>Заявок відправлено <b>${applied}</b></span><span>В роботі <b>${working}</b></span><span>Здано <b>${done}</b></span><span>Оплачено <b>${paid}</b></span>`;
  const meta=document.getElementById('global-feed-meta');
  if(meta)meta.textContent=`${rows.length} відстежується · ${live} активних · ${archive} в архіві · оновлено ${globalFeedData.generatedAt?new Date(globalFeedData.generatedAt).toLocaleTimeString():'—'}`;
}

document.addEventListener('DOMContentLoaded',loadGlobalFeed);
setInterval(loadGlobalFeed,10000);

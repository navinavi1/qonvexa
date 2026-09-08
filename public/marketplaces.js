let globalFeedData={rows:[],counts:{},actioner:{},generatedAt:''};
let globalFeedFilter='live';

const LEGACY_SOURCES=new Set(['t2000','superteam','clawjobs','laborx','dework','bountycaster','questbook']);
function htmlEsc(v){return String(v??'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':'&quot;',"'":"&#39;"})[c]);}
function time(v){const n=Date.parse(String(v||''));return Number.isFinite(n)?n:0;}
function sourceId(row){return String(row?.source||'').toLowerCase().replace(/\s+/g,'');}
function isLegacy(row){const s=sourceId(row);return LEGACY_SOURCES.has(s)||s.startsWith('t2000');}
function statusLabel(row){const s=String(row?.status||row?.bucket||'').toLowerCase();if(['applied','applied_email'].includes(s))return'Заявку відправлено';if(s==='email_rate_limited')return'У черзі на подачу';if(['accepted','accepted_email','in_progress','working'].includes(s))return'Прийнято';if(s==='accepted_waiting_treasury')return'Прийнято · резерв бюджету';if(s==='accepted_needs_capability')return'Прийнято · готується інструмент';if(['executing','executing_email','delivery_email_in_progress','preparing','qa'].includes(s))return'Виконується';if(['submitted','submitted_email','delivery_ready'].includes(s))return'Здано';if(['paid','paid_or_approved','completed'].includes(s))return'Оплачено';if(s==='payout_unverified')return'Ціна не підтверджена';if(s==='needs_capability')return'Готується можливість';if(s==='no_direct_route')return'Немає каналу подачі';if(['new','ready',''].includes(s))return'Знайдено';return s.replaceAll('_',' ');}
function rowTime(row,filter){if(filter==='applied')return time(row.appliedAt||row.lastSeenAt||row.firstSeenAt);if(filter==='working')return time(row.acceptedAt||row.updatedAt||row.lastSeenAt||row.firstSeenAt);if(filter==='done'||filter==='paid')return time(row.submittedAt||row.paidAt||row.updatedAt||row.lastSeenAt||row.firstSeenAt);return time(row.firstSeenAt||row.appliedAt||row.lastSeenAt);}
function isActive(row){return row?.bucket!=='archive'&&!isLegacy(row);}
function availableCount(rows){return rows.filter(r=>!isLegacy(r)&&(['new','ready'].includes(String(r.bucket||''))||String(r.status||'')==='email_rate_limited')).length;}

window.renderNewMarketplaces=function(){
  const root=document.getElementById('new-marketplaces');
  if(root)root.remove();
  document.querySelector('section[aria-label="AgentHansa and TaskBounty"]')?.remove();
};

function removeLegacyDashboardNodes(){
  document.querySelector('.autonomos-t2000-card')?.remove();
  document.querySelector('section[aria-label="AgentHansa and TaskBounty"]')?.remove();
  const radar=document.getElementById('autonomos-market-radar');
  if(radar){for(const card of [...radar.children]){const text=String(card.textContent||'').toLowerCase();if([...LEGACY_SOURCES].some(x=>text.includes(x)))card.remove();}}
  const outcomes=document.getElementById('autonomos-market-jobs');
  if(outcomes){for(const card of [...outcomes.children]){const text=String(card.textContent||'').toLowerCase();if([...LEGACY_SOURCES].some(x=>text.includes(x)))card.remove();}}
}

function ensureGlobalFeedPanel(){
  const anchor=document.querySelector('.autonomos-command-panel');if(!anchor)return;
  anchor.remove();removeLegacyDashboardNodes();
  if(document.getElementById('autonomos-global-work-feed'))return;
  const panel=document.createElement('section');panel.id='autonomos-global-work-feed';panel.className='admin-panel autonomos-panel global-work-feed';
  const tabs=[['live','Усі активні'],['applied','Подано'],['working','В роботі'],['done','Здано'],['paid','Оплачено'],['archive','Архів']];
  panel.innerHTML=`<div class="admin-panel-head"><div><small>ПО ВСЬОМУ СВІТУ · НАЖИВО</small><h2>Реальний робочий потік</h2><p class="settings-note">Тільки актуальні джерела й задачі. Старі вимкнені ринки та їх історичний шум тут не показуються.</p></div><div id="global-feed-meta"></div></div><div id="global-feed-summary" class="global-feed-summary"></div><div class="global-feed-tabs" role="tablist">${tabs.map(([k,l])=>`<button class="admin-secondary global-feed-tab${k==='live'?' active':''}" data-global-feed="${k}" type="button">${l} <b data-global-count="${k}">0</b></button>`).join('')}</div><div class="autonomos-job-toolbar"><input id="global-feed-search" type="search" placeholder="Шукати роботу, джерело або категорію…"></div><div class="autonomos-job-table-wrap"><table class="autonomos-job-table"><thead><tr><th>Робота</th><th>Джерело</th><th>Категорія</th><th>Виплата</th><th>Статус</th><th>Знайдено / дія</th></tr></thead><tbody id="global-feed-body"></tbody></table></div>`;
  const parent=document.querySelector('[data-panel="autonomos"]');const firstOperator=parent?.querySelector('.autonomos-operator-row');if(firstOperator)parent.insertBefore(panel,firstOperator);else parent?.appendChild(panel);
  if(!document.getElementById('global-feed-style')){const style=document.createElement('style');style.id='global-feed-style';style.textContent=`.global-feed-tabs{display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0}.global-feed-tab.active{outline:2px solid currentColor}.global-feed-tab b{margin-left:.35rem}.global-work-feed{border:1px solid rgba(120,140,255,.28)}#global-feed-meta{font-size:.82rem;opacity:.8;max-width:390px;text-align:right}.global-feed-summary{display:flex;gap:.7rem;flex-wrap:wrap;margin:.75rem 0 1rem}.global-feed-summary span{padding:.5rem .75rem;border:1px solid rgba(120,140,255,.22);border-radius:10px;font-size:.82rem}.global-feed-summary b{font-size:1rem;margin-left:.35rem}.global-feed-archive{opacity:.48}.global-feed-working{font-weight:600}.global-feed-applied td:nth-child(5){font-weight:700}`;document.head.appendChild(style);}
  panel.addEventListener('click',e=>{const b=e.target.closest('[data-global-feed]');if(!b)return;globalFeedFilter=b.dataset.globalFeed;panel.querySelectorAll('.global-feed-tab').forEach(x=>x.classList.toggle('active',x===b));renderGlobalFeed();});
  panel.querySelector('#global-feed-search')?.addEventListener('input',renderGlobalFeed);
}

async function loadGlobalFeed(){ensureGlobalFeedPanel();try{const r=await fetch(`/autonomos-global-feed.json?t=${Date.now()}`,{cache:'no-store'});if(r.ok)globalFeedData=await r.json();}catch{}renderGlobalFeed();removeLegacyDashboardNodes();}
function renderGlobalFeed(){
  const body=document.getElementById('global-feed-body');if(!body)return;
  const search=String(document.getElementById('global-feed-search')?.value||'').trim().toLowerCase();
  const rows=(Array.isArray(globalFeedData.rows)?globalFeedData.rows:[]).filter(r=>!isLegacy(r));
  let visible=rows.filter(row=>{if(globalFeedFilter==='live'&&!isActive(row))return false;if(globalFeedFilter!=='live'&&row.bucket!==globalFeedFilter)return false;if(!search)return true;return `${row.title} ${row.source} ${row.category} ${row.status}`.toLowerCase().includes(search);});
  visible=visible.sort((a,b)=>rowTime(b,globalFeedFilter)-rowTime(a,globalFeedFilter)||String(a.id||'').localeCompare(String(b.id||''))).slice(0,400);
  body.innerHTML=visible.length?visible.map(row=>{const payout=Number(row.amountUsd||0)>0?`$${Number(row.amountUsd).toFixed(2)} ${htmlEsc(row.currency||'')}`:'не підтверджено';const when=globalFeedFilter==='applied'&&row.appliedAt?row.appliedAt:globalFeedFilter==='working'&&row.acceptedAt?row.acceptedAt:row.submittedAt||row.paidAt||row.firstSeenAt||row.lastSeenAt;return `<tr class="global-feed-${htmlEsc(row.bucket)}"><td>${row.url?`<a href="${htmlEsc(row.url)}" target="_blank" rel="noopener noreferrer">${htmlEsc(row.title)}</a>`:htmlEsc(row.title)}</td><td>${htmlEsc(row.source)}</td><td>${htmlEsc(row.category)}</td><td>${payout}</td><td>${htmlEsc(statusLabel(row))}</td><td>${htmlEsc(when?new Date(when).toLocaleString():'—')}</td></tr>`;}).join(''):'<tr><td colspan="6">У цьому розділі поки немає записів.</td></tr>';
  const c=globalFeedData.counts||{},live=rows.filter(isActive).length;for(const node of document.querySelectorAll('[data-global-count]')){const key=node.dataset.globalCount;node.textContent=key==='live'?live:Number(c[key]||0);}
  const summary=document.getElementById('global-feed-summary');if(summary)summary.innerHTML=`<span>Доступно до подачі <b>${availableCount(rows)}</b></span><span>Заявок відправлено <b>${Number(c.applied||0)}</b></span><span>В роботі <b>${Number(c.working||0)}</b></span><span>Здано <b>${Number(c.done||0)}</b></span><span>Оплачено <b>${Number(c.paid||0)}</b></span>`;
  const meta=document.getElementById('global-feed-meta');if(meta)meta.textContent=`${rows.length} актуальних записів · ${live} активних · оновлено ${globalFeedData.generatedAt?new Date(globalFeedData.generatedAt).toLocaleTimeString():'—'}`;
}
function refreshMissionControl(){if(document.hidden)return;const b=document.querySelector('#refresh-btn');if(b&&!b.disabled)b.click();}
const observer=new MutationObserver(removeLegacyDashboardNodes);observer.observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener('DOMContentLoaded',()=>{ensureGlobalFeedPanel();loadGlobalFeed();setTimeout(refreshMissionControl,1500);});
setInterval(loadGlobalFeed,10000);setInterval(refreshMissionControl,10000);

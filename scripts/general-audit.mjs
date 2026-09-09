import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig, DEFAULT_AUTONOMOS_CONFIG, isDemoOrTestOpportunity } from '../src/autonomos/policy-engine.js';
import { infrastructureStatus } from '../src/autonomos/infrastructure.js';
import { triggerEnabled } from '../src/autonomos/trigger-client.js';

const root=path.resolve(process.cwd());
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const checks=[];
const check=(name,ok,detail='')=>checks.push({name,ok:Boolean(ok),detail});

const pkg=JSON.parse(read('package.json'));
check('Trigger.dev SDK dependency is pinned',pkg.dependencies?.['@trigger.dev/sdk']==='4.5.14');
check('LangGraph checkpoint peer is explicit',Boolean(pkg.dependencies?.['@langchain/langgraph-checkpoint']));
check('OpenTelemetry API peer is explicit',Boolean(pkg.dependencies?.['@opentelemetry/api']));
check('OpenTelemetry core peer is explicit',Boolean(pkg.dependencies?.['@opentelemetry/core']));
check('OTLP HTTP exporter peer is explicit',Boolean(pkg.dependencies?.['@opentelemetry/exporter-trace-otlp-http']));
check('OTEL trace-base peer is explicit',Boolean(pkg.dependencies?.['@opentelemetry/sdk-trace-base']));
check('Legacy NATS package removed',!pkg.dependencies?.nats);

const tools=read('src/autonomos/tools.js');
const freeWeb=fs.existsSync(path.join(root,'src/autonomos/free-web-tool.js'))?read('src/autonomos/free-web-tool.js'):'';
check('Free web search is wired into worker tools',/freeWebSearch/.test(tools)&&/free-web-tool/.test(tools));
check('Free web search implementation exists',/free_public_web/.test(freeWeb)&&/duckduckgo/i.test(freeWeb));
check('GitHub direct token can be identity-pinned',/AUTONOMOS_GITHUB_EXPECTED_LOGIN/.test(tools)&&/github_identity_mismatch/.test(tools));

const runtime=read('src/autonomos/runtime.js');
check('Trigger.dev durable dispatch is wired into main cycle',/dispatchTriggerPaidOpportunity\((?:opportunity|durableOpportunity)/.test(runtime));
check('Trigger.dev durable dispatch is wired into fast cycle',/dispatchTriggerPaidOpportunity\((?:op|durableOp),env\)/.test(runtime));
const triggerClient=read('src/autonomos/trigger-client.js');
check('Trigger.dev dispatch uses SDK task trigger API',/tasks\.trigger\(/.test(triggerClient));
check('Trigger.dev dispatch has per-opportunity idempotency',/idempotencyKey/.test(triggerClient)&&/createHash\('sha256'\)/.test(triggerClient));
check('Demo/test filter participates in candidacy',/demo_or_test_opportunity/.test(runtime));

const server=read('server.js');
check('Signed Trigger.dev callback endpoint exists',/\/api\/internal\/autonomos\/trigger\/execute/.test(server)&&/unauthorized_trigger_callback/.test(server));
const eventBus=read('src/autonomos/event-bus.js');
check('Event bus uses already-paid Redis Streams',/xAdd\(/.test(eventBus)&&/REDIS_URL/.test(eventBus)&&!/import\(['\"]nats['\"]\)/.test(eventBus));

const env=read('.env.example');
for(const key of ['OPENAI_API_KEY','DATABASE_URL','REDIS_URL','TRIGGER_SECRET_KEY','COMPOSIO_API_KEY','S3_ENDPOINT','S3_REGION','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_BASE_URL','E2B_API_KEY']){
  check(`.env.example documents ${key}`,new RegExp(`^${key}=`,`m`).test(env));
}

const cfg=normalizeConfig({...DEFAULT_AUTONOMOS_CONFIG});
check('Global minimum payout defaults to at least $5.00',Number(cfg.minJobPayoutUsd)>=5,`value=${cfg.minJobPayoutUsd}`);
check('Demo/test protection defaults ON',cfg.rejectDemoAndTestJobs===true);
check('Explicit demo opportunity is rejected',isDemoOrTestOpportunity({title:'DEMO ONLY - no payment',environment:'sandbox'})===true);
check('Legitimate software testing title is not rejected solely for word test',isDemoOrTestOpportunity({title:'QA engineer to test production web app',budgetUsd:500})===false);

const syntheticEnv={TRIGGER_SECRET_KEY:'tr_prod_redacted',DATABASE_URL:'postgres://x',REDIS_URL:'redis://x',OPENAI_API_KEY:'sk-redacted',COMPOSIO_API_KEY:'c',S3_ENDPOINT:'https://x',S3_BUCKET:'b',S3_ACCESS_KEY_ID:'a',S3_SECRET_ACCESS_KEY:'s',LANGFUSE_PUBLIC_KEY:'pk',LANGFUSE_SECRET_KEY:'sk',LANGFUSE_BASE_URL:'https://cloud.langfuse.com',E2B_API_KEY:'e'};
check('Trigger.dev config gate recognizes secret key',triggerEnabled(syntheticEnv));
const infra=infrastructureStatus(syntheticEnv);
for(const id of ['openai_agents','langgraph','memory','redis','redis_streams','triggerdev','composio','s3','langfuse','e2b'])check(`Infrastructure ${id} can reach ready state`,infra.find(x=>x.id===id)?.configured===true);

const html=read('public/admin.html'),js=read('public/admin.js');
check('Admin exposes demo/test safety toggle',/name="rejectDemoAndTestJobs"/.test(html));
check('Admin submits demo/test safety toggle',/rejectDemoAndTestJobs:f\.elements\.rejectDemoAndTestJobs\.checked/.test(js));
check('Admin copy reflects $5.00 general floor',/global floor \$5\.00/.test(html));

const forbiddenInPublic=['server.js','package.json','render.yaml','Procfile','scripts'];
for(const name of forbiddenInPublic)check(`public/${name} does not exist (would be served to the internet)`,!fs.existsSync(path.join(root,'public',name)));
const publicMdReports=fs.readdirSync(path.join(root,'public')).filter(f=>/\.md$/i.test(f)&&f.toLowerCase()!=='license.md');
check('No stray internal .md reports inside public/',publicMdReports.length===0,publicMdReports.join(', '));

const failed=checks.filter(x=>!x.ok);
for(const c of checks)console.log(`${c.ok?'PASS':'FAIL'} ${c.name}${c.detail?` — ${c.detail}`:''}`);
console.log(`\nGENERAL AUDIT: ${checks.length-failed.length}/${checks.length} passed`);
if(failed.length)process.exitCode=1;

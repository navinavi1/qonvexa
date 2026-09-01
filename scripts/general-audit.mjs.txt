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
check('Tavily is wired into web_search',/tavilySearch/.test(tools)&&/TAVILY_API_KEY/.test(tools));
check('GitHub direct token can be identity-pinned',/AUTONOMOS_GITHUB_EXPECTED_LOGIN/.test(tools)&&/github_identity_mismatch/.test(tools));

const runtime=read('src/autonomos/runtime.js');
check('Trigger.dev durable dispatch is wired into main cycle',/dispatchTriggerPaidOpportunity\(opportunity/.test(runtime));
check('Trigger.dev durable dispatch is wired into fast cycle',/dispatchTriggerPaidOpportunity\(op,env\)/.test(runtime));
const triggerClient=read('src/autonomos/trigger-client.js');
check('Trigger.dev dispatch uses SDK task trigger API',/tasks\.trigger\(/.test(triggerClient));
check('Trigger.dev dispatch has per-opportunity idempotency',/idempotencyKey/.test(triggerClient)&&/autonomos:\$\{source\}:\$\{externalId\}/.test(triggerClient));
check('Demo/test filter participates in candidacy',/demo_or_test_opportunity/.test(runtime));

const server=read('server.js');
check('Signed Trigger.dev callback endpoint exists',/\/api\/internal\/autonomos\/trigger\/execute/.test(server)&&/unauthorized_trigger_callback/.test(server));

const eventBus=read('src/autonomos/event-bus.js');
check('Event bus uses already-paid Redis Streams',/xAdd\(/.test(eventBus)&&/REDIS_URL/.test(eventBus)&&!/import\(['\"]nats['\"]\)/.test(eventBus));

const env=read('.env.example');
for(const key of ['OPENAI_API_KEY','DATABASE_URL','REDIS_URL','BROWSERBASE_API_KEY','BROWSERBASE_PROJECT_ID','TRIGGER_SECRET_KEY','COMPOSIO_API_KEY','S3_ENDPOINT','S3_REGION','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','LANGFUSE_PUBLIC_KEY','LANGFUSE_SECRET_KEY','LANGFUSE_BASE_URL','TAVILY_API_KEY']){
  check(`.env.example documents ${key}`,new RegExp(`^${key}=`,`m`).test(env));
}

const cfg=normalizeConfig({...DEFAULT_AUTONOMOS_CONFIG});
check('Global minimum payout defaults to at least $25',Number(cfg.minJobPayoutUsd)>=25,`value=${cfg.minJobPayoutUsd}`);
check('Clawlancer minimum defaults to at least $25',Number(cfg.clawlancerMinJobPayoutUsd)>=25,`value=${cfg.clawlancerMinJobPayoutUsd}`);
check('Dealwork minimum defaults to at least $25',Number(cfg.dealworkMinJobPayoutUsd)>=25,`value=${cfg.dealworkMinJobPayoutUsd}`);
check('Demo/test protection defaults ON',cfg.rejectDemoAndTestJobs===true);
check('Explicit demo opportunity is rejected',isDemoOrTestOpportunity({title:'DEMO ONLY - no payment',environment:'sandbox'})===true);
check('Legitimate software testing title is not rejected solely for word test',isDemoOrTestOpportunity({title:'QA engineer to test production web app',budgetUsd:500})===false);

const syntheticEnv={TRIGGER_SECRET_KEY:'tr_prod_redacted',TAVILY_API_KEY:'tvly-redacted',DATABASE_URL:'postgres://x',REDIS_URL:'redis://x',OPENAI_API_KEY:'sk-redacted',BROWSERBASE_API_KEY:'bb',BROWSERBASE_PROJECT_ID:'p',COMPOSIO_API_KEY:'c',S3_ENDPOINT:'https://x',S3_BUCKET:'b',S3_ACCESS_KEY_ID:'a',S3_SECRET_ACCESS_KEY:'s',LANGFUSE_PUBLIC_KEY:'pk',LANGFUSE_SECRET_KEY:'sk',LANGFUSE_BASE_URL:'https://cloud.langfuse.com',FIRECRAWL_API_KEY:'f',E2B_API_KEY:'e'};
check('Trigger.dev config gate recognizes secret key',triggerEnabled(syntheticEnv));
const infra=infrastructureStatus(syntheticEnv);
for(const id of ['openai_agents','langgraph','memory','redis','redis_streams','triggerdev','tavily','firecrawl','stagehand','composio','s3','langfuse','e2b'])check(`Infrastructure ${id} can reach ready state`,infra.find(x=>x.id===id)?.configured===true);
check('Deferred Temporal is optional',infra.find(x=>x.id==='temporal')?.optional===true);

const html=read('public/admin.html'),js=read('public/admin.js');
check('Admin exposes demo/test safety toggle',/name="rejectDemoAndTestJobs"/.test(html));
check('Admin submits demo/test safety toggle',/rejectDemoAndTestJobs:f\.elements\.rejectDemoAndTestJobs\.checked/.test(js));
check('Admin copy reflects $25 general floors',/global floor \$25/.test(html));

const failed=checks.filter(x=>!x.ok);
for(const c of checks)console.log(`${c.ok?'PASS':'FAIL'} ${c.name}${c.detail?` — ${c.detail}`:''}`);
console.log(`\nGENERAL AUDIT: ${checks.length-failed.length}/${checks.length} passed`);
if(failed.length)process.exitCode=1;

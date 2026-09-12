import crypto from 'node:crypto';

export const PROGRAM_FILE='security-programs.json';
export const FINDING_FILE='security-findings.json';

// A finding leaves this system only when a human sends it. Nothing in this lane
// posts to Immunefi, Cantina or any other platform: an agent that auto-submits
// unverified reports gets the owner's account permanently banned, and a banned
// account cannot earn anything ever again. The queue below is the deliverable.
export const SUBMISSION_IS_MANUAL=true;

export const SEVERITY_WEIGHT=Object.freeze({critical:5,high:4,medium:3,low:2,informational:1});
// Immunefi's standard severity classification pays a band of the program maximum.
// These are the conservative low ends, so an estimate never flatters a finding.
export const SEVERITY_PAYOUT_SHARE=Object.freeze({critical:0.10,high:0.03,medium:0.01,low:0.002,informational:0});

export const REVIEWABLE_EXTENSIONS=Object.freeze(['.sol','.rs','.go','.ts','.js','.vy','.cairo','.move']);

export function normalizeProgram(raw){
  const program=raw&&typeof raw==='object'?raw:{};
  const maxBountyUsd=Number(program.maxBountyUsd??program.maxBounty??0);
  const vaultUsd=Number(program.vaultUsd??program.vault??0);
  return{
    programId:String(program.programId||program.id||program.name||'').trim().toLowerCase().replace(/\s+/g,'-'),
    name:String(program.name||program.programId||''),
    platform:String(program.platform||'immunefi').toLowerCase(),
    url:String(program.url||''),
    scopeRepos:(Array.isArray(program.scopeRepos)?program.scopeRepos:[]).map(String).filter(Boolean),
    maxBountyUsd:Number.isFinite(maxBountyUsd)?Math.max(0,maxBountyUsd):0,
    // Vault TVL is money already escrowed on chain. Max bounty is a ceiling the
    // program advertises and rarely pays, so the two are kept apart on purpose
    // and never summed into one "available" number.
    vaultUsd:Number.isFinite(vaultUsd)?Math.max(0,vaultUsd):0,
    lastUpdated:String(program.lastUpdated||''),
    enabled:program.enabled!==false
  };
}

export function programsFromRegistry(rows){
  const list=Array.isArray(rows)?rows:Array.isArray(rows?.programs)?rows.programs:Object.values(rows||{});
  const seen=new Set(),programs=[];
  for(const raw of list){
    const program=normalizeProgram(raw);
    if(!program.programId||!program.scopeRepos.length||seen.has(program.programId))continue;
    seen.add(program.programId);programs.push(program);
  }
  return programs;
}

export function findingId({programId,repo,file,line,vulnerabilityClass}){
  return crypto.createHash('sha256').update([programId,repo,file,String(line||0),vulnerabilityClass].map(part=>String(part||'')).join('|')).digest('hex').slice(0,24);
}

export function normalizeFinding(raw,program){
  const finding=raw&&typeof raw==='object'?raw:{};
  const severity=String(finding.severity||'').toLowerCase();
  const confidence=Number(finding.confidence);
  return{
    programId:program.programId,
    repo:String(finding.repo||''),
    file:String(finding.file||''),
    line:Number(finding.line||0),
    vulnerabilityClass:String(finding.vulnerabilityClass||finding.class||'unclassified'),
    severity:SEVERITY_WEIGHT[severity]?severity:'informational',
    confidence:Number.isFinite(confidence)?Math.min(1,Math.max(0,confidence)):0,
    summary:String(finding.summary||'').slice(0,600),
    impact:String(finding.impact||'').slice(0,600),
    evidence:String(finding.evidence||'').slice(0,2000),
    status:'awaiting_human_review'
  };
}

// Deliberately pessimistic: the severity band's low end, discounted by the
// reviewer's own confidence. A number that flatters a finding is worse than no
// number, because it is what decides which one the owner reads first.
export function expectedValueUsd(finding,program){
  const share=SEVERITY_PAYOUT_SHARE[finding.severity]??0;
  return Math.round(Number(program?.maxBountyUsd||0)*share*Number(finding.confidence||0)*100)/100;
}

export function rankFindings(findings,programsById={}){
  return [...findings]
    .map(finding=>({...finding,expectedValueUsd:expectedValueUsd(finding,programsById[finding.programId])}))
    .sort((a,b)=>b.expectedValueUsd-a.expectedValueUsd
      ||SEVERITY_WEIGHT[b.severity]-SEVERITY_WEIGHT[a.severity]
      ||b.confidence-a.confidence);
}

export function reviewableFiles(paths,{limit=40}={}){
  return (Array.isArray(paths)?paths:[])
    .filter(file=>REVIEWABLE_EXTENSIONS.some(extension=>String(file).toLowerCase().endsWith(extension)))
    .filter(file=>!/(^|\/)(node_modules|test|tests|mock|mocks|script|scripts|lib\/forge-std)\//i.test(String(file)))
    .slice(0,Math.max(1,limit));
}

export function queueSummary(queue){
  const rows=Object.values(queue||{});
  const bySeverity={};
  for(const row of rows)bySeverity[row.severity]=(bySeverity[row.severity]||0)+1;
  return{
    total:rows.length,
    awaitingReview:rows.filter(row=>row.status==='awaiting_human_review').length,
    submittedByOwner:rows.filter(row=>row.status==='submitted_by_owner').length,
    dismissed:rows.filter(row=>row.status==='dismissed').length,
    bySeverity,
    estimatedValueUsd:Math.round(rows.filter(row=>row.status==='awaiting_human_review').reduce((sum,row)=>sum+Number(row.expectedValueUsd||0),0)*100)/100
  };
}

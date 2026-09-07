import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const file=path.join(here,'..','src','autonomos','runtime.js');
const raw=fs.readFileSync(file,'utf8');
const before=`  function isPreCommittedAssignedOrder(op={}){\n    return ['t2000','dealwork'].includes(String(op.source||''))&&String(op.claimMode||'')==='already_assigned';\n  }`;
const after=`  function isPreCommittedAssignedOrder(op={}){\n    const assigned=['t2000','dealwork'].includes(String(op.source||''))&&String(op.claimMode||'')==='already_assigned';\n    if(!assigned)return false;\n    const row=jobRegistry.get(op);\n    if(!row)return true; // Fresh seller assignment: it is an obligation and may start.\n    const status=String(row.status||'');\n    const blocked=jobRegistry.blockReason(op);\n    if(blocked||row.everOwned||row.terminal)return false;\n    return !['manual_attention','system_blocked','capability_hold','graveyard','archived','stale_check','retry'].includes(status);\n  }`;
if(raw.includes(after))process.exit(0);
if(!raw.includes(before))throw new Error('runtime assigned-order patch target drifted; refusing an unverified rewrite');
const next=raw.replace(before,after);
fs.writeFileSync(file,next,'utf8');
console.log('Applied registry-aware assigned-order scheduler patch.');

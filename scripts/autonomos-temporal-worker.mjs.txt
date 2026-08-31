import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from '../src/autonomos/temporal/activities.js';

const address=String(process.env.TEMPORAL_ADDRESS||'').trim();
if(!address)throw new Error('TEMPORAL_ADDRESS is required');
if(!process.env.AUTONOMOS_TEMPORAL_WORKER_TOKEN)throw new Error('AUTONOMOS_TEMPORAL_WORKER_TOKEN is required');
const connection=await NativeConnection.connect({address,tls:/^(1|true|yes)$/i.test(String(process.env.TEMPORAL_TLS||''))?{}:undefined});
const worker=await Worker.create({connection,namespace:String(process.env.TEMPORAL_NAMESPACE||'default'),taskQueue:String(process.env.TEMPORAL_TASK_QUEUE||'autonomos-paid-jobs'),workflowsPath:fileURLToPath(new URL('../src/autonomos/temporal/workflows.js',import.meta.url)),activities});
console.log(`AutonomOS Temporal worker listening on ${process.env.TEMPORAL_TASK_QUEUE||'autonomos-paid-jobs'}`);
await worker.run();

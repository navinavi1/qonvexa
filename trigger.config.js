import { defineConfig } from '@trigger.dev/sdk';

const project = process.env.TRIGGER_PROJECT_REF || process.env.AUTONOMOS_TRIGGER_PROJECT_REF || 'proj_kiyllajxwhqkdrvrfldr';
if (!project) throw new Error('TRIGGER_PROJECT_REF is required when deploying Trigger.dev tasks');

export default defineConfig({
  project,
  runtime:'node-24',
  dirs:['./trigger'],
  maxDuration:1800,
  retries:{ enabledInDev:false, default:{ maxAttempts:5, minTimeoutInMs:15000, maxTimeoutInMs:300000, factor:2 } }
});

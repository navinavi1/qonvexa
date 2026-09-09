import { defineConfig } from '@trigger.dev/sdk';

// Falls back to this project ref when neither env var is set. The `if (!project) throw`
// guard that used to sit here could never fire because of that fallback; it is removed
// rather than made live, so an existing deploy keeps working. Override per environment with
// TRIGGER_PROJECT_REF or AUTONOMOS_TRIGGER_PROJECT_REF.
const project = process.env.TRIGGER_PROJECT_REF || process.env.AUTONOMOS_TRIGGER_PROJECT_REF || 'proj_kiyllajxwhqkdrvrfldr';

export default defineConfig({
  project,
  runtime:'node-24',
  dirs:['./trigger'],
  maxDuration:1800,
  retries:{ enabledInDev:false, default:{ maxAttempts:5, minTimeoutInMs:15000, maxTimeoutInMs:300000, factor:2 } }
});

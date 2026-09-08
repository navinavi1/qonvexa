import { AgrentingLiveWorker } from './agrenting-live-worker.js';
import { freeCapabilityContext } from './free-capability-layer.js';

export class FreeAgrentingLiveWorker extends AgrentingLiveWorker{
  capabilityContext(){return freeCapabilityContext(this.env);}
}

import { AgrentingWorker } from './agrenting-worker.js';
import { freeCapabilityContext } from './free-capability-layer.js';

export class FreeAgrentingWorker extends AgrentingWorker{
  capabilityContext(){return freeCapabilityContext(this.env);}
}

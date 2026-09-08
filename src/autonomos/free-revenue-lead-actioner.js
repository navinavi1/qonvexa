import { RevenueLeadActioner } from './revenue-lead-actioner.js';
import { freeCapabilityContext } from './free-capability-layer.js';

export class FreeRevenueLeadActioner extends RevenueLeadActioner{
  capabilityContext(){return freeCapabilityContext(this.env);}
}

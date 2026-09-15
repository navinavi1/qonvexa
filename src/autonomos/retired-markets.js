import { isRetiredResource, retiredResources } from './retired-resources.js';
export const isRetiredMarket=value=>isRetiredResource(value,'markets');

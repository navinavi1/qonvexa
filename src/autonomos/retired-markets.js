import { isRetiredResource, retiredResources } from './retired-resources.js';
export const RETIRED_MARKET_SOURCES=Object.freeze(retiredResources().markets.map(x=>x.id));
export const isRetiredMarket=value=>isRetiredResource(value,'markets');

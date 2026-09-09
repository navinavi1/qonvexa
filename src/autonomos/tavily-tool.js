// Compatibility bridge for modules that still use the historical search helper name.
// This file never calls Tavily, Firecrawl, or any paid search provider.
import { freeWebSearch } from './free-web-tool.js';

export async function tavilySearch(query, env=process.env, signal) {
  return freeWebSearch(query, env, signal);
}

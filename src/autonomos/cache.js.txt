export class AutonomOSCache{
  constructor({env=process.env,logger=console}={}){this.env=env;this.logger=logger;this.client=null;}
  async init(){if(!this.env.REDIS_URL)return{ok:false,reason:'redis_url_missing'};try{const {createClient}=await import('redis');this.client=createClient({url:this.env.REDIS_URL});this.client.on('error',e=>this.logger.warn?.('Redis',e?.message||e));await this.client.connect();return{ok:true};}catch(error){return{ok:false,reason:String(error?.message||error)}}}
  async getJson(key){if(!this.client)return null;try{const value=await this.client.get(`autonomos:${key}`);return value?JSON.parse(value):null}catch{return null}}
  async setJson(key,value,ttlSeconds=300){if(!this.client)return false;try{await this.client.set(`autonomos:${key}`,JSON.stringify(value),{EX:Math.max(1,Number(ttlSeconds||300))});return true}catch{return false}}
  async close(){try{await this.client?.quit()}catch{}}
}

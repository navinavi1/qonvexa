export class EventBus{
  constructor({env=process.env,logger=console}={}){this.env=env;this.logger=logger;this.nc=null;}
  async init(){if(!this.env.NATS_URL)return{ok:false,reason:'nats_url_missing'};try{const {connect}=await import('nats');this.nc=await connect({servers:this.env.NATS_URL,name:'autonomos'});return{ok:true};}catch(error){this.logger.warn?.('NATS init failed',error?.message||error);return{ok:false,reason:String(error?.message||error)}}}
  async publish(subject,payload){if(!this.nc)return false;const bytes=new TextEncoder().encode(JSON.stringify(payload));this.nc.publish(`autonomos.${subject}`,bytes);return true;}
  async close(){try{await this.nc?.drain()}catch{}}
}

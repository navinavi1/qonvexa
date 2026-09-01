const STREAM_KEY='autonomos:events';

export class EventBus{
  constructor({env=process.env,logger=console}={}){this.env=env;this.logger=logger;this.client=null;}
  async init(){
    if(!this.env.REDIS_URL)return{ok:false,reason:'redis_url_missing'};
    try{
      const {createClient}=await import('redis');
      this.client=createClient({url:this.env.REDIS_URL});
      this.client.on('error',e=>this.logger.warn?.('AutonomOS event stream Redis',e?.message||e));
      await this.client.connect();
      return{ok:true,provider:'redis_streams',stream:STREAM_KEY};
    }catch(error){
      this.logger.warn?.('AutonomOS Redis Streams init failed',error?.message||error);
      return{ok:false,reason:String(error?.message||error)};
    }
  }
  async publish(subject,payload){
    if(!this.client)return false;
    try{
      await this.client.xAdd(STREAM_KEY,'*',{
        subject:String(subject||'event'),
        payload:JSON.stringify(payload??null)
      },{TRIM:{strategy:'MAXLEN',strategyModifier:'~',threshold:10000}});
      return true;
    }catch(error){
      this.logger.warn?.('AutonomOS Redis Streams publish failed',error?.message||error);
      return false;
    }
  }
  async close(){try{await this.client?.quit()}catch{}}
}

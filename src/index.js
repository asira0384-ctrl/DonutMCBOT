'use strict';
require('./env').loadLocalEnv();
const http=require('node:http');
const path=require('node:path');
const {State}=require('./state');
const {Diagnostics}=require('./diagnostics');
const {Fleet}=require('./fleet');
const {WebServer}=require('./web-server');
async function main(){
  const store=new State(process.env.DATA_DIR||path.join(process.cwd(),'data'));
  const log=new Diagnostics(store.dir),fleet=new Fleet(store,log),web=new WebServer(fleet);
  const server=http.createServer((req,res)=>web.handle(req,res));server.requestTimeout=180000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.PORT||3000),'0.0.0.0',resolve);});
  log.log('important','web','ready','DonutBOT管理画面を起動しました: port '+(process.env.PORT||3000));
  const discordPromise=require('./discord-control').startDiscord(fleet);fleet.resume();
  let closing=false;const shutdown=async()=>{if(closing)return;closing=true;web.close();await fleet.shutdown();(await discordPromise).destroy();server.close();setTimeout(()=>process.exit(0),1000).unref();};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  process.on('unhandledRejection',error=>{log.error('process','unhandled',error instanceof Error?error:Error(String(error)));shutdown();});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

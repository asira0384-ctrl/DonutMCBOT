'use strict';
const {EventEmitter}=require('node:events');
const {Accounts}=require('./accounts');
const {ROLES}=require('./state');
const {failure,clean}=require('./diagnostics');
const {Agent}=require('./agent');
const {Coordinator}=require('./coordinator');
const {xyz}=require('./telemetry');
class Fleet extends EventEmitter {
  constructor(store,log,options={}){
    super();this.store=store;this.log=log;this.agents=new Map();this.reconnects=new Map();this.attempts=new Map();this.connectTimers=new Map();this.shuttingDown=false;this.Bot=options.Bot;
    this.connectionJobs=new Map();this.transferCounts=new Map();this.accounts=new Accounts(store,{onChange:(id,text)=>{log.log('info',id,'auth',text);this.emit('change');}});
    this.cycle=new Coordinator(this);this.log.log('info','fleet','startup','DonutBOT v1.0.0 起動。自動回収はパール確認後に開始してください',{storage:store.storage()});
  }
  get(id){if(!ROLES.includes(id))throw failure('INVALID_BOT','BOTを選んでください');const a=this.agents.get(id);if(!a||a.closed)throw failure('NOT_CONNECTED',id+'が未接続です');return a;}
  connect(id,manual=true){
    const config=this.store.bot(id),current=this.agents.get(id),pending=this.connectionJobs.get(id);
    if(!config.name.trim())throw failure('INVALID_CONFIG','先にゲーマータグを保存してください');
    if(current&&!current.closed)return current.snapshot();
    const auth=this.authState(id);
    if(pending&&!pending.finished&&!['failed','expired'].includes(auth.state))return auth;
    if(pending)pending.cancelled=true;
    if(!this.store.data.resumeConnections.includes(id)){this.store.data.resumeConnections.push(id);this.store.save();}
    const job={name:config.name,finished:false,cancelled:false};this.connectionJobs.set(id,job);
    const active=()=>!this.shuttingDown&&!job.cancelled&&this.connectionJobs.get(id)===job&&this.store.bot(id).name===job.name;
    const open=()=>{if(active())return this._open(id,manual);};
    if(auth.saved&&!['failed','expired','checking','waiting'].includes(auth.state))job.promise=Promise.resolve().then(open);
    else{this.accounts.start(id,config.name);const login=this.accounts.jobs.get(id);job.promise=Promise.resolve(login?.promise).then(()=>{if(!active())return;if(login?.state!=='ready')throw failure('AUTH_EXPIRED',login?.error||'認証が完了しませんでした');return open();});}
    job.promise=job.promise.catch(e=>{if(active()){job.error=e.message;this.log.error(id,'connect',e);}}).finally(()=>{job.finished=true;});
    return this.authState(id);
  }
  _open(id,manual=true,destination=null){
    const c=this.store.bot(id),current=this.agents.get(id);
    if(!c.name.trim())throw failure('INVALID_CONFIG','まずゲーマータグを保存してください');
    for(const [other,agent]of this.agents)if(other!==id&&!agent.closed&&agent.config.name.toLowerCase()===c.name.toLowerCase())throw failure('DUPLICATE_ACCOUNT','3つの役割には別々のMinecraftアカウントを使ってください');
    if(current&&!current.closed)return current.snapshot();
    clearTimeout(this.reconnects.get(id));if(manual){this.attempts.set(id,0);this.transferCounts.set(id,0);}
    if(!this.store.data.resumeConnections.includes(id)){this.store.data.resumeConnections.push(id);this.store.save();}
    const Bot=this.Bot||require('./bedrock').BedrockBot;
    if(c.version&&!Object.hasOwn(require('bedrock-protocol/src/options').Versions,c.version))throw failure('UNSUPPORTED_VERSION','この版には未対応です: '+c.version);
    this.log.log('important',id,'connect','Minecraftに接続します',{host:c.host,port:c.port,version:c.version||'auto'});
    const bot=new Bot({id,name:c.name,host:destination?.host||c.host,port:destination?.port||c.port,version:c.version||undefined,authDir:this.accounts.directory(id,c.name),authflow:this.accounts.flow(id,c.name)},data=>{
      const job=this.accounts.jobs.get(id);if(job){job.code={...data,expires:Date.now()+(data.expires_in||900)*1000};job.state='waiting';}
      this.liveCodes??=new Map();this.liveCodes.set(id,{value:data.user_code,url:'https://www.microsoft.com/link',expires:Date.now()+(data.expires_in||900)*1000});
      this.log.log('important',id,'auth','Microsoftのデバイス認証待ち。コードはWeb/Discordの認証画面で確認できます');
    });
    const agent=new Agent(id,bot,this);this.agents.set(id,agent);
    bot.on('serverTransfer',packet=>{
      if(this.agents.get(id)!==agent||agent.transferring)return;
      const host=String(packet.server_address||'').trim(),port=Number(packet.port),n=(this.transferCounts.get(id)||0)+1;
      if(!/^[a-zA-Z0-9.:-]{1,253}$/.test(host)||!Number.isInteger(port)||port<1||port>65535||n>5){this.log.log('error',id,'transfer','転送先不正または連続転送が5回を超えました');this.disconnect(id);return;}
      this.transferCounts.set(id,n);agent.transferring=true;bot.disconnect();
      this.log.log('important',id,'transfer','サーバー転送に追従します',{host,port,hop:n});
      const timer=setTimeout(()=>{if(this.shuttingDown||!this.store.data.resumeConnections.includes(id))return;try{this._open(id,false,{host,port});}catch(e){this.log.error(id,'transfer',e);}},300);timer.unref();this.reconnects.set(id,timer);
    });
    bot.once('spawn',()=>{clearTimeout(this.connectTimers.get(id));this.liveCodes?.delete(id);this.attempts.set(id,0);try{this.accounts.record(id,c.name,{name:bot.username});}catch(e){this.log.error(id,'auth',e);bot.disconnect();return;}this.log.log('important',id,'spawn','Minecraft入室を確認しました');});
    bot.once('end',()=>{
      clearTimeout(this.connectTimers.get(id));if(this.agents.get(id)!==agent)return;
      this.liveCodes?.delete(id);this.cycle.armed=null;this.cycle.interrupt(failure('NOT_CONNECTED',id+'が切断しました'));this.cycle.config.enabled=false;this.store.save();
      this.log.log('warn',id,'disconnect',bot.lastDisconnect||agent.lastError||'切断しました');
      if(this.shuttingDown||agent.transferring||!this.store.data.resumeConnections.includes(id)||!this.store.bot(id).reconnect)return;
      const attempts=(this.attempts.get(id)||0)+1;this.attempts.set(id,attempts);
      if(attempts>8||/wrong|違い|ban(?:ned)?|suspend|outdated|失効|not own|invalid.*token/i.test(agent.lastError||bot.lastDisconnect||'')){this.log.log('error',id,'reconnect','自動再接続を停止しました。ログを確認して手動で接続してください',{code:'RECONNECT_STOPPED'});return;}
      const ms=Math.min(300000,15000*2**(attempts-1));this.log.log('info',id,'reconnect',Math.round(ms/1000)+'秒後に再接続します');
      const timer=setTimeout(()=>{try{this.connect(id,false);}catch(e){this.log.error(id,'reconnect',e);}},ms);timer.unref();this.reconnects.set(id,timer);
    });
    const timer=setTimeout(()=>{if(!bot.connected&&!bot.ended){this.log.log('error',id,'connect','接続が15分以内に完了しませんでした',{code:'AUTH_EXPIRED'});bot.disconnect();}},900000);timer.unref();this.connectTimers.set(id,timer);
    return agent.snapshot();
  }
  disconnect(id){const job=this.connectionJobs.get(id);if(job)job.cancelled=true;this.store.data.resumeConnections=this.store.data.resumeConnections.filter(x=>x!==id);this.store.save();clearTimeout(this.reconnects.get(id));clearTimeout(this.connectTimers.get(id));this.accounts.cancel(id);this.agents.get(id)?.bot.disconnect();return{ok:true};}
  auth(id){const c=this.store.bot(id);if(!c.name)throw failure('INVALID_CONFIG','ゲーマータグを保存してください');if(this.agents.get(id)&&!this.agents.get(id).closed)return this.authState(id);return this.accounts.start(id,c.name);}
  authState(id){const s=this.accounts.snapshot(id,this.store.bot(id).name),code=this.liveCodes?.get(id),a=this.agents.get(id),job=this.connectionJobs.get(id);if(code&&code.expires>Date.now())s.code=code;if(a&&!a.closed)s.state=a.bot.connected?'connected':'connecting';if(job?.error)s.error=job.error;return s;}
  update(patch){
    if(this.cycle.running)throw failure('BOT_BUSY','回収中は設定を変更できません');
    if(this.cycle.config.enabled)throw failure('BOT_BUSY','設定変更前に自動回収を停止してください');
    for(const id of ROLES){const a=this.agents.get(id),job=this.connectionJobs.get(id);for(const k of ['name','host','port','version'])if(patch.bots?.[id]&&Object.hasOwn(patch.bots[id],k)&&patch.bots[id][k]!==this.store.bot(id)[k]&&((a&&!a.closed)||(job&&!job.finished&&!job.cancelled)))throw failure('BOT_BUSY','アカウント/接続先を変更する前に'+id+'を切断してください');}
    const result=this.store.update(patch);if(patch.automation)this.cycle.armed=null;this.log.log('info','fleet','config','設定を保存しました');return result;
  }
  async action(id,action,args={}){
    this.store.bot(id);
    if(action==='connect')return this.connect(id);
    if(action==='disconnect')return this.disconnect(id);
    if(action==='auth')return this.auth(id);
    if(action==='authStatus')return this.authState(id);
    if(action==='stop'){this.cycle.stop();const a=this.agents.get(id);a?.stop();this.store.bot(id).follow='';this.store.save();return{ok:true};}
    const agent=this.get(id);
    if(action==='command')return agent.command(args.command);
    if(action==='home')return agent.exclusive('home',signal=>agent.home(signal));
    if(action==='eat')return agent.exclusive('食事',signal=>agent.eat(args.item||'golden_apple',signal));
    if(action==='respawn'){if(!agent.bot.dead)throw failure('NOT_DEAD','死亡していません');if(agent.bot.respawnPacket)agent.bot.respawn();else{agent.bot.requestRespawn();await agent.bot.waitUntil(()=>!!agent.bot.respawnPacket,7000);agent.bot.respawn();}return{sent:true};}
    if(action==='walkPlayer')return agent.exclusive('プレイヤーへ移動',async signal=>{const target=[...agent.bot.actors.values()].find(a=>a.player&&a.name.toLowerCase()===String(args.name).toLowerCase());if(!target)throw failure('PLAYER_NOT_VISIBLE','対象の座標が受信されていません');if(agent.config.mirrorLook)agent.bot.pathLook=()=>target;try{await agent.walk(target.position,signal);if(agent.config.mirrorLook&&Number.isFinite(target.yaw))agent.bot.look(target.yaw,target.pitch||0);return{ok:true};}finally{agent.bot.pathLook=null;agent.bot.desiredMoveWorld=null;}});
    if(action==='openTrapdoor'||action==='closeTrapdoor'){if(this.cycle.running)throw failure('BOT_BUSY','回収処理中です');this.cycle.armed=null;return agent.setTrapdoor(action==='openTrapdoor');}
    if(action==='form'){agent.live();if(!agent.form||agent.form.id!==Number(args.id))throw failure('STALE_FORM','フォームが更新されました');const b=agent.bot;const modern=b.registry.protocol.types.packet_modal_form_response?.[1]?.some(f=>f.name==='has_response_data');b.client.queue('modal_form_response',{form_id:agent.form.id,...(modern?{has_response_data:true,has_cancel_reason:false}:{}),data:JSON.stringify(args.value)});agent.form=null;return{sent:true};}
    if(action==='savePosition'){agent.live();const p=xyz(agent.bot.entity.position),a=this.store.data.automation;
      if(!['home','detectorCenter','recallAnchor','pearlCenter'].includes(args.target))throw failure('INVALID_CONFIG','保存先が不正です');
      const patch={automation:{[args.target]:p}};if(args.target==='home'||args.target==='detectorCenter')patch.automation.dimension=agent.bot.dimensionId;if(args.target==='recallAnchor')patch.automation.recallDimension=agent.bot.dimensionId;
      this.update(patch);return{position:p};}
    throw failure('UNKNOWN_ACTION','未対応の操作です: '+action);
  }
  state(){return{version:'1.0.0',at:Date.now(),config:this.store.publicConfig(),storage:this.store.storage(),automation:this.cycle.snapshot(),bots:ROLES.map(id=>{const agent=this.agents.get(id);return{...(agent?agent.snapshot():{id,name:this.store.bot(id).name,connected:false,phase:'未接続'}),auth:this.authState(id)};})};}
  report(){const snapshot=this.state();for(const b of snapshot.bots){b.auth.codePending=!!b.auth.code;delete b.auth.code;}return clean({version:'1.0.0',generatedAt:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,uptime:Math.round(process.uptime())},state:snapshot,events:this.log.recent(600),notes:['回収成功はインベントリ増加、帰還成功はテレポートと座標で確認します。','他プレイヤーの体力・遠距離座標・死亡中のアイテム配信はサーバーが送信した情報だけ表示します。']});}
  async resume(){for(const id of [...this.store.data.resumeConnections]){try{this.connect(id,false);}catch(e){this.log.error(id,'resume',e);}}}
  async shutdown(){this.shuttingDown=true;for(const job of this.connectionJobs.values())job.cancelled=true;this.cycle.interrupt();this.cycle.config.enabled=false;this.store.save();clearTimeout(this.cycle.debounce);clearInterval(this.cycle.monitor);for(const timer of [...this.reconnects.values(),...this.connectTimers.values()])clearTimeout(timer);for(const a of this.agents.values())a.bot.disconnect();this.accounts.destroy();}
}
module.exports={Fleet};

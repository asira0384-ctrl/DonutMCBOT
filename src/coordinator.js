'use strict';
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { matching, distance, xyz, normal } = require('./telemetry');
const { failure } = require('./diagnostics');
class Coordinator {
  constructor(fleet) {
    this.fleet=fleet; this.state='idle'; this.running=false; this.armed=null; this.lastResult=null; this.cooldownUntil=0; this.used=new Set();
    // A saved ON setting must never assume a surviving in-world pearl after a restart.
    if(this.config.enabled){this.config.enabled=false;fleet.store.save();fleet.log.log('warn','fleet','startup','再起動後の自動回収は停止。パールの待機を再確認してください',{code:'NOT_ARMED'});}
    fleet.on('drop',(id,item)=>{
      if(id!=='detector')return;
      const center=this.config.detectorCenter||this.config.home;
      const relevant=this.config.requirements.some(r=>normal(r.name)===item.name)&&item.dimension===this.config.dimension&&center&&distance(item.position,center)<=this.config.detectRadius;
      if(relevant)fleet.log.log('important',id,'detect','対象アイテムを受信: '+item.name+' ×'+item.count,{item});
      if(!this.config.enabled||this.running||Date.now()<this.cooldownUntil)return;
      clearTimeout(this.debounce);this.debounce=setTimeout(()=>this.evaluate().catch(e=>fleet.log.error('fleet','detect',e)),75);
    });
    this.monitor=setInterval(()=>{if(this.config.enabled&&!this.running)this.evaluate().catch(e=>{this.stop();fleet.log.error('fleet','monitor',e);});},1000);this.monitor.unref();
  }
  get config(){return this.fleet.store.data.automation;}
  stage(stage,message,details={}){this.state=stage;this.fleet.log.log('important','fleet',stage,message,details,this.trace);this.fleet.emit('change');}
  snapshot(){return{state:this.state,running:this.running,armed:this.armed,lastResult:this.lastResult,cooldownUntil:this.cooldownUntil,enabled:this.config.enabled,trace:this.trace||null};}
  prepare(){
    const a=this.config,c=this.fleet.get('collector'),p=this.fleet.get('pearl');c.live();p.live();
    if(!a.home||!a.recallAnchor||!a.trapdoor||!a.pearlCenter)throw failure('INVALID_CONFIG','home・回収BOT待機位置・トラップドア・パール中心を設定してください');
    if(c.followBusy||p.followBusy||c.config.follow||p.config.follow)throw failure('BOT_BUSY','自動回収前に回収BOTとパールBOTの追従をOFFにしてください');
    if(!p.trapdoor().open)throw failure('TRAPDOOR_CLOSED','パールを保持するトラップドアを開いた状態にしてください');
    if(this.armed?.entityId&&!p.bot.actors.has(this.armed.entityId)){this.armed=null;throw failure('NOT_ARMED','待機していたパールの消失を受信しました');}
    return{c,p};
  }
  enable(){
    if(this.running)throw failure('BOT_BUSY','回収サイクルを実行中です');this.prepare();const d=this.fleet.get('detector');if(!d.bot.connected)throw failure('NOT_CONNECTED','検知BOTが未接続です');
    if(!d.bot.dead)throw failure('DETECTOR_NOT_DEAD','検知BOTを死亡画面で待機させてください');
    if(!this.armed)throw failure('NOT_ARMED','パールの待機が未確認です');
    this.config.enabled=true;this.fleet.store.save();this.stage('watching','自動回収を開始しました。死亡中のアイテム受信を監視します');
    if(!d.telemetry.itemsAfterDeath)this.fleet.log.log('warn','detector','receiver','死亡中のアイテム受信は未検証です。対象品を実際に落として確認してください',{code:'NO_ITEM_UPDATES'});
    this.evaluate().catch(e=>this.fleet.log.error('fleet','detect',e));return this.snapshot();
  }
  interrupt(error=failure('CANCELLED','停止しました')){if(this.running){this.cancelReason=error;this.controller?.abort();}}
  stop(){this.config.enabled=false;this.fleet.store.save();this.interrupt();clearTimeout(this.debounce);if(!this.running)this.stage('idle','自動回収を停止しました');return this.snapshot();}
  confirm(){if(this.running)throw failure('BOT_BUSY','回収中は手動確認を変更できません');const{c}=this.prepare();if(c.busy)throw failure('BOT_BUSY','回収BOTは操作中です');if(distance(c.bot.entity.position,this.config.recallAnchor)>this.config.recallRadius||c.bot.dimensionId!==this.config.recallDimension)throw failure('INVALID_POSITION','回収BOTが待機位置にいません');this.armed={at:Date.now(),verifiedBy:'user',entityId:null};this.stage('armed','装置内のパール待機を手動確認として登録しました');return this.snapshot();}
  async arm(signal){
    const{c,p}=this.prepare();this.armed=null;
    const previous=new Set(p.bot.actors.keys());
    await c.throwPearl(signal);
    const settled=new Map();
    try{await p.bot.waitUntil(()=>{
      const now=Date.now();let found=null;
      for(const actor of p.bot.actors.values()){
        if(previous.has(String(actor.id))||!/ender_pearl/.test(actor.name)||distance(actor.position,this.config.pearlCenter)>this.config.pearlRadius)continue;
        const key=String(actor.id),last=settled.get(key);
        if(!last||distance(last.position,actor.position)>.8)settled.set(key,{position:xyz(actor.position),since:now});
        else if(now-last.since>=2000)found=key;
      }
      if(found){this.armed={at:now,verifiedBy:'new_pearl_in_chamber',entityId:found};return true;}return false;
    },this.config.rearmTimeoutMs,signal);}catch(e){throw failure(signal?.aborted?'CANCELLED':'REARM_TIMEOUT','投げたパールの装置内待機を確認できません。投げ直す前に装置を確認してください');}
    this.stage('armed','装置内の新しいパールの待機を確認しました',this.armed);return this.armed;
  }
  async evaluate(){
    if(!this.config.enabled||this.running||Date.now()<this.cooldownUntil)return;
    const d=this.fleet.agents.get('detector');if(!d?.bot.connected||!d.bot.dead)return;
    const items=matching([...d.telemetry.drops.values()].filter(i=>!this.used.has(i.id)),this.config);
    if(items.length)await this.run(items);
  }
  totals(bot){const items=[...bot.list(),...(bot.armor||[]).filter(Boolean).map(raw=>({name:bot.name(raw),count:raw.count||1})),...(bot.offhand||[]).filter(Boolean).map(raw=>({name:bot.name(raw),count:raw.count||1}))];return Object.fromEntries(this.config.requirements.map(r=>[normal(r.name),items.filter(i=>normal(i.name)===normal(r.name)).reduce((n,i)=>n+i.count,0)]));}
  async recall(c,p,signal){
    const a=this.config, before=c.teleports;this.armed=null;this.stage('recall','トラップドアを閉じてパールを引きます');
    try{
      await p.setTrapdoor(false,signal);
      await c.bot.waitUntil(()=>c.teleports>before && c.bot.dimensionId===a.recallDimension && distance(c.bot.entity?.position,a.recallAnchor)<=a.recallRadius,a.recallTimeoutMs,signal);
      this.stage('returned','回収BOTが待機位置に戻ったことを確認しました',{position:xyz(c.bot.entity.position)});
    }catch(e){if(signal?.aborted)throw this.cancelReason||failure('CANCELLED','パール回収を停止しました');if(e.code?.startsWith('TRAPDOOR'))throw e;throw failure('RECALL_TIMEOUT','パールによる帰還を確認できません',{position:xyz(c.bot.entity?.position),teleports:c.teleports-before});}
    finally{
      // Reopen even when the return times out or the user stops. Do not send repeated blind clicks.
      try{if(p.bot.connected&&!p.bot.dead)await p.setTrapdoor(true);}catch(e){this.fleet.log.error('pearl','trapdoor_reopen',e,this.trace);throw e;}
    }
  }
  async run(items=[],manual=false){
    if(this.running)throw failure('BOT_BUSY','回収処理はすでに実行中です');
    const{c,p}=this.prepare();if(!this.armed)throw failure('NOT_ARMED','パールの待機が未確認です');
    if(c.busy||p.busy)throw failure('BOT_BUSY','回収BOTまたはパールBOTが操作中です');
    if(!manual&&!items.length)throw failure('NO_ITEMS','回収対象がありません');
    this.running=true;c.busy='回収';p.busy='パール連携';this.trace=crypto.randomUUID();this.controller=new AbortController();this.cancelReason=null;
    const signal=this.controller.signal,a=this.config,started=Date.now(),before=this.totals(c.bot);let went=false,returned=false,collected={};
    for(const i of items)this.used.add(i.id);if(this.used.size>2000)this.used=new Set([...this.used].slice(-500));
    try{
      this.stage('teleport','回収BOTをendへ移動します',{items:items.map(i=>({name:i.name,count:i.count,position:i.position}))});
      await c.home(signal);went=true;
      this.stage('pickup','落下地点で回収を確認します');
      const target=items[0];
      const pickupStart=Date.now();
      // Detection is evidence of a drop. Only authoritative inventory increases prove retrieval.
      const gained=()=>{const now=this.totals(c.bot);collected=Object.fromEntries(Object.entries(now).map(([name,count])=>[name,Math.max(0,count-(before[name]||0))]).filter(([,n])=>n>0));return Object.keys(collected).length>0;};
      if(target&&distance(c.bot.entity.position,target.position)>1.5&&distance(c.bot.entity.position,target.position)<16){
        try{await Promise.race([c.walk(target.position,signal),delay(Math.min(2500,a.pickupTimeoutMs),undefined,{signal}).then(()=>{c.bot.pathfinder?.stop();})]);}catch(e){this.fleet.log.log('warn','collector','pickup_walk',e.message,{code:e.code},this.trace);}
      }
      try{await c.bot.waitUntil(()=>gained()&&Date.now()-pickupStart>=a.minPickupMs,a.pickupTimeoutMs,signal);}catch(e){if(signal.aborted)throw this.cancelReason||failure('CANCELLED','回収を停止しました');throw failure('PICKUP_TIMEOUT','対象品のインベントリ増加がありません',{before,after:this.totals(c.bot)});}
      this.stage('collected','回収をインベントリ増加で確認しました',{collected});
      c.bot.halt();await this.recall(c,p,signal);returned=true;
      this.stage('rearm','同じ装置へパールを投げ直します');await this.arm(signal);
      this.lastResult={ok:true,started,finished:Date.now(),collected,trace:this.trace};this.cooldownUntil=Date.now()+a.cooldownMs;
      this.stage('complete','回収・帰還・パールの再待機まで完了しました',{collected});
    }catch(e){
      const error=signal.aborted?(this.cancelReason||failure('CANCELLED','操作を停止しました')):e;
      if(went&&!returned&&a.recallOnFailure&&!signal.aborted&&c.bot.connected&&!c.bot.dead&&this.armed){
        this.fleet.log.log('warn','fleet','rescue','回収失敗のため帰還を試みます',{code:error.code},this.trace);
        try{await this.recall(c,p,signal);returned=true;}catch(rescueError){this.fleet.log.error('fleet','rescue',rescueError,this.trace);}
      }
      this.config.enabled=false;this.fleet.store.save();this.lastResult={ok:false,started,finished:Date.now(),code:error.code||'ERROR',reason:error.message,collected,returned,trace:this.trace};
      this.state='failed';this.fleet.log.error('fleet','cycle',error,this.trace);
    }finally{
      c.bot.halt();p.bot.halt();c.busy=null;p.busy=null;this.running=false;this.controller=null;
      if(this.config.enabled)this.state='watching';this.fleet.emit('change');
    }
    return this.lastResult;
  }
  destroy(){this.stop();clearTimeout(this.debounce);clearInterval(this.monitor);}
}
module.exports={Coordinator};

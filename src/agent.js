'use strict';
const crypto = require('node:crypto');
const { failure } = require('./diagnostics');
const { Telemetry, normal, xyz, distance, Vec3 } = require('./telemetry');
const { useItem } = require('./protocol');
const { setTimeout: delay } = require('node:timers/promises');
class Agent {
  constructor(id, bot, fleet) {
    this.id = id; this.bot = bot; this.fleet = fleet; this.telemetry = new Telemetry(this); this.busy = null; this.handTail = Promise.resolve(); this.closed = false;
    this.followBusy = false; this.protectionBusy = false; this.lastProtection = 0; this.lastWarnings = new Map(); this.teleports = 0; this.lastError = null;
    bot.on('forcedMove', () => this.teleports++);
    bot.on('error', error => { this.lastError = require('./auth-network').details(error)||error.message; this.warn('protocol', error.code || 'PROTOCOL', this.lastError); if(!bot.connected)queueMicrotask(()=>{if(!bot.ended)bot.disconnect();}); });
    bot.on('diagnostic', text => fleet.log.log('debug', id, 'protocol', text));
    bot.on('serverMessage', text => fleet.log.log('info', id, 'server', text.replace(/\/(?:login|register|password)\s+\S+/gi, '/login [hidden]')));
    bot.on('death', () => { bot.halt();this.operationController?.abort(); this.fleet.log.log('important', id, 'death', id === 'detector' ? '死亡画面で検知待機。自動リスポーンは行いません' : 'BOTが死亡しました', { code: id === 'detector' ? null : 'DEAD' }); if (id !== 'detector') {fleet.cycle?.interrupt(failure('DEAD', id + 'が死亡しました'));if(fleet.cycle)fleet.cycle.armed=null;fleet.store.data.automation.enabled=false;fleet.store.save();} });
    bot.on('totemUsed', () => {
      fleet.log.log('important', id, 'totem', 'トーテム発動。持ち替え・補充を実行します');
      const slot = bot.items.findIndex((i,slot) => slot < 9 && /totem/.test(bot.name(i)) && slot !== bot.quickBarSlot);
      if (this.config.autoTotem && slot >= 0 && !bot.handUse) { try { bot.select(slot, true); } catch (e) { this.warn('totem', 'INVENTORY_REJECTED', e.message); } }
      this.lastProtection = 0; this.protect();
    });
    bot.client.on('modal_form_request', p => { try { this.form = { id: p.form_id, data: JSON.parse(p.data) }; } catch { this.form = { id: p.form_id, data: { type:'unknown', title:'フォームを読み取れません' } }; } });
    bot.on('end', () => { this.closed = true; clearInterval(this.timer); });
    this.timer = setInterval(() => { this.protect(); this.follow(); }, 150); this.timer.unref();
  }
  get config() { return this.fleet.store.bot(this.id); }
  live() { if (!this.bot.connected || this.bot.ended) throw failure('NOT_CONNECTED', this.id + 'は未接続です'); if (this.bot.dead) throw failure('DEAD', this.id + 'は死亡画面です'); return this.bot; }
  warn(stage, code, text) { const key = stage+':'+text; if (Date.now()-(this.lastWarnings.get(key)||0)<15000) return; this.lastWarnings.set(key,Date.now()); this.fleet.log.log('warn',this.id,stage,text,{code}); }
  async exclusive(stage, task) {
    if (this.busy) throw failure('BOT_BUSY', `${this.id}は${this.busy}を実行中です`); this.busy = stage;this.operationController=new AbortController();
    try { return await task(this.operationController.signal); } finally { this.busy = null;this.operationController=null; }
  }
  stop(){this.operationController?.abort();this.bot.halt();this.bot.pathLook=null;this.bot.desiredMoveWorld=null;}
  async hand(task) { const p = this.handTail.catch(()=>{}).then(task); this.handTail = p.catch(()=>{}); return p; }
  async command(command, { internal = false } = {}) {
    const b = this.live(); if (!internal && (this.busy || this.fleet.cycle?.running)) throw failure('BOT_BUSY', this.id + 'は回収処理または'+this.busy+'中です');
    if (typeof command !== 'string' || !/^\/[^\r\n\x00]{1,219}$/.test(command)) throw failure('INVALID_COMMAND','コマンドは/から1行で入力してください');
    const types = b.registry?.protocol.types.packet_command_request?.[1];
    b.client.queue('command_request', { command, origin:{ type:'player', uuid:crypto.randomUUID(), request_id:crypto.randomUUID(), player_entity_id:BigInt(b.client.startGameData?.entity_id||0) }, internal:false, version:types?.find(f=>f.name==='version')?.type==='string' ? b.client.options.version : 0 });
    this.fleet.log.log('info', this.id, 'command', 'コマンド送信: ' + command.split(/\s/)[0] + '（実行結果はサーバーログを確認）');
    return { sent:true, confirmed:false };
  }
  async home(signal) {
    const b = this.live(), a = this.fleet.store.data.automation;
    if (!a.home) throw failure('INVALID_CONFIG', 'endの到着確認座標を保存してください');
    const already = b.dimensionId===a.dimension && distance(b.entity.position,a.home)<=a.homeRadius,startingDimension=b.dimensionId;
    const before = this.teleports;
    await this.command(a.homeCommand,{internal:true});
    try { await b.waitUntil(() => b.dimensionId===a.dimension && distance(b.entity?.position,a.home)<=a.homeRadius && (already || this.teleports>before || b.dimensionId !== startingDimension), a.arrivalTimeoutMs, signal); }
    catch(e) { if(signal?.aborted) throw failure('CANCELLED','home移動を停止しました'); throw failure('HOME_TIMEOUT','/homeの到着を確認できません',{target:a.home,position:xyz(b.entity?.position),dimension:b.dimensionId}); }
    this.fleet.log.log('important',this.id,'home','endの到着座標を確認しました',{position:xyz(b.entity.position)});
  }
  async walk(position, signal) {
    const b = this.live(); if (this.followBusy) throw failure('BOT_BUSY','追従中です');
    try { await b.go(new Vec3(position.x,position.y,position.z).floored(),signal); }
    catch(e) { throw failure(signal?.aborted?'CANCELLED':'MOVE_REJECTED',e.message,{target:xyz(position),physics:b.physicsState}); }
    if (distance(b.entity?.position,position)>2.8) throw failure('MOVE_REJECTED','指定座標に到着できませんでした');
  }
  async protect() {
    const b = this.bot; if (this.protectionBusy || !b.connected || b.dead || !b.registry || Date.now()-this.lastProtection<600) return;
    if (!this.config.autoArmor && !this.config.autoTotem) return;
    this.protectionBusy=true; this.lastProtection=Date.now();
    try { await this.hand(async()=>{
      if (!b.connected||b.dead||b.handUse||b.actionHandBusy) return;
      const armor = this.config.autoArmor;
      await require('./equipment').wear(b,{armor,totem:this.config.autoTotem});
      if (!this.config.autoTotem) return;
      const slots=this.config.totemSlots;
      for (let dest=0;dest<slots;dest++) if (!/totem/.test(b.name(b.items[dest]))) {
        const source=b.list().find(i=>/totem/.test(i.name)&&i.slot>=slots); if (!source) break;
        await b.openInventory(); try { await b.swap(source.slot,dest); } finally { b.closeContainer(); }
      }
      if (!b.handUse && !b.actionHandBusy) { const slot=b.items.findIndex((i,j)=>j<9&&/totem/.test(b.name(i))); if(slot>=0)b.select(slot); }
    }); } catch(e) { if(b.connected&&!b.dead) this.warn('equipment','INVENTORY_REJECTED',e.message); }
    finally { this.protectionBusy=false; }
  }
  async eat(name, signal) {
    return this.hand(async()=>{
      const b=this.live(); const food=b.list().find(i=>normal(i.name)===normal(name));
      if (!['golden_apple','enchanted_golden_apple','cooked_beef'].includes(normal(name))) throw failure('INVALID_FOOD','金リンゴ・エンチャ金リンゴ・ステーキを選んでください');
      if (!food) throw failure('NO_FOOD','指定した食料がありません');
      try { await require('./item-use').consume(b,food,'food',signal); }
      catch(e) { throw failure(signal?.aborted?'CANCELLED':'FOOD_TIMEOUT',e.message); }
      this.fleet.log.log('important',this.id,'food','食事完了をインベントリの減少で確認: '+name);
    });
  }
  trapdoor() {
    const b=this.live(), p=this.fleet.store.data.automation.trapdoor;
    const block=p&&b.blockAt(new Vec3(p.x,p.y,p.z));
    if(!block||!/_trapdoor$/.test(block.name)||!b.reach(block))throw failure('TRAPDOOR_UNKNOWN','トラップドアが未受信・範囲外・座標違いです',{position:p,block:block?.name});
    const value=block.properties?.open_bit??block.properties?.open;
    if(value===undefined) throw failure('TRAPDOOR_UNKNOWN','トラップドアの開閉状態を読み取れません');
    return {block,open:value===true||value===1||value==='true'||value==='1'};
  }
  async setTrapdoor(open, signal) {
    return this.hand(async()=>{
      const b=this.live(), initial=this.trapdoor(); if(initial.open===open)return;
      b.clearControlStates(); b.lookAt(initial.block.position.offset(.5,.5,.5));
      // Empty hand prevents an accidental block placement or pearl throw.
      let empty=b.items.findIndex((i,j)=>j<9&&!i);
      if(empty<0){const spare=b.items.findIndex((i,j)=>j>=9&&!i);if(spare<0)throw failure('INVENTORY_REJECTED','パールBOTの手を空けるための空き枠がありません');await b.openInventory(signal);try{await b.swapContainer('hotbar_and_inventory',0,'hotbar_and_inventory',spare,signal);}finally{b.closeContainer();}empty=0;}
      b.select(empty);b.client.queue('inventory_transaction',useItem(b,'click_block',initial.block.position,1,initial.block.stateId));
      try{await b.waitUntil(()=>this.trapdoor().open===open,5000,signal);}catch(e){throw failure(signal?.aborted?'CANCELLED':'TRAPDOOR_TIMEOUT','トラップドアの'+(open?'開':'閉')+'を確認できません');}
      this.fleet.log.log('important',this.id,'trapdoor','トラップドア: '+(open?'開':'閉')+'を確認しました');
    });
  }
  async throwPearl(signal) {
    return this.hand(async()=>{
      const b=this.live(), a=this.fleet.store.data.automation, item=b.find('ender_pearl');
      if(!item)throw failure('NO_PEARL','回収BOTにエンダーパールがありません');
      if(!a.recallAnchor||distance(b.entity.position,a.recallAnchor)>a.recallRadius||b.dimensionId!==a.recallDimension)throw failure('INVALID_POSITION','パールを投げる待機位置にいません');
      const before=b.count('ender_pearl');b.actionHandBusy=true;
      try{await b.equip(item.slot,signal);b.look(a.throwYaw*Math.PI/180,a.throwPitch*Math.PI/180);await delay(100,undefined,{signal});
        b.client.queue('inventory_transaction',useItem(b,'click_air',{x:0,y:0,z:0},-1));
        try{await b.waitUntil(()=>b.count('ender_pearl')<before,5000,signal);}catch(e){throw failure('REARM_TIMEOUT','投擲によるパール個数の減少を確認できません');}
      }finally{b.actionHandBusy=false;}
      this.fleet.log.log('important',this.id,'pearl','パール投擲を確認。装置内の待機確認は別の段階です');
    });
  }
  async follow() {
    const b=this.bot,c=this.config;if(!c.follow||this.followBusy||this.busy||!b.connected||b.dead||this.fleet.cycle?.running)return;
    const target=[...b.actors.values()].find(a=>a.player&&a.name.toLowerCase()===c.follow.toLowerCase()&&a.dimension===b.dimensionId);
    if(!target){this.warn('follow','PLAYER_NOT_VISIBLE','対象の座標が届いていません: '+c.follow);return;}
    this.followBusy=true;
    try{if(c.mirrorLook)b.pathLook=()=>[...b.actors.values()].find(a=>a.player&&a.name.toLowerCase()===c.follow.toLowerCase());if(distance(b.entity.position,target.position)>1.8)await b.go(target.position.floored());
      if(c.mirrorLook&&Number.isFinite(target.yaw)&&Number.isFinite(target.pitch))b.look(target.yaw,target.pitch);
    }catch(e){if(b.connected)this.warn('follow','MOVE_REJECTED',e.message);}finally{b.pathLook=null;b.desiredMoveWorld=null;this.followBusy=false;}
  }
  snapshot() { return {id:this.id,name:this.config.name,connected:this.bot.connected,phase:this.bot.connectionPhase,busy:this.busy,lastError:this.lastError,form:this.form||null,...this.telemetry.snapshot()}; }
}
module.exports={Agent};

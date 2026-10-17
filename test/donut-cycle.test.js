'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {State}=require('../src/state'),{Diagnostics}=require('../src/diagnostics'),{Fleet}=require('../src/fleet'),{Agent}=require('../src/agent'),{Vec3}=require('vec3');
const {adapter}=require('./helpers/adapter');
function fixture(t,{pickup=true,recall=true,rearm=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'donut-cycle-'));const state=new State(dir),log=new Diagnostics(dir,{quiet:true});
 for(const id of ['collector','pearl','detector'])state.update({bots:{[id]:{name:'Aslrq6th',autoArmor:false,autoTotem:false}}});
 state.update({automation:{home:{x:0,y:64,z:0},recallAnchor:{x:100,y:64,z:100},trapdoor:{x:101,y:65,z:100},pearlCenter:{x:100,y:66,z:100},arrivalTimeoutMs:700,pickupTimeoutMs:150,recallTimeoutMs:150,rearmTimeoutMs:3000,minPickupMs:0,cooldownMs:50}});
 const fleet=new Fleet(state,log),d=adapter(t),c=adapter(t),p=adapter(t);const all={detector:d,collector:c,pearl:p};
 for(const[id,f]of Object.entries(all)){f.b.dimensionId=id==='detector'?2:0;f.b.entity.position=id==='detector'?new Vec3(0,64,0):new Vec3(100,64,100);fleet.agents.set(id,new Agent(id,f.b,fleet));}
 d.b.markDead('test');d.b.players.set('java player',{name:'Java Player',uuid:'java',xuid:null});
 c.b.items[5]={...c.item('ender_pearl',50),count:16};
 let open=true,closes=0;
 p.b.blockAt=point=>Math.floor(point.x)===101&&Math.floor(point.y)===65?{name:'oak_trapdoor',position:new Vec3(101,65,100),properties:{open_bit:open},stateId:123}:null;
 p.b.entity.position=new Vec3(101,64,100);
 const pQueue=p.c.queue;p.c.queue=(name,params)=>{
   pQueue(name,params);
   if(name==='inventory_transaction'&&params.transaction.transaction_type==='item_use'&&params.transaction.transaction_data.action_type==='click_block')queueMicrotask(()=>{
     open=!open;p.b.emit('worldUpdate');if(!open){closes++;if(recall){c.c.emit('change_dimension',{dimension:0,position:{x:100,y:65.62,z:100}});c.c.emit('move_player',{runtime_id:c.b._runtimeEntityId,position:{x:100,y:65.62,z:100},yaw:0,pitch:0,mode:'teleport'});}}
   });
 };
 const cQueue=c.c.queue;c.c.queue=(name,params)=>{
   cQueue(name,params);
   if(name==='command_request')queueMicrotask(()=>{c.c.emit('change_dimension',{dimension:2,position:{x:0,y:65.62,z:0}});c.c.emit('move_player',{runtime_id:c.b._runtimeEntityId,position:{x:0,y:65.62,z:0},mode:'teleport'});if(pickup)c.c.emit('inventory_slot',{window_id:'inventory',slot:9,item:c.item('elytra',80)});});
   if(name==='inventory_transaction'&&params.transaction.transaction_type==='item_use'&&params.transaction.transaction_data.action_type==='click_air')queueMicrotask(()=>{const slot=c.b.quickBarSlot;c.c.emit('inventory_slot',{window_id:'inventory',slot,item:{...c.b.items[slot],count:c.b.items[slot].count-1}});if(rearm)p.c.emit('add_entity',{runtime_id:555n,unique_id:555n,entity_type:'minecraft:ender_pearl',position:{x:100,y:66,z:100},metadata:[]});});
 };
 fleet.cycle.armed={verifiedBy:'test',at:Date.now()};
 t.after(async()=>{await fleet.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
 return{fleet,c,p,d,get open(){return open;},get closes(){return closes;}};
}
test('complete cycle uses actual command, item-use, inventory and teleport packets; rearms only after a pearl remains in the chamber',async t=>{
 const f=fixture(t);const result=await f.fleet.cycle.run([{id:'loot',name:'elytra',count:1,position:{x:0,y:64,z:0}}]);
 assert.equal(result.ok,true);assert.equal(result.collected.elytra,1);assert.equal(f.closes,1);assert.equal(f.open,true);assert.equal(f.fleet.cycle.armed.verifiedBy,'new_pearl_in_chamber');
 const stages=f.fleet.log.entries.map(e=>e.stage);assert(stages.includes('collected'));assert(stages.includes('returned'));assert(stages.includes('complete'));
 assert.equal(f.c.b.find('elytra').count,1);assert.equal(f.c.b.count('ender_pearl'),15);
});
test('drop detection alone never proves pickup; a missed pickup stops automation and attempts a safe pearl return',async t=>{
 const f=fixture(t,{pickup:false});f.fleet.store.data.automation.enabled=true;
 const result=await f.fleet.cycle.run([{id:'stolen',name:'elytra',count:1,position:{x:0,y:64,z:0}}]);
 assert.equal(result.ok,false);assert.equal(result.code,'PICKUP_TIMEOUT');assert.equal(result.returned,true);assert.equal(f.fleet.cycle.config.enabled,false);assert.equal(f.open,true);assert.equal(f.fleet.cycle.armed,null);
 assert(!f.fleet.log.entries.some(e=>e.stage==='complete'));
});
test('a closed trapdoor does not prove return; missing teleport stops the run and the door reopens',async t=>{
 const f=fixture(t,{recall:false});const result=await f.fleet.cycle.run([{id:'loot',name:'elytra',count:1,position:{x:0,y:64,z:0}}]);
 assert.equal(result.ok,false);assert.equal(result.code,'RECALL_TIMEOUT');assert.equal(f.open,true);assert.equal(f.fleet.cycle.armed,null);
 assert.equal(f.c.b.count('ender_pearl'),16,'must not throw a new pearl from the wrong location');
});
test('a consumed pearl without a visible settled projectile never becomes an armed station',async t=>{
 const f=fixture(t,{rearm:false});f.fleet.store.data.automation.rearmTimeoutMs=100;
 const result=await f.fleet.cycle.run([{id:'loot',name:'elytra',count:1,position:{x:0,y:64,z:0}}]);
 assert.equal(result.ok,false);assert.equal(result.code,'REARM_TIMEOUT');assert.equal(f.fleet.cycle.armed,null);assert.equal(f.open,true);
});
test('dead detector keeps item packets and no respawn is sent; combat reads server text and hidden health stays unknown',t=>{
 const f=fixture(t);f.d.c.emit('add_item_entity',{runtime_entity_id:900n,entity_id_self:900n,item:f.d.item('elytra'),position:{x:0,y:64,z:0}});
 assert.equal(f.fleet.get('detector').telemetry.itemsAfterDeath,1);assert.equal(f.d.b.dead,true);
 assert.equal(f.d.packets.filter(p=>p.name==='respawn').length,0);
 f.c.c.emit('set_title',{type:'action_bar_message',text:'§cCombat: 14s'});assert.equal(f.fleet.get('collector').snapshot().combat.seconds,14);
 assert.equal(f.fleet.get('detector').snapshot().players[0].health,null);
});
test('stop cancels an in-flight pickup and does not launch a second cycle or report completion',async t=>{
 const f=fixture(t,{pickup:false});f.fleet.store.data.automation.pickupTimeoutMs=5000;const pending=f.fleet.cycle.run([{id:'wait',name:'elytra',count:1,position:{x:0,y:64,z:0}}]);
 await new Promise(resolve=>setTimeout(resolve,40));await assert.rejects(f.fleet.cycle.run([],true),e=>e.code==='BOT_BUSY');f.fleet.cycle.stop();const result=await pending;
 assert.equal(result.ok,false);assert.equal(result.code,'CANCELLED');assert.equal(f.fleet.cycle.running,false);assert(!f.fleet.log.entries.some(e=>e.stage==='complete'));
});
test('known pearl disappearance blocks travel before the home command can be sent',async t=>{
 const f=fixture(t);f.fleet.cycle.armed={at:Date.now(),verifiedBy:'new_pearl_in_chamber',entityId:'missing'};
 await assert.rejects(f.fleet.cycle.run([],true),e=>e.code==='NOT_ARMED');assert.equal(f.c.packets.filter(p=>p.name==='command_request').length,0);
});
test('a newly equipped armor piece still counts as collected; pre-existing equipped items are included in the baseline',t=>{
 const f=fixture(t);f.fleet.store.data.automation.requirements=[{name:'diamond_helmet',count:1}];assert.equal(f.fleet.cycle.totals(f.c.b).diamond_helmet,0);
 f.c.b.armor[0]=f.c.item('diamond_helmet',91);assert.equal(f.fleet.cycle.totals(f.c.b).diamond_helmet,1);
 f.c.b.items[12]=f.c.item('diamond_helmet',92);assert.equal(f.fleet.cycle.totals(f.c.b).diamond_helmet,2);
});

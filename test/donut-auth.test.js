'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const bedrock=require('bedrock-protocol');
const {State}=require('../src/state'),{Diagnostics}=require('../src/diagnostics'),{Fleet}=require('../src/fleet');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'donut-auth-')),state=new State(dir),log=new Diagnostics(dir,{quiet:true}),fleet=new Fleet(state,log),flows=[],clients=[];
 state.update({bots:{collector:{name:'Asira Collector',autoArmor:false,autoTotem:false}}});
 class Flow{constructor(username,directory,options,onCode){this.directory=directory;this.onCode=onCode;this.msa={};flows.push(this);}getMinecraftBedrockToken(){this.onCode({user_code:'PRIVATE-DEVICE-CODE',expires_in:600});return new Promise((resolve,reject)=>{this.reject=reject;this.finish=name=>{fs.mkdirSync(this.directory,{recursive:true});fs.writeFileSync(path.join(this.directory,'user_live-cache.json'),JSON.stringify({token:{refresh_token:'PRIVATE-REFRESH-TOKEN'}}));resolve({chain:['header.payload.signature','header.'+Buffer.from(JSON.stringify({extraData:{displayName:name}})).toString('base64url')+'.signature']});};});}}
 fleet.accounts.Flow=Flow;fleet.accounts.run=(_scope,fn)=>fn();
 const original=bedrock.createClient;bedrock.createClient=options=>{const c=new EventEmitter();c.options={...options,version:options.version||'1.26.51'};c.profile={name:'Asira Collector'};c.queue=()=>{};c.close=()=>{if(!c._closed){c._closed=true;c.emit('close');}};c.disconnect=c.close;clients.push(c);return c;};
 t.after(async()=>{await fleet.shutdown();bedrock.createClient=original;fs.rmSync(dir,{recursive:true,force:true});});
 return{dir,fleet,flows,clients};
}
test('connect waits for exactly one account-verified device login; report hides device codes; saved credentials survive restart',async t=>{
 const f=fixture(t);f.fleet.connect('collector');assert.equal(f.flows.length,1);assert.equal(f.clients.length,0);assert.equal(f.fleet.authState('collector').code.value,'PRIVATE-DEVICE-CODE');
 f.fleet.connect('collector');assert.equal(f.flows.length,1);const before=JSON.stringify(f.fleet.report());assert(!before.includes('PRIVATE-DEVICE-CODE'));
 f.flows[0].finish('Asira Collector');await f.fleet.connectionJobs.get('collector').promise;assert.equal(f.clients.length,1);
 const c=f.clients[0];c.startGameData={runtime_entity_id:11n,entity_id:11n,player_position:{x:0,y:65.62,z:0},rotation:{x:0,y:0},dimension:0};c.emit('start_game',c.startGameData);f.fleet.get('collector').bot.physicsEnabled=false;c.emit('spawn');
 assert.equal(f.fleet.authState('collector').state,'connected');assert(f.fleet.authState('collector').saved);
 assert(!JSON.stringify(f.fleet.report()).includes('PRIVATE-REFRESH-TOKEN'));assert(f.fleet.report().state.bots.find(b=>b.id==='collector').auth.saved);
 const newState=new State(f.dir);assert(newState.bot('collector').authAccounts);assert(fs.existsSync(f.fleet.accounts.directory('collector','Asira Collector')));
 f.fleet.disconnect('collector');f.fleet.connect('collector');await f.fleet.connectionJobs.get('collector').promise;assert.equal(f.flows.length,1,'cached login must not request a new code');assert.equal(f.clients.length,2);
});
test('disconnect during login prevents a late successful code from joining',async t=>{
 const f=fixture(t);f.fleet.connect('collector');const pending=f.fleet.connectionJobs.get('collector').promise;f.fleet.disconnect('collector');f.flows[0].finish('Asira Collector');await pending;assert.equal(f.clients.length,0);assert.deepEqual(f.fleet.store.data.resumeConnections,[]);
});
test('wrong gamer tag cannot join; user can retry and changing account data during login is blocked',async t=>{
 const f=fixture(t);f.fleet.connect('collector');assert.throws(()=>f.fleet.update({bots:{collector:{name:'Other'}}}),/切断/);f.flows[0].finish('Wrong Person');await f.fleet.connectionJobs.get('collector').promise;
 assert.equal(f.clients.length,0);assert.match(f.fleet.authState('collector').error,/違います/);f.fleet.connect('collector');assert.equal(f.flows.length,2);
 f.fleet.disconnect('collector');
});
test('server transfer follows the destination once and manual disconnect cancels a queued transfer',async t=>{
 const f=fixture(t);f.fleet.connect('collector');f.flows[0].finish('Asira Collector');await f.fleet.connectionJobs.get('collector').promise;
 f.clients[0].emit('transfer',{server_address:'world.example',port:19134});assert(f.clients[0]._closed);
 await new Promise(resolve=>setTimeout(resolve,350));assert.equal(f.clients.length,2);assert.equal(f.clients[1].options.host,'world.example');assert.equal(f.clients[1].options.port,19134);
 f.clients[1].emit('transfer',{server_address:'next.example',port:19135});f.fleet.disconnect('collector');await new Promise(resolve=>setTimeout(resolve,350));assert.equal(f.clients.length,2);
});

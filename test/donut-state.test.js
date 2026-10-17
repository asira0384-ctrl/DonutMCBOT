'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {State,defaults,validate}=require('../src/state');
const {matching,plain}=require('../src/telemetry');
test('saved account settings survive a new process; invalid patches are atomic and cannot enable automation',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'donut-state-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new State(dir);
 s.update({bots:{collector:{name:'Asira Collector',totemSlots:5}},automation:{requirements:[{name:'elytra',count:2}]}});
 const reloaded=new State(dir);assert.equal(reloaded.bot('collector').name,'Asira Collector');assert.equal(reloaded.data.automation.requirements[0].count,2);
 assert.throws(()=>s.update({automation:{requirements:[{name:'elytra',count:-1}]}}));assert.equal(s.data.automation.requirements[0].count,2);
 s.update({automation:{enabled:true}});assert.equal(s.data.automation.enabled,false);
 assert.throws(()=>s.update({bots:{collector:{port:1.5}}}));validate(defaults());
});
test('any/all item matching sums stacks and excludes other dimensions, stale drops, and other locations',()=>{
 const a={...defaults().automation,home:{x:0,y:64,z:0},requirements:[{name:'elytra',count:2},{name:'diamond_helmet',count:1}],match:'all'};
 const drop=(id,name,count,extra={})=>({id,name,count,position:{x:1,y:64,z:0},dimension:2,at:10000,...extra});
 const drops=[drop('1','elytra',1),drop('2','elytra',1)];assert.equal(matching(drops,a,11000).length,0);
 drops.push(drop('3','diamond_helmet',1));assert.equal(matching(drops,a,11000).length,3);
 assert.equal(matching(drops.map(d=>({...d,dimension:0})),a,11000).length,0);assert.equal(matching(drops,a,30000).length,0);
 assert.equal(matching(drops.map(d=>({...d,position:{x:200,y:64,z:0}})),a,11000).length,0);
 a.match='any';assert.equal(matching(drops.slice(0,2),a,11000).length,2);
 assert.equal(plain('{"rawtext":[{"text":"§cCombat: 14s"}]}'),'Combat: 14s');
});

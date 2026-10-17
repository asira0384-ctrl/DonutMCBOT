'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {adapter}=require('./helpers/adapter');
function floor(bot){bot.blockAt=p=>{const y=Math.floor(p.y),solid=y<64;return{name:solid?'stone':'air',position:new Vec3(Math.floor(p.x),y,Math.floor(p.z)),boundingBox:solid?'block':'empty',solid,isAir:!solid,shapes:solid?[[0,0,0,1,1,1]]:[]};};bot.entity.position=new Vec3(.5,64,.5);bot.entity.velocity=new Vec3(0,0,0);bot.entity.onGround=true;bot.physicsEnabled=true;bot.emit('spawn');}
test('walking can preserve another player look direction while moving along the world path',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const{b,packets}=adapter(t);floor(b);b.pathLook=()=>({yaw:Math.PI/2,pitch:.2});
 const promise=b.go(new Vec3(4,64,0));let finished=false;promise.then(()=>finished=true,()=>finished=true);
 for(let i=0;i<100&&!finished;i++){t.mock.timers.tick(50);await Promise.resolve();}
 await promise;assert(b.entity.position.x>=4);assert(Math.abs(b.entity.yaw-Math.PI/2)<1e-8);
 const moves=packets.filter(p=>p.name==='player_auth_input');assert(moves.length>3);assert(Math.abs(moves.at(-1).params.yaw-90)<1e-8);
});
test('death wait sends no movement or respawn, and does not simulate falling from the death location',t=>{
 t.mock.timers.enable({apis:['setInterval']});const{b,packets}=adapter(t);floor(b);b.entity.position=new Vec3(0,100,0);b.markDead('test');const count=packets.length;t.mock.timers.tick(1000);
 assert.equal(b.entity.position.y,100);assert.equal(b.physicsState.mode,'dead');assert.equal(packets.slice(count).filter(p=>['player_auth_input','move_player','respawn'].includes(p.name)).length,0);
});

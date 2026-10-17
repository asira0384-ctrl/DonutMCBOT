'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {State}=require('../src/state'),{Diagnostics}=require('../src/diagnostics'),{Fleet}=require('../src/fleet'),{WebServer}=require('../src/web-server');
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'donut-web-'));const s=new State(dir),f=new Fleet(s,new Diagnostics(dir,{quiet:true}));const web=new WebServer(f,{password:'private-test-password-123'});const server=http.createServer((req,res)=>web.handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{web.close();await f.shutdown();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 return{base,f,web,request:(route,options={})=>fetch(base+route,options)};
}
test('Web API protects state, actions and debug; login sets an HttpOnly cookie; edits require same-origin request marker',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/health')).status,200);assert.equal((await f.request('/api/state')).status,401);assert.equal((await f.request('/api/debug')).status,401);
 const publicHtml=await f.request('/');assert.equal(publicHtml.status,200);assert((await publicHtml.text()).includes('DonutBOT'));
 const headers={'content-type':'application/json','x-requested-with':'DonutBOT'};
 const response=await f.request('/api/login',{method:'POST',headers,body:JSON.stringify({password:'private-test-password-123'})});assert.equal(response.status,200);
 const raw=response.headers.get('set-cookie');assert.match(raw,/HttpOnly/);assert.match(raw,/SameSite=Strict/);const cookie=raw.split(';')[0];
 assert.equal((await f.request('/api/state',{headers:{cookie}})).status,200);
 assert.equal((await f.request('/api/config',{method:'PATCH',headers:{cookie},body:'{}'})).status,403);
 assert.equal((await f.request('/api/config',{method:'PATCH',headers:{...headers,cookie,origin:'https://attacker.invalid'},body:'{}'})).status,403);
 const changed=await f.request('/api/config',{method:'PATCH',headers:{...headers,cookie},body:JSON.stringify({bots:{collector:{name:'Saved From Web'}}})});assert.equal(changed.status,200);assert.equal(f.f.store.bot('collector').name,'Saved From Web');
 const invalid=await f.request('/api/action',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({bot:'collector',action:'eat',args:{item:'golden_apple'}})});assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'NOT_CONNECTED');
 const report=await f.request('/api/debug',{headers:{cookie}});assert.equal(report.status,200);assert.match(report.headers.get('content-disposition'),/DonutBOT-debug/);assert(!(await report.text()).includes('private-test-password'));
 assert.equal((await f.request('/catalog.json')).status,200);assert.equal((await f.request('/items.png')).status,200);
 assert.equal((await f.request('/.env')).status,404);assert.equal((await f.request('/src/index.js')).status,404);
 const corrupt=cookie.slice(0,-2)+'xx';assert.equal((await f.request('/api/state',{headers:{cookie:corrupt}})).status,401);
});
test('Web login throttles repeated wrong passwords and never exposes bot state',async t=>{
 const f=await fixture(t),options={method:'POST',headers:{'content-type':'application/json','x-requested-with':'DonutBOT'},body:'{"password":"wrong"}'};
 for(let i=0;i<10;i++)assert.equal((await f.request('/api/login',options)).status,401);
 assert.equal((await f.request('/api/login',options)).status,429);assert.equal((await f.request('/api/state')).status,401);
});

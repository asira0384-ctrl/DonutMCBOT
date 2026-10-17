'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {failure}=require('./diagnostics');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
class WebServer {
  constructor(fleet,{password=process.env.WEB_PASSWORD,secret=process.env.WEB_SESSION_SECRET,now=Date.now}={}){
    if(!password||password.length<12)throw Error('WEB_PASSWORDを12文字以上で設定してください');
    this.fleet=fleet;this.password=password;this.secret=secret||crypto.createHash('sha256').update('DonutBOT:'+password).digest('hex');this.now=now;this.attempts=new Map();this.clients=new Set();this.root=path.resolve(__dirname,'../web');
    this.onEntry=e=>this.broadcast('log',e);fleet.log.on('entry',this.onEntry);
    this.timer=setInterval(()=>this.broadcast('state',fleet.state()),1000);this.timer.unref();
  }
  token(){const body=Buffer.from(JSON.stringify({expires:this.now()+8*3600000,nonce:crypto.randomUUID()})).toString('base64url');return body+'.'+crypto.createHmac('sha256',this.secret).update(body).digest('base64url');}
  authorized(req){try{const token=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('donut_session='))?.slice(14);const[body,sig]=String(token||'').split('.');return equal(sig||'',crypto.createHmac('sha256',this.secret).update(body||'').digest('base64url'))&&JSON.parse(Buffer.from(body,'base64url').toString()).expires>this.now();}catch{return false;}}
  headers(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");res.setHeader('Cache-Control','no-store');}
  json(res,status,value){res.writeHead(status,{'Content-Type':mime['.json']});res.end(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v));}
  async body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>131072)throw failure('PAYLOAD_TOO_LARGE','入力が大きすぎます');}try{return JSON.parse(text||'{}');}catch{throw failure('BAD_JSON','JSONの形式が不正です');}}
  secure(req){return req.socket.encrypted||req.headers['x-forwarded-proto']==='https';}
  sameOrigin(req){const host=req.headers.host;return req.headers['x-requested-with']==='DonutBOT'&&(!req.headers.origin||new URL(req.headers.origin).host===host);}
  async handle(req,res){
    this.headers(res);
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/health'){return this.json(res,200,{ok:true,service:'DonutBOT',version:'1.0.0'});}
      if(req.method==='POST'&&url.pathname==='/api/login'){
        if(!this.sameOrigin(req))return this.json(res,403,{error:'このページからログインしてください'});
        const key=req.socket.remoteAddress||'unknown',now=this.now();let entry=this.attempts.get(key);if(!entry||now-entry.at>900000){entry={at:now,n:0};this.attempts.set(key,entry);}
        if(this.attempts.size>2000)for(const[k,v]of this.attempts)if(now-v.at>900000)this.attempts.delete(k);
        if(entry.n>=10)return this.json(res,429,{error:'ログイン試行が多すぎます。15分後に再試行してください'});
        const data=await this.body(req);if(!equal(data.password||'',this.password)){entry.n++;return this.json(res,401,{error:'パスワードが違います'});}
        this.attempts.delete(key);res.setHeader('Set-Cookie',`donut_session=${this.token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${this.secure(req)?'; Secure':''}`);return this.json(res,200,{ok:true});
      }
      if(url.pathname.startsWith('/api/')){
        if(!this.authorized(req))return this.json(res,401,{error:'ログインが必要です'});
        if(req.method!=='GET'&&!this.sameOrigin(req))return this.json(res,403,{error:'送信元を確認できません'});
        if(req.method==='POST'&&url.pathname==='/api/logout'){res.setHeader('Set-Cookie','donut_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return this.json(res,200,{ok:true});}
        if(req.method==='GET'&&url.pathname==='/api/state')return this.json(res,200,this.fleet.state());
        if(req.method==='GET'&&url.pathname==='/api/logs')return this.json(res,200,this.fleet.log.recent());
        if(req.method==='GET'&&url.pathname==='/api/debug'){res.setHeader('Content-Disposition','attachment; filename="DonutBOT-debug.json"');return this.json(res,200,this.fleet.report());}
        if(req.method==='GET'&&url.pathname==='/api/events'){
          if(this.clients.size>=20)return this.json(res,429,{error:'接続数が多すぎます'});
          res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('retry: 3000\n\n');this.clients.add(res);
          const expiry=setTimeout(()=>res.end(),8*3600000);expiry.unref();req.on('close',()=>{this.clients.delete(res);clearTimeout(expiry);});
          res.write('event: state\ndata: '+JSON.stringify(this.fleet.state())+'\n\n');return;
        }
        if(req.method==='PATCH'&&url.pathname==='/api/config'){const data=await this.body(req);return this.json(res,200,this.fleet.update(data));}
        if(req.method==='POST'&&url.pathname==='/api/action'){
          const data=await this.body(req);const result=await this.fleet.action(data.bot,data.action,data.args);return this.json(res,200,{ok:true,result});
        }
        if(req.method==='POST'&&url.pathname==='/api/automation'){
          const data=await this.body(req),c=this.fleet.cycle;
          if(data.action==='start')return this.json(res,200,c.enable());
          if(data.action==='stop')return this.json(res,200,c.stop());
          if(data.action==='confirm')return this.json(res,200,c.confirm());
          if(data.action==='arm'){if(c.running)throw failure('BOT_BUSY','回収中です');const a=this.fleet.get('collector');return this.json(res,200,await a.exclusive('パール投擲',signal=>c.arm(signal)));}
          if(data.action==='cycle'){const result=await c.run([],true);return this.json(res,200,result);}
          throw failure('UNKNOWN_ACTION','未対応の操作です');
        }
        return this.json(res,404,{error:'APIが見つかりません'});
      }
      if(!['GET','HEAD'].includes(req.method))return this.json(res,405,{error:'Method not allowed'});
      const names=new Set(['index.html','app.js','app.css','items.json','catalog.json','items.png','favicon.svg','MINECRAFT-TEXTURES.txt']);const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!names.has(name))return this.json(res,404,{error:'Not found'});
      const file=path.join(this.root,name);if(!fs.existsSync(file))return this.json(res,404,{error:'Not found'});
      res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
    }catch(e){if(res.headersSent){res.end();return;}const status=e.code==='PAYLOAD_TOO_LARGE'?413:e.code==='BOT_BUSY'?409:400;this.fleet.log.error('web','request',e);this.json(res,status,{error:e.message,code:e.code||'ERROR',hint:require('./diagnostics').hints[e.code]||null});}
  }
  broadcast(event,data){if(!this.clients.size)return;const text='event: '+event+'\ndata: '+JSON.stringify(data,(_,v)=>typeof v==='bigint'?String(v):v)+'\n\n';for(const res of this.clients){if(res.writableLength>2*1024*1024){res.end();this.clients.delete(res);}else res.write(text);}}
  close(){clearInterval(this.timer);this.fleet.log.removeListener('entry',this.onEntry);for(const res of this.clients)res.end();this.clients.clear();}
}
module.exports={WebServer,equal};

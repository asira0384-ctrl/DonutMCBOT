'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.js'))execFileSync(process.execPath,['--check',p],{stdio:'inherit'});}}
for(const dir of ['src','web','scripts','test','vendor/bedrockflayer/lib'])walk(dir);
require('../src/state').validate(require('../src/state').defaults());
require('../src/discord-control').command();
console.log('Syntax, default settings and Discord commands: OK');

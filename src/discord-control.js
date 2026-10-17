'use strict';
const {Client,GatewayIntentBits,SlashCommandBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,AttachmentBuilder,EmbedBuilder,MessageFlags,ChannelType}=require('discord.js');
const {ROLES}=require('./state');
const choices=ROLES.map(id=>({name:{detector:'検知BOT',collector:'回収BOT',pearl:'パールBOT'}[id],value:id}));
const botOpt=b=>b.addStringOption(o=>o.setName('bot').setDescription('操作するBOT').setRequired(true).addChoices(...choices));
function command(){return new SlashCommandBuilder().setName('donut').setDescription('DonutBOTを管理します')
  .addSubcommand(s=>s.setName('panel').setDescription('操作パネルを表示'))
  .addSubcommand(s=>s.setName('status').setDescription('BOT・体力・combat・回収状態'))
  .addSubcommand(s=>botOpt(s.setName('auth').setDescription('Microsoft認証')))
  .addSubcommand(s=>botOpt(s.setName('connect').setDescription('BOTを接続')))
  .addSubcommand(s=>botOpt(s.setName('disconnect').setDescription('BOTを切断')))
  .addSubcommand(s=>botOpt(s.setName('command').setDescription('/shopなどをBOTから実行')).addStringOption(o=>o.setName('text').setDescription('/から入力').setRequired(true)))
  .addSubcommand(s=>botOpt(s.setName('eat').setDescription('指定した食料を食べる')).addStringOption(o=>o.setName('item').setDescription('食料').setRequired(true).addChoices({name:'金リンゴ',value:'golden_apple'},{name:'エンチャ金リンゴ',value:'enchanted_golden_apple'},{name:'ステーキ',value:'cooked_beef'})))
  .addSubcommand(s=>botOpt(s.setName('home').setDescription('/home endで移動')))
  .addSubcommand(s=>botOpt(s.setName('respawn').setDescription('死亡画面からリスポーン')))
  .addSubcommand(s=>botOpt(s.setName('follow').setDescription('指定MCIDへ歩く/追従を停止')).addStringOption(o=>o.setName('player').setDescription('MCID / off').setRequired(true)))
  .addSubcommand(s=>botOpt(s.setName('inventory').setDescription('BOTのインベントリ一覧')))
  .addSubcommand(s=>botOpt(s.setName('players').setDescription('Playerlist・受信できた体力')))
  .addSubcommand(s=>s.setName('watch').setDescription('自動回収ON/OFF').addBooleanOption(o=>o.setName('enabled').setDescription('開始/停止').setRequired(true)))
  .addSubcommand(s=>s.setName('pearl').setDescription('パールの投擲・手動確認・装置開閉').addStringOption(o=>o.setName('action').setDescription('操作').setRequired(true).addChoices({name:'投げる＋装置内待機を確認',value:'arm'},{name:'装置内待機を手動確認',value:'confirm'},{name:'トラップドアを開く',value:'openTrapdoor'},{name:'トラップドアを閉じる',value:'closeTrapdoor'})))
  .addSubcommand(s=>s.setName('cycle').setDescription('回収サイクルを手動実行'))
  .addSubcommand(s=>s.setName('stop').setDescription('自動回収と全BOTの移動を停止'))
  .addSubcommand(s=>s.setName('logs').setDescription('通知・デバッグ用チャンネルを保存').addChannelOption(o=>o.setName('channel').setDescription('通知先').setRequired(true).addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s=>s.setName('debug').setDescription('失敗理由付きデバッグレポートを保存'))
  .addSubcommand(s=>s.setName('config').setDescription('設定JSONを取得、Webと同じ設定を変更').addStringOption(o=>o.setName('json').setDescription('例 {"bots":{"collector":{"autoTotem":true}}}').setRequired(false)))
  .toJSON();}
function status(fleet){const s=fleet.state();return `**DonutBOT** — ${s.automation.state}\n自動回収: **${s.automation.enabled?'ON':'OFF'}** / パール: **${s.automation.armed?'確認済み':'未確認'}**\n`+s.bots.map(b=>`**${b.id} — ${b.name||'未設定'}**\n${b.phase} / HP: ${b.health??'不明'} / combat: ${b.combat?.known?b.combat.seconds+'秒':'未受信'}${b.dead?' / **死亡画面**':''}`).join('\n\n');}
async function startDiscord(fleet){
  const token=process.env.DISCORD_TOKEN,owner=process.env.DISCORD_OWNER_ID||'1343843235252146219';
  if(!/^\d{17,20}$/.test(owner))throw Error('DISCORD_OWNER_IDが不正です');
  if(!token){fleet.log.log('info','discord','startup','DISCORD_TOKEN未設定。Web管理で起動しました');return{destroy(){}};}
  const client=new Client({intents:[GatewayIntentBits.Guilds]});let queue=Promise.resolve();let queued=0;
  const onLog=e=>{
    if(!['important','warn','error'].includes(e.level)||!fleet.store.data.discord.logChannel||queued>=30)return;
    queued++;queue=queue.catch(()=>{}).then(async()=>{try{const channel=await client.channels.fetch(fleet.store.data.discord.logChannel);if(!channel?.isTextBased())return;
      const title=`[${e.bot}] ${e.stage}`;const embed=new EmbedBuilder().setColor(e.level==='error'?0xef6464:e.level==='warn'?0xf0be60:0x8b7cf8).setTitle(title).setDescription(`**${e.message.replace(/[*`]/g,'').slice(0,1200)}**${e.code?'\nコード: `'+e.code+'`':''}${e.hint?'\n'+e.hint:''}`).setTimestamp(e.at);if(e.trace)embed.setFooter({text:'Trace: '+e.trace});
      await channel.send({embeds:[embed],allowedMentions:{parse:[]}});
    }catch(error){console.error('Discord log:',error.message);}finally{queued--;}});
  };
  client.once('clientReady',async()=>{try{
    if(process.env.DISCORD_GUILD_ID)await client.application.commands.set([command()],process.env.DISCORD_GUILD_ID);else await client.application.commands.set([command()]);
    fleet.log.log('important','discord','ready','Discord操作が利用できます: /donut panel');
  }catch(e){fleet.log.error('discord','register',e);}});
  client.on('error',e=>fleet.log.error('discord','connection',e));
  client.on('interactionCreate',async interaction=>{
    if(!interaction.isChatInputCommand()&&!interaction.isButton())return;
    if(interaction.user.id!==owner){await interaction.reply({content:'所有者だけが操作できます。',flags:MessageFlags.Ephemeral});return;}
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    try{
      const reply=content=>interaction.editReply({content:String(content).slice(0,1900),allowedMentions:{parse:[]}});
      const sub=interaction.isButton()?interaction.customId.replace('donut:',''):interaction.options.getSubcommand();
      const id=interaction.isButton()?null:interaction.options.getString('bot');
      if(sub==='panel'){
        const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('donut:status').setLabel('状態更新').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('donut:stop').setLabel('全停止').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('donut:debug').setLabel('デバッグ保存').setStyle(ButtonStyle.Secondary));
        const url=process.env.PUBLIC_URL;if(url&&/^https:\/\//.test(url))row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Web管理画面').setURL(url));
        return interaction.editReply({content:status(fleet),components:[row],allowedMentions:{parse:[]}});
      }
      if(sub==='status')return reply(status(fleet));
      if(sub==='debug')return interaction.editReply({content:'**失敗理由・操作履歴・受信状態**を保存しました。認証情報は含みません。',files:[new AttachmentBuilder(Buffer.from(JSON.stringify(fleet.report(),null,2)),{name:'DonutBOT-debug.json'})]});
      if(sub==='config'){
        const json=interaction.options.getString('json');if(json){fleet.update(JSON.parse(json));return reply('**設定を保存しました。**');}
        return interaction.editReply({files:[new AttachmentBuilder(Buffer.from(JSON.stringify(fleet.store.publicConfig(),null,2)),{name:'DonutBOT-settings.json'})]});
      }
      if(sub==='logs'){fleet.store.data.discord.logChannel=interaction.options.getChannel('channel').id;fleet.store.save();return reply('**通知先を保存しました。** 重要な結果・失敗理由をこのチャンネルに送ります。');}
      if(sub==='stop'){fleet.cycle.stop();for(const role of ROLES){fleet.agents.get(role)?.stop();fleet.store.bot(role).follow='';}fleet.store.save();return reply('**全停止しました。**');}
      if(sub==='watch'){const on=interaction.options.getBoolean('enabled');on?fleet.cycle.enable():fleet.cycle.stop();return reply('**自動回収 '+(on?'ON':'OFF')+'**');}
      if(sub==='cycle'){const result=await fleet.cycle.run([],true);return reply(result.ok?'**回収・帰還・パール再待機が完了しました。**':`**失敗: ${result.code}**\n${result.reason}`);}
      if(sub==='pearl'){const a=interaction.options.getString('action');if(a==='confirm')fleet.cycle.confirm();else if(a==='arm'){if(fleet.cycle.running)throw Error('回収中です');await fleet.get('collector').exclusive('パール投擲',signal=>fleet.cycle.arm(signal));}else await fleet.action('pearl',a);return reply('**操作が完了しました。**');}
      if(sub==='auth'){const s=fleet.auth(id);await new Promise(resolve=>setTimeout(resolve,200));const auth=fleet.authState(id);return reply(auth.code?`**${id}: Microsoft認証**\n${auth.code.url}\nコード: **${auth.code.value}**\nゲーマータグ: ${fleet.store.bot(id).name}\n有効期限までに認証してください。`:auth.saved?'**保存済みの認証があります。**':`認証状態: ${auth.state}\nもう一度 /donut auth でコードを確認できます。`);}
      if(sub==='follow'){const name=interaction.options.getString('player');const follow=name.toLowerCase()==='off'?'':name;fleet.update({bots:{[id]:{follow}}});if(!follow)fleet.agents.get(id)?.bot.halt();return reply('**追従 '+(follow?'ON: '+follow:'OFF')+'**');}
      if(sub==='players'){const players=fleet.get(id).snapshot().players;return reply(`**Playerlist (${players.length})**\n`+players.slice(0,70).map(p=>`${p.name} / HP: ${p.health??'未受信'}${p.visible?' / 座標受信':''}`).join('\n'));}
      if(sub==='inventory'){const a=fleet.get(id).snapshot();return reply('**'+id+' インベントリ**\n'+a.inventory.filter(Boolean).map(i=>`${i.slot+1}: ${i.name} ×${i.count}`).join('\n'));}
      const args=sub==='command'?{command:interaction.options.getString('text')}:sub==='eat'?{item:interaction.options.getString('item')}:{};
      await fleet.action(id,sub,args);return reply('**'+id+': '+sub+'** '+(['command','respawn','connect'].includes(sub)?'送信しました。結果は状態・ログで確認してください。':'完了しました。'));
    }catch(e){fleet.log.error('discord','operation',e);await interaction.editReply({content:`**失敗: ${e.code||'ERROR'}**\n${e.message}\n${require('./diagnostics').hints[e.code]||''}`.slice(0,1900),allowedMentions:{parse:[]}});}
  });
  fleet.log.on('entry',onLog);
  try{await client.login(token);}catch(e){fleet.log.removeListener('entry',onLog);fleet.log.error('discord','login',e);client.destroy();return{destroy(){}};}
  return{destroy(){fleet.log.removeListener('entry',onLog);client.destroy();}};
}
module.exports={startDiscord,command,status};

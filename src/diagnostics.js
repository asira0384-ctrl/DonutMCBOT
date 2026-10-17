'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const hints = {
  NOT_CONNECTED: '対象BOTを接続してください。認証状態とサーバーの切断理由を確認してください。',
  DEAD: '対象BOTが死亡しています。検知BOT以外はリスポーンして装備を確認してください。',
  DETECTOR_NOT_DEAD: '検知BOTを /home end に移動させ、死亡画面のまま待機させてください。',
  NO_ITEM_UPDATES: '通信自体が生きていても死亡中に落下アイテムが配信されない可能性があります。実際に対象品を落として受信試験してください。',
  HOME_TIMEOUT: 'home座標・ディメンション・待ち時間を確認してください。combatや/homeの待機で拒否されていないかチャットログも確認してください。',
  PICKUP_TIMEOUT: '他の人に先に拾われた、バッグが満杯、移動が拒否された、検知場所がずれている可能性があります。',
  NOT_ARMED: '回収BOTのパールを装置に投げて、装置内での待機を確認してください。再起動後は再確認が必要です。',
  TRAPDOOR_UNKNOWN: 'パールBOTを装置の近くへ置き、トラップドア座標を保存してください。地形が未受信の場合は操作しません。',
  TRAPDOOR_TIMEOUT: 'トラップドアの開閉更新が来ません。距離・保護・接続・Java側の装置を確認してください。',
  RECALL_TIMEOUT: 'パールの待機状態、開閉方向、装置と回収BOTが読み込まれているかを確認してください。',
  REARM_TIMEOUT: '投げたパールが装置内に残っていません。投げる角度・装置の中心・距離を調整してください。',
  PLAYER_NOT_VISIBLE: 'Playerlistにいても遠くの座標や向きは配信されません。対象をBOTの描画範囲内に置いてください。',
  MOVE_REJECTED: '到着を確認できません。地形・障害物・サーバー補正をレポートで確認してください。',
  INVENTORY_REJECTED: 'アイテム操作のサーバー応答を確認できません。通信方式・接続バージョンをレポートで確認してください。',
  FOOD_TIMEOUT: '食べた後の個数変化がありません。満腹、クールダウン、サーバー拒否の可能性があります。',
  AUTH_EXPIRED: '保存された認証をMicrosoftが失効した場合は、Webの認証からログインし直してください。',
  CANCELLED: '操作を停止しました。パール装置と回収BOTの位置を確認してから再開してください。'
};
function failure(code, message, details = {}) { return Object.assign(Error(message), { code, details }); }
function clean(value, depth = 0) {
  if (depth > 9) return '[depth limit]';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[hidden]').slice(0, 4000);
  if (value instanceof Error) return { code: value.code || 'ERROR', message: clean(value.message), details: clean(value.details, depth + 1) };
  if (Array.isArray(value)) return value.slice(0, 300).map(v => clean(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/token|password|secret|cookie|authorization|user_code|device_code|chain|authAccounts|authflow/i.test(k)).map(([k,v]) => [k, clean(v, depth + 1)]));
  return value;
}
class Diagnostics extends EventEmitter {
  constructor(dir, { quiet = false } = {}) {
    super(); this.quiet = quiet; this.dir = path.join(dir, 'logs'); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); this.file = path.join(this.dir, 'events.jsonl'); this.entries = []; this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    if(this.bytes)for(const line of fs.readFileSync(this.file,'utf8').split('\n').slice(-1501)){try{const entry=JSON.parse(line);if(entry.at&&entry.stage)this.entries.push(clean(entry));}catch{}}
  }
  log(level, bot, stage, message, details = {}, trace = null) {
    const code = details.code || null;
    const entry = clean({ id: crypto.randomUUID(), at: Date.now(), level, bot, stage, message, code, hint: hints[code] || null, trace, details });
    this.entries.push(entry); if (this.entries.length > 1500) this.entries.shift();
    if (this.bytes > 5 * 1024 * 1024) {
      for (let i = 2; i >= 1; i--) if (fs.existsSync(this.file + '.' + i)) fs.renameSync(this.file + '.' + i, this.file + '.' + (i + 1));
      if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file + '.1'); this.bytes = 0;
    }
    const line = JSON.stringify(entry) + '\n'; fs.appendFileSync(this.file, line, { mode: 0o600 }); this.bytes += Buffer.byteLength(line);
    if (level !== 'debug' && !this.quiet) console.log(JSON.stringify(entry)); this.emit('entry', entry); return entry;
  }
  error(bot, stage, error, trace) { return this.log('error', bot, stage, error.message, { code: error.code || 'ERROR', ...error.details }, trace); }
  recent(n = 200) { return this.entries.slice(-n); }
}
module.exports = { Diagnostics, failure, hints, clean };

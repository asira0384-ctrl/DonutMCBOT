'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { storageInfo } = require('./accounts');
const ROLES = ['detector', 'collector', 'pearl'];
const defaults = () => ({
  schema: 1,
  bots: Object.fromEntries(ROLES.map(id => [id, {
    name: '', host: 'donutsmp.net', port: 19132, version: '', reconnect: true,
    autoArmor: id === 'collector', autoTotem: id === 'collector', totemSlots: 5,
    follow: '', mirrorLook: true, authAccounts: {}
  }])),
  automation: {
    enabled: false, homeCommand: '/home end', home: null, homeRadius: 12,
    detectorCenter: null, detectRadius: 24, dimension: 2,
    requirements: [{ name: 'elytra', count: 1 }], match: 'any',
    arrivalTimeoutMs: 20000, pickupTimeoutMs: 5000, minPickupMs: 500,
    recallTimeoutMs: 10000, cooldownMs: 3000, combatPattern: '(?:combat|戦闘)[^\\d]{0,24}(\\d{1,3}(?:\\.\\d{1,2})?)\\s{0,4}(?:s|sec|秒)',
    trapdoor: null, recallAnchor: null, recallDimension: 0, recallRadius: 5,
    throwYaw: 0, throwPitch: -85, pearlCenter: null, pearlRadius: 3,
    rearmTimeoutMs: 12000, recallOnFailure: true
  },
  discord: { logChannel: null }, resumeConnections: []
});
function fail(message) { throw Object.assign(Error(message), { code: 'INVALID_CONFIG' }); }
function finite(n, min, max, label) { if (!Number.isFinite(n) || n < min || n > max) fail(`${label}: ${min}〜${max}で指定してください`); }
function point(p, label) { if (p === null) return; if (!p || typeof p !== 'object') fail(`${label}: 座標が必要です`); for (const k of ['x', 'y', 'z']) finite(p[k], k === 'y' ? -128 : -30000000, k === 'y' ? 512 : 30000000, label + '.' + k); }
function validate(s) {
  for (const id of ROLES) {
    const b = s.bots[id];
    if (typeof b.name !== 'string' || b.name.length > 32 || /[\r\n\x00]/.test(b.name)) fail('ゲーマータグが不正です');
    if (typeof b.host !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(b.host)) fail('サーバーアドレスが不正です');
    finite(b.port, 1, 65535, 'port'); if (!Number.isInteger(b.port)) fail('portは整数です');
    if (typeof b.version !== 'string' || !/^$|^\d+\.\d+\.\d+$/.test(b.version)) fail('バージョンが不正です');
    if (typeof b.follow !== 'string' || b.follow.length > 32) fail('追従MCIDが不正です');
    for (const k of ['reconnect', 'autoArmor', 'autoTotem', 'mirrorLook']) if (typeof b[k] !== 'boolean') fail(k + 'はON/OFFです');
    finite(b.totemSlots, 1, 7, 'トーテム枠'); if (!Number.isInteger(b.totemSlots)) fail('枠は整数です');
  }
  const a = s.automation;
  if (typeof a.enabled !== 'boolean' || typeof a.recallOnFailure !== 'boolean') fail('自動化のON/OFFが不正です');
  if (typeof a.homeCommand !== 'string' || !/^\/[^\r\n\x00]{1,199}$/.test(a.homeCommand)) fail('homeコマンドは/から入力してください');
  for (const k of ['home', 'detectorCenter', 'trapdoor', 'recallAnchor', 'pearlCenter']) point(a[k], k);
  for (const k of ['homeRadius', 'detectRadius', 'recallRadius', 'pearlRadius']) finite(a[k], .5, 128, k);
  for (const k of ['arrivalTimeoutMs', 'pickupTimeoutMs', 'recallTimeoutMs', 'rearmTimeoutMs']) finite(a[k], 100, 120000, k);
  finite(a.cooldownMs, 0, 120000, 'cooldown'); finite(a.minPickupMs, 0, a.pickupTimeoutMs, 'pickup');
  finite(a.throwYaw, -180, 180, 'yaw'); finite(a.throwPitch, -90, 90, 'pitch');
  if (![0, 1, 2].includes(a.dimension) || ![0, 1, 2].includes(a.recallDimension) || !['any', 'all'].includes(a.match)) fail('ディメンション/一致条件が不正です');
  if (!Array.isArray(a.requirements) || a.requirements.length < 1 || a.requirements.length > 64) fail('対象アイテムは1〜64種類です');
  const seen = new Set();
  for (const r of a.requirements) {
    if (!r || !/^[a-z0-9_]{1,80}$/.test(r.name) || seen.has(r.name)) fail('アイテムIDの重複/形式を確認してください');
    seen.add(r.name); finite(r.count, 1, 2304, '必要数'); if (!Number.isInteger(r.count)) fail('必要数は整数です');
  }
  // Bounded input and a conservative expression grammar avoid untrusted expensive regexes.
  if (typeof a.combatPattern !== 'string' || a.combatPattern.length > 160 || /[+*]|\{\d*,\}|\\[1-9]/.test(a.combatPattern)) fail('combat正規表現は160文字以内、無制限の繰返し不可です');
  try { new RegExp(a.combatPattern, 'i'); } catch { fail('combat正規表現が不正です'); }
}
class State {
  constructor(dir) {
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); this.file = path.join(this.dir, 'state.json');
    const base = defaults();
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.schema !== 1) fail('対応していない設定ファイルです');
      for (const id of ROLES) base.bots[id] = { ...base.bots[id], ...saved.bots?.[id] };
      base.automation = { ...base.automation, ...saved.automation }; base.discord = { ...base.discord, ...saved.discord };
      base.resumeConnections = (saved.resumeConnections || []).filter(id => ROLES.includes(id));
    }
    this.data = base; validate(base); this.save();
  }
  bot(id) { if (!ROLES.includes(id)) fail('BOTの役割が不正です'); return this.data.bots[id]; }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  update(patch) {
    const next = structuredClone(this.data);
    if (patch.bots) for (const id of ROLES) for (const k of ['name','host','port','version','reconnect','autoArmor','autoTotem','totemSlots','follow','mirrorLook']) {
      if (Object.hasOwn(patch.bots[id] || {}, k)) next.bots[id][k] = patch.bots[id][k];
    }
    if (patch.automation) for (const k of Object.keys(defaults().automation)) if (k !== 'enabled' && Object.hasOwn(patch.automation, k)) next.automation[k] = patch.automation[k];
    validate(next); this.data = next; this.save(); return this.publicConfig();
  }
  publicConfig() { const s = structuredClone(this.data); for (const b of Object.values(s.bots)) delete b.authAccounts; delete s.resumeConnections; return s; }
  storage() { return storageInfo(this.dir); }
}
module.exports = { State, ROLES, defaults, validate };

'use strict';
const { Vec3 } = require('vec3');
const normal = s => String(s || '').replace(/^minecraft:/, '').replace(/^totem$/, 'totem_of_undying');
const xyz = p => p ? { x: p.x, y: p.y, z: p.z } : null;
const distance = (a, b) => a && b ? Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z) : Infinity;
function plain(s) {
  try { const o = JSON.parse(s); const flatten = x => typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.text || '') + (x.extra || x.rawtext || []).map(flatten).join('') : ''; s = flatten(o); } catch {}
  return String(s || '').replace(/§./g, '').slice(0, 2000);
}
class Telemetry {
  constructor(agent) {
    this.agent = agent; this.bot = agent.bot; this.drops = new Map(); this.health = new Map(); this.combat = { known: false, until: null, text: '', at: null };
    this.lastItemAt = null; this.itemsAfterDeath = 0; this.deathPosition = null; this.actions = []; this.lastActionBar = '';
    const b = this.bot, c = b.client;
    c.on('add_item_entity', p => {
      const raw = p.item; const item = { id: String(p.runtime_entity_id), uniqueId: String(p.entity_id_self), name: normal(b.name(raw)), count: raw.count || 1, position: xyz(p.position), dimension: b.dimensionId, at: Date.now() };
      this.drops.set(item.id, item); this.lastItemAt = Date.now(); if (b.dead) this.itemsAfterDeath++;
      while (this.drops.size > 600) this.drops.delete(this.drops.keys().next().value);
      agent.fleet.emit('drop', agent.id, item);
    });
    c.on('move_entity', p => { const d = this.drops.get(String(p.runtime_entity_id)); if (d && p.position) d.position = xyz(p.position); const a = b.actors.get(String(p.runtime_entity_id)); if (a && p.rotation) { a.pitch = p.rotation.pitch * Math.PI/180; a.yaw = p.rotation.yaw * Math.PI/180; } });
    c.on('move_entity_delta', p => { const d = this.drops.get(String(p.runtime_entity_id)); if (d) for (const k of ['x','y','z']) if (Number.isFinite(p[k])) d.position[k] = p[k]; const a = b.actors.get(String(p.runtime_entity_id)); if (a) { if (p.rot_y !== undefined) a.yaw = p.rot_y * Math.PI/128; if (p.rot_x !== undefined) a.pitch = p.rot_x * Math.PI/128; } });
    c.on('move_player', p => { const a = b.actors.get(String(p.runtime_id)); if (a) { if (p.yaw !== undefined) a.yaw = p.yaw * Math.PI/180; if (p.pitch !== undefined) a.pitch = p.pitch * Math.PI/180; } });
    c.on('add_player', p => { const a = b.actors.get(String(p.runtime_id)); if (a) { a.yaw = (p.yaw || 0)*Math.PI/180; a.pitch = (p.pitch || 0)*Math.PI/180; } });
    c.on('update_attributes', p => {
      const h = p.attributes?.find(a => a.name === 'minecraft:health'); if (h) this.health.set(String(p.runtime_entity_id), { current: h.current, max: h.max || 20, at: Date.now() });
      if (String(p.runtime_entity_id) === String(b._runtimeEntityId)) { const f = p.attributes?.find(a => a.name === 'minecraft:player.hunger'); if (f) this.hunger = f.current; }
    });
    c.on('take_item_entity', p => this.drops.delete(String(p.runtime_entity_id)));
    c.on('remove_entity', p => { for (const [id,d] of this.drops) if (d.uniqueId === String(p.entity_id_self)) this.drops.delete(id); });
    c.on('set_title', p => { if (['action_bar_message','action_bar_message_json',4,8].includes(p.type)) { this.lastActionBar = plain(p.text); this.readCombat(this.lastActionBar); } });
    c.on('text', p => this.readCombat(plain(p.message)));
    b.on('dimensionChanged', () => { this.drops.clear(); this.health.clear(); });
    b.on('death', () => { this.deathPosition = xyz(b.entity?.position); this.itemsAfterDeath = 0; if (agent.id === 'detector') this.drops.clear(); });
    b.on('end', () => this.drops.clear());
  }
  readCombat(text) {
    if (/(?:no longer in combat|out of combat|combat (?:ended|expired)|戦闘(?:状態)?(?:が)?終了)/i.test(text)) {
      this.combat = { known: true, until: Date.now(), text, at: Date.now() }; return;
    }
    const pattern = this.agent.fleet.store.data.automation.combatPattern;
    const match = text.match(new RegExp(pattern, 'i'));
    if (match && Number.isFinite(Number(match[1])) && Number(match[1]) <= 300) {
      this.combat = { known: true, until: Date.now() + Number(match[1])*1000, text, at: Date.now() };
    }
  }
  combatState() { const c = this.combat; return { ...c, seconds: c.known ? Math.max(0, Math.ceil((c.until - Date.now())/1000)) : null, active: c.known && c.until > Date.now() }; }
  item(raw, slot) { return raw?.network_id ? { slot, name: normal(this.bot.name(raw)), count: raw.count, damage: this.bot.damage(raw) } : null; }
  snapshot() {
    const b = this.bot;
    const actors = [...b.actors.values()].filter(a => a.player);
    return {
      position: xyz(b.entity?.position), serverPosition: xyz(b.serverPosition), dimension: b.dimensionId,
      health: b.health, hunger: this.hunger ?? null, dead: b.dead, selected: b.quickBarSlot,
      inventory: Array.from({length:36}, (_,i) => this.item(b.items[i], i)),
      armor: b.armor.map((r,i) => this.item(r,i)), offhand: this.item(b.offhand[0],0), inventoryAt: b.lastInventoryAt,
      players: [...b.players.values()].slice(0, 2000).map(p => {
        const a = actors.find(a => a.uuid === p.uuid || a.name.toLowerCase() === p.name.toLowerCase()); const health = a && this.health.get(String(a.id));
        return { name: p.name, visible: !!a, position: xyz(a?.position), health: health?.current ?? null, healthAt: health?.at ?? null, yaw: a?.yaw ?? null, pitch: a?.pitch ?? null };
      }),
      combat: this.combatState(), actionBar: this.lastActionBar,
      drops: [...this.drops.values()].filter(d => Date.now()-d.at < 300000),
      detector: { lastItemAt: this.lastItemAt, itemsAfterDeath: this.itemsAfterDeath, deathPosition: this.deathPosition, receivingAfterDeath: this.itemsAfterDeath > 0 ? 'confirmed' : 'unverified' },
      packets: { lastAt: b.lastPacketAt, counts: b.packetCounts }, terrain: { ready: b.terrainReady, established: b.terrainEstablished, physics: b.physicsState },
      lastInventoryResult: b.lastStackResponse || null, lastFood: b.lastItemUse || null
    };
  }
}
function matching(drops, config, now = Date.now()) {
  const center = config.detectorCenter || config.home;
  const eligible = drops.filter(d => d.dimension === config.dimension && now-d.at <= 15000 && center && distance(d.position,center) <= config.detectRadius);
  const counts = new Map(); for (const d of eligible) counts.set(d.name, (counts.get(d.name)||0)+d.count);
  const test = r => (counts.get(normal(r.name))||0) >= r.count;
  const pass = config.match === 'all' ? config.requirements.every(test) : config.requirements.some(test);
  return pass ? eligible.filter(d => config.requirements.some(r => normal(r.name) === d.name)) : [];
}
module.exports = { Telemetry, normal, xyz, distance, plain, matching, Vec3 };

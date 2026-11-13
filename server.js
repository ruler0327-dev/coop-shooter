const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ===== 遊戲與房間常數 =====
const WORLD = { width: 1600, height: 900 };
const TICK_RATE = 60;
const SNAPSHOT_RATE = 30;
const MAX_ROOMS = 50;
const MAX_PLAYERS = 4;
const MAX_NICKNAME_LENGTH = 12;

const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 240;
const PLAYER_MAX_HP = 100;
const BULLET_SPEED = 680;
const BULLET_RADIUS = 5;
const BULLET_LIFE = 1.6;
const BULLET_DAMAGE = 25;
const SHOOT_COOLDOWN = 0.16;

const REVIVE_RANGE = 70;
const REVIVE_TIME = 2.0;
const WIPE_DELAY = 3.0;
const AFTER_WIPE = 'waiting'; // 'waiting' | 'restart'

// ===== 波次與怪物 =====
const WAVE_DURATION = 25;
const BOSS_WAVE_INTERVAL = 5;
const MAX_MONSTERS = 30;

const MONSTER_TYPES = {
  normal: { label: '普通怪', r: 16, speed: 120, hp: 50, maxHp: 50, dmg: 15, atkCd: 0.8, color: '#ff7b72', shape: 'circle', minWave: 1, weight: 6 },
  fast:   { label: '疾走怪', r: 13, speed: 205, hp: 30, maxHp: 30, dmg: 10, atkCd: 0.6, color: '#ffa657', shape: 'circle', minWave: 2, weight: 4 },
  tank:   { label: '重裝怪', r: 26, speed: 72,  hp: 160, maxHp: 160, dmg: 28, atkCd: 1.1, color: '#f85149', shape: 'circle', minWave: 3, weight: 2 },
  dasher: { label: '衝刺怪', r: 15, speed: 110, hp: 55, maxHp: 55, dmg: 22, atkCd: 0.8, color: '#a855f7', shape: 'diamond', dasher: true, triggerRange: 280, windup: 0.7, dashSpeed: 560, dashRange: 250, dashCd: 2.8, minWave: 4, weight: 3 },
  shooter:{ label: '射手怪', r: 17, speed: 85,  hp: 65, maxHp: 65, dmg: 12, atkCd: 1.0, color: '#38bdf8', shape: 'hexagon', shooter: true, prefRange: 340, aimTime: 0.9, shotCd: 2.4, bulletSpeed: 360, bulletDmg: 16, bulletR: 6, minWave: 3, weight: 3 },
  boss:   { label: 'BOSS',  r: 46, speed: 68,  hp: 1500, maxHp: 1500, dmg: 35, atkCd: 1.0, color: '#f5c542', boss: true, bossOnly: true, aimTime: 1.1, fanCount: 7, fanSpread: 0.85, bulletSpeed: 340, bulletDmg: 20, bulletR: 8, dashWindup: 1.0, dashSpeed: 500, dashRange: 340, actionCd: 3.2 },
};

// ===== 掉落物 =====
const DROP_LIFETIME = 15;
const DROP_RADIUS = 12;
const BUFF_DURATION = 8;
const DROP_TYPES = {
  heal:   { label: '醫療包 +30', color: '#3fb950', weight: 4 },
  spread: { label: '散彈強化',   color: '#58a6ff', weight: 3 },
  speed:  { label: '疾風加速',   color: '#ffd43b', weight: 3 },
};

// ===== 永久升級 =====
const UPGRADE_TIMEOUT = 15;
const UPGRADE_ORDER = ['damage', 'firerate', 'maxhp', 'speed', 'multishot', 'pierce'];
const UPGRADE_TYPES = {
  damage:    { label: '火力強化', icon: '🔥', desc: '子彈傷害 +25%',     color: '#ff7b72', maxLevel: 5 },
  firerate:  { label: '極速射擊', icon: '⚡', desc: '射擊冷卻 -15%',     color: '#ffd43b', maxLevel: 5 },
  maxhp:     { label: '生命擴容', icon: '❤️', desc: '最大生命 +30 並回滿', color: '#3fb950', maxLevel: 5 },
  speed:     { label: '疾風步伐', icon: '👟', desc: '移動速度 +12%',     color: '#58a6ff', maxLevel: 5 },
  multishot: { label: '多重射擊', icon: '🔱', desc: '額外發射 +1 發子彈', color: '#d2a8ff', maxLevel: 3 },
  pierce:    { label: '穿透彈頭', icon: '💎', desc: '子彈可穿透額外目標', color: '#7ee7ff', maxLevel: 2 },
};

const PLAYER_COLORS = ['#58a6ff', '#3fb950', '#d2a8ff', '#ff9bce'];
const rooms = new Map();

// ===== 工具函式 =====
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  const len = Array.from(s).length;
  return len >= 1 && len <= MAX_NICKNAME_LENGTH ? s : null;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function createPlayer(id, name, colorIndex) {
  return {
    id,
    name,
    color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
    x: WORLD.width / 2 + (Math.random() - 0.5) * 160,
    y: WORLD.height / 2 + (Math.random() - 0.5) * 160,
    angle: 0,
    input: { up: false, down: false, left: false, right: false },
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    downed: false,
    inv: 0,
    kills: 0,
    reviveProgress: 0,
    shootCd: 0,
    buffs: { spread: 0, speed: 0 },
    upgrades: { damage: 0, firerate: 0, maxhp: 0, speed: 0, multishot: 0, pierce: 0 },
    offer: null,
    picked: false,
  };
}

function createRoom(code, hostId) {
  return {
    id: code,
    hostId,
    phase: 'waiting', // 'waiting' | 'playing' | 'upgrade'
    players: new Map(),
    monsters: [],
    bullets: [],
    enemyBullets: [],
    drops: [],
    nextMonsterId: 1,
    nextDropId: 1,
    wave: 1,
    surviveTime: 0,
    spawnTimer: 1.0,
    wipeTimer: null,
    upgradeTimer: 0,
    bossSpawnedWave: 0,
  };
}

function buildInitPayload(room, playerId) {
  return {
    id: playerId,
    roomId: room.id,
    maxPlayers: MAX_PLAYERS,
    world: WORLD,
    playerRadius: PLAYER_RADIUS,
    playerMaxHp: PLAYER_MAX_HP,
    bulletRadius: BULLET_RADIUS,
    reviveRange: REVIVE_RANGE,
    reviveTime: REVIVE_TIME,
    maxMonsters: MAX_MONSTERS,
    monsterTypes: MONSTER_TYPES,
    waveDuration: WAVE_DURATION,
    bossWaveInterval: BOSS_WAVE_INTERVAL,
    dropLifetime: DROP_LIFETIME,
    dropRadius: DROP_RADIUS,
    buffDuration: BUFF_DURATION,
    dropTypes: DROP_TYPES,
    upgradeTypes: UPGRADE_TYPES,
    upgradeOrder: UPGRADE_ORDER,
    upgradeTimeout: UPGRADE_TIMEOUT,
    afterWipe: AFTER_WIPE,
  };
}

function getNearestAlivePlayer(room, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const p of room.players.values()) {
    if (p.downed) continue;
    const d = dist(x, y, p.x, p.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function rollMonsterType(wave) {
  const pool = Object.entries(MONSTER_TYPES).filter(([, t]) => !t.bossOnly && t.minWave <= wave);
  const total = pool.reduce((s, [, t]) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const [key, t] of pool) {
    r -= t.weight;
    if (r <= 0) return key;
  }
  return 'normal';
}

function spawnMonster(room, forcedType) {
  if (room.monsters.length >= MAX_MONSTERS) return;
  const type = forcedType || rollMonsterType(room.wave);
  const info = MONSTER_TYPES[type];
  const scale = 1 + (room.wave - 1) * 0.12;
  const maxHp = Math.round(info.hp * scale);

  const edge = Math.floor(Math.random() * 4);
  let x = 0;
  let y = 0;
  if (edge === 0) { x = Math.random() * WORLD.width; y = -info.r; }
  else if (edge === 1) { x = WORLD.width + info.r; y = Math.random() * WORLD.height; }
  else if (edge === 2) { x = Math.random() * WORLD.width; y = WORLD.height + info.r; }
  else { x = -info.r; y = Math.random() * WORLD.height; }

  room.monsters.push({
    id: room.nextMonsterId++,
    type,
    x,
    y,
    hp: maxHp,
    maxHp,
    atkTimer: 0,
    state: 0,
    stateTimer: info.boss ? 2.0 : 0,
    angle: 0,
    dashVx: 0,
    dashVy: 0,
    dashRemain: 0,
  });

  if (info.boss) {
    io.to(room.id).emit('bossSpawn', { wave: room.wave });
  }
}

function spawnDrop(room, x, y, forcedType) {
  let type = forcedType;
  if (!type) {
    const entries = Object.entries(DROP_TYPES);
    const total = entries.reduce((s, [, v]) => s + v.weight, 0);
    let r = Math.random() * total;
    for (const [k, v] of entries) {
      r -= v.weight;
      if (r <= 0) { type = k; break; }
    }
  }
  room.drops.push({
    id: room.nextDropId++,
    type: type || 'heal',
    x: clamp(x, 30, WORLD.width - 30),
    y: clamp(y, 30, WORLD.height - 30),
    life: DROP_LIFETIME,
  });
}

function rollUpgradeOptions(p) {
  const available = UPGRADE_ORDER.filter((k) => p.upgrades[k] < UPGRADE_TYPES[k].maxLevel);
  const shuffled = available.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3).map((key) => ({ key, level: p.upgrades[key] }));
}

function applyUpgrade(p, key) {
  if (!(key in p.upgrades)) return;
  const def = UPGRADE_TYPES[key];
  if (p.upgrades[key] >= def.maxLevel) return;
  p.upgrades[key]++;
  if (key === 'maxhp') {
    p.maxHp = PLAYER_MAX_HP + p.upgrades.maxhp * 30;
    p.hp = p.maxHp;
    p.downed = false;
  }
}

function startUpgradePhase(room) {
  room.phase = 'upgrade';
  room.upgradeTimer = UPGRADE_TIMEOUT;
  room.bullets = [];
  room.enemyBullets = [];

  for (const p of room.players.values()) {
    const opts = rollUpgradeOptions(p);
    if (opts.length > 0) {
      p.offer = opts;
      p.picked = false;
      p.chosenKey = null;
      io.to(p.id).emit('upgradeOffer', { wave: room.wave - 1, options: opts, timeout: UPGRADE_TIMEOUT });
    } else {
      p.offer = null;
      p.picked = true;
      p.chosenKey = null;
    }
  }
}

function finishUpgradePhase(room) {
  const picks = {};
  for (const p of room.players.values()) {
    if (p.offer && !p.picked) {
      const auto = p.offer[Math.floor(Math.random() * p.offer.length)].key;
      applyUpgrade(p, auto);
      p.chosenKey = auto;
      io.to(p.id).emit('upgradeChosen', { key: auto });
    }
    if (p.chosenKey) picks[p.id] = p.chosenKey;
    p.offer = null;
    p.picked = false;
  }
  room.phase = 'playing';
  io.to(room.id).emit('upgradeEnd', { picks });

  if (room.wave % BOSS_WAVE_INTERVAL === 0 && room.bossSpawnedWave !== room.wave) {
    room.bossSpawnedWave = room.wave;
    spawnMonster(room, 'boss');
  }
}

function resetPlayersForMatch(room, fullReset) {
  let idx = 0;
  for (const p of room.players.values()) {
    p.x = WORLD.width / 2 + (idx - 1.5) * 70;
    p.y = WORLD.height / 2;
    p.downed = false;
    p.reviveProgress = 0;
    p.inv = 2.0;
    p.buffs = { spread: 0, speed: 0 };
    if (fullReset) {
      p.upgrades = { damage: 0, firerate: 0, maxhp: 0, speed: 0, multishot: 0, pierce: 0 };
      p.maxHp = PLAYER_MAX_HP;
      p.kills = 0;
    }
    p.hp = p.maxHp;
    p.offer = null;
    p.picked = false;
    idx++;
  }
}

function startMatch(room) {
  room.phase = 'playing';
  room.wave = 1;
  room.surviveTime = 0;
  room.spawnTimer = 0.8;
  room.wipeTimer = null;
  room.bossSpawnedWave = 0;
  room.monsters = [];
  room.bullets = [];
  room.enemyBullets = [];
  room.drops = [];
  resetPlayersForMatch(room, true);
  io.to(room.id).emit('gameStart');
}

// ===== Socket.io 連線與事件 =====
io.on('connection', (socket) => {
  let currentRoomId = null;

  function leaveCurrentRoom() {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    currentRoomId = null;
    if (!room) return;

    socket.leave(room.id);
    room.players.delete(socket.id);
    io.to(room.id).emit('playerLeft', socket.id);

    if (room.players.size === 0) {
      rooms.delete(room.id);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }
  }

  socket.on('createRoom', (payload, cb) => {
    const nickname = sanitizeNickname(payload && payload.nickname);
    if (!nickname) return cb && cb({ ok: false, error: '暱稱格式不正確' });
    if (rooms.size >= MAX_ROOMS) return cb && cb({ ok: false, error: '伺服器房間已滿，請稍後再試' });

    leaveCurrentRoom();
    const code = generateRoomCode();
    if (!code) return cb && cb({ ok: false, error: '無法產生
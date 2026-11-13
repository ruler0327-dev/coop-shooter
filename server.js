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
    if (!code) return cb && cb({ ok: false, error: '無法產生房號' });

    const room = createRoom(code, socket.id);
    const player = createPlayer(socket.id, nickname, 0);
    room.players.set(socket.id, player);
    rooms.set(code, room);

    currentRoomId = code;
    socket.join(code);
    if (cb) cb({ ok: true });
    socket.emit('init', buildInitPayload(room, socket.id));
  });

  socket.on('joinRoom', (payload, cb) => {
    const nickname = sanitizeNickname(payload && payload.nickname);
    if (!nickname) return cb && cb({ ok: false, error: '暱稱格式不正確' });

    const code = typeof (payload && payload.roomId) === 'string' ? payload.roomId.toUpperCase().trim() : '';
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: '找不到該房間，請確認房號' });
    if (room.players.size >= MAX_PLAYERS) return cb && cb({ ok: false, error: '該房間人數已滿（上限 4 人）' });

    leaveCurrentRoom();
    const player = createPlayer(socket.id, nickname, room.players.size);
    room.players.set(socket.id, player);

    currentRoomId = code;
    socket.join(code);
    if (cb) cb({ ok: true });
    socket.emit('init', buildInitPayload(room, socket.id));
  });

  socket.on('leaveRoom', () => {
    leaveCurrentRoom();
  });

  socket.on('startGame', (_, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room) return cb && cb({ ok: false, error: '不在房間內' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '只有房主可以開始遊戲' });
    if (room.phase !== 'waiting') return cb && cb({ ok: false, error: '遊戲已經開始' });

    startMatch(room);
    if (cb) cb({ ok: true });
  });

  socket.on('chooseUpgrade', (payload, cb) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'upgrade') return cb && cb({ ok: false, error: '目前不在強化選擇階段' });
    const p = room.players.get(socket.id);
    if (!p || !p.offer || p.picked) return cb && cb({ ok: false, error: '無法選擇' });

    const key = payload && payload.key;
    if (!p.offer.some((o) => o.key === key)) return cb && cb({ ok: false, error: '無效的強化選項' });

    applyUpgrade(p, key);
    p.picked = true;
    p.chosenKey = key;
    if (cb) cb({ ok: true });

    if (Array.from(room.players.values()).every((pl) => pl.picked)) {
      finishUpgradePhase(room);
    }
  });

  socket.on('input', (inp) => {
    const room = rooms.get(currentRoomId);
    const p = room && room.players.get(socket.id);
    if (!p || !inp) return;
    p.input.up = !!inp.up;
    p.input.down = !!inp.down;
    p.input.left = !!inp.left;
    p.input.right = !!inp.right;
  });

  socket.on('aim', (data) => {
    const room = rooms.get(currentRoomId);
    const p = room && room.players.get(socket.id);
    if (!p || !data || typeof data.angle !== 'number') return;
    p.angle = data.angle;
  });

  socket.on('shoot', (data) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase === 'upgrade') return;
    const p = room.players.get(socket.id);
    if (!p || p.downed || p.shootCd > 0) return;

    const angle = data && typeof data.angle === 'number' ? data.angle : p.angle;
    p.angle = angle;
    const cdMult = Math.pow(0.85, p.upgrades.firerate);
    p.shootCd = SHOOT_COOLDOWN * cdMult;

    const dmg = Math.round(BULLET_DAMAGE * (1 + p.upgrades.damage * 0.25));
    const pierce = p.upgrades.pierce;
    let count = 1 + p.upgrades.multishot + (p.buffs.spread > 0 ? 2 : 0);
    const spreadStep = 0.14;

    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * spreadStep;
      const a = angle + offset;
      room.bullets.push({
        ownerId: p.id,
        x: p.x + Math.cos(a) * (PLAYER_RADIUS + 8),
        y: p.y + Math.sin(a) * (PLAYER_RADIUS + 8),
        vx: Math.cos(a) * BULLET_SPEED,
        vy: Math.sin(a) * BULLET_SPEED,
        dmg,
        pierce,
        hitIds: new Set(),
        life: BULLET_LIFE,
      });
    }

    io.to(room.id).emit('shot', { id: p.id });
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });
});

// ===== 遊戲主迴圈（60Hz）=====
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;

  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;

    // 升級階段倒數
    if (room.phase === 'upgrade') {
      room.upgradeTimer -= dt;
      if (room.upgradeTimer <= 0) {
        finishUpgradePhase(room);
      }
      continue;
    }

    // 玩家移動與計時
    for (const p of room.players.values()) {
      if (p.shootCd > 0) p.shootCd -= dt;
      if (p.inv > 0) p.inv = Math.max(0, p.inv - dt);
      if (p.buffs.spread > 0) p.buffs.spread = Math.max(0, p.buffs.spread - dt);
      if (p.buffs.speed > 0) p.buffs.speed = Math.max(0, p.buffs.speed - dt);

      if (p.downed) continue;
      let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        const spd = PLAYER_SPEED * (1 + p.upgrades.speed * 0.12) * (p.buffs.speed > 0 ? 1.35 : 1);
        p.x = clamp(p.x + (dx / len) * spd * dt, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
        p.y = clamp(p.y + (dy / len) * spd * dt, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);
      }
    }

    // 玩家子彈
    for (let i = room.bullets.length - 1; i >= 0; i--) {
      const b = room.bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.x < -20 || b.x > WORLD.width + 20 || b.y < -20 || b.y > WORLD.height + 20) {
        room.bullets.splice(i, 1);
        continue;
      }

      for (let j = room.monsters.length - 1; j >= 0; j--) {
        const m = room.monsters[j];
        if (b.hitIds.has(m.id)) continue;
        const info = MONSTER_TYPES[m.type];
        if (dist(b.x, b.y, m.x, m.y) <= BULLET_RADIUS + info.r) {
          b.hitIds.add(m.id);
          m.hp -= b.dmg;

          if (m.hp <= 0) {
            const killer = room.players.get(b.ownerId);
            if (killer) killer.kills++;
            if (info.boss) {
              io.to(room.id).emit('bossDefeated', { x: m.x, y: m.y });
              spawnDrop(room, m.x - 35, m.y, 'heal');
              spawnDrop(room, m.x, m.y - 30, 'spread');
              spawnDrop(room, m.x + 35, m.y, 'speed');
            } else if (Math.random() < 0.25) {
              spawnDrop(room, m.x, m.y);
            }
            room.monsters.splice(j, 1);
          }

          if (b.pierce > 0) {
            b.pierce--;
          } else {
            room.bullets.splice(i, 1);
            break;
          }
        }
      }
    }

    // 撿取掉落物
    for (let i = room.drops.length - 1; i >= 0; i--) {
      const d = room.drops[i];
      d.life -= dt;
      if (d.life <= 0) {
        room.drops.splice(i, 1);
        continue;
      }
      for (const p of room.players.values()) {
        if (p.downed) continue;
        if (dist(p.x, p.y, d.x, d.y) <= PLAYER_RADIUS + DROP_RADIUS) {
          if (d.type === 'heal') p.hp = Math.min(p.maxHp, p.hp + 30);
          else if (d.type === 'spread') p.buffs.spread = BUFF_DURATION;
          else if (d.type === 'speed') p.buffs.speed = BUFF_DURATION;
          io.to(room.id).emit('pickup', { id: p.id, type: d.type });
          room.drops.splice(i, 1);
          break;
        }
      }
    }

    if (room.phase !== 'playing') continue;

    // 波次推進與生成
    room.surviveTime += dt;
    const nextWave = Math.floor(room.surviveTime / WAVE_DURATION) + 1;
    if (nextWave > room.wave) {
      room.wave = nextWave;
      startUpgradePhase(room);
      continue;
    }

    const spawnInterval = Math.max(0.45, 2.0 - (room.wave - 1) * 0.14);
    room.spawnTimer -= dt;
    if (room.spawnTimer <= 0) {
      room.spawnTimer = spawnInterval;
      spawnMonster(room);
    }

    // 怪物 AI
    for (const m of room.monsters) {
      const info = MONSTER_TYPES[m.type];
      if (m.atkTimer > 0) m.atkTimer -= dt;
      const target = getNearestAlivePlayer(room, m.x, m.y);
      if (!target) continue;

      const ang = Math.atan2(target.y - m.y, target.x - m.x);
      const d = dist(m.x, m.y, target.x, target.y);

      if (info.boss) {
        m.stateTimer -= dt;
        if (m.state === 0) {
          m.angle = ang;
          m.x += Math.cos(ang) * info.speed * dt;
          m.y += Math.sin(ang) * info.speed * dt;
          if (m.stateTimer <= 0) {
            if (Math.random() < 0.55) {
              m.state = 1;
              m.stateTimer = info.aimTime;
            } else {
              m.state = 3;
              m.stateTimer = info.dashWindup;
            }
          }
        } else if (m.state === 1) {
          m.angle = ang;
          if (m.stateTimer <= 0) {
            for (let i = 0; i < info.fanCount; i++) {
              const offset = ((i / (info.fanCount - 1)) - 0.5) * info.fanSpread;
              const a = m.angle + offset;
              room.enemyBullets.push({
                x: m.x + Math.cos(a) * info.r,
                y: m.y + Math.sin(a) * info.r,
                vx: Math.cos(a) * info.bulletSpeed,
                vy: Math.sin(a) * info.bulletSpeed,
                r: info.bulletR,
                dmg: info.bulletDmg,
                life: 3.5,
              });
            }
            io.to(room.id).emit('enemyShot', { boss: true });
            m.state = 0;
            m.stateTimer = info.actionCd;
          }
        } else if (m.state === 3) {
          if (m.stateTimer <= 0) {
            m.state = 4;
            m.dashVx = Math.cos(m.angle) * info.dashSpeed;
            m.dashVy = Math.sin(m.angle) * info.dashSpeed;
            m.dashRemain = info.dashRange / info.dashSpeed;
          }
        } else if (m.state === 4) {
          m.x = clamp(m.x + m.dashVx * dt, info.r, WORLD.width - info.r);
          m.y = clamp(m.y + m.dashVy * dt, info.r, WORLD.height - info.r);
          m.dashRemain -= dt;
          if (m.dashRemain <= 0) {
            m.state = 0;
            m.stateTimer = info.actionCd;
          }
        }
      } else if (info.dasher) {
        if (m.state === 0) {
          m.angle = ang;
          m.x += Math.cos(ang) * info.speed * dt;
          m.y += Math.sin(ang) * info.speed * dt;
          if (m.stateTimer > 0) m.stateTimer -= dt;
          else if (d <= info.triggerRange) {
            m.state = 1;
            m.stateTimer = info.windup;
          }
        } else if (m.state === 1) {
          m.stateTimer -= dt;
          if (m.stateTimer <= 0) {
            m.state = 2;
            m.dashVx = Math.cos(m.angle) * info.dashSpeed;
            m.dashVy = Math.sin(m.angle) * info.dashSpeed;
            m.dashRemain = info.dashRange / info.dashSpeed;
          }
        } else if (m.state === 2) {
          m.x = clamp(m.x + m.dashVx * dt, info.r, WORLD.width - info.r);
          m.y = clamp(m.y + m.dashVy * dt, info.r, WORLD.height - info.r);
          m.dashRemain -= dt;
          if (m.dashRemain <= 0) {
            m.state = 0;
            m.stateTimer = info.dashCd;
          }
        }
      } else if (info.shooter) {
        m.angle = ang;
        if (m.state === 0) {
          if (d > info.prefRange) {
            m.x += Math.cos(ang) * info.speed * dt;
            m.y += Math.sin(ang) * info.speed * dt;
          }
          if (m.stateTimer > 0) m.stateTimer -= dt;
          else if (d <= info.prefRange + 140) {
            m.state = 1;
            m.stateTimer = info.aimTime;
          }
        } else if (m.state === 1) {
          m.stateTimer -= dt;
          if (m.stateTimer <= 0) {
            room.enemyBullets.push({
              x: m.x + Math.cos(m.angle) * info.r,
              y: m.y + Math.sin(m.angle) * info.r,
              vx: Math.cos(m.angle) * info.bulletSpeed,
              vy: Math.sin(m.angle) * info.bulletSpeed,
              r: info.bulletR,
              dmg: info.bulletDmg,
              life: 3.0,
            });
            io.to(room.id).emit('enemyShot', { boss: false });
            m.state = 0;
            m.stateTimer = info.shotCd;
          }
        }
      } else {
        m.x += Math.cos(ang) * info.speed * dt;
        m.y += Math.sin(ang) * info.speed * dt;
      }

      // 近戰碰撞傷害
      for (const p of room.players.values()) {
        if (p.downed || p.inv > 0) continue;
        if (dist(m.x, m.y, p.x, p.y) <= info.r + PLAYER_RADIUS && m.atkTimer <= 0) {
          p.hp = Math.max(0, p.hp - info.dmg);
          p.inv = 0.5;
          m.atkTimer = info.atkCd;
          if (p.hp <= 0) p.downed = true;
        }
      }
    }

    // 敵方子彈
    for (let i = room.enemyBullets.length - 1; i >= 0; i--) {
      const b = room.enemyBullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.x < -30 || b.x > WORLD.width + 30 || b.y < -30 || b.y > WORLD.height + 30) {
        room.enemyBullets.splice(i, 1);
        continue;
      }
      for (const p of room.players.values()) {
        if (p.downed || p.inv > 0) continue;
        if (dist(b.x, b.y, p.x, p.y) <= b.r + PLAYER_RADIUS) {
          p.hp = Math.max(0, p.hp - b.dmg);
          p.inv = 0.45;
          if (p.hp <= 0) p.downed = true;
          room.enemyBullets.splice(i, 1);
          break;
        }
      }
    }

    // 救援倒地隊友
    for (const p of room.players.values()) {
      if (!p.downed) {
        p.reviveProgress = 0;
        continue;
      }
      let helper = false;
      for (const other of room.players.values()) {
        if (other.id !== p.id && !other.downed && dist(p.x, p.y, other.x, other.y) <= REVIVE_RANGE) {
          helper = true;
          break;
        }
      }
      if (helper) {
        p.reviveProgress += dt;
        if (p.reviveProgress >= REVIVE_TIME) {
          p.downed = false;
          p.hp = Math.round(p.maxHp * 0.5);
          p.inv = 2.0;
          p.reviveProgress = 0;
        }
      } else {
        p.reviveProgress = Math.max(0, p.reviveProgress - dt * 0.5);
      }
    }

    // 全員倒地判定
    const allDown = Array.from(room.players.values()).every((p) => p.downed);
    if (allDown) {
      if (room.wipeTimer === null) room.wipeTimer = WIPE_DELAY;
      room.wipeTimer -= dt;
      if (room.wipeTimer <= 0) {
        room.wipeTimer = null;
        if (AFTER_WIPE === 'restart') {
          startMatch(room);
          io.to(room.id).emit('teamReset', { mode: 'restart' });
        } else {
          room.phase = 'waiting';
          room.monsters = [];
          room.bullets = [];
          room.enemyBullets = [];
          room.drops = [];
          resetPlayersForMatch(room, true);
          io.to(room.id).emit('teamReset', { mode: 'waiting' });
        }
      }
    } else {
      room.wipeTimer = null;
    }
  }
}, 1000 / TICK_RATE);

// ===== 狀態廣播（30Hz）=====
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    const spawnInterval = Math.max(0.45, 2.0 - (room.wave - 1) * 0.14);

    io.to(room.id).emit('state', {
      phase: room.phase,
      host: room.hostId,
      upLeft: Math.max(0, room.upgradeTimer),
      wave: room.wave,
      time: room.surviveTime,
      spawnInterval,
      wipe: room.wipeTimer,
      players: Array.from(room.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        angle: Math.round(p.angle * 100) / 100,
        color: p.color,
        hp: p.hp,
        mh: p.maxHp,
        downed: p.downed,
        inv: p.inv > 0,
        kills: p.kills,
        revive: Math.round((p.reviveProgress / REVIVE_TIME) * 100) / 100,
        buffs: {
          spread: Math.round(p.buffs.spread * 10) / 10,
          speed: Math.round(p.buffs.speed * 10) / 10,
        },
        up: UPGRADE_ORDER.map((k) => p.upgrades[k]),
        pk: p.picked,
      })),
      monsters: room.monsters.map((m) => ({
        id: m.id,
        type: m.type,
        x: Math.round(m.x * 10) / 10,
        y: Math.round(m.y * 10) / 10,
        hp: m.hp,
        mx: m.maxHp,
        st: m.state,
        a: Math.round(m.angle * 100) / 100,
      })),
      bullets: room.bullets.map((b) => ({
        x: Math.round(b.x),
        y: Math.round(b.y),
        vx: Math.round(b.vx),
        vy: Math.round(b.vy),
        pc: b.pierce > 0 ? 1 : 0,
      })),
      enemyBullets: room.enemyBullets.map((b) => ({
        x: Math.round(b.x),
        y: Math.round(b.y),
        vx: Math.round(b.vx),
        vy: Math.round(b.vy),
        r: b.r,
      })),
      drops: room.drops.map((d) => ({
        id: d.id,
        type: d.type,
        x: d.x,
        y: d.y,
        life: Math.round(d.life * 10) / 10,
      })),
    });
  }
}, 1000 / SNAPSHOT_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`伺服器啟動：http://localhost:${PORT}`);
});
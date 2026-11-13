const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// ===== 基本設定 =====
const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;                    // 遊戲邏輯頻率 (Hz)
const TICK_MS = 1000 / TICK_RATE;
const BROADCAST_EVERY_N_TICKS = 2;       // 每 2 個 tick 廣播一次 = 30Hz（改成 1 即為 60Hz）
const WORLD_WIDTH = 1280;
const WORLD_HEIGHT = 720;

// ===== 房間 / 暱稱設定 =====
const MAX_PLAYERS_PER_ROOM = 4;          // 每個房間人數上限
const MAX_ROOMS = 200;                   // 伺服器房間總數上限（保護記憶體）
const MAX_NICKNAME_LENGTH = 12;          // 暱稱上限（以「字元」計，emoji 算 1 個）
const ROOM_ID_LENGTH = 4;
// 排除容易混淆的字元：0/O、1/I
const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ===== 房間階段 =====
//   waiting：等待房主開始。可自由移動與試射，不生成怪物、不計時、不計波次
//   playing：正式戰鬥
//   upgrade：每波結束後暫停（刷怪、計時、怪物與子彈全部凍結），讓每位玩家三選一強化
// 全員倒地並倒數結束後的行為：
//   'waiting'：回到等待階段，由房主重新按下「開始遊戲」
//   'restart'：直接重新開局（Wave 1）
const AFTER_WIPE = 'waiting';

// ===== 玩家設定 =====
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 240;                // 每秒移動像素（基礎值）
const PLAYER_MAX_HP = 100;               // 基礎最大血量
const PLAYER_HIT_INVINCIBLE = 0.5;       // 被打到後的無敵時間（秒）
const PLAYER_SPAWN_INVINCIBLE = 2;       // 加入 / 重置 / 被救起後的無敵時間（秒）
const PLAYER_REVIVE_HP_RATIO = 0.5;      // 被救起後恢復的血量比例（以該玩家目前最大血量計算）

// ===== 射擊設定 =====
const SHOOT_COOLDOWN = 0.25;             // 射擊冷卻（秒，基礎值）
const SHOOT_INTENT_WINDOW_MS = 120;      // 收到 shoot 事件後，「想射擊」狀態持續的毫秒數
const BULLET_SPEED = 800;                // 每秒像素
const BULLET_RADIUS = 5;
const BULLET_DAMAGE = 10;                // 基礎傷害
const BULLET_LIFETIME = 1.0;             // 秒
const MUZZLE_OFFSET = PLAYER_RADIUS + 12; // 槍口距離角色中心

// ===== 永久升級設定（每波三選一）=====
const UPGRADE_TIMEOUT = 15;              // 選擇時限（秒），超時會為未選者隨機挑一項
const UPGRADE_CHOICES = 3;               // 每次提供的選項數
const POWER_PER_LEVEL = 0.25;            // 火力強化：每級傷害 +25%（線性疊加）
const RELOAD_MULT = 0.85;                // 快速裝填：每級冷卻 ×0.85（-15%，乘算疊加）
const AGILITY_PER_LEVEL = 0.12;          // 疾行步伐：每級基礎移速 +12%（線性疊加）
const VITALITY_MAX_HP = 25;              // 生命強化：每級最大血量 +25
const VITALITY_HEAL = 40;                // 生命強化：立即回復 40 HP
const MULTISHOT_STEP = 0.22;             // 3 發以上時，相鄰子彈的夾角（弧度）
const MULTISHOT_STEP_DOUBLE = 0.12;      // 剛好 2 發時，兩發的夾角（弧度）

const UPGRADE_DEFS = {
  power:     { label: '火力強化', icon: '🔥', color: '#ff7b72', maxLevel: 10, desc: `子彈傷害 +${Math.round(POWER_PER_LEVEL * 100)}%` },
  reload:    { label: '快速裝填', icon: '🔄', color: '#ffa657', maxLevel: 6,  desc: `射擊冷卻 -${Math.round((1 - RELOAD_MULT) * 100)}%` },
  agility:   { label: '疾行步伐', icon: '👟', color: '#56d4dd', maxLevel: 6,  desc: `基礎移動速度 +${Math.round(AGILITY_PER_LEVEL * 100)}%` },
  vitality:  { label: '生命強化', icon: '❤️', color: '#3fb950', maxLevel: 6,  desc: `最大血量 +${VITALITY_MAX_HP}，立即回復 ${VITALITY_HEAL} HP` },
  multishot: { label: '多重射擊', icon: '🔱', color: '#58a6ff', maxLevel: 4,  desc: '基礎彈道 +1（可與散彈強化疊加）' },
  pierce:    { label: '穿透彈頭', icon: '🎯', color: '#bc8cff', maxLevel: 4,  desc: '子彈額外穿透 1 隻怪物，傷害不減' },
};
const UPGRADE_ORDER = Object.keys(UPGRADE_DEFS);   // 同時決定廣播時 up 陣列的順序

const UPGRADE_INFO = {};
for (const key of UPGRADE_ORDER) {
  const d = UPGRADE_DEFS[key];
  UPGRADE_INFO[key] = { label: d.label, icon: d.icon, color: d.color, desc: d.desc, maxLevel: d.maxLevel };
}

// ===== 波次設定 =====
const WAVE_DURATION = 25;                // 每存活幾秒推進一波
const SPAWN_INTERVAL_START = 2.0;        // Wave 1 的怪物生成間隔（秒）
const SPAWN_INTERVAL_MIN = 0.6;          // 生成間隔下限（秒）
const SPAWN_INTERVAL_STEP = 0.2;         // 每推進一波縮短的秒數（Wave 8 起到達下限）

// ===== Boss 設定 =====
const BOSS_WAVE_INTERVAL = 5;            // 每逢 5 的倍數波次生成 Boss
const BOSS_DROP_COUNT = 3;               // 擊殺 Boss 必掉的道具數
const BOSS_SPAWN_INTERVAL_MULT = 1.6;    // Boss 在場時，小怪生成間隔的倍率（>1 = 變慢）
const BOSS_SPAWN_X = WORLD_WIDTH / 2;
const BOSS_SPAWN_Y = 120;                // 場中央上方

// ===== 敵方子彈設定 =====
const MAX_ENEMY_BULLETS = 200;           // 每個房間敵方子彈上限
const ENEMY_BULLET_LIFETIME = 3;         // 秒

// ===== 怪物設定 =====
const MAX_MONSTERS = 30;                 // 每個房間的怪物上限
const MIN_SPAWN_DISTANCE = 200;          // 怪物生成點與存活玩家的最小距離
// weight：基礎權重；weightPerWave：每推進一波增減的權重；minWave：最早出現的波次
// shape：客戶端繪製外型（circle / diamond / hexagon / boss）
const MONSTER_TYPES = {
  small:  { label: '小怪',   shape: 'circle', r: 12, maxHp: 20,  speed: 150, damage: 8,  color: '#ff6b6b', weight: 50, weightPerWave: -2, minWave: 1 },
  normal: { label: '普通怪', shape: 'circle', r: 18, maxHp: 40,  speed: 110, damage: 12, color: '#e03131', weight: 35, weightPerWave: 0,  minWave: 1 },
  big:    { label: '巨型怪', shape: 'circle', r: 28, maxHp: 100, speed: 70,  damage: 20, color: '#a61e1e', weight: 15, weightPerWave: 3,  minWave: 1 },

  // 衝刺怪：靠近到 triggerDist 內 → 蓄力 windup 秒（原地不動、鎖定玩家方向）→ 高速直線衝刺 duration 秒 → 硬直 recover 秒 → 冷卻 cooldown 秒後才能再衝刺
  dasher: {
    label: '衝刺怪', shape: 'diamond', r: 10, maxHp: 25, speed: 120, damage: 14, color: '#a855f7',
    weight: 25, weightPerWave: 2, minWave: 2,
    dash: { triggerDist: 260, windup: 0.6, speed: 720, duration: 0.3, recover: 0.5, cooldown: 2.0 },
  },

  // 遠程射手怪：進場後與最近的玩家保持 keepDist 左右的距離；
  // 每 fireInterval 秒發射一顆子彈，發射前 aimTime 秒原地停住並鎖定瞄準（客戶端會畫出瞄準線）
  shooter: {
    label: '遠程射手', shape: 'hexagon', r: 16, maxHp: 30, speed: 90, damage: 10, color: '#22c55e',
    weight: 20, weightPerWave: 1, minWave: 3,
    shooter: {
      keepDist: 300, tolerance: 40, maxFireDist: 700,
      fireInterval: 2.2, aimTime: 0.45,
      bulletSpeed: 340, bulletDamage: 15, bulletRadius: 7,
    },
  },

  // Boss：不會被隨機生成，只在 5 的倍數波次由 spawnBoss() 生成。血量依人數與 Boss 階數計算。
  // 行為循環：追擊 → 扇形彈幕（連續 volleys 輪）→ 追擊 → 短距離衝刺 → …（兩種攻擊輪流）
  boss: {
    label: 'Boss', shape: 'boss', r: 46, maxHp: 0, speed: 55, damage: 25, color: '#f5c542',
    weight: 0, weightPerWave: 0, minWave: BOSS_WAVE_INTERVAL, bossOnly: true,
    boss: {
      baseHp: 1200, hpPerPlayer: 400, hpTierMult: 0.4,   // hp = (baseHp + hpPerPlayer × 人數) × (1 + hpTierMult × (階數 - 1))
      introTime: 1.8, idleTime: 1.4, recover: 0.9,
      aimTime: 0.9, volleys: 3, volleyInterval: 0.45,
      fanCount: 7, fanSpread: 1.6, bulletSpeed: 300, bulletDamage: 15, bulletRadius: 9,
      dashWindup: 0.9, dashSpeed: 560, dashDuration: 0.45,
    },
  },
};

// 只傳給客戶端渲染所需的型態資訊（不含速度、傷害等伺服器內部數值）
const MONSTER_TYPE_INFO = {};
for (const key in MONSTER_TYPES) {
  const t = MONSTER_TYPES[key];
  const info = {
    label: t.label,
    shape: t.shape,
    r: t.r,
    maxHp: t.maxHp,
    color: t.color,
    minWave: t.minWave,
    bossOnly: !!t.bossOnly,
  };
  if (t.dash) {
    info.dasher = true;
    info.windup = t.dash.windup;
    info.dashRange = t.dash.speed * t.dash.duration;
  }
  if (t.shooter) {
    info.shooter = true;
    info.aimTime = t.shooter.aimTime;
    info.keepDist = t.shooter.keepDist;
  }
  if (t.boss) {
    info.boss = true;
    info.aimTime = t.boss.aimTime;
    info.dashWindup = t.boss.dashWindup;
    info.dashRange = t.boss.dashSpeed * t.boss.dashDuration;
    info.fanSpread = t.boss.fanSpread;
  }
  MONSTER_TYPE_INFO[key] = info;
}

// 特殊怪物的狀態碼（廣播給客戶端用；同一個數字在不同怪物上意義不同，由客戶端依類型解讀）
//   衝刺怪：0 追擊 / 1 蓄力 / 2 衝刺 / 3 硬直
//   射手怪：0 移動 / 1 瞄準中
//   Boss：  0 登場或追擊 / 1 彈幕蓄力 / 2 彈幕發射中 / 3 衝刺蓄力 / 4 衝刺中 / 5 硬直
const STATE_CODE = {
  chase: 0, intro: 0, idle: 0,
  windup: 1, aim: 1,
  dash: 2, fire: 2,
  recover: 3, telegraph: 3,
  charge: 4,
  bossRecover: 5,
};

// ===== 掉落物 / Buff 設定 =====
const DROP_CHANCE = 0.25;                // 怪物死亡掉落機率
const DROP_LIFETIME = 15;                // 掉落物存在秒數
const DROP_RADIUS = 12;
const MAX_DROPS_PER_ROOM = 30;
const HEAL_AMOUNT = 30;
const HEAL_ONLY_WHEN_HURT = true;        // true：滿血時不會吃掉醫療包，留給需要的隊友
const BUFF_DURATION = 8;                 // spread / speed 持續秒數
const SPREAD_BUFF_EXTRA = 2;             // 散彈強化額外增加的彈道數（1 發 → 3 發）
const SPEED_MOVE_MULT = 1.35;            // 疾風：移動速度倍率
const SPEED_COOLDOWN_MULT = 0.5;         // 疾風：射擊冷卻倍率

const DROP_TYPES = {
  heal:   { weight: 40, color: '#3fb950', label: `+${HEAL_AMOUNT} HP` },
  spread: { weight: 30, color: '#58a6ff', label: '散彈強化' },
  speed:  { weight: 30, color: '#ffd43b', label: '疾風加速' },
};

const DROP_TYPE_INFO = {};
for (const key in DROP_TYPES) {
  DROP_TYPE_INFO[key] = { color: DROP_TYPES[key].color, label: DROP_TYPES[key].label };
}

// ===== 救援 / 團滅設定 =====
const REVIVE_RANGE = 70;                 // 隊友與倒地玩家的中心距離 <= 此值才算「靠近」
const REVIVE_TIME = 2;                   // 需要靠近的累計秒數
const TEAM_WIPE_RESET_TIME = 3;          // 全員倒地後幾秒重置

// ===== 伺服器初始化 =====
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ===== 遊戲狀態（暫存於記憶體，以房間為單位）=====
// rooms[roomId] = {
//   id, hostId, phase, players: { [socketId]: player },
//   monsters, bullets, enemyBullets, drops,
//   nextMonsterId, nextBulletId, nextDropId, monsterSpawnTimer, wipeTimer, wipeCountdown,
//   wave, surviveTime, bossQueue, pendingWave, upgradeTimer
// }
const rooms = {};

// ===== 工具函式 =====
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 80%, 55%)`;
}

function randomPosition(max, radius) {
  return radius + Math.random() * (max - radius * 2);
}

function r1(v) {
  return Math.round(v * 10) / 10;
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

function isValidAngleData(d) {
  return typeof d === 'object' && d !== null && typeof d.angle === 'number' && Number.isFinite(d.angle);
}

// 線段（上一幀到這一幀的子彈軌跡）是否碰到圓形，避免子彈太快穿過目標
function segmentHitsCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = clamp(((cx - x1) * dx + (cy - y1) * dy) / lenSq, 0, 1);
  }
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  const ddx = cx - px;
  const ddy = cy - py;
  return ddx * ddx + ddy * ddy <= r * r;
}

function playerCount(room) {
  return Object.keys(room.players).length;
}

// 依波次計算怪物生成間隔：2.0 → 1.8 → 1.6 → … → 0.6（下限）
function getSpawnInterval(wave) {
  return Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_START - (wave - 1) * SPAWN_INTERVAL_STEP);
}

// ===== 暱稱 / 房號驗證 =====
// 回傳清理後的暱稱；不合法則回傳 null
function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw
    // 移除控制字元、零寬字元與雙向文字控制字元（保留一般空白，下一步再合併）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const length = Array.from(name).length;
  if (length < 1 || length > MAX_NICKNAME_LENGTH) return null;
  return name;
}

// 回傳大寫房號；格式不合法則回傳 null
function normalizeRoomId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(id) ? id : null;
}

function generateRoomId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < ROOM_ID_LENGTH; i++) {
      id += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
    }
    if (!rooms[id]) return id;
  }
  return null;
}

// ===== 房間 =====
function createRoomState(id, hostId) {
  return {
    id,
    hostId,                // 房主（第一位建立房間的玩家；離開時自動移交）
    phase: 'waiting',      // waiting / playing / upgrade
    players: {},
    monsters: [],
    bullets: [],
    enemyBullets: [],
    drops: [],
    nextMonsterId: 1,
    nextBulletId: 1,
    nextDropId: 1,
    monsterSpawnTimer: 0,
    wipeTimer: 0,
    wipeCountdown: null,   // 全員倒地時為剩餘秒數，否則為 null（給客戶端顯示用）
    wave: 1,               // 目前波次
    surviveTime: 0,        // 本輪累計生存秒數（重新開局時歸零）
    bossQueue: [],         // 等待生成的 Boss（記錄觸發它的波次）；場上已有 Boss 時會先排隊
    pendingWave: null,     // 升級階段結束後才會正式進入的下一波
    upgradeTimer: 0,       // 升級階段剩餘秒數
  };
}

function getAlivePlayers(room) {
  const list = [];
  for (const id in room.players) {
    if (!room.players[id].downed) list.push(room.players[id]);
  }
  return list;
}

// ===== 玩家 =====
function emptyUpgrades() {
  const u = {};
  for (const key of UPGRADE_ORDER) u[key] = 0;
  return u;
}

function clearBuffs(p) {
  p.buffs.spread = 0;
  p.buffs.speed = 0;
}

// 開局 / 重新開局時，把玩家恢復成全新狀態（永久升級與擊殺數一併歸零）
function resetPlayerForRun(p) {
  p.x = randomPosition(WORLD_WIDTH, PLAYER_RADIUS);
  p.y = randomPosition(WORLD_HEIGHT, PLAYER_RADIUS);
  p.maxHp = PLAYER_MAX_HP;
  p.hp = p.maxHp;
  p.downed = false;
  p.invincibleTimer = PLAYER_SPAWN_INVINCIBLE;
  p.shootCooldown = 0;
  p.shootIntentUntil = 0;
  p.kills = 0;
  p.reviveProgress = 0;
  clearBuffs(p);
  p.upg = emptyUpgrades();
  p.offer = [];
  p.picked = true;
  p.lastPick = null;
}

function createPlayer(id, name) {
  const p = {
    id,
    name,
    color: randomColor(),
    angle: 0,                          // 瞄準角度（弧度）
    input: { up: false, down: false, left: false, right: false },
    buffs: { spread: 0, speed: 0 },    // 各 Buff 剩餘秒數（0 = 未啟用）
    x: 0, y: 0,
    maxHp: PLAYER_MAX_HP,
    hp: PLAYER_MAX_HP,
    downed: false,
    invincibleTimer: 0,
    shootCooldown: 0,
    shootIntentUntil: 0,               // 在此時間（ms）之前視為「正在要求射擊」
    kills: 0,
    reviveProgress: 0,                 // 被救援的累計秒數
    upg: emptyUpgrades(),              // 永久升級等級
    offer: [],                         // 本次升級階段提供的選項（key 陣列）
    picked: true,                      // 本次升級階段是否已選擇（無選項視為已選）
    lastPick: null,                    // 本次升級階段選了什麼（用於結束時顯示特效）
  };
  resetPlayerForRun(p);
  return p;
}

function getMoveSpeed(p) {
  return PLAYER_SPEED * (1 + AGILITY_PER_LEVEL * p.upg.agility) * (p.buffs.speed > 0 ? SPEED_MOVE_MULT : 1);
}

function damagePlayer(p, amount) {
  p.hp -= amount;
  p.invincibleTimer = PLAYER_HIT_INVINCIBLE;
  if (p.hp <= 0) {
    p.hp = 0;
    p.downed = true;
    p.reviveProgress = 0;
    p.shootIntentUntil = 0;
    clearBuffs(p); // 倒地時 Buff 消失（永久升級不會消失）
  }
}

function revivePlayer(p) {
  p.downed = false;
  p.hp = Math.round(p.maxHp * PLAYER_REVIVE_HP_RATIO);
  p.reviveProgress = 0;
  p.invincibleTimer = PLAYER_SPAWN_INVINCIBLE;
}

function fireBullet(room, p) {
  const u = p.upg;

  // 彈道數 = 基礎 1 + 多重射擊等級 + 散彈強化（+2）；以瞄準角為中心對稱展開
  const count = 1 + u.multishot + (p.buffs.spread > 0 ? SPREAD_BUFF_EXTRA : 0);
  const step = count === 2 ? MULTISHOT_STEP_DOUBLE : MULTISHOT_STEP;
  const damage = Math.round(BULLET_DAMAGE * (1 + POWER_PER_LEVEL * u.power));
  const pierce = u.pierce;

  for (let i = 0; i < count; i++) {
    const a = p.angle + (i - (count - 1) / 2) * step;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    room.bullets.push({
      id: room.nextBulletId++,
      ownerId: p.id,
      x: p.x + cos * MUZZLE_OFFSET,
      y: p.y + sin * MUZZLE_OFFSET,
      vx: cos * BULLET_SPEED,
      vy: sin * BULLET_SPEED,
      life: BULLET_LIFETIME,
      damage,
      pierceLeft: pierce,                        // 還能再穿透幾隻怪物
      hitIds: pierce > 0 ? new Set() : null,     // 已命中過的怪物（避免同一隻怪物被同一顆子彈重複計算）
    });
  }

  // 冷卻 = 基礎 × 快速裝填 × 疾風加速；下限為一個 tick，避免超過迴圈能處理的頻率
  const cd = SHOOT_COOLDOWN * Math.pow(RELOAD_MULT, u.reload) * (p.buffs.speed > 0 ? SPEED_COOLDOWN_MULT : 1);
  p.shootCooldown = Math.max(1 / TICK_RATE, cd);

  // 一次開火只發一個事件（不論幾發子彈），客戶端用來播放射擊音效與後座力
  io.to(room.id).emit('shot', { id: p.id });
}

// 敵方子彈（射手怪 / Boss 共用）：只會傷害玩家
function fireEnemyBullet(room, x, y, angle, speed, damage, radius) {
  if (room.enemyBullets.length >= MAX_ENEMY_BULLETS) return;
  room.enemyBullets.push({
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    r: radius,
    damage,
    life: ENEMY_BULLET_LIFETIME,
  });
}

// ===== 怪物 =====
// 依目前波次挑選怪物類型（尚未解鎖的類型、Boss 不會出現在隨機池）
function pickMonsterType(wave) {
  const pool = [];
  let total = 0;
  for (const key in MONSTER_TYPES) {
    const t = MONSTER_TYPES[key];
    if (t.bossOnly || wave < t.minWave) continue;
    const w = Math.max(1, t.weight + t.weightPerWave * (wave - 1));
    pool.push({ key, w });
    total += w;
  }
  let roll = Math.random() * total;
  for (const entry of pool) {
    roll -= entry.w;
    if (roll <= 0) return entry.key;
  }
  return 'normal';
}

function spawnMonster(room) {
  const alive = getAlivePlayers(room);
  if (alive.length === 0) return;

  const typeKey = pickMonsterType(room.wave);
  const type = MONSTER_TYPES[typeKey];

  let x = 0;
  let y = 0;
  // 從地圖四邊外緣生成；盡量避開玩家身邊（最多重試 8 次）
  for (let attempt = 0; attempt < 8; attempt++) {
    const side = Math.floor(Math.random() * 4);
    if (side === 0) { x = Math.random() * WORLD_WIDTH; y = -type.r; }
    else if (side === 1) { x = WORLD_WIDTH + type.r; y = Math.random() * WORLD_HEIGHT; }
    else if (side === 2) { x = Math.random() * WORLD_WIDTH; y = WORLD_HEIGHT + type.r; }
    else { x = -type.r; y = Math.random() * WORLD_HEIGHT; }

    const tooClose = alive.some((p) => Math.hypot(p.x - x, p.y - y) < MIN_SPAWN_DISTANCE);
    if (!tooClose) break;
  }

  const monster = {
    id: room.nextMonsterId++,
    type: typeKey,
    x,
    y,
    hp: type.maxHp,
    r: type.r,
    speed: type.speed,
    damage: type.damage,
    angle: Math.atan2(WORLD_HEIGHT / 2 - y, WORLD_WIDTH / 2 - x),
  };

  // 衝刺怪專用狀態機欄位
  if (type.dash) {
    monster.dash = type.dash;
    monster.state = 'chase';
    monster.stateTimer = 0;
    monster.dashCooldown = 1;   // 剛生成時先追一下，不會立刻衝刺
    monster.dirX = 0;
    monster.dirY = 0;
  }

  // 射手怪專用欄位
  if (type.shooter) {
    monster.shooter = type.shooter;
    monster.state = 'chase';
    monster.entered = false;    // 尚未進入地圖範圍前只會往場中央移動、不會開火
    monster.fireCooldown = type.shooter.fireInterval * (0.5 + Math.random() * 0.5);
    monster.strafeDir = Math.random() < 0.5 ? -1 : 1;
  }

  room.monsters.push(monster);
}

// 生成 Boss：場中央上方，血量依「當下人數」與「Boss 階數」計算
function spawnBoss(room, triggerWave) {
  const type = MONSTER_TYPES.boss;
  const cfg = type.boss;
  const tier = Math.max(1, Math.floor(triggerWave / BOSS_WAVE_INTERVAL));
  const hp = Math.round((cfg.baseHp + cfg.hpPerPlayer * playerCount(room)) * (1 + cfg.hpTierMult * (tier - 1)));

  room.monsters.push({
    id: room.nextMonsterId++,
    type: 'boss',
    x: BOSS_SPAWN_X,
    y: BOSS_SPAWN_Y,
    hp,
    maxHp: hp,
    r: type.r,
    speed: type.speed,
    damage: type.damage,
    angle: Math.PI / 2,
    isBoss: true,
    boss: cfg,
    state: 'intro',               // 登場階段：不會行動、不會造成碰撞傷害，但可以被攻擊
    stateTimer: cfg.introTime,
    nextAttack: 'barrage',        // 第一招用彈幕，之後輪流
    volleysLeft: 0,
    volleyTimer: 0,
    volleyIndex: 0,
    dirX: 0,
    dirY: 1,
  });

  io.to(room.id).emit('bossSpawn', { wave: triggerWave });
  console.log(`[B] 房間 ${room.id} 生成 Boss（Wave ${triggerWave}、${playerCount(room)} 人、HP ${hp}）`);
}

// ===== 掉落物 =====
function pickDropType() {
  let total = 0;
  for (const key in DROP_TYPES) total += DROP_TYPES[key].weight;
  let roll = Math.random() * total;
  for (const key in DROP_TYPES) {
    roll -= DROP_TYPES[key].weight;
    if (roll <= 0) return key;
  }
  return 'heal';
}

// force = true 時無視房間掉落物上限（Boss 的必掉道具使用）
function spawnDrop(room, type, x, y, force) {
  if (!force && room.drops.length >= MAX_DROPS_PER_ROOM) return;
  room.drops.push({
    id: room.nextDropId++,
    type,
    // 怪物可能死在地圖邊緣外，把掉落點限制在玩家走得到的範圍內
    x: clamp(x, DROP_RADIUS, WORLD_WIDTH - DROP_RADIUS),
    y: clamp(y, DROP_RADIUS, WORLD_HEIGHT - DROP_RADIUS),
    life: DROP_LIFETIME,
  });
}

function maybeDropItem(room, monster) {
  if (Math.random() >= DROP_CHANCE) return;
  spawnDrop(room, pickDropType(), monster.x, monster.y, false);
}

function applyDrop(room, p, drop) {
  if (drop.type === 'heal') {
    p.hp = Math.min(p.maxHp, p.hp + HEAL_AMOUNT);
  } else if (drop.type === 'spread') {
    p.buffs.spread = BUFF_DURATION; // 重複拾取只會刷新時間，不會疊加
  } else if (drop.type === 'speed') {
    p.buffs.speed = BUFF_DURATION;
  }
  io.to(room.id).emit('pickup', { id: p.id, type: drop.type });
}

// Boss 被擊殺：必掉 BOSS_DROP_COUNT 個隨機道具、清除場上敵方子彈
function onBossDefeated(room, boss) {
  const startAngle = Math.random() * Math.PI * 2;
  for (let i = 0; i < BOSS_DROP_COUNT; i++) {
    const a = startAngle + (Math.PI * 2 * i) / BOSS_DROP_COUNT;
    spawnDrop(room, pickDropType(), boss.x + Math.cos(a) * 60, boss.y + Math.sin(a) * 60, true);
  }
  room.enemyBullets = [];
  io.to(room.id).emit('bossDefeated', { x: r1(boss.x), y: r1(boss.y) });
  console.log(`[B] 房間 ${room.id} 的 Boss 被擊敗（Wave ${room.wave}）`);
}

// 怪物被擊殺：加擊殺數、Boss 必掉 / 一般怪物機率掉落
function onMonsterKilled(room, monster, ownerId) {
  const owner = room.players[ownerId];
  if (owner) owner.kills += 1;

  if (monster.isBoss) onBossDefeated(room, monster);
  else maybeDropItem(room, monster);
}

// ===== 房主 / 開局 =====
// 房主離開時，移交給最早加入、仍在房內的玩家
function reassignHost(room) {
  if (room.hostId && room.players[room.hostId]) return;
  const next = Object.keys(room.players)[0] || null;
  room.hostId = next;
  if (next) {
    console.log(`[H] 房間 ${room.id} 的房主移交給 ${room.players[next].name}`);
  }
}

// 重置整個「一輪遊戲」：玩家、怪物、子彈、掉落物、波次、升級全部回到初始狀態（不改變 phase）
function resetRun(room) {
  for (const id in room.players) resetPlayerForRun(room.players[id]);
  room.monsters = [];
  room.bullets = [];
  room.enemyBullets = [];
  room.drops = [];
  room.bossQueue = [];
  room.monsterSpawnTimer = 0;
  room.wipeTimer = 0;
  room.wipeCountdown = null;
  room.wave = 1;
  room.surviveTime = 0;
  room.pendingWave = null;
  room.upgradeTimer = 0;
}

function startRun(room) {
  resetRun(room);
  room.phase = 'playing';
  io.to(room.id).emit('gameStart');
  console.log(`[>] 房間 ${room.id} 開始遊戲（${playerCount(room)} 人）`);
}

// ===== 每波三選一永久升級 =====
function rollOffer(p) {
  // 已升到上限的項目不會再出現
  const pool = UPGRADE_ORDER.filter((k) => p.upg[k] < UPGRADE_DEFS[k].maxLevel);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, UPGRADE_CHOICES);
}

function applyUpgrade(p, key) {
  p.upg[key] += 1;

  if (key === 'vitality') {
    p.maxHp += VITALITY_MAX_HP;
    // 倒地的玩家只提高上限，不會因此直接站起來
    if (!p.downed) p.hp = Math.min(p.maxHp, p.hp + VITALITY_HEAL);
  }

  p.lastPick = key;
  p.picked = true;
  p.offer = [];
}

// 一波結束：暫停戰鬥並為每位玩家各自抽出選項
function beginUpgradePhase(room) {
  room.pendingWave = room.wave + 1;

  let anyOffer = false;
  for (const id in room.players) {
    const p = room.players[id];
    p.lastPick = null;
    p.shootIntentUntil = 0;
    p.offer = rollOffer(p);
    p.picked = p.offer.length === 0;     // 所有項目都滿級時沒有選項，視為已選
    if (!p.picked) anyOffer = true;
  }

  // 所有人都滿級：直接進入下一波
  if (!anyOffer) {
    finishUpgradePhase(room);
    return;
  }

  room.phase = 'upgrade';
  room.upgradeTimer = UPGRADE_TIMEOUT;

  for (const id in room.players) {
    const p = room.players[id];
    if (p.picked) continue;
    io.to(p.id).emit('upgradeOffer', {
      wave: room.wave,
      timeout: UPGRADE_TIMEOUT,
      options: p.offer.map((key) => ({ key, level: p.upg[key] })),
    });
  }
  console.log(`[U] 房間 ${room.id} Wave ${room.wave} 結束，進入升級選擇（${playerCount(room)} 人）`);
}

// 升級階段結束：正式進入下一波（Boss 波次在這時才排入生成佇列）
function finishUpgradePhase(room) {
  const picks = {};
  for (const id in room.players) {
    const p = room.players[id];
    if (p.lastPick) picks[id] = p.lastPick;
    p.lastPick = null;
    p.offer = [];
    p.picked = true;
  }

  room.wave = room.pendingWave || room.wave + 1;
  room.pendingWave = null;
  if (room.wave % BOSS_WAVE_INTERVAL === 0) room.bossQueue.push(room.wave);

  room.phase = 'playing';
  io.to(room.id).emit('upgradeEnd', { picks });
  console.log(`[^] 房間 ${room.id} 進入 Wave ${room.wave}（生成間隔 ${getSpawnInterval(room.wave).toFixed(1)} 秒）`);
}

function checkUpgradeComplete(room) {
  if (room.phase !== 'upgrade') return;
  const everyonePicked = Object.values(room.players).every((p) => p.picked);
  if (everyonePicked) finishUpgradePhase(room);
}

// 時間到：為尚未選擇的玩家隨機挑一項
function autoPickRemaining(room) {
  for (const id in room.players) {
    const p = room.players[id];
    if (p.picked || p.offer.length === 0) continue;
    const key = p.offer[Math.floor(Math.random() * p.offer.length)];
    applyUpgrade(p, key);
    io.to(p.id).emit('upgradeChosen', { key, level: p.upg[key], auto: true });
  }
}

function updateUpgrade(room, dt) {
  room.upgradeTimer -= dt;
  if (room.upgradeTimer <= 0) {
    autoPickRemaining(room);
    finishUpgradePhase(room);
  }
}

// ===== 房間進出 =====
// 把玩家放進房間並通知客戶端
function enterRoom(socket, room, name) {
  const player = createPlayer(socket.id, name);
  room.players[socket.id] = player;
  if (!room.hostId || !room.players[room.hostId]) room.hostId = socket.id;
  socket.data.roomId = room.id;
  socket.join(room.id);

  console.log(
    `[+] ${name} (${socket.id}) 加入房間 ${room.id}（${playerCount(room)}/${MAX_PLAYERS_PER_ROOM}）`
  );

  socket.emit('init', {
    id: socket.id,
    roomId: room.id,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    playerRadius: PLAYER_RADIUS,
    playerMaxHp: PLAYER_MAX_HP,
    bulletRadius: BULLET_RADIUS,
    reviveRange: REVIVE_RANGE,
    reviveTime: REVIVE_TIME,
    maxMonsters: MAX_MONSTERS,
    monsterTypes: MONSTER_TYPE_INFO,
    waveDuration: WAVE_DURATION,
    bossWaveInterval: BOSS_WAVE_INTERVAL,
    dropLifetime: DROP_LIFETIME,
    dropRadius: DROP_RADIUS,
    buffDuration: BUFF_DURATION,
    dropTypes: DROP_TYPE_INFO,
    upgradeTypes: UPGRADE_INFO,
    upgradeOrder: UPGRADE_ORDER,
    upgradeTimeout: UPGRADE_TIMEOUT,
    afterWipe: AFTER_WIPE,
  });
}

// 把玩家移出所在房間；房間變空時立即刪除並釋放記憶體
function removePlayerFromRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  socket.data.roomId = null;
  socket.leave(roomId);

  const room = rooms[roomId];
  if (!room) return;

  const leaving = room.players[socket.id];
  delete room.players[socket.id];

  if (leaving) {
    console.log(`[-] ${leaving.name} (${socket.id}) 離開房間 ${roomId}（剩 ${playerCount(room)} 人）`);
  }

  if (playerCount(room) === 0) {
    delete rooms[roomId];
    console.log(`[x] 房間 ${roomId} 已清空並刪除（目前共 ${Object.keys(rooms).length} 間房）`);
    return;
  }

  reassignHost(room);
  io.to(roomId).emit('playerLeft', socket.id);

  // 離開的人可能正好是升級階段中最後一個還沒選的人
  checkUpgradeComplete(room);
}

// 取得該 socket 所在的房間與玩家物件
function getPlayerContext(socket) {
  const room = rooms[socket.data.roomId];
  if (!room) return null;
  const player = room.players[socket.id];
  return player ? { room, player } : null;
}

// ===== Socket.io 連線處理 =====
io.on('connection', (socket) => {
  socket.data.roomId = null;
  console.log(`[~] 連線: ${socket.id}（在大廳）`);

  // 建立新房間（建立者成為房主，房間從等待階段開始）
  socket.on('createRoom', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};

    if (socket.data.roomId) return reply({ ok: false, error: '你已經在房間中了' });

    const name = sanitizeNickname(data && typeof data === 'object' ? data.nickname : undefined);
    if (!name) return reply({ ok: false, error: `暱稱需為 1～${MAX_NICKNAME_LENGTH} 個字元` });

    if (Object.keys(rooms).length >= MAX_ROOMS) {
      return reply({ ok: false, error: '伺服器房間數已達上限，請稍後再試' });
    }

    const roomId = generateRoomId();
    if (!roomId) return reply({ ok: false, error: '暫時無法產生房號，請再試一次' });

    const room = createRoomState(roomId, socket.id);
    rooms[roomId] = room;
    console.log(`[*] 建立房間 ${roomId}（目前共 ${Object.keys(rooms).length} 間房）`);

    enterRoom(socket, room, name);
    reply({ ok: true, roomId });
  });

  // 加入既有房間
  socket.on('joinRoom', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};

    if (socket.data.roomId) return reply({ ok: false, error: '你已經在房間中了' });

    const payload = data && typeof data === 'object' ? data : {};

    const name = sanitizeNickname(payload.nickname);
    if (!name) return reply({ ok: false, error: `暱稱需為 1～${MAX_NICKNAME_LENGTH} 個字元` });

    const roomId = normalizeRoomId(payload.roomId);
    if (!roomId) return reply({ ok: false, error: '請輸入 4 碼英數字房號' });

    const room = rooms[roomId];
    if (!room) return reply({ ok: false, error: `找不到房號 ${roomId}，請確認後再試一次` });

    if (playerCount(room) >= MAX_PLAYERS_PER_ROOM) {
      return reply({
        ok: false,
        error: `房間 ${roomId} 已滿（${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM}），請換一間或建立新房間`,
      });
    }

    enterRoom(socket, room, name);
    reply({ ok: true, roomId });
  });

  // 房主開始遊戲（只有房主、且房間在等待階段時有效）
  socket.on('startGame', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};

    const ctx = getPlayerContext(socket);
    if (!ctx) return reply({ ok: false, error: '你不在房間中' });

    const { room } = ctx;
    if (room.hostId !== socket.id) return reply({ ok: false, error: '只有房主可以開始遊戲' });
    if (room.phase !== 'waiting') return reply({ ok: false, error: '遊戲已經開始了' });

    startRun(room);
    reply({ ok: true });
  });

  // 選擇本波的永久升級
  socket.on('chooseUpgrade', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};

    const ctx = getPlayerContext(socket);
    if (!ctx) return reply({ ok: false, error: '你不在房間中' });

    const { room, player } = ctx;
    if (room.phase !== 'upgrade') return reply({ ok: false, error: '現在不是選擇強化的時間' });
    if (player.picked) return reply({ ok: false, error: '你已經選擇過了' });

    const key = data && typeof data === 'object' ? data.key : null;
    if (typeof key !== 'string' || !player.offer.includes(key)) {
      return reply({ ok: false, error: '無效的選項' });
    }

    applyUpgrade(player, key);
    reply({ ok: true, key, level: player.upg[key] });

    // 先回覆再檢查，確保客戶端先收到自己的確認、再收到 upgradeEnd
    checkUpgradeComplete(room);
  });

  // 主動離開房間（回到大廳，連線保持）
  socket.on('leaveRoom', (cb) => {
    removePlayerFromRoom(socket);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // 移動輸入（伺服器只信任輸入，不信任客戶端座標）
  socket.on('input', (data) => {
    const ctx = getPlayerContext(socket);
    if (!ctx || typeof data !== 'object' || data === null) return;
    const { input } = ctx.player;
    input.up = data.up === true;
    input.down = data.down === true;
    input.left = data.left === true;
    input.right = data.right === true;
  });

  // 瞄準角度（僅用來讓其他玩家看到你的槍管方向）
  socket.on('aim', (data) => {
    const ctx = getPlayerContext(socket);
    if (!ctx || !isValidAngleData(data)) return;
    ctx.player.angle = data.angle;
  });

  // 射擊請求：伺服器記下「想射擊」的時間窗口，由遊戲迴圈依冷卻時間實際開火
  socket.on('shoot', (data) => {
    const ctx = getPlayerContext(socket);
    if (!ctx || ctx.player.downed || ctx.room.phase === 'upgrade' || !isValidAngleData(data)) return;
    ctx.player.angle = data.angle;
    ctx.player.shootIntentUntil = Date.now() + SHOOT_INTENT_WINDOW_MS;
  });

  socket.on('disconnect', () => {
    removePlayerFromRoom(socket);
    console.log(`[~] 斷線: ${socket.id}`);
  });
});

// ===== 遊戲更新：玩家 =====
function updatePlayers(room, dt) {
  const now = Date.now();

  for (const id in room.players) {
    const p = room.players[id];

    if (p.invincibleTimer > 0) p.invincibleTimer = Math.max(0, p.invincibleTimer - dt);
    if (p.shootCooldown > 0) p.shootCooldown = Math.max(0, p.shootCooldown - dt);
    if (p.buffs.spread > 0) p.buffs.spread = Math.max(0, p.buffs.spread - dt);
    if (p.buffs.speed > 0) p.buffs.speed = Math.max(0, p.buffs.speed - dt);

    // 倒地：無法移動與射擊
    if (p.downed) continue;

    let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);

    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }

    const speed = getMoveSpeed(p);
    p.x = clamp(p.x + dx * speed * dt, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
    p.y = clamp(p.y + dy * speed * dt, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);

    // 射擊：有射擊意圖且冷卻完畢才開火
    if (now < p.shootIntentUntil && p.shootCooldown <= 0) {
      fireBullet(room, p);
    }
  }
}

// ===== 遊戲更新：波次（每存活 WAVE_DURATION 秒結束一波 → 進入升級選擇）=====
function updateWave(room, dt) {
  // 全員倒地的倒數期間不計入生存時間
  if (getAlivePlayers(room).length === 0) return;

  room.surviveTime += dt;
  const newWave = 1 + Math.floor(room.surviveTime / WAVE_DURATION);
  if (newWave > room.wave) {
    beginUpgradePhase(room);
  }
}

// ===== 遊戲更新：Boss 生成（場上同時只會有一隻，其餘排隊）=====
function updateBossSpawning(room) {
  if (room.bossQueue.length === 0) return;
  if (getAlivePlayers(room).length === 0) return;
  if (room.monsters.some((m) => m.isBoss)) return;
  spawnBoss(room, room.bossQueue.shift());
}

// ===== 遊戲更新：怪物生成與 AI =====
function updateMonsterSpawning(room, dt) {
  if (getAlivePlayers(room).length === 0) {
    room.monsterSpawnTimer = 0;
    return;
  }

  // Boss 在場時，小怪生成變慢，避免玩家同時被彈幕與怪潮淹沒
  const bossAlive = room.monsters.some((m) => m.isBoss);
  const interval = getSpawnInterval(room.wave) * (bossAlive ? BOSS_SPAWN_INTERVAL_MULT : 1);

  room.monsterSpawnTimer += dt;
  while (room.monsterSpawnTimer >= interval) {
    room.monsterSpawnTimer -= interval;
    if (room.monsters.length < MAX_MONSTERS) spawnMonster(room);
  }
}

function nearestAlive(alive, x, y) {
  let target = null;
  let bestDistSq = Infinity;
  for (const p of alive) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      target = p;
    }
  }
  return { target, dist: target ? Math.sqrt(bestDistSq) : Infinity };
}

function moveToward(m, tx, ty, step) {
  const dx = tx - m.x;
  const dy = ty - m.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.0001) return;
  const s = Math.min(step, d);
  m.x += (dx / d) * s;
  m.y += (dy / d) * s;
}

// 一般追擊：朝目標移動，貼近到略微重疊就停下
function chaseTarget(m, target, dist, dt) {
  m.angle = Math.atan2(target.y - m.y, target.x - m.x);
  const stopDist = (m.r + PLAYER_RADIUS) * 0.8;
  if (dist > stopDist) {
    const step = Math.min(m.speed * dt, dist - stopDist);
    m.x += ((target.x - m.x) / dist) * step;
    m.y += ((target.y - m.y) / dist) * step;
  }
}

// 衝刺怪狀態機：chase → windup（蓄力）→ dash（衝刺）→ recover（硬直）→ chase
function updateDasher(m, target, dist, dt) {
  const cfg = m.dash;
  if (m.dashCooldown > 0) m.dashCooldown = Math.max(0, m.dashCooldown - dt);

  if (m.state === 'windup') {
    // 蓄力：原地不動、持續瞄準目標；時間到才鎖定方向
    if (target) m.angle = Math.atan2(target.y - m.y, target.x - m.x);
    m.stateTimer -= dt;
    if (m.stateTimer <= 0) {
      m.state = 'dash';
      m.stateTimer = cfg.duration;
      m.dirX = Math.cos(m.angle);
      m.dirY = Math.sin(m.angle);
    }
    return;
  }

  if (m.state === 'dash') {
    // 衝刺：朝鎖定方向高速直線前進（不會轉彎，玩家可以側移閃避）
    m.x += m.dirX * cfg.speed * dt;
    m.y += m.dirY * cfg.speed * dt;
    m.stateTimer -= dt;
    if (m.stateTimer <= 0) {
      m.state = 'recover';
      m.stateTimer = cfg.recover;
      m.dashCooldown = cfg.cooldown;
    }
    return;
  }

  if (m.state === 'recover') {
    m.stateTimer -= dt;
    if (m.stateTimer <= 0) m.state = 'chase';
    return;
  }

  // chase
  if (!target) return;
  chaseTarget(m, target, dist, dt);
  if (dist <= cfg.triggerDist && m.dashCooldown <= 0) {
    m.state = 'windup';
    m.stateTimer = cfg.windup;
  }
}

// 射手怪：進場 → 與最近玩家保持距離（太遠靠近、太近後退、距離剛好就橫向繞圈）
// 開火前 aimTime 秒進入 aim 狀態（原地停住，客戶端畫出瞄準線），冷卻歸零時發射一顆子彈
function updateShooter(room, m, target, dist, dt) {
  const cfg = m.shooter;

  // 尚未進入地圖：先往場中央走，這段時間不開火
  if (!m.entered) {
    if (m.x >= m.r && m.x <= WORLD_WIDTH - m.r && m.y >= m.r && m.y <= WORLD_HEIGHT - m.r) {
      m.entered = true;
    } else {
      m.angle = Math.atan2(WORLD_HEIGHT / 2 - m.y, WORLD_WIDTH / 2 - m.x);
      moveToward(m, WORLD_WIDTH / 2, WORLD_HEIGHT / 2, m.speed * dt);
      return;
    }
  }

  if (!target) {
    m.state = 'chase';
    return;
  }

  const safeDist = dist || 1;
  const ux = (target.x - m.x) / safeDist;
  const uy = (target.y - m.y) / safeDist;
  m.angle = Math.atan2(uy, ux);

  // 開火邏輯：只有在射程內才會倒數冷卻
  if (dist <= cfg.maxFireDist) {
    m.fireCooldown -= dt;
    m.state = m.fireCooldown <= cfg.aimTime ? 'aim' : 'chase';

    if (m.fireCooldown <= 0) {
      fireEnemyBullet(
        room,
        m.x + ux * (m.r + 4),
        m.y + uy * (m.r + 4),
        m.angle,
        cfg.bulletSpeed,
        cfg.bulletDamage,
        cfg.bulletRadius
      );
      m.fireCooldown = cfg.fireInterval;
      m.state = 'chase';
      io.to(room.id).emit('enemyShot', { boss: false });
    }
  } else {
    m.state = 'chase';
  }

  // 瞄準中原地不動，給玩家反應時間
  if (m.state === 'aim') return;

  if (dist > cfg.keepDist + cfg.tolerance) {
    m.x += ux * m.speed * dt;
    m.y += uy * m.speed * dt;
  } else if (dist < cfg.keepDist - cfg.tolerance) {
    m.x -= ux * m.speed * dt;
    m.y -= uy * m.speed * dt;
  } else {
    // 距離剛好：橫向繞圈
    m.x += -uy * m.strafeDir * m.speed * 0.5 * dt;
    m.y += ux * m.strafeDir * m.speed * 0.5 * dt;
  }

  // 進場後限制在地圖內；撞到邊界就換繞圈方向
  const cx = clamp(m.x, m.r, WORLD_WIDTH - m.r);
  const cy = clamp(m.y, m.r, WORLD_HEIGHT - m.r);
  if (cx !== m.x || cy !== m.y) {
    m.x = cx;
    m.y = cy;
    m.strafeDir *= -1;
  }
}

// Boss 扇形彈幕：fanCount 發、總張角 fanSpread；奇數輪錯開半格，形成可穿越的縫隙
function fireBossFan(room, m) {
  const cfg = m.boss;
  const step = cfg.fanSpread / (cfg.fanCount - 1);
  const offset = (m.volleyIndex % 2) * (step / 2);

  for (let i = 0; i < cfg.fanCount; i++) {
    const a = m.angle - cfg.fanSpread / 2 + step * i + offset;
    fireEnemyBullet(
      room,
      m.x + Math.cos(a) * m.r * 0.8,
      m.y + Math.sin(a) * m.r * 0.8,
      a,
      cfg.bulletSpeed,
      cfg.bulletDamage,
      cfg.bulletRadius
    );
  }
  io.to(room.id).emit('enemyShot', { boss: true });
}

// Boss 狀態機：
//   intro → idle（追擊）→ aim（彈幕蓄力）→ fire（連續 volleys 輪）→ bossRecover → idle
//        → idle → telegraph（衝刺蓄力，持續瞄準）→ charge（鎖定方向衝刺）→ bossRecover → idle → 回到彈幕 …
function updateBoss(room, m, target, dist, dt) {
  const cfg = m.boss;

  // 衝刺中方向已鎖定；其餘狀態都面向最近的存活玩家
  if (target && m.state !== 'charge') {
    m.angle = Math.atan2(target.y - m.y, target.x - m.x);
  }

  m.stateTimer -= dt;

  switch (m.state) {
    case 'intro':
      if (m.stateTimer <= 0) {
        m.state = 'idle';
        m.stateTimer = cfg.idleTime;
      }
      break;

    case 'idle':
      if (target) chaseTarget(m, target, dist, dt);
      if (m.stateTimer <= 0) {
        if (!target) {
          m.stateTimer = 0.5;
        } else if (m.nextAttack === 'barrage') {
          m.state = 'aim';
          m.stateTimer = cfg.aimTime;
          m.nextAttack = 'dash';
        } else {
          m.state = 'telegraph';
          m.stateTimer = cfg.dashWindup;
          m.nextAttack = 'barrage';
        }
      }
      break;

    case 'aim':
      if (m.stateTimer <= 0) {
        m.state = 'fire';
        m.volleysLeft = cfg.volleys;
        m.volleyTimer = 0;
        m.volleyIndex = 0;
      }
      break;

    case 'fire':
      m.volleyTimer -= dt;
      if (m.volleyTimer <= 0) {
        if (target) fireBossFan(room, m);
        m.volleysLeft -= 1;
        m.volleyIndex += 1;
        m.volleyTimer = cfg.volleyInterval;
        if (m.volleysLeft <= 0 || !target) {
          m.state = 'bossRecover';
          m.stateTimer = cfg.recover;
        }
      }
      break;

    case 'telegraph':
      if (m.stateTimer <= 0) {
        m.dirX = Math.cos(m.angle);
        m.dirY = Math.sin(m.angle);
        m.state = 'charge';
        m.stateTimer = cfg.dashDuration;
      }
      break;

    case 'charge':
      m.x += m.dirX * cfg.dashSpeed * dt;
      m.y += m.dirY * cfg.dashSpeed * dt;
      if (m.stateTimer <= 0) {
        m.state = 'bossRecover';
        m.stateTimer = cfg.recover;
      }
      break;

    case 'bossRecover':
      if (m.stateTimer <= 0) {
        m.state = 'idle';
        m.stateTimer = cfg.idleTime;
      }
      break;

    default:
      break;
  }

  m.x = clamp(m.x, m.r, WORLD_WIDTH - m.r);
  m.y = clamp(m.y, m.r, WORLD_HEIGHT - m.r);
}

function updateMonsters(room, dt) {
  const alive = getAlivePlayers(room);
  const monsters = room.monsters;

  for (const m of monsters) {
    const { target, dist } = nearestAlive(alive, m.x, m.y);

    if (m.isBoss) {
      updateBoss(room, m, target, dist, dt);
    } else if (m.dash) {
      updateDasher(m, target, dist, dt);
    } else if (m.shooter) {
      updateShooter(room, m, target, dist, dt);
    } else if (target) {
      chaseTarget(m, target, dist, dt);
    }
  }

  // 怪物之間的簡易分離，避免全部疊成同一點（Boss 不會被小怪推動，只會把小怪推開）
  for (let i = 0; i < monsters.length; i++) {
    for (let j = i + 1; j < monsters.length; j++) {
      const a = monsters[i];
      const b = monsters[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.r + b.r;
      if (dist >= minDist) continue;
      if (a.isBoss && b.isBoss) continue;

      if (dist === 0) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        dist = Math.sqrt(dx * dx + dy * dy) || 1;
      }
      const overlap = minDist - dist;
      const nx = dx / dist;
      const ny = dy / dist;

      if (a.isBoss) {
        b.x += nx * overlap;
        b.y += ny * overlap;
      } else if (b.isBoss) {
        a.x -= nx * overlap;
        a.y -= ny * overlap;
      } else {
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;
      }
    }
  }
}

// ===== 遊戲更新：玩家子彈與命中判定（子彈只會打怪物，不會傷害隊友）=====
// 穿透彈頭：一顆子彈在同一幀可能依序命中多隻怪物，依「離子彈起點的距離」由近到遠結算；
// 每次穿透消耗 1 點 pierceLeft，貫穿傷害不減；同一顆子彈不會重複命中同一隻怪物
function updateBullets(room, dt) {
  for (const b of room.bullets) {
    const px = b.x;
    const py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

    if (
      b.life <= 0 ||
      b.x < -50 || b.x > WORLD_WIDTH + 50 ||
      b.y < -50 || b.y > WORLD_HEIGHT + 50
    ) {
      b.dead = true;
      continue;
    }

    // 收集這一幀軌跡上碰到的所有怪物
    let hits = null;
    for (const m of room.monsters) {
      if (m.hp <= 0) continue;
      if (b.hitIds && b.hitIds.has(m.id)) continue;
      if (segmentHitsCircle(px, py, b.x, b.y, m.x, m.y, m.r + BULLET_RADIUS)) {
        if (!hits) hits = [];
        hits.push({ m, d2: (m.x - px) * (m.x - px) + (m.y - py) * (m.y - py) });
      }
    }
    if (!hits) continue;

    hits.sort((a, c) => a.d2 - c.d2);

    for (const h of hits) {
      const m = h.m;
      if (m.hp <= 0) continue; // 同一幀已被其他子彈打死，不重複結算擊殺與掉落

      m.hp -= b.damage;
      if (b.hitIds) b.hitIds.add(m.id);
      if (m.hp <= 0) onMonsterKilled(room, m, b.ownerId);

      if (b.pierceLeft > 0) {
        b.pierceLeft -= 1; // 穿過去，繼續處理下一隻
        continue;
      }
      b.dead = true;
      break;
    }
  }

  room.bullets = room.bullets.filter((b) => !b.dead);
  room.monsters = room.monsters.filter((m) => m.hp > 0);
}

// ===== 遊戲更新：敵方子彈（只會傷害玩家；無敵中的玩家會被穿過，不會消耗子彈）=====
function updateEnemyBullets(room, dt) {
  const players = Object.values(room.players);

  for (const b of room.enemyBullets) {
    const px = b.x;
    const py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

    if (
      b.life <= 0 ||
      b.x < -60 || b.x > WORLD_WIDTH + 60 ||
      b.y < -60 || b.y > WORLD_HEIGHT + 60
    ) {
      b.dead = true;
      continue;
    }

    for (const p of players) {
      if (p.downed || p.invincibleTimer > 0) continue;
      if (segmentHitsCircle(px, py, b.x, b.y, p.x, p.y, PLAYER_RADIUS + b.r)) {
        damagePlayer(p, b.damage);
        b.dead = true;
        break;
      }
    }
  }

  room.enemyBullets = room.enemyBullets.filter((b) => !b.dead);
}

// ===== 遊戲更新：怪物碰撞玩家（含 0.5 秒無敵幀）=====
function handleMonsterContacts(room) {
  for (const m of room.monsters) {
    if (m.state === 'intro') continue; // Boss 登場期間不會造成碰撞傷害

    for (const id in room.players) {
      const p = room.players[id];
      if (p.downed || p.invincibleTimer > 0) continue;

      const dist = Math.hypot(p.x - m.x, p.y - m.y);
      if (dist < m.r + PLAYER_RADIUS) {
        damagePlayer(p, m.damage);
      }
    }
  }
}

// ===== 遊戲更新：掉落物（倒數消失 + 玩家碰觸拾取）=====
function updateDrops(room, dt) {
  const players = Object.values(room.players);
  const remaining = [];

  for (const drop of room.drops) {
    drop.life -= dt;
    if (drop.life <= 0) continue;

    let taken = false;
    for (const p of players) {
      if (p.downed) continue;
      if (Math.hypot(p.x - drop.x, p.y - drop.y) > PLAYER_RADIUS + DROP_RADIUS) continue;

      // 滿血時不吃醫療包，留給需要的隊友
      if (drop.type === 'heal' && HEAL_ONLY_WHEN_HURT && p.hp >= p.maxHp) continue;

      applyDrop(room, p, drop);
      taken = true;
      break;
    }

    if (!taken) remaining.push(drop);
  }

  room.drops = remaining;
}

// ===== 遊戲更新：救援 =====
function updateRevive(room, dt) {
  const list = Object.values(room.players);

  for (const downed of list) {
    if (!downed.downed) continue;

    const hasHelper = list.some(
      (h) => !h.downed && h.id !== downed.id && Math.hypot(h.x - downed.x, h.y - downed.y) <= REVIVE_RANGE
    );

    if (hasHelper) {
      // 多人同時靠近不會加速，只要有至少一位存活隊友在範圍內即累計
      downed.reviveProgress += dt;
      if (downed.reviveProgress >= REVIVE_TIME) revivePlayer(downed);
    } else {
      // 隊友離開範圍，進度逐漸消退
      downed.reviveProgress = Math.max(0, downed.reviveProgress - dt);
    }
  }
}

// ===== 遊戲更新：全員倒地 → 3 秒後重置整輪遊戲 =====
// 重置內容：玩家、怪物、Boss、子彈、掉落物、Buff、波次、永久升級、擊殺數
// 之後依 AFTER_WIPE 回到等待階段，或直接重新開局
function resetTeam(room) {
  resetRun(room);
  room.phase = AFTER_WIPE === 'restart' ? 'playing' : 'waiting';
  io.to(room.id).emit('teamReset', { mode: AFTER_WIPE === 'restart' ? 'restart' : 'waiting' });
  console.log(`[!] 房間 ${room.id} 全員倒地，整輪遊戲已重置（${AFTER_WIPE === 'restart' ? '直接重新開局' : '回到等待階段'}）`);
}

function updateTeamWipe(room, dt) {
  const list = Object.values(room.players);
  const everyoneDown = list.length > 0 && list.every((p) => p.downed);

  if (!everyoneDown) {
    room.wipeTimer = 0;
    room.wipeCountdown = null;
    return;
  }

  room.wipeTimer += dt;
  if (room.wipeTimer >= TEAM_WIPE_RESET_TIME) {
    resetTeam(room);
    return;
  }
  room.wipeCountdown = TEAM_WIPE_RESET_TIME - room.wipeTimer;
}

// ===== 單一房間的遊戲更新（依階段分流）=====
function updateRoom(room, dt) {
  // 等待階段：只更新玩家移動與子彈（讓大家可以試槍），不刷怪、不計時
  if (room.phase === 'waiting') {
    updatePlayers(room, dt);
    updateBullets(room, dt);
    return;
  }

  // 升級階段：整個戰場凍結，只倒數選擇時限
  if (room.phase === 'upgrade') {
    updateUpgrade(room, dt);
    return;
  }

  updatePlayers(room, dt);
  updateWave(room, dt);
  if (room.phase !== 'playing') return; // 這一幀剛好進入升級階段，後續更新留到下一幀

  updateBossSpawning(room);
  updateMonsterSpawning(room, dt);
  updateMonsters(room, dt);
  updateBullets(room, dt);
  updateEnemyBullets(room, dt);
  handleMonsterContacts(room);
  updateDrops(room, dt);
  updateRevive(room, dt);
  updateTeamWipe(room, dt);
}

// ===== 廣播單一房間的狀態（只送給該房間的玩家）=====
function broadcastState(room) {
  const upgrading = room.phase === 'upgrade';

  const playerList = [];
  for (const id in room.players) {
    const p = room.players[id];
    playerList.push({
      id: p.id,
      name: p.name,
      x: r1(p.x),
      y: r1(p.y),
      color: p.color,
      angle: r2(p.angle),
      hp: p.hp,
      mh: p.maxHp,
      downed: p.downed,
      inv: p.invincibleTimer > 0,
      kills: p.kills,
      revive: r2(p.reviveProgress / REVIVE_TIME),
      buffs: { spread: r1(p.buffs.spread), speed: r1(p.buffs.speed) },
      up: UPGRADE_ORDER.map((k) => p.upg[k]),     // 依 UPGRADE_ORDER 排列的各項升級等級
      pk: upgrading && p.picked ? 1 : 0,          // 升級階段：是否已選完
    });
  }

  const monsterList = room.monsters.map((m) => {
    const o = {
      id: m.id,
      type: m.type,
      x: r1(m.x),
      y: r1(m.y),
      hp: m.hp,
    };
    // 特殊怪物（衝刺 / 射手 / Boss）：狀態碼與朝向
    if (m.state !== undefined) {
      o.st = STATE_CODE[m.state];
      o.a = r2(m.angle);
    }
    if (m.isBoss) o.mx = m.maxHp;
    return o;
  });

  // 升級階段戰場凍結：速度送 0，避免客戶端依速度外插造成子彈抖動
  const bulletList = room.bullets.map((b) => ({
    x: r1(b.x),
    y: r1(b.y),
    vx: upgrading ? 0 : Math.round(b.vx),
    vy: upgrading ? 0 : Math.round(b.vy),
    pc: b.pierceLeft > 0 ? 1 : 0,        // 1 = 穿透彈（客戶端用不同顏色繪製）
  }));

  const enemyBulletList = room.enemyBullets.map((b) => ({
    x: r1(b.x),
    y: r1(b.y),
    vx: upgrading ? 0 : Math.round(b.vx),
    vy: upgrading ? 0 : Math.round(b.vy),
    r: b.r,
  }));

  const dropList = room.drops.map((d) => ({
    id: d.id,
    type: d.type,
    x: r1(d.x),
    y: r1(d.y),
    life: r1(d.life),
  }));

  io.to(room.id).emit('state', {
    phase: room.phase,
    host: room.hostId,
    upLeft: upgrading ? r1(Math.max(0, room.upgradeTimer)) : 0,
    players: playerList,
    monsters: monsterList,
    bullets: bulletList,
    enemyBullets: enemyBulletList,
    drops: dropList,
    wave: room.wave,
    time: r1(room.surviveTime),
    spawnInterval: r2(getSpawnInterval(room.wave)),
    wipe: room.wipeCountdown === null ? null : r1(room.wipeCountdown),
  });
}

// ===== 遊戲主迴圈（60Hz 固定頻率，逐一更新所有「有玩家」的房間）=====
let lastTime = process.hrtime.bigint();
let tickCount = 0;

setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - lastTime) / 1e9;
  lastTime = now;

  // 避免事件迴圈卡頓後 dt 過大造成瞬移 / 穿牆
  if (dt > 0.1) dt = 0.1;

  tickCount++;
  const shouldBroadcast = tickCount % BROADCAST_EVERY_N_TICKS === 0;

  for (const roomId in rooms) {
    const room = rooms[roomId];

    // 保險機制：理論上空房間在最後一位玩家離開時就已刪除
    if (playerCount(room) === 0) {
      delete rooms[roomId];
      continue;
    }

    updateRoom(room, dt);
    if (shouldBroadcast) broadcastState(room);
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`伺服器啟動：http://localhost:${PORT}`);
});
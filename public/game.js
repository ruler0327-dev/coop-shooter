const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const lobbyEl = document.getElementById('lobby');
const inviteBannerEl = document.getElementById('invite-banner');
const nicknameInput = document.getElementById('nickname-input');
const randomNameBtn = document.getElementById('random-name-btn');
const createBtn = document.getElementById('create-btn');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const lobbyErrorEl = document.getElementById('lobby-error');
const lobbyStatusEl = document.getElementById('lobby-status');

const roomPanelEl = document.getElementById('room-panel');
const roomCodeEl = document.getElementById('room-code');
const roomCountEl = document.getElementById('room-count');
const copyLinkBtn = document.getElementById('copy-link-btn');
const leaveBtn = document.getElementById('leave-btn');
const scoreboardEl = document.getElementById('scoreboard');

const topRightEl = document.getElementById('top-right');
const pingEl = document.getElementById('ping');
const muteBtn = document.getElementById('mute-btn');

const waitingPanelEl = document.getElementById('waiting-panel');
const waitingTitleEl = document.getElementById('waiting-title');
const waitingSubEl = document.getElementById('waiting-sub');
const startBtn = document.getElementById('start-btn');

const upgradeOverlayEl = document.getElementById('upgrade-overlay');
const upgradeTitleEl = document.getElementById('upgrade-title');
const upgradeTimerEl = document.getElementById('upgrade-timer');
const upgradeCardsEl = document.getElementById('upgrade-cards');
const upgradeStatusEl = document.getElementById('upgrade-status');

const socket = io();

// ===== Web Audio 合成音效 =====
let audioCtx = null;
let muted = localStorage.getItem('coop_shooter_muted') === '1';
function updateMuteBtn() { muteBtn.textContent = muted ? '🔇' : '🔊'; }
updateMuteBtn();
function ensureAudio() {
  if (muted) return null;
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function playTone(type, f0, f1, dur, gainVal, delay = 0) {
  const ac = ensureAudio();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(gainVal, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain); gain.connect(ac.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
const sfx = {
  shoot: (me) => playTone('triangle', me ? 560 : 440, me ? 190 : 160, 0.075, me ? 0.12 : 0.045),
  enemyShot: (boss) => playTone('sawtooth', boss ? 210 : 320, boss ? 70 : 120, boss ? 0.18 : 0.1, boss ? 0.14 : 0.07),
  pickup: () => { playTone('sine', 520, 780, 0.08, 0.12, 0); playTone('sine', 780, 1040, 0.1, 0.12, 0.07); },
  upgrade: () => { playTone('triangle', 440, 660, 0.09, 0.13, 0); playTone('triangle', 660, 880, 0.12, 0.13, 0.08); },
  bossSpawn: () => { playTone('sawtooth', 140, 55, 0.55, 0.2, 0); playTone('square', 95, 48, 0.55, 0.14, 0.12); },
  bossDefeated: () => [523, 659, 784, 1047].forEach((f, i) => playTone('triangle', f, f * 1.02, 0.16, 0.15, i * 0.09)),
};
muteBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('coop_shooter_muted', muted ? '1' : '0');
  updateMuteBtn();
  if (!muted) ensureAudio();
});

// ===== 遊戲狀態 =====
let myId = null, roomId = null, maxPlayers = 4;
let world = { width: 1600, height: 900 };
let playerRadius = 20, playerMaxHp = 100, bulletRadius = 5;
let reviveRange = 70, reviveTime = 2.0, maxMonsters = 30;
let monsterTypes = {}, waveDuration = 25, bossWaveInterval = 5;
let dropLifetime = 15, dropRadius = 12, buffDuration = 8, dropTypes = {};
let upgradeTypes = {}, upgradeOrder = [], upgradeTimeout = 15, afterWipe = 'waiting';

let state = { phase: 'waiting', host: null, upLeft: 0, wave: 1, time: 0, spawnInterval: 2.0, wipe: null, players: [], monsters: [], bullets: [], enemyBullets: [], drops: [] };
let lastWave = 1, lastScoreboardKey = '', lastWaitingKey = '';
let currentOffer = null, chosenUpgradeKey = null, banner = null;

function setBanner(text, color, duration) { banner = { text, color, until: performance.now() + duration }; }

const NAME_ADJS = ['勇敢的', '神準的', '迷路的', '冷靜的', '閃電', '夜行', '鋼鐵', '幸運的'];
const NAME_NOUNS = ['射手', '遊俠', '獵人', '貓頭鷹', '狐狸', '騎士', '旅人', '特務'];
function randomNickname() { return NAME_ADJS[Math.floor(Math.random() * NAME_ADJS.length)] + NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)]; }
nicknameInput.value = localStorage.getItem('coop_shooter_name') || randomNickname();
randomNameBtn.addEventListener('click', () => { nicknameInput.value = randomNickname(); nicknameInput.focus(); });

const urlParams = new URLSearchParams(window.location.search);
const inviteRoom = (urlParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
if (inviteRoom.length === 4) {
  roomInput.value = inviteRoom;
  inviteBannerEl.textContent = `你收到房間 ${inviteRoom} 的邀請，輸入暱稱即可加入！`;
  inviteBannerEl.hidden = false;
}

function getNickname() { return nicknameInput.value.replace(/\s+/g, ' ').trim(); }
function setLobbyBusy(busy, statusText) {
  createBtn.disabled = busy || !socket.connected;
  joinBtn.disabled = busy || !socket.connected;
  if (statusText !== undefined) lobbyStatusEl.textContent = statusText;
}
function showLobby(errorMsg) {
  roomId = null; myId = null; currentOffer = null; chosenUpgradeKey = null;
  upgradeOverlayEl.hidden = true; waitingPanelEl.hidden = true;
  roomPanelEl.hidden = true; topRightEl.hidden = true; lobbyEl.hidden = false;
  lobbyErrorEl.textContent = errorMsg || '';
  setLobbyBusy(false, socket.connected ? '已連線到伺服器' : '連線伺服器中…');
}
function enterRoomUI() {
  lobbyEl.hidden = true; roomPanelEl.hidden = false; topRightEl.hidden = false;
  roomCodeEl.textContent = roomId; lastScoreboardKey = ''; lastWaitingKey = '';
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  window.history.replaceState({}, '', url);
}

function requestCreateRoom() {
  const nickname = getNickname();
  if (!nickname) { lobbyErrorEl.textContent = '請先輸入暱稱'; nicknameInput.focus(); return; }
  ensureAudio(); localStorage.setItem('coop_shooter_name', nickname);
  lobbyErrorEl.textContent = ''; setLobbyBusy(true, '正在建立房間…');
  socket.emit('createRoom', { nickname }, (res) => { if (!res || !res.ok) { lobbyErrorEl.textContent = (res && res.error) || '建立房間失敗'; setLobbyBusy(false, '已連線到伺服器'); } });
}
function requestJoinRoom() {
  const nickname = getNickname();
  const code = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
  if (!nickname) { lobbyErrorEl.textContent = '請先輸入暱稱'; nicknameInput.focus(); return; }
  if (code.length !== 4) { lobbyErrorEl.textContent = '請輸入 4 碼房號'; roomInput.focus(); return; }
  ensureAudio(); localStorage.setItem('coop_shooter_name', nickname);
  lobbyErrorEl.textContent = ''; setLobbyBusy(true, `正在加入房間 ${code}…`);
  socket.emit('joinRoom', { nickname, roomId: code }, (res) => { if (!res || !res.ok) { lobbyErrorEl.textContent = (res && res.error) || '加入房間失敗'; setLobbyBusy(false, '已連線到伺服器'); } });
}
createBtn.addEventListener('click', requestCreateRoom);
joinBtn.addEventListener('click', requestJoinRoom);
roomInput.addEventListener('input', () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') (roomInput.value.trim().length === 4 ? requestJoinRoom() : requestCreateRoom()); });
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestJoinRoom(); });

copyLinkBtn.addEventListener('click', async () => {
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  try { await navigator.clipboard.writeText(url.toString()); } catch { window.prompt('複製以下邀請連結傳給朋友：', url.toString()); }
  copyLinkBtn.textContent = '已複製！';
  setTimeout(() => { copyLinkBtn.textContent = '複製邀請連結'; }, 1600);
});
leaveBtn.addEventListener('click', () => {
  socket.emit('leaveRoom');
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  showLobby();
});
startBtn.addEventListener('click', () => {
  ensureAudio(); startBtn.disabled = true;
  socket.emit('startGame', null, (res) => { startBtn.disabled = false; if (!res || !res.ok) setBanner((res && res.error) || '無法開始', '#ff7b72', 2000); });
});

function renderUpgradeCards() {
  if (!currentOffer) return;
  upgradeCardsEl.innerHTML = currentOffer.map((opt, idx) => {
    const def = upgradeTypes[opt.key];
    if (!def) return '';
    const isSelected = chosenUpgradeKey === opt.key;
    const isDim = chosenUpgradeKey && !isSelected;
    return `
      <button type="button" class="upg-card ${isSelected ? 'selected' : ''} ${isDim ? 'dim' : ''}" data-key="${opt.key}" style="--c:${def.color}" ${chosenUpgradeKey ? 'disabled' : ''}>
        <span class="upg-key">${idx + 1}</span>
        <div class="upg-icon">${def.icon}</div>
        <div class="upg-name">${def.label}</div>
        <div class="upg-desc">${def.desc}</div>
        <div class="upg-level">Lv.${opt.level} → Lv.${opt.level + 1}（上限 ${def.maxLevel}）</div>
      </button>`;
  }).join('');
  upgradeCardsEl.querySelectorAll('.upg-card').forEach((btn) => { btn.addEventListener('click', () => chooseUpgrade(btn.dataset.key)); });
}
function chooseUpgrade(key) {
  if (!currentOffer || chosenUpgradeKey) return;
  ensureAudio(); chosenUpgradeKey = key; renderUpgradeCards();
  socket.emit('chooseUpgrade', { key }, (res) => { if (!res || !res.ok) { chosenUpgradeKey = null; renderUpgradeCards(); } else sfx.upgrade(); });
}

socket.on('connect', () => { if (!roomId) setLobbyBusy(false, '已連線到伺服器'); });
socket.on('disconnect', () => {
  if (roomId) { pingEl.textContent = '已斷線，重連中…'; pingEl.style.color = '#f85149'; }
  else setLobbyBusy(true, '與伺服器斷線，重連中…');
});
socket.on('init', (data) => {
  myId = data.id; roomId = data.roomId; maxPlayers = data.maxPlayers; world = data.world;
  playerRadius = data.playerRadius; playerMaxHp = data.playerMaxHp; bulletRadius = data.bulletRadius;
  reviveRange = data.reviveRange; reviveTime = data.reviveTime; maxMonsters = data.maxMonsters;
  monsterTypes = data.monsterTypes; waveDuration = data.waveDuration; bossWaveInterval = data.bossWaveInterval;
  dropLifetime = data.dropLifetime; dropRadius = data.dropRadius; buffDuration = data.buffDuration;
  dropTypes = data.dropTypes; upgradeTypes = data.upgradeTypes; upgradeOrder = data.upgradeOrder;
  upgradeTimeout = data.upgradeTimeout; afterWipe = data.afterWipe;
  canvas.width = world.width; canvas.height = world.height;
  stage.style.setProperty('--ar', `${world.width} / ${world.height}`);
  lastWave = 1; currentOffer = null; chosenUpgradeKey = null;
  enterRoomUI();
  pingEl.textContent = '已連線'; pingEl.style.color = '#3fb950';
});
socket.on('gameStart', () => {
  lastWave = 1; currentOffer = null; chosenUpgradeKey = null;
  upgradeOverlayEl.hidden = true;
  setBanner('戰鬥開始！', '#3fb950', 1800);
});
socket.on('state', (s) => {
  if (!roomId) return;
  if (s.wave > lastWave) { lastWave = s.wave; setBanner(`第 ${s.wave} 波！`, '#ffd43b', 2200); }
  state = s;
  updateRoomUI();
});
socket.on('shot', (data) => { if (roomId) sfx.shoot(data && data.id === myId); });
socket.on('enemyShot', (data) => { if (roomId) sfx.enemyShot(data && data.boss); });
socket.on('pickup', (data) => { if (roomId && data && data.id === myId) sfx.pickup(); });
socket.on('bossSpawn', (data) => { if (roomId) { sfx.bossSpawn(); setBanner(`⚠️ 第 ${data.wave} 波 BOSS 來襲！`, '#f5c542', 3200); } });
socket.on('bossDefeated', () => { if (roomId) { sfx.bossDefeated(); setBanner('🎉 BOSS 擊破！掉落大量補給！', '#3fb950', 3000); } });
socket.on('upgradeOffer', (data) => {
  if (!roomId) return;
  currentOffer = data.options; chosenUpgradeKey = null;
  upgradeTitleEl.textContent = `第 ${data.wave} 波完成！選擇一項永久強化`;
  renderUpgradeCards();
  upgradeOverlayEl.hidden = false;
});
socket.on('upgradeChosen', (data) => {
  if (currentOffer && data && data.key) { chosenUpgradeKey = data.key; renderUpgradeCards(); sfx.upgrade(); }
});
socket.on('upgradeEnd', (data) => {
  currentOffer = null; chosenUpgradeKey = null; upgradeOverlayEl.hidden = true;
  const myPick = data && data.picks && data.picks[myId];
  if (myPick && upgradeTypes[myPick]) {
    const def = upgradeTypes[myPick];
    setBanner(`獲得強化：${def.icon} ${def.label}`, def.color, 2000);
  }
});
socket.on('teamReset', (data) => {
  if (!roomId) return;
  lastWave = 1; currentOffer = null; chosenUpgradeKey = null; upgradeOverlayEl.hidden = true;
  setBanner((data && data.mode === 'restart') ? '全軍覆沒！重新開始' : '全軍覆沒！已返回房間等待開始', '#ff7b72', 2600);
});
socket.on('playerLeft', (id) => {
  if (!roomId) return;
  state.players = state.players.filter((p) => p.id !== id);
  updateRoomUI();
});

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function updateRoomUI() {
  const players = state.players;
  const isHost = state.host === myId;
  const waitingKey = `${state.phase}|${isHost}|${players.length}`;
  if (waitingKey !== lastWaitingKey) {
    lastWaitingKey = waitingKey;
    if (state.phase === 'waiting') {
      waitingPanelEl.hidden = false;
      if (isHost) {
        waitingTitleEl.textContent = `你是房主（目前 ${players.length}/${maxPlayers} 人）`;
        waitingSubEl.textContent = '複製左上角邀請連結給朋友，隨時可按下方按鈕開始';
        startBtn.hidden = false;
      } else {
        const hostPlayer = players.find((p) => p.id === state.host);
        waitingTitleEl.textContent = `等待房主${hostPlayer ? `「${hostPlayer.name}」` : ''}開始遊戲…`;
        waitingSubEl.textContent = '房主按下開始後全員立即進入戰鬥';
        startBtn.hidden = true;
      }
    } else waitingPanelEl.hidden = true;
  }
  if (state.phase === 'upgrade' && !upgradeOverlayEl.hidden) {
    const sec = Math.max(0, Math.ceil(state.upLeft || 0));
    upgradeTimerEl.textContent = String(sec);
    upgradeTimerEl.classList.toggle('urgent', sec <= 5);
    const pickedCount = players.filter((p) => p.pk).length;
    upgradeStatusEl.textContent = `${chosenUpgradeKey ? '已選擇！' : '按 1 / 2 / 3 或點擊卡片選擇 · '}已有 ${pickedCount}/${players.length} 人完成`;
  }
  const key = `${state.host}|${players.map((p) => `${p.id}:${p.name}:${p.downed ? 1 : 0}:${p.hp}:${p.mh}:${p.kills}`).join(',')}`;
  if (key === lastScoreboardKey) return;
  lastScoreboardKey = key;
  roomCountEl.textContent = `(${players.length}/${maxPlayers})`;
  scoreboardEl.innerHTML = players.map((p) => {
    const isMe = p.id === myId;
    const isPlayerHost = p.id === state.host;
    const status = p.downed ? '倒地' : `${p.hp}/${p.mh}`;
    return `
      <div class="sb-row ${isMe ? 'me' : ''}">
        <span class="sb-dot" style="background:${p.color}"></span>
        <span class="sb-name-wrap">
          ${isPlayerHost ? '<span class="sb-host">房主</span>' : ''}
          <span class="sb-name">${escapeHtml(p.name)}${isMe ? ' (你)' : ''}</span>
        </span>
        <span class="sb-status ${p.downed ? 'down' : ''}">${status}</span>
        <span class="sb-kills">${p.kills} 殺</span>
      </div>`;
  }).join('');
}

// ===== 輸入控制 =====
const input = { up: false, down: false, left: false, right: false };
let mouseX = world.width / 2, mouseY = world.height / 2, mouseDown = false;
function isTyping() { const el = document.activeElement; return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); }
function setKey(code, pressed) {
  let changed = false;
  if (code === 'KeyW' || code === 'ArrowUp') { changed = input.up !== pressed; input.up = pressed; }
  if (code === 'KeyS' || code === 'ArrowDown') { changed = input.down !== pressed; input.down = pressed; }
  if (code === 'KeyA' || code === 'ArrowLeft') { changed = input.left !== pressed; input.left = pressed; }
  if (code === 'KeyD' || code === 'ArrowRight') { changed = input.right !== pressed; input.right = pressed; }
  if (changed && roomId) socket.emit('input', input);
}
window.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  if (e.code === 'KeyM') { muteBtn.click(); return; }
  if (roomId && state.phase === 'upgrade' && currentOffer && !chosenUpgradeKey) {
    if (e.code === 'Digit1' && currentOffer[0]) { chooseUpgrade(currentOffer[0].key); return; }
    if (e.code === 'Digit2' && currentOffer[1]) { chooseUpgrade(currentOffer[1].key); return; }
    if (e.code === 'Digit3' && currentOffer[2]) { chooseUpgrade(currentOffer[2].key); return; }
  }
  setKey(e.code, true);
});
window.addEventListener('keyup', (e) => setKey(e.code, false));
window.addEventListener('blur', () => {
  mouseDown = false;
  if (input.up || input.down || input.left || input.right) {
    input.up = input.down = input.left = input.right = false;
    if (roomId) socket.emit('input', input);
  }
});
function updateMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  mouseX = ((e.clientX - rect.left) / rect.width) * world.width;
  mouseY = ((e.clientY - rect.top) / rect.height) * world.height;
}
canvas.addEventListener('mousemove', updateMousePos);
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0 && roomId) { ensureAudio(); updateMousePos(e); mouseDown = true; tryShoot(); }
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; });

function getMyAngle() {
  const me = state.players.find((p) => p.id === myId);
  return me ? Math.atan2(mouseY - me.y, mouseX - me.x) : 0;
}
function tryShoot() {
  if (!roomId || state.phase === 'upgrade') return;
  const me = state.players.find((p) => p.id === myId);
  if (!me || me.downed) return;
  socket.emit('shoot', { angle: getMyAngle() });
}
setInterval(() => {
  if (!roomId || state.phase === 'upgrade') return;
  if (mouseDown) tryShoot();
  else { const me = state.players.find((p) => p.id === myId); if (me && !me.downed) socket.emit('aim', { angle: getMyAngle() }); }
}, 50);

// ===== 畫面渲染 =====
function formatTime(sec) { const s = Math.floor(sec); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function drawGrid() {
  ctx.strokeStyle = '#1f242c'; ctx.lineWidth = 1;
  for (let x = 0; x <= world.width; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, world.height); ctx.stroke(); }
  for (let y = 0; y <= world.height; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(world.width, y); ctx.stroke(); }
}
function drawDrops() {
  const now = performance.now() / 1000;
  for (const d of state.drops) {
    const info = dropTypes[d.type] || { label: '', color: '#58a6ff' };
    if (d.life < 3 && Math.floor(d.life * 8) % 2 === 0) continue;
    const pulse = 1 + Math.sin(now * 6 + d.id) * 0.14;
    const r = dropRadius * pulse;
    ctx.save(); ctx.globalAlpha = 0.25; ctx.fillStyle = info.color;
    ctx.beginPath(); ctx.arc(d.x, d.y, r * 1.9, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.fillStyle = info.color; ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2;
    ctx.beginPath();
    if (d.type === 'heal') {
      const w = r * 0.42, l = r * 1.05;
      ctx.rect(d.x - w, d.y - l, w * 2, l * 2); ctx.rect(d.x - l, d.y - w, l * 2, w * 2);
    } else if (d.type === 'spread') {
      ctx.moveTo(d.x, d.y - r * 1.2); ctx.lineTo(d.x + r * 1.2, d.y); ctx.lineTo(d.x, d.y + r * 1.2); ctx.lineTo(d.x - r * 1.2, d.y); ctx.closePath();
    } else {
      for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + (i * Math.PI * 2) / 3; const px = d.x + Math.cos(a) * r * 1.25, py = d.y + Math.sin(a) * r * 1.25; i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
      ctx.closePath();
    }
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c9d1d9'; ctx.font = '11px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(info.label, d.x, d.y - r - 6);
  }
}
function drawMonsters() {
  for (const m of state.monsters) {
    const info = monsterTypes[m.type] || { r: 16, color: '#ff7b72', label: '', shape: 'circle' };
    const r = info.r;
    if (info.boss) {
      if (m.st === 1) { ctx.save(); ctx.strokeStyle = 'rgba(245,197,66,0.55)'; ctx.lineWidth = 3; ctx.setLineDash([12, 8]); const spread = info.fanSpread || 0.85; [-spread / 2, 0, spread / 2].forEach((off) => { ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x + Math.cos(m.a + off) * 520, m.y + Math.sin(m.a + off) * 520); ctx.stroke(); }); ctx.restore(); }
      else if (m.st === 3) { ctx.save(); ctx.strokeStyle = 'rgba(248,81,73,0.75)'; ctx.lineWidth = 4; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x + Math.cos(m.a) * (info.dashRange || 340), m.y + Math.sin(m.a) * (info.dashRange || 340)); ctx.stroke(); ctx.restore(); }
      ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = info.color; ctx.beginPath(); ctx.arc(m.x, m.y, r * 1.45, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      ctx.fillStyle = m.st === 3 || m.st === 4 ? '#ff7b72' : info.color; ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 4;
      ctx.beginPath(); for (let i = 0; i < 8; i++) { const ang = (i * Math.PI) / 4; const px = m.x + Math.cos(ang) * r, py = m.y + Math.sin(ang) * r; i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0d1117'; ctx.beginPath(); ctx.arc(m.x, m.y, r * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f85149'; ctx.beginPath(); ctx.arc(m.x + Math.cos(m.a) * r * 0.2, m.y + Math.sin(m.a) * r * 0.2, r * 0.18, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    if (info.dasher && m.st === 1) { ctx.save(); ctx.strokeStyle = 'rgba(168,85,247,0.65)'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x + Math.cos(m.a) * (info.dashRange || 250), m.y + Math.sin(m.a) * (info.dashRange || 250)); ctx.stroke(); ctx.restore(); }
    if (info.shooter && m.st === 1) { ctx.save(); ctx.strokeStyle = 'rgba(56,189,248,0.6)'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x + Math.cos(m.a) * 420, m.y + Math.sin(m.a) * 420); ctx.stroke(); ctx.restore(); }
    ctx.fillStyle = (info.dasher && m.st === 1) || (info.shooter && m.st === 1) ? '#ffffff' : info.color;
    ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (info.shape === 'diamond') { const a = m.a || 0; ctx.moveTo(m.x + Math.cos(a) * r * 1.35, m.y + Math.sin(a) * r * 1.35); ctx.lineTo(m.x + Math.cos(a + Math.PI / 2) * r * 0.9, m.y + Math.sin(a + Math.PI / 2) * r * 0.9); ctx.lineTo(m.x - Math.cos(a) * r * 1.1, m.y - Math.sin(a) * r * 1.1); ctx.lineTo(m.x + Math.cos(a - Math.PI / 2) * r * 0.9, m.y + Math.sin(a - Math.PI / 2) * r * 0.9); ctx.closePath(); }
    else if (info.shape === 'hexagon') { for (let i = 0; i < 6; i++) { const ang = (m.a || 0) + (i * Math.PI) / 3; const px = m.x + Math.cos(ang) * r * 1.1, py = m.y + Math.sin(ang) * r * 1.1; i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.closePath(); }
    else ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    if (m.hp < m.mx) {
      const bw = r * 2.2, bx = m.x - bw / 2, by = m.y - r - 10;
      ctx.fillStyle = '#0d1117'; ctx.fillRect(bx - 1, by - 1, bw + 2, 6);
      ctx.fillStyle = info.color; ctx.fillRect(bx, by, bw * Math.max(0, m.hp / m.mx), 4);
    }
  }
}
function drawBullets() {
  for (const b of state.bullets) {
    const spd = Math.hypot(b.vx, b.vy) || 1, nx = b.vx / spd, ny = b.vy / spd;
    ctx.strokeStyle = b.pc ? 'rgba(126,231,255,0.55)' : 'rgba(255,212,59,0.45)'; ctx.lineWidth = b.pc ? 4 : 3;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - nx * 16, b.y - ny * 16); ctx.stroke();
    ctx.fillStyle = b.pc ? '#7ee7ff' : '#ffd43b';
    ctx.beginPath(); ctx.arc(b.x, b.y, bulletRadius + (b.pc ? 1 : 0), 0, Math.PI * 2); ctx.fill();
  }
  for (const b of state.enemyBullets) {
    const r = b.r || 6;
    ctx.save(); ctx.globalAlpha = 0.28; ctx.fillStyle = '#f85149'; ctx.beginPath(); ctx.arc(b.x, b.y, r * 1.9, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#ff7b72'; ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}
function drawPlayers() {
  for (const p of state.players) {
    const isMe = p.id === myId;
    const angle = isMe ? getMyAngle() : p.angle;
    if (p.downed) {
      ctx.strokeStyle = 'rgba(248,81,73,0.45)'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.arc(p.x, p.y, reviveRange, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      if (p.revive > 0) { ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(p.x, p.y, playerRadius + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.revive); ctx.stroke(); }
    } else if (p.buffs) {
      if (p.buffs.spread > 0) { ctx.strokeStyle = 'rgba(88,166,255,0.75)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, playerRadius + 6, 0, Math.PI * 2); ctx.stroke(); }
      if (p.buffs.speed > 0) { ctx.strokeStyle = 'rgba(255,212,59,0.75)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, playerRadius + 10, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.save();
    if (p.downed) ctx.globalAlpha = 0.45;
    else if (p.inv) ctx.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() * 0.04);
    if (!p.downed) {
      ctx.strokeStyle = '#c9d1d9'; ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(angle) * (playerRadius + 10), p.y + Math.sin(angle) * (playerRadius + 10)); ctx.stroke();
    }
    ctx.fillStyle = p.downed ? '#6e7681' : p.color; ctx.strokeStyle = isMe ? '#ffffff' : '#0d1117'; ctx.lineWidth = isMe ? 3 : 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, playerRadius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (!p.downed) {
      const bw = 44, bx = p.x - bw / 2, by = p.y + playerRadius + 8, ratio = Math.max(0, p.hp / (p.mh || playerMaxHp));
      ctx.fillStyle = '#0d1117'; ctx.fillRect(bx - 1, by - 1, bw + 2, 7);
      ctx.fillStyle = ratio > 0.5 ? '#3fb950' : ratio > 0.25 ? '#d29922' : '#f85149'; ctx.fillRect(bx, by, bw * ratio, 5);
    }
    ctx.fillStyle = p.downed ? '#ff7b72' : '#e6edf3'; ctx.font = '13px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(p.downed ? `${p.name} [倒地]` : p.name, p.x, p.y - playerRadius - 8);
  }
}
function drawBossBar() {
  const boss = state.monsters.find((m) => monsterTypes[m.type] && monsterTypes[m.type].boss);
  if (!boss) return;
  const info = monsterTypes[boss.type];
  const bw = 540, bh = 18, bx = (world.width - bw) / 2, by = 52;
  ctx.fillStyle = 'rgba(13,17,23,0.82)'; ctx.fillRect(bx - 10, by - 24, bw + 20, bh + 32);
  ctx.fillStyle = '#f5c542'; ctx.font = 'bold 14px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`⚠️ 第 ${state.wave} 波 ${info.label}  (${Math.max(0, boss.hp)} / ${boss.mx})`, world.width / 2, by - 7);
  ctx.fillStyle = '#21262d'; ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = '#f5c542'; ctx.fillRect(bx, by, bw * Math.max(0, boss.hp / boss.mx), bh);
  ctx.strokeStyle = '#f5c542'; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, bh);
}
function drawHUD() {
  if (!roomId || state.phase === 'waiting') return;
  ctx.fillStyle = 'rgba(13,17,23,0.75)'; ctx.fillRect(world.width / 2 - 175, 10, 350, 34);
  ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 15px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`第 ${state.wave} 波  ·  存活 ${formatTime(state.time)}  ·  怪物 ${state.monsters.length}/${maxMonsters}`, world.width / 2, 32);
  const progress = (state.time % waveDuration) / waveDuration;
  ctx.fillStyle = '#30363d'; ctx.fillRect(world.width / 2 - 175, 42, 350, 3);
  ctx.fillStyle = state.wave % bossWaveInterval === 0 ? '#f5c542' : '#58a6ff'; ctx.fillRect(world.width / 2 - 175, 42, 350 * progress, 3);
  const me = state.players.find((p) => p.id === myId);
  if (me && me.up) {
    const items = upgradeOrder.map((k, i) => ({ def: upgradeTypes[k], lv: me.up[i] || 0 })).filter((x) => x.def && x.lv > 0);
    if (items.length > 0) {
      ctx.font = '12px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'left';
      let x = 14; const y = world.height - 14;
      for (const it of items) {
        const text = `${it.def.icon}${it.def.label} Lv.${it.lv}`;
        const w = ctx.measureText(text).width + 14;
        ctx.fillStyle = 'rgba(13,17,23,0.75)'; ctx.fillRect(x, y - 18, w, 24);
        ctx.strokeStyle = it.def.color; ctx.lineWidth = 1; ctx.strokeRect(x, y - 18, w, 24);
        ctx.fillStyle = '#e6edf3'; ctx.fillText(text, x + 7, y - 2); x += w + 6;
      }
    }
  }
  if (me && me.buffs) {
    const active = [];
    if (me.buffs.spread > 0) active.push({ label: `散彈強化 ${me.buffs.spread.toFixed(1)}s`, color: '#58a6ff' });
    if (me.buffs.speed > 0) active.push({ label: `疾風加速 ${me.buffs.speed.toFixed(1)}s`, color: '#ffd43b' });
    active.forEach((b, idx) => {
      const y = world.height - 26 - idx * 24;
      ctx.fillStyle = 'rgba(13,17,23,0.75)'; ctx.fillRect(world.width - 178, y - 16, 166, 22);
      ctx.fillStyle = b.color; ctx.font = 'bold 13px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(b.label, world.width - 20, y);
    });
  }
  if (banner && performance.now() < banner.until) {
    ctx.fillStyle = 'rgba(13,17,23,0.78)'; ctx.fillRect(world.width / 2 - 220, 96, 440, 44);
    ctx.fillStyle = banner.color; ctx.font = 'bold 20px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(banner.text, world.width / 2, 125);
  }
  if (state.wipe !== null) {
    ctx.fillStyle = 'rgba(13,17,23,0.78)'; ctx.fillRect(0, world.height / 2 - 58, world.width, 116);
    ctx.fillStyle = '#f85149'; ctx.font = 'bold 34px system-ui, "Noto Sans TC", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('全軍覆沒！', world.width / 2, world.height / 2 - 8);
    ctx.fillStyle = '#e6edf3'; ctx.font = '18px system-ui, "Noto Sans TC", sans-serif';
    ctx.fillText(`${Math.max(0, state.wipe).toFixed(1)} 秒後${afterWipe === 'restart' ? '重新開始' : '返回房間'}…`, world.width / 2, world.height / 2 + 28);
  }
}

function render() {
  ctx.clearRect(0, 0, world.width, world.height);
  drawGrid();
  if (roomId) { drawDrops(); drawMonsters(); drawBullets(); drawPlayers(); drawBossBar(); drawHUD(); }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
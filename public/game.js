(() = {
   ===== DOM =====
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const stage = document.getElementById('stage');

  const lobby = document.getElementById('lobby');
  const lobbyInvite = document.getElementById('lobby-invite');
  const nicknameInput = document.getElementById('nickname');
  const diceBtn = document.getElementById('dice-btn');
  const createBtn = document.getElementById('create-btn');
  const roomInput = document.getElementById('room-input');
  const joinBtn = document.getElementById('join-btn');
  const lobbyError = document.getElementById('lobby-error');
  const lobbyStatus = document.getElementById('lobby-status');

  const roomPanel = document.getElementById('room-panel');
  const roomCodeEl = document.getElementById('room-code');
  const roomCountEl = document.getElementById('room-count');
  const copyBtn = document.getElementById('copy-btn');
  const leaveBtn = document.getElementById('leave-btn');
  const scoreboardEl = document.getElementById('scoreboard');

  const topRight = document.getElementById('top-right');
  const monsterCountEl = document.getElementById('monster-count');
  const muteBtn = document.getElementById('mute-btn');

  const waitingPanel = document.getElementById('waiting-panel');
  const waitingTitle = document.getElementById('waiting-title');
  const waitingSub = document.getElementById('waiting-sub');
  const startBtn = document.getElementById('start-btn');

  const upgradeOverlay = document.getElementById('upgrade-overlay');
  const upgradeTitle = document.getElementById('upgrade-title');
  const upgradeTimerEl = document.getElementById('upgrade-timer');
  const upgradeCardsEl = document.getElementById('upgrade-cards');
  const upgradeStatus = document.getElementById('upgrade-status');

  const socket = io();

   ===== 常數 =====
  const MAX_NICKNAME_LENGTH = 12;
  const NICK_STORAGE_KEY = 'coop-shooternickname';
  const COPY_LABEL = '複製邀請連結';
  const HUD_HINT = 'WASD  方向鍵移動・滑鼠瞄準・左鍵射擊・1  2  3 選擇強化・M 鍵切換音效';
  const FONT = 'system-ui, Noto Sans TC, sans-serif';
  const BUFF_KEYS = ['spread', 'speed'];
  const BUFF_LABELS = { spread '散彈強化', speed '疾風加速' };
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion reduce)').matches);

   =====================================================
    音效（Web Audio API 程式化合成，不需要任何外部音檔）
   =====================================================
  const Sound = (() = {
    const MUTE_KEY = 'coop-shootermuted';
    const MASTER_VOLUME = 0.6;
    const MAX_VOICES = 36;       同時發聲上限，避免大量怪物同時死亡時爆音或卡頓

    let ac = null;
    let master = null;
    let noiseBuf = null;
    let voices = 0;
    let muted = false;
    const lastPlay = {};

    try {
      muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch (_) {  忽略  }

     必須在使用者操作（點擊  按鍵）之後呼叫，瀏覽器才允許開始播放
    function ensure() {
      if (!ac) {
        const AC = window.AudioContext  window.webkitAudioContext;
        if (!AC) return null;
        try {
          ac = new AC();
        } catch (_) {
          return null;
        }
        const comp = ac.createDynamicsCompressor();
        master = ac.createGain();
        master.gain.value = muted  0  MASTER_VOLUME;
        master.connect(comp);
        comp.connect(ac.destination);

         預先產生 1 秒白噪音，爆破聲重複使用
        noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i  data.length; i++) data[i] = Math.random()  2 - 1;
      }
      if (ac.state === 'suspended') {
        const r = ac.resume();
        if (r && typeof r.catch === 'function') r.catch(() = {});
      }
      return ac;
    }

    function ready() {
      return !!ac && ac.state === 'running' && !muted && voices  MAX_VOICES;
    }

     限制同一種音效的最短間隔（毫秒）
    function gate(key, ms) {
      const t = performance.now();
      if (t - (lastPlay[key]  0)  ms) return false;
      lastPlay[key] = t;
      return true;
    }

     單一振盪器音：頻率從 f0 滑到 f1，音量快速淡入、指數淡出
    function tone(o) {
      const t0 = ac.currentTime + (o.delay  0);
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = o.type  'square';
      osc.frequency.setValueAtTime(o.f0, t0);
      if (o.f1 && o.f1 !== o.f0) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + o.dur);
      }
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      osc.connect(g);
      g.connect(master);
      voices++;
      osc.onended = () = { voices--; };
      osc.start(t0);
      osc.stop(t0 + o.dur + 0.03);
    }

     濾波白噪音：用來做爆破  撞擊的「沙沙」質感
    function noise(o) {
      const t0 = ac.currentTime + (o.delay  0);
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const filter = ac.createBiquadFilter();
      filter.type = o.filter  'lowpass';
      filter.frequency.setValueAtTime(o.f0, t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      src.connect(filter);
      filter.connect(g);
      g.connect(master);
      voices++;
      src.onended = () = { voices--; };
      src.start(t0);
      src.stop(t0 + o.dur + 0.03);
    }

     爆破：噪音下掃 + 低頻重擊；delay 讓 Boss 死亡可以疊多段
    function boom(big, delay) {
      noise({ f0 big  2400  1800, f1 160, dur big  0.5  0.28, vol big  0.45  0.32, delay });
      tone({ type 'sine', f0 big  110  150, f1 38, dur big  0.45  0.25, vol big  0.45  0.3, delay });
    }

    return {
      unlock() { ensure(); },
      isMuted() { return muted; },
      setMuted(v) {
        muted = v;
        try {
          localStorage.setItem(MUTE_KEY, v  '1'  '0');
        } catch (_) {  忽略  }
        if (master && ac) master.gain.setTargetAtTime(v  0  MASTER_VOLUME, ac.currentTime, 0.02);
        if (!v) ensure();
      },

       射擊雷射聲（own = 自己的槍聲較大聲，隊友的較小聲且限頻）
      shoot(own) {
        if (!ready()  !gate(own  'shotOwn'  'shotOther', own  40  70)) return;
        tone({ type 'square', f0 920, f1 170, dur 0.09, vol own  0.1  0.035 });
      },

       擊殺怪物爆破聲
      explode(big) {
        if (!ready()  !gate('boom', 30)) return;
        boom(big, 0);
      },

       撿取道具：三連音，依道具類型改變音高
      pickup(type, own) {
        if (!ready()  !gate('pickup' + (own  'Own'  'Other'), 60)) return;
        const notes = {
          heal [523, 659, 784],
          spread [440, 660, 880],
          speed [660, 880, 1320],
        }[type]  [660, 880, 1100];
        notes.forEach((f, i) = {
          tone({ type 'triangle', f0 f, f1 f  1.02, dur 0.1, vol own  0.16  0.06, delay i  0.065 });
        });
      },

       波次晉級：上行小號
      wave() {
        if (!ready()  !gate('wave', 300)) return;
        [392, 523, 659, 784].forEach((f, i) = {
          tone({ type 'square', f0 f, dur 0.14, vol 0.1, delay i  0.09 });
        });
        tone({ type 'square', f0 1047, dur 0.35, vol 0.1, delay 0.36 });
      },

       玩家受傷：低沉悶響
      hurt() {
        if (!ready()  !gate('hurt', 90)) return;
        tone({ type 'sawtooth', f0 190, f1 55, dur 0.3, vol 0.28 });
        noise({ f0 700, f1 90, dur 0.2, vol 0.25 });
      },

       敵方開火：較輕的下滑音
      enemyShot(isBoss) {
        if (!ready()  !gate('enemyShot', 70)) return;
        tone({ type 'triangle', f0 isBoss  260  340, f1 120, dur 0.11, vol isBoss  0.1  0.06 });
      },

       Boss 登場：低頻怒吼 + 轟隆
      bossSpawn() {
        if (!ready()  !gate('bossSpawn', 500)) return;
        tone({ type 'sawtooth', f0 62, f1 44, dur 1.5, vol 0.28 });
        tone({ type 'sawtooth', f0 66, f1 50, dur 1.5, vol 0.2 });
        tone({ type 'square', f0 130, f1 80, dur 1.2, vol 0.06, delay 0.1 });
        noise({ f0 380, f1 50, dur 1.4, vol 0.32 });
      },

       Boss 被擊破：連環爆破 + 上行勝利音
      bossDefeat() {
        if (!ready()  !gate('bossDefeat', 500)) return;
        [0, 0.13, 0.3, 0.48].forEach((d, i) = boom(i === 3, d));
        [523, 659, 784, 1047, 1319].forEach((f, i) = {
          tone({ type 'triangle', f0 f, dur 0.18, vol 0.14, delay 0.7 + i  0.09 });
        });
      },

       升級選項彈出：兩聲清脆的提示音
      upgradeOpen() {
        if (!ready()  !gate('upgradeOpen', 200)) return;
        [523, 784].forEach((f, i) = {
          tone({ type 'triangle', f0 f, dur 0.16, vol 0.12, delay i  0.1 });
        });
      },

       選定升級：上掃「充能」聲 + 四連閃亮音
      upgradePick() {
        if (!ready()  !gate('upgradePick', 150)) return;
        tone({ type 'square', f0 300, f1 900, dur 0.18, vol 0.12 });
        [659, 880, 1175, 1568].forEach((f, i) = {
          tone({ type 'triangle', f0 f, dur 0.12, vol 0.13, delay 0.1 + i  0.07 });
        });
      },

       房主開始遊戲：短促的上行號角
      gameStart() {
        if (!ready()  !gate('gameStart', 400)) return;
        [330, 440, 554, 659].forEach((f, i) = {
          tone({ type 'square', f0 f, dur 0.12, vol 0.1, delay i  0.08 });
        });
        tone({ type 'square', f0 880, dur 0.4, vol 0.11, delay 0.34 });
        noise({ f0 1200, f1 200, dur 0.3, vol 0.12, delay 0.34 });
      },
    };
  })();

   瀏覽器規定：第一次使用者操作後才能播放。之後每次操作都順便確認 AudioContext 沒被暫停
  ['pointerdown', 'keydown', 'touchstart'].forEach((evName) = {
    window.addEventListener(evName, () = Sound.unlock(), { capture true, passive true });
  });

  function refreshMuteBtn() {
    const m = Sound.isMuted();
    muteBtn.textContent = m  '🔇'  '🔊';
    muteBtn.title = m  '音效已靜音（M）'  '音效開啟中（M）';
    muteBtn.setAttribute('aria-pressed', String(m));
  }

  function toggleMute() {
    Sound.setMuted(!Sound.isMuted());
    refreshMuteBtn();
  }

  muteBtn.addEventListener('click', () = {
    muteBtn.blur();
    toggleMute();
  });

  refreshMuteBtn();

   =====================================================
    螢幕震動
   =====================================================
  const MAX_SHAKE = 24;
  let shakeMag = 0;           目前震動幅度（canvas 像素）
  let rumbleUntil = 0;        持續震動（Boss 登場  死亡）的結束時間
  let rumbleMag = 0;

  function addShake(mag) {
    const m = reduceMotion  mag  0.3  mag;
    shakeMag = Math.min(MAX_SHAKE, Math.max(shakeMag, m));
  }

  function rumble(mag, ms) {
    rumbleMag = mag;
    rumbleUntil = performance.now() + ms;
  }

   ===== 狀態 =====
  let inGame = false;       是否已進入房間（false = 顯示大廳）
  let pending = false;      是否正在等待伺服器回應建立  加入房間
  let myId = null;
  let roomId = null;
  let maxPlayers = 4;

  let phase = null;         房間階段：'waiting'  'playing'  'upgrade'（null = 尚未收到第一個快照）
  let hostId = null;        目前房主的 socket id
  let offer = null;         升級選項：{ wave, options, sel, picked, pending, endAt }；null = 沒有進行中的選擇
  let startPending = false;
  let startFeedback = '';
  let startFeedbackTimer = null;

   由伺服器 init 事件覆寫
  let config = {
    playerRadius 20,
    playerMaxHp 100,
    bulletRadius 5,
    reviveRange 70,
    reviveTime 2,
    maxMonsters 30,
    monsterTypes {},
    waveDuration 25,
    bossWaveInterval 5,
    dropLifetime 15,
    dropRadius 12,
    buffDuration 8,
    dropTypes {},
    upgradeTypes {},
    upgradeOrder [],
    upgradeTimeout 15,
    afterWipe 'waiting',
  };

   ===== 客戶端渲染用資料 =====
   players[id] = { name, x, y (伺服器座標), rx, ry (平滑後繪製座標), angle, rAngle, color, hp, maxHp, downed, inv, kills, revive, flash, buffEnd, up, pk }
     buffEnd = { spread, speed }：Buff 結束的時間點（performance.now 時基），0 代表未啟用
     up = 依 config.upgradeOrder 排列的永久升級等級
  const players = {};
   monsters Mapid, { type, x, y, rx, ry, hp, flash, st, stAt, ang, rAng, maxHp, shownHp }
  const monsters = new Map();
   bullets  enemyBullets [{ x, y, vx, vy, (r), (pc), t }]  t 為收到該快照的時間，用來做位置外插
  let bullets = [];
  let enemyBullets = [];
   drops [{ id, type, x, y, endAt }]  endAt 為消失的時間點（performance.now 時基）
  let drops = [];
   特效：{ kind 'ring'  'text', x, y, r, grow, lw, text, color, life, maxLife }
  let effects = [];

  let wave = 1;
  let surviveTime = 0;
  let spawnInterval = 2;
  let lastWave = null;     用來偵測波次變化（null = 尚未收到第一個快照）

  let wipeEndAt = null;    全員倒地時，預計重置的時間點 (performance.now 時基)
  let banner = null;       { text, sub, color, start, until }

   ===== 輸入狀態 =====
  const input = { up false, down false, left false, right false };
  const mouse = { x canvas.width  2, y canvas.height  2, down false };
  let lastAimSent = 0;
  let lastAimAngle = 0;

   =====================================================
    大廳（Lobby）
   =====================================================
  const NAME_PREFIXES = ['獵人', '射手', '游俠', '守衛', '先鋒', '突擊', '狙擊', '工程師'];

  function randomNickname() {
    const prefix = NAME_PREFIXES[Math.floor(Math.random()  NAME_PREFIXES.length)];
    return prefix + (Math.floor(Math.random()  9000) + 1000);
  }

  function isValidNickname(name) {
    const len = Array.from(name).length;
    return len = 1 && len = MAX_NICKNAME_LENGTH;
  }

  function loadSavedNickname() {
    try {
      const saved = localStorage.getItem(NICK_STORAGE_KEY);
      if (saved && isValidNickname(saved)) return saved;
    } catch (_) {  隱私模式等情況無法使用 localStorage，忽略即可  }
    return randomNickname();
  }

  function saveNickname(name) {
    try {
      localStorage.setItem(NICK_STORAGE_KEY, name);
    } catch (_) {  忽略  }
  }

   回傳整理過的暱稱（合併空白、去頭尾空白）；不合法則回傳 null
  function readNickname() {
    const name = nicknameInput.value.replace(s+g, ' ').trim();
    return isValidNickname(name)  name  null;
  }

   房號：轉大寫並只保留英數字
  function normalizeRoomCode(value) {
    return value.toUpperCase().replace([^A-Z0-9]g, '').slice(0, 4);
  }

   從網址 room=ABCD 取出邀請房號；格式不正確則回傳 null
  function readInviteCode() {
    try {
      const raw = new URLSearchParams(window.location.search).get('room');
      if (!raw) return null;
      const code = normalizeRoomCode(raw);
      return code.length === 4  code  null;
    } catch (_) {
      return null;
    }
  }

   產生目前房間的完整邀請網址（保留目前的網域與路徑，只換掉 query）
  function buildInviteUrl() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', roomId);
    return url.toString();
  }

  function showLobbyError(msg) {
    lobbyError.textContent = msg;
  }

  function clearLobbyError() {
    lobbyError.textContent = '';
  }

  function refreshLobbyButtons() {
    const disabled = pending  !socket.connected;
    createBtn.disabled = disabled;
    joinBtn.disabled = disabled;
  }

   送出「建立  加入房間」請求。成功時伺服器會接著送出 init 事件，由 init 負責切換畫面
  function requestEnter(eventName, payload) {
    if (pending) return;
    pending = true;
    refreshLobbyButtons();
    lobbyStatus.textContent = '處理中…';

    socket.timeout(5000).emit(eventName, payload, (err, res) = {
      pending = false;
      lobbyStatus.textContent = '';
      refreshLobbyButtons();

      if (err) {
        showLobbyError('伺服器沒有回應，請稍後再試');
        return;
      }
      if (!res  !res.ok) {
        showLobbyError((res && res.error)  '無法進入房間，請稍後再試');
      }
    });
  }

  createBtn.addEventListener('click', () = {
    clearLobbyError();
    const nickname = readNickname();
    if (!nickname) {
      showLobbyError(`暱稱需為 1～${MAX_NICKNAME_LENGTH} 個字元`);
      nicknameInput.focus();
      return;
    }
    saveNickname(nickname);
    requestEnter('createRoom', { nickname });
  });

  joinBtn.addEventListener('click', () = {
    clearLobbyError();
    const nickname = readNickname();
    if (!nickname) {
      showLobbyError(`暱稱需為 1～${MAX_NICKNAME_LENGTH} 個字元`);
      nicknameInput.focus();
      return;
    }
    const code = normalizeRoomCode(roomInput.value);
    roomInput.value = code;
    if (code.length !== 4) {
      showLobbyError('請輸入 4 碼英數字房號');
      roomInput.focus();
      return;
    }
    saveNickname(nickname);
    requestEnter('joinRoom', { nickname, roomId code });
  });

  diceBtn.addEventListener('click', () = {
    nicknameInput.value = randomNickname();
    clearLobbyError();
  });

  nicknameInput.addEventListener('input', clearLobbyError);

   房號欄已填好（例如透過邀請連結）時，在暱稱欄按 Enter 直接加入
  nicknameInput.addEventListener('keydown', (e) = {
    if (e.key !== 'Enter'  e.isComposing  e.keyCode === 229) return;  避開輸入法選字用的 Enter
    if (normalizeRoomCode(roomInput.value).length === 4) {
      e.preventDefault();
      joinBtn.click();
    }
  });

  roomInput.addEventListener('input', (e) = {
    clearLobbyError();
    if (e.isComposing) return;  輸入法組字中先不要動內容
    roomInput.value = normalizeRoomCode(roomInput.value);
  });

  roomInput.addEventListener('keydown', (e) = {
    if (e.key === 'Enter') {
      e.preventDefault();
      joinBtn.click();
    }
  });

  nicknameInput.value = loadSavedNickname();
  lobbyStatus.textContent = '連線伺服器中…';
  hud.textContent = '請先建立或加入房間';
  refreshLobbyButtons();

   透過 room=ABCD 開啟：自動填入房號並聚焦在暱稱欄（全選方便直接改名）
  const inviteCode = readInviteCode();
  if (inviteCode) {
    roomInput.value = inviteCode;
    lobbyInvite.textContent = `你受邀加入房間 ${inviteCode}，確認暱稱後按「加入房間」即可`;
    lobbyInvite.hidden = false;
    nicknameInput.focus();
    nicknameInput.select();
  } else {
    nicknameInput.focus();
  }

   =====================================================
    房間面板（複製邀請連結  離開房間  記分板）
   =====================================================
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {  改用備援做法  }

     備援：區網 IP（http）下沒有 navigator.clipboard，改用 execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  let copyResetTimer = null;
  copyBtn.addEventListener('click', async () = {
    copyBtn.blur();  避免按鈕保留焦點，之後按空白鍵  Enter 又重複觸發
    if (!roomId) return;
    const ok = await copyText(buildInviteUrl());
    copyBtn.textContent = ok  '已複製連結！'  '複製失敗';
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() = {
      copyBtn.textContent = COPY_LABEL;
    }, 1500);
  });

  leaveBtn.addEventListener('click', () = {
    leaveBtn.blur();
    if (!inGame) return;
    socket.emit('leaveRoom');
    leaveToLobby();
  });

  let lastScoreboardAt = 0;

   記分板、人數與怪物數量都是 HTML 元素，限頻更新即可
  function updateScoreboard(now, force) {
    if (!force && now - lastScoreboardAt  120) return;
    lastScoreboardAt = now;

    const entries = Object.keys(players)
      .map((id) = ({ id, p players[id] }))
      .sort((a, b) = b.p.kills - a.p.kills);

    roomCountEl.textContent = `人數 ${entries.length}${maxPlayers}`;
    monsterCountEl.textContent = `怪物 ${monsters.size}${config.maxMonsters}`;

    const frag = document.createDocumentFragment();
    for (const { id, p } of entries) {
      const row = document.createElement('div');
      row.className = 'sb-row' + (id === myId  ' me'  '');

      const dot = document.createElement('span');
      dot.className = 'sb-dot';
      dot.style.background = p.downed  '#6e7681'  p.color;

       名稱欄：房主前面加上皇冠標籤
      const nameWrap = document.createElement('span');
      nameWrap.className = 'sb-name-wrap';
      if (id === hostId) {
        const tag = document.createElement('span');
        tag.className = 'sb-host';
        tag.textContent = '👑 房主';
        nameWrap.appendChild(tag);
      }
      const name = document.createElement('span');
      name.className = 'sb-name';
      name.textContent = p.name;        一律用 textContent，暱稱不會被當成 HTML
      nameWrap.appendChild(name);

      const status = document.createElement('span');
      status.className = 'sb-status' + (p.downed  ' down'  '');
      status.textContent = p.downed  '倒地'  `HP ${p.hp}`;

      const kills = document.createElement('span');
      kills.className = 'sb-kills';
      kills.textContent = `擊殺 ${p.kills}`;

      row.append(dot, nameWrap, status, kills);
      frag.appendChild(row);
    }
    scoreboardEl.replaceChildren(frag);

    if (phase === 'waiting') updateWaitingPanel();
  }

   =====================================================
    等待階段面板（房主才有「開始遊戲」按鈕）
   =====================================================
  function updateWaitingPanel() {
    const isHost = myId !== null && myId === hostId;
    const hostPlayer = players[hostId];
    const count = Object.keys(players).length;

    waitingTitle.textContent = isHost  '你是房主：準備好就開始遊戲！'  '等待房主開始遊戲…';

    if (startFeedback) {
      waitingSub.textContent = startFeedback;
    } else if (isHost) {
      waitingSub.textContent = `目前 ${count}${maxPlayers} 人・等隊友加入後按下開始，期間可以自由移動與試射`;
    } else {
      const hostName = hostPlayer  hostPlayer.name  '房主';
      waitingSub.textContent = `房主：${hostName}・先熟悉一下操作，可以自由移動與試射`;
    }

    startBtn.hidden = !isHost;
    startBtn.disabled = startPending;
  }

  function showStartFeedback(text) {
    startFeedback = text;
    clearTimeout(startFeedbackTimer);
    startFeedbackTimer = setTimeout(() = {
      startFeedback = '';
      if (inGame && phase === 'waiting') updateWaitingPanel();
    }, 3000);
  }

  startBtn.addEventListener('click', () = {
    startBtn.blur();
    if (!inGame  phase !== 'waiting'  startPending) return;

    startPending = true;
    startBtn.disabled = true;

    socket.timeout(5000).emit('startGame', {}, (err, res) = {
      startPending = false;
      if (err) {
        showStartFeedback('伺服器沒有回應，請再試一次');
      } else if (!res  !res.ok) {
        showStartFeedback((res && res.error)  '無法開始遊戲');
      }
      if (inGame && phase === 'waiting') updateWaitingPanel();
    });
  });

   =====================================================
    每波三選一升級介面
   =====================================================
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function renderUpgradeCards() {
    if (!offer) return;
    const cards = upgradeCardsEl.children;
    for (let i = 0; i  cards.length; i++) {
      const card = cards[i];
      const key = offer.options[i] && offer.options[i].key;
      const locked = offer.picked !== null  offer.pending;
      const chosen = locked && offer.sel === key;
      card.disabled = locked;
      card.classList.toggle('selected', chosen);
      card.classList.toggle('dim', locked && !chosen);
    }
  }

  function showUpgradeOverlay(d) {
    mouse.down = false;  選擇期間不射擊
    offer = {
      wave d.wave,
      options d.options,
      sel null,          目前點選（或已確認）的選項 key
      picked null,       伺服器已確認的選項 key
      pending false,     已送出、等待伺服器確認
      endAt performance.now() + d.timeout  1000,
    };

    upgradeTitle.textContent = `WAVE ${d.wave} 完成！選擇一項永久強化`;
    upgradeStatus.textContent = '點擊卡片，或按鍵盤 1  2  3';

    const frag = document.createDocumentFragment();
    d.options.forEach((opt, i) = {
      const def = config.upgradeTypes[opt.key];
      if (!def) return;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upg-card';
      card.style.setProperty('--c', def.color);

      const keyEl = document.createElement('span');
      keyEl.className = 'upg-key';
      keyEl.textContent = String(i + 1);

      const icon = document.createElement('span');
      icon.className = 'upg-icon';
      icon.textContent = def.icon;

      const name = document.createElement('div');
      name.className = 'upg-name';
      name.textContent = def.label;

      const desc = document.createElement('div');
      desc.className = 'upg-desc';
      desc.textContent = def.desc;

      const lv = document.createElement('div');
      lv.className = 'upg-level';
      lv.textContent = `Lv ${opt.level} → Lv ${opt.level + 1}（上限 ${def.maxLevel}）`;

      card.append(keyEl, icon, name, desc, lv);
      card.addEventListener('click', () = {
        card.blur();
        chooseUpgrade(opt.key);
      });
      frag.appendChild(card);
    });
    upgradeCardsEl.replaceChildren(frag);

    upgradeOverlay.hidden = false;
    renderUpgradeCards();
    Sound.upgradeOpen();
  }

  function hideUpgradeOverlay() {
    offer = null;
    upgradeOverlay.hidden = true;
    upgradeCardsEl.replaceChildren();
  }

  function chooseUpgradeByIndex(i) {
    if (!offer  !offer.options[i]) return;
    chooseUpgrade(offer.options[i].key);
  }

  function chooseUpgrade(key) {
    if (!offer  offer.picked !== null  offer.pending) return;

    offer.pending = true;
    offer.sel = key;
    renderUpgradeCards();

    socket.timeout(5000).emit('chooseUpgrade', { key }, (err, res) = {
      if (!offer) return;
      offer.pending = false;

       時間剛好到、伺服器已自動幫我們選了：以 upgradeChosen 事件為準
      if (offer.picked !== null) {
        renderUpgradeCards();
        return;
      }

      if (err  !res  !res.ok) {
        offer.sel = null;
        upgradeStatus.textContent = err  '伺服器沒有回應，請再選一次'  (res && res.error)  '選擇失敗，請再試一次';
        renderUpgradeCards();
        return;
      }

      offer.picked = key;
      Sound.upgradePick();
      addShake(3);
      renderUpgradeCards();
    });
  }

   每一幀更新：倒數秒數與「等待其他玩家」的進度
  function updateUpgradeUI(now) {
    if (!offer  upgradeOverlay.hidden) return;

    const remain = Math.max(0, Math.ceil((offer.endAt - now)  1000));
    setText(upgradeTimerEl, String(remain));
    upgradeTimerEl.classList.toggle('urgent', remain = 5);

    if (offer.picked !== null) {
      const def = config.upgradeTypes[offer.picked];
      let ready = 0;
      const ids = Object.keys(players);
      for (const id of ids) if (players[id].pk) ready++;
      setText(
        upgradeStatus,
        `已選擇「${def  def.label  offer.picked}」・等待其他玩家（${ready}${ids.length}）…`
      );
    }
  }

   =====================================================
    畫面切換
   =====================================================
  function resetWorldState() {
    for (const id in players) delete players[id];
    monsters.clear();
    bullets = [];
    enemyBullets = [];
    drops = [];
    effects = [];
    wave = 1;
    surviveTime = 0;
    spawnInterval = 2;
    lastWave = null;
    wipeEndAt = null;
    banner = null;
    shakeMag = 0;
    rumbleUntil = 0;
    phase = null;
    hostId = null;
    startPending = false;
    startFeedback = '';
    for (const k in input) input[k] = false;
    mouse.down = false;
    lastAimSent = 0;
    lastAimAngle = 0;
    scoreboardEl.replaceChildren();
    waitingPanel.hidden = true;
    hideUpgradeOverlay();
  }

  function enterGame(data) {
    resetWorldState();

    myId = data.id;
    roomId = data.roomId;
    maxPlayers = data.maxPlayers;
    config = {
      playerRadius data.playerRadius,
      playerMaxHp data.playerMaxHp,
      bulletRadius data.bulletRadius,
      reviveRange data.reviveRange,
      reviveTime data.reviveTime,
      maxMonsters data.maxMonsters,
      monsterTypes data.monsterTypes,
      waveDuration data.waveDuration,
      bossWaveInterval data.bossWaveInterval,
      dropLifetime data.dropLifetime,
      dropRadius data.dropRadius,
      buffDuration data.buffDuration,
      dropTypes data.dropTypes,
      upgradeTypes data.upgradeTypes,
      upgradeOrder data.upgradeOrder,
      upgradeTimeout data.upgradeTimeout,
      afterWipe data.afterWipe,
    };
    canvas.width = data.world.width;
    canvas.height = data.world.height;
    stage.style.setProperty('--ar', String(data.world.width  data.world.height));

    roomCodeEl.textContent = `房號 ${roomId}`;
    roomCountEl.textContent = `人數 1${maxPlayers}`;
    monsterCountEl.textContent = `怪物 0${config.maxMonsters}`;
    copyBtn.textContent = COPY_LABEL;
    refreshMuteBtn();

    inGame = true;
    lobby.hidden = true;
    lobbyInvite.hidden = true;
    roomPanel.hidden = false;
    topRight.hidden = false;
    hud.textContent = HUD_HINT;
    clearLobbyError();
  }

  function leaveToLobby(message) {
    inGame = false;
    myId = null;
    roomId = null;
    resetWorldState();

    roomPanel.hidden = true;
    topRight.hidden = true;
    lobby.hidden = false;
    lobbyInvite.hidden = true;
    hud.textContent = '請先建立或加入房間';
    roomInput.value = '';
    clearLobbyError();
    if (message) showLobbyError(message);
    refreshLobbyButtons();
  }

   房間階段切換時的處理
  function onPhaseChange(prev) {
    if (prev === 'upgrade') hideUpgradeOverlay();

    waitingPanel.hidden = phase !== 'waiting';
    if (phase === 'waiting') updateWaitingPanel();
  }

   =====================================================
    鍵盤  滑鼠輸入（只在遊戲中生效，並避開輸入框）
   =====================================================
  const keyMap = {
    KeyW 'up',
    ArrowUp 'up',
    KeyS 'down',
    ArrowDown 'down',
    KeyA 'left',
    ArrowLeft 'left',
    KeyD 'right',
    ArrowRight 'right',
  };

   升級快捷鍵：主鍵盤與數字鍵盤的 1  2  3
  const upgradeKeyMap = {
    Digit1 0, Numpad1 0,
    Digit2 1, Numpad2 1,
    Digit3 2, Numpad3 2,
  };

  function isTypingTarget(t) {
    return !!t && (t.tagName === 'INPUT'  t.tagName === 'TEXTAREA');
  }

  function sendInput() {
    socket.emit('input', input);
  }

  window.addEventListener('keydown', (e) = {
    if (!inGame  isTypingTarget(e.target)) return;

    if (e.code === 'KeyM') {
      if (!e.repeat) toggleMute();
      return;
    }

    if (e.code in upgradeKeyMap) {
      if (offer && !e.repeat) {
        e.preventDefault();
        chooseUpgradeByIndex(upgradeKeyMap[e.code]);
      }
      return;
    }

    const dir = keyMap[e.code];
    if (!dir) return;
    e.preventDefault();
    if (!input[dir]) {
      input[dir] = true;
      sendInput();
    }
  });

  window.addEventListener('keyup', (e) = {
    if (!inGame) return;
    const dir = keyMap[e.code];
    if (!dir) return;
    e.preventDefault();
    if (input[dir]) {
      input[dir] = false;
      sendInput();
    }
  });

   把螢幕座標換算成 canvas 內部座標（canvas 可能被 CSS 縮放）
  function updateMouse(e) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - rect.left)  (canvas.width  rect.width);
    mouse.y = (e.clientY - rect.top)  (canvas.height  rect.height);
  }

  function getMyAngle() {
    const me = players[myId];
    if (!me) return 0;
    return Math.atan2(mouse.y - me.ry, mouse.x - me.rx);
  }

  function trySendShoot() {
    if (!inGame  phase === 'upgrade') return;
    const me = players[myId];
    if (!me  me.downed  !socket.connected) return;
    socket.emit('shoot', { angle getMyAngle() });
  }

  window.addEventListener('mousemove', updateMouse);

  canvas.addEventListener('mousedown', (e) = {
    if (!inGame  e.button !== 0) return;
    e.preventDefault();
    updateMouse(e);
    mouse.down = true;
    trySendShoot();
  });

  window.addEventListener('mouseup', (e) = {
    if (e.button === 0) mouse.down = false;
  });

  canvas.addEventListener('contextmenu', (e) = e.preventDefault());

   按住左鍵時持續送出 shoot（真正的射速與冷卻由伺服器決定）
  setInterval(() = {
    if (inGame && mouse.down) trySendShoot();
  }, 60);

   定期把瞄準角度同步給伺服器，讓其他玩家看到你的槍管方向
  function sendAimIfNeeded(now) {
    if (!inGame  !myId  !players[myId]  !socket.connected) return;
    const a = getMyAngle();
    if (Math.abs(a - lastAimAngle)  0.02  now - lastAimSent  33) return;
    lastAimAngle = a;
    lastAimSent = now;
    socket.emit('aim', { angle a });
  }

   視窗失焦時清空按鍵與滑鼠狀態
  window.addEventListener('blur', () = {
    mouse.down = false;
    if (!inGame) return;
    let changed = false;
    for (const k in input) {
      if (input[k]) {
        input[k] = false;
        changed = true;
      }
    }
    if (changed) sendInput();
  });

   =====================================================
    Socket 事件
   =====================================================
  socket.on('connect', () = {
    lobbyStatus.textContent = '';
    refreshLobbyButtons();
  });

  socket.on('connect_error', () = {
    lobbyStatus.textContent = '無法連線到伺服器，重試中…';
  });

  socket.on('disconnect', () = {
    pending = false;
    if (inGame) {
      leaveToLobby('與伺服器的連線中斷，請重新加入房間');
    }
    lobbyStatus.textContent = '連線中斷，重新連線中…';
    refreshLobbyButtons();
  });

  socket.on('init', (data) = {
    enterGame(data);
  });

  socket.on('state', (s) = {
    if (!inGame) return;
    const now = performance.now();

     --- 房間階段與房主 ---
    let hostChanged = false;
    if (s.host !== hostId) {
      hostId = s.host;
      hostChanged = true;
    }
    if (s.phase !== phase) {
      const prev = phase;
      phase = s.phase;
      onPhaseChange(prev);
    }
     以伺服器剩餘秒數校正升級倒數
    if (offer && s.phase === 'upgrade') offer.endAt = now + s.upLeft  1000;

     --- 玩家 ---
    const aliveIds = new Set();
    for (const sp of s.players) {
      aliveIds.add(sp.id);
      let p = players[sp.id];
      if (!p) {
        p = players[sp.id] = {
          x sp.x, y sp.y, rx sp.x, ry sp.y,
          angle sp.angle, rAngle sp.angle,
          hp sp.hp, flash 0,
        };
      } else if (sp.hp  p.hp) {
        p.flash = 1;  受傷閃紅
        if (sp.id === myId) {
           自己受傷：低沉音效 + 明顯的鏡頭震動（傷害越高震越大）
          Sound.hurt();
          addShake(Math.min(16, 5 + (p.hp - sp.hp)  0.6));
        }
      }
      p.name = sp.name;
      p.x = sp.x;
      p.y = sp.y;
      p.angle = sp.angle;
      p.color = sp.color;
      p.hp = sp.hp;
      p.maxHp = sp.mh;
      p.downed = sp.downed;
      p.inv = sp.inv;
      p.kills = sp.kills;
      p.revive = sp.revive;
      p.up = sp.up;
      p.pk = sp.pk;
       Buff 剩餘秒數 → 結束時間點，之後每一幀都能算出平滑的剩餘時間
      p.buffEnd = {
        spread sp.buffs.spread  0  now + sp.buffs.spread  1000  0,
        speed sp.buffs.speed  0  now + sp.buffs.speed  1000  0,
      };
    }
    for (const id in players) {
      if (!aliveIds.has(id)) delete players[id];
    }

     --- 怪物 ---
    const seen = new Set();
    for (const sm of s.monsters) {
      seen.add(sm.id);
      let m = monsters.get(sm.id);
      if (!m) {
        m = {
          type sm.type, x sm.x, y sm.y, rx sm.x, ry sm.y, hp sm.hp, flash 0,
          st sm.st  0, stAt now,
          ang sm.a  0, rAng sm.a  0,
          maxHp sm.mx  0, shownHp sm.hp,
        };
        monsters.set(sm.id, m);
      } else if (sm.hp  m.hp) {
        m.flash = 1;  被打到閃白
      }
      m.x = sm.x;
      m.y = sm.y;
      m.hp = sm.hp;
      if (sm.mx) m.maxHp = sm.mx;

       特殊怪物（衝刺  射手  Boss）：狀態與朝向
      if (sm.st !== undefined) {
        if (sm.st !== m.st) {
          m.st = sm.st;
          m.stAt = now;
        }
        m.ang = sm.a;
      }
    }
    for (const [id, m] of monsters) {
      if (seen.has(id)) continue;
      const info = config.monsterTypes[m.type];
       Boss 的死亡演出由 bossDefeated 事件負責
      if (!(info && info.boss)) {
        effects.push({
          kind 'ring', x m.rx, y m.ry, r info  info.r  15,
          color '#ff7b72', life 0.35, maxLife 0.35,
        });
        Sound.explode(!!info && info.r = 26);
      }
      monsters.delete(id);
    }

     --- 子彈（記下收到時間，渲染時依速度外插）---
    bullets = s.bullets.map((b) = ({ x b.x, y b.y, vx b.vx, vy b.vy, pc b.pc, t now }));
    enemyBullets = s.enemyBullets.map((b) = ({ x b.x, y b.y, vx b.vx, vy b.vy, r b.r, t now }));

     --- 掉落物（記下消失時間點，用來畫倒數與閃爍）---
    drops = s.drops.map((d) = ({ id d.id, type d.type, x d.x, y d.y, endAt now + d.life  1000 }));

     --- 波次 ---
    wave = s.wave;
    surviveTime = s.time;
    spawnInterval = s.spawnInterval;
    if (lastWave === null) {
      lastWave = wave;
    } else if (wave  lastWave) {
       Boss 波次的橫幅與音效由 bossSpawn 事件負責
      if (wave % config.bossWaveInterval !== 0) {
         晉級：若這一波解鎖了新怪物，在橫幅上提示
        const unlocked = Object.values(config.monsterTypes)
          .filter((t) = !t.bossOnly && t.minWave === wave)
          .map((t) = t.label);
        banner = {
          text `WAVE ${wave}`,
          sub unlocked.length  0  `新怪物登場：${unlocked.join('、')}`  '怪物越來越多了！',
          color '#ffd43b',
          start now,
          until now + 2200,
        };
        Sound.wave();
      }
      lastWave = wave;
    } else if (wave  lastWave) {
      lastWave = wave;  重置後回到 Wave 1
    }

     --- 全員倒地倒數 ---
    wipeEndAt = s.wipe === null  null  now + s.wipe  1000;

    if (hostChanged) updateScoreboard(now, true);
  });

   有玩家離開房間時立即移除
  socket.on('playerLeft', (id) = {
    if (!inGame) return;
    delete players[id];
    updateScoreboard(performance.now(), true);
  });

   房主按下開始：全員重置並進入 Wave 1
  socket.on('gameStart', () = {
    if (!inGame) return;
    const now = performance.now();
    monsters.clear();
    bullets = [];
    enemyBullets = [];
    drops = [];
    effects = [];
    lastWave = 1;
    wipeEndAt = null;
    banner = {
      text '戰鬥開始！',
      sub 'WAVE 1・每撐過一波就能選擇一項永久強化',
      color '#3fb950',
      start now,
      until now + 2600,
    };
    Sound.gameStart();
    addShake(4);
  });

  socket.on('teamReset', (d) = {
    if (!inGame) return;
    const now = performance.now();
     重置時怪物整批消失，先清掉才不會被當成「被擊殺」而播放大量爆破聲
    monsters.clear();
    bullets = [];
    enemyBullets = [];
    drops = [];
    wipeEndAt = null;
    hideUpgradeOverlay();

    if (d && d.mode === 'restart') {
      banner = {
        text '全員復活！',
        sub '回到 WAVE 1，永久強化已重置',
        color '#3fb950',
        start now,
        until now + 2400,
      };
    } else {
      banner = {
        text '全隊重整',
        sub '回到等待階段，等房主重新開始遊戲',
        color '#58a6ff',
        start now,
        until now + 2800,
      };
    }
  });

   每波結束：彈出三選一
  socket.on('upgradeOffer', (d) = {
    if (!inGame) return;
    showUpgradeOverlay(d);
  });

   時間到，伺服器幫我們隨機選了一項
  socket.on('upgradeChosen', (d) = {
    if (!inGame  !offer  offer.picked !== null) return;
    const def = config.upgradeTypes[d.key];
    offer.picked = d.key;
    offer.sel = d.key;
    offer.pending = false;
    renderUpgradeCards();
    upgradeStatus.textContent = `時間到，已自動選擇「${def  def.label  d.key}」`;
    Sound.upgradePick();
  });

   所有人選完（或超時）：關閉介面，在每位玩家身上顯示他們選了什麼
  socket.on('upgradeEnd', (d) = {
    if (!inGame) return;
    hideUpgradeOverlay();

    const picks = (d && d.picks)  {};
    for (const id in picks) {
      const p = players[id];
      const def = config.upgradeTypes[picks[id]];
      if (!p  !def) continue;
      effects.push({
        kind 'ring', x p.rx, y p.ry, r config.playerRadius,
        grow 36, lw 4, color def.color, life 0.6, maxLife 0.6,
      });
      effects.push({
        kind 'text', x p.rx, y p.ry, text def.label,
        color def.color, life 1.2, maxLife 1.2,
      });
    }
  });

   有人開火：播放射擊音效；自己開火時加上極輕微的後座力震動
  socket.on('shot', (d) = {
    if (!inGame) return;
    if (d.id === myId) {
      Sound.shoot(true);
      addShake(1.4);
    } else {
      Sound.shoot(false);
    }
  });

   敵方開火（射手怪  Boss 彈幕）
  socket.on('enemyShot', (d) = {
    if (!inGame) return;
    Sound.enemyShot(!!d.boss);
    if (d.boss) addShake(2.5);
  });

   有人撿到掉落物：在該玩家身上顯示光圈與文字
  socket.on('pickup', (d) = {
    if (!inGame) return;
    Sound.pickup(d.type, d.id === myId);
    const p = players[d.id];
    const info = config.dropTypes[d.type];
    if (!p  !info) return;
    effects.push({
      kind 'ring', x p.rx, y p.ry, r config.playerRadius,
      color info.color, life 0.4, maxLife 0.4,
    });
    effects.push({
      kind 'text', x p.rx, y p.ry, text info.label,
      color info.color, life 0.9, maxLife 0.9,
    });
  });

   Boss 登場：橫幅、怒吼、鏡頭震動（登場期間持續低頻震動）
  socket.on('bossSpawn', (d) = {
    if (!inGame) return;
    const now = performance.now();
    banner = {
      text '⚠ BOSS 出現！',
      sub `WAVE ${d.wave}・擊敗牠必掉 3 個強化道具`,
      color '#ff5c5c',
      start now,
      until now + 2800,
    };
    Sound.bossSpawn();
    addShake(14);
    rumble(5, 1200);
  });

   Boss 被擊破：連環爆破、大型光環、強烈震動
  socket.on('bossDefeated', (d) = {
    if (!inGame) return;
    const now = performance.now();
    banner = {
      text 'BOSS 擊破！',
      sub '快撿起掉落的強化道具',
      color '#ffd43b',
      start now,
      until now + 2600,
    };
    Sound.bossDefeat();
    addShake(20);
    rumble(8, 600);
    [[80, 0.6], [140, 0.8], [210, 1.0]].forEach(([grow, life]) = {
      effects.push({
        kind 'ring', x d.x, y d.y, r 46, grow, lw 5,
        color '#ffd43b', life, maxLife life,
      });
    });
  });

   =====================================================
    渲染輔助
   =====================================================
  function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff  Math.PI) diff -= Math.PI  2;
    while (diff  -Math.PI) diff += Math.PI  2;
    return a + diff  t;
  }

  function hpColor(ratio) {
    if (ratio  0.5) return '#3fb950';
    if (ratio  0.25) return '#d29922';
    return '#f85149';
  }

  function formatTime(sec) {
    const total = Math.max(0, Math.floor(sec));
    const m = Math.floor(total  60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}${String(s).padStart(2, '0')}`;
  }

  function drawGrid() {
    const step = 80;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x = canvas.width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
    }
    for (let y = 0; y = canvas.height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();
  }

  function drawEffects() {
    for (const fx of effects) {
      const progress = 1 - fx.life  fx.maxLife;

      if (fx.kind === 'text') {
        ctx.globalAlpha = Math.max(0, 1 - progress  progress);
        ctx.font = `bold 15px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        const ty = fx.y - 34 - progress  28;
        ctx.strokeText(fx.text, fx.x, ty);
        ctx.fillStyle = fx.color;
        ctx.fillText(fx.text, fx.x, ty);
        ctx.lineJoin = 'miter';
      } else {
        ctx.globalAlpha = Math.max(0, 1 - progress);
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.r + progress  (fx.grow  18), 0, Math.PI  2);
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = fx.lw  3;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

   ----- 掉落物 -----
  function drawDropIcon(type, cx, cy) {
    if (type === 'heal') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 2, cy - 6, 4, 12);
      ctx.fillRect(cx - 6, cy - 2, 12, 4);
    } else if (type === 'spread') {
       三條扇形線
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy + 6);
      ctx.lineTo(cx - 7, cy - 4);
      ctx.moveTo(cx, cy + 6);
      ctx.lineTo(cx, cy - 7);
      ctx.moveTo(cx, cy + 6);
      ctx.lineTo(cx + 7, cy - 4);
      ctx.stroke();
      ctx.lineCap = 'butt';
    } else if (type === 'speed') {
       閃電
      ctx.fillStyle = '#4a3800';
      ctx.beginPath();
      ctx.moveTo(cx + 2, cy - 8);
      ctx.lineTo(cx - 5, cy + 1);
      ctx.lineTo(cx - 1, cy + 1);
      ctx.lineTo(cx - 2, cy + 8);
      ctx.lineTo(cx + 5, cy - 2);
      ctx.lineTo(cx + 1, cy - 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawDrops(now) {
    const R = config.dropRadius;

    for (const d of drops) {
      const remain = (d.endAt - now)  1000;
      if (remain = 0) continue;
      const info = config.dropTypes[d.type];
      if (!info) continue;

       快消失時閃爍
      if (remain  4 && Math.floor(now  120) % 2 === 0) continue;

      const bob = Math.sin(now  250 + d.id)  2;
      const cx = d.x;
      const cy = d.y + bob;
      const pulse = 0.5 + 0.5  Math.sin(now  200 + d.id);

       外發光
      ctx.beginPath();
      ctx.arc(cx, cy, R + 5 + pulse  3, 0, Math.PI  2);
      ctx.fillStyle = info.color;
      ctx.globalAlpha = 0.18 + pulse  0.1;
      ctx.fill();
      ctx.globalAlpha = 1;

       本體
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI  2);
      ctx.fillStyle = info.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.stroke();

      drawDropIcon(d.type, cx, cy);

       剩餘時間環
      const frac = Math.max(0, Math.min(1, remain  config.dropLifetime));
      ctx.beginPath();
      ctx.arc(cx, cy, R + 4, -Math.PI  2, -Math.PI  2 + Math.PI  2  frac);
      ctx.strokeStyle = info.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

   ----- 怪物 -----
   一般怪物外型：circle  diamond（衝刺怪，尖頭朝向移動方向） hexagon（射手怪）
  function traceMonsterBody(m, info) {
    ctx.beginPath();
    const r = info.r;
    if (info.shape === 'diamond') {
      const a = m.rAng;
      ctx.moveTo(m.rx + Math.cos(a)  r  1.35, m.ry + Math.sin(a)  r  1.35);
      ctx.lineTo(m.rx + Math.cos(a + 2.4)  r, m.ry + Math.sin(a + 2.4)  r);
      ctx.lineTo(m.rx + Math.cos(a + Math.PI)  r  0.6, m.ry + Math.sin(a + Math.PI)  r  0.6);
      ctx.lineTo(m.rx + Math.cos(a - 2.4)  r, m.ry + Math.sin(a - 2.4)  r);
      ctx.closePath();
    } else if (info.shape === 'hexagon') {
      for (let i = 0; i  6; i++) {
        const a = m.rAng + (Math.PI  3)  i;
        const px = m.rx + Math.cos(a)  r;
        const py = m.ry + Math.sin(a)  r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(m.rx, m.ry, r, 0, Math.PI  2);
    }
  }

   蓄力預警與攻擊殘影（畫在本體下方）
  function drawMonsterTelegraph(m, info, now) {
    if (info.dasher) {
      if (m.st === 1) {
         蓄力：預警帶越來越明顯
        const progress = Math.min(1, (now - m.stAt)  (info.windup  1000));
        const len = info.dashRange + info.r;
        ctx.save();
        ctx.translate(m.rx, m.ry);
        ctx.rotate(m.rAng);
        ctx.fillStyle = `rgba(168, 85, 247, ${0.12 + 0.3  progress})`;
        ctx.fillRect(0, -info.r, len, info.r  2);
        ctx.strokeStyle = `rgba(216, 180, 254, ${0.3 + 0.5  progress})`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0, -info.r, len, info.r  2);
        ctx.restore();
      } else if (m.st === 2) {
         衝刺：身後拖出殘影
        ctx.beginPath();
        ctx.moveTo(m.rx, m.ry);
        ctx.lineTo(m.rx - Math.cos(m.rAng)  70, m.ry - Math.sin(m.rAng)  70);
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.45)';
        ctx.lineWidth = info.r  1.3;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
      return;
    }

    if (info.shooter) {
      if (m.st === 1) {
         瞄準中：從槍口拉出一條紅色虛線瞄準線
        const progress = Math.min(1, (now - m.stAt)  (info.aimTime  1000));
        const cos = Math.cos(m.rAng);
        const sin = Math.sin(m.rAng);
        ctx.save();
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(m.rx + cos  info.r, m.ry + sin  info.r);
        ctx.lineTo(m.rx + cos  900, m.ry + sin  900);
        ctx.strokeStyle = `rgba(255, 77, 77, ${0.2 + 0.5  progress})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    if (info.boss) {
      if (m.st === 1) {
         彈幕蓄力：紅色扇形預警
        const progress = Math.min(1, (now - m.stAt)  (info.aimTime  1000));
        ctx.beginPath();
        ctx.moveTo(m.rx, m.ry);
        ctx.arc(m.rx, m.ry, 560, m.rAng - info.fanSpread  2, m.rAng + info.fanSpread  2);
        ctx.closePath();
        ctx.fillStyle = `rgba(255, 77, 77, ${0.05 + 0.15  progress})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255, 120, 120, ${0.25 + 0.45  progress})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (m.st === 3) {
         衝刺蓄力：紅色衝刺路徑
        const progress = Math.min(1, (now - m.stAt)  (info.dashWindup  1000));
        const len = info.dashRange + info.r;
        ctx.save();
        ctx.translate(m.rx, m.ry);
        ctx.rotate(m.rAng);
        ctx.fillStyle = `rgba(255, 77, 77, ${0.08 + 0.24  progress})`;
        ctx.fillRect(0, -info.r, len, info.r  2);
        ctx.strokeStyle = `rgba(255, 140, 140, ${0.3 + 0.5  progress})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(0, -info.r, len, info.r  2);
        ctx.restore();
      } else if (m.st === 4) {
         衝刺中：身後拖出金色殘影
        ctx.beginPath();
        ctx.moveTo(m.rx, m.ry);
        ctx.lineTo(m.rx - Math.cos(m.rAng)  140, m.ry - Math.sin(m.rAng)  140);
        ctx.strokeStyle = 'rgba(245, 197, 66, 0.4)';
        ctx.lineWidth = info.r  1.6;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }
  }

   Boss 本體：金色圓盤 + 十六芒星外環 + 前方紅色眼睛
  function drawBossBody(m, info, now) {
    const r = info.r;

    ctx.save();
    ctx.translate(m.rx, m.ry);
    ctx.rotate(m.rAng);

     彈幕發射中：外圈發光
    if (m.st === 2) {
      ctx.shadowColor = '#ff5c5c';
      ctx.shadowBlur = 24;
    }

     外環尖刺
    ctx.beginPath();
    for (let i = 0; i  16; i++) {
      const a = (Math.PI  8)  i;
      const rad = i % 2 === 0  r  1.28  r  0.96;
      const px = Math.cos(a)  rad;
      const py = Math.sin(a)  rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = '#b8860b';
    ctx.fill();
    ctx.shadowBlur = 0;

     本體
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI  2);
    ctx.fillStyle = info.color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();

     內圈
    ctx.beginPath();
    ctx.arc(0, 0, r  0.55, 0, Math.PI  2);
    ctx.fillStyle = '#7a5a00';
    ctx.fill();

     眼睛（朝向目標）
    ctx.beginPath();
    ctx.arc(r  0.3, 0, r  0.2, 0, Math.PI  2);
    ctx.fillStyle = '#ff4d4d';
    ctx.fill();

     受擊閃白
    if (m.flash  0) {
      ctx.beginPath();
      ctx.arc(0, 0, r  1.1, 0, Math.PI  2);
      ctx.fillStyle = `rgba(255, 255, 255, ${m.flash  0.6})`;
      ctx.fill();
    }

     蓄力（彈幕  衝刺）時快速閃紅，提示「要攻擊了」
    if ((m.st === 1  m.st === 3) && Math.floor(now  90) % 2 === 0) {
      ctx.beginPath();
      ctx.arc(0, 0, r  1.1, 0, Math.PI  2);
      ctx.fillStyle = 'rgba(255, 60, 60, 0.35)';
      ctx.fill();
    }

    ctx.restore();
  }

  function drawMonster(m, now) {
    const info = config.monsterTypes[m.type];
    if (!info) return;

    drawMonsterTelegraph(m, info, now);

     Boss 有自己的外觀與頂部大血條，不畫頭頂小血條
    if (info.boss) {
      drawBossBody(m, info, now);
      return;
    }

    traceMonsterBody(m, info);
    ctx.fillStyle = info.color;
    ctx.fill();

     受擊閃白
    if (m.flash  0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${m.flash  0.8})`;
      ctx.fill();
    }
     衝刺怪蓄力時快速閃爍，提示「要衝過來了」
    if (info.dasher && m.st === 1 && Math.floor(now  70) % 2 === 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fill();
    }

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.stroke();

     射手怪的槍管（朝向目標）
    if (info.shooter) {
      ctx.save();
      ctx.translate(m.rx, m.ry);
      ctx.rotate(m.rAng);
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(info.r  0.3, -3, info.r  0.95, 6);
      ctx.restore();
    }

     受傷後才顯示怪物血條
    if (m.hp  info.maxHp) {
      const w = Math.max(24, info.r  2);
      const x = m.rx - w  2;
      const y = m.ry - info.r - 9;
      ctx.fillStyle = '#30363d';
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = '#f85149';
      ctx.fillRect(x, y, w  Math.max(0, m.hp  info.maxHp), 4);
    }
  }

   玩家子彈：一般為黃色；穿透彈（pc = 1）改為青藍色，一眼就能分辨
  function drawBullets(now) {
    for (const b of bullets) {
       依速度外插，讓 30Hz 快照下子彈看起來仍然順暢
      const elapsed = Math.min((now - b.t)  1000, 0.1);
      const x = b.x + b.vx  elapsed;
      const y = b.y + b.vy  elapsed;
      const pierce = b.pc === 1;

       尾跡
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - b.vx  0.03, y - b.vy  0.03);
      ctx.strokeStyle = pierce  'rgba(126, 231, 255, 0.5)'  'rgba(255, 212, 59, 0.45)';
      ctx.lineWidth = config.bulletRadius  1.6;
      ctx.lineCap = 'round';
      ctx.stroke();

       彈頭
      ctx.beginPath();
      ctx.arc(x, y, config.bulletRadius, 0, Math.PI  2);
      ctx.fillStyle = pierce  '#7ee7ff'  '#ffd43b';
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

   敵方子彈：紅色光球 + 淺色核心，一眼就能與玩家的子彈區分
  function drawEnemyBullets(now) {
    for (const b of enemyBullets) {
      const elapsed = Math.min((now - b.t)  1000, 0.1);
      const x = b.x + b.vx  elapsed;
      const y = b.y + b.vy  elapsed;

       尾跡
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - b.vx  0.04, y - b.vy  0.04);
      ctx.strokeStyle = 'rgba(255, 77, 77, 0.4)';
      ctx.lineWidth = b.r  1.5;
      ctx.lineCap = 'round';
      ctx.stroke();

       外發光 + 本體
      ctx.save();
      ctx.shadowColor = '#ff4d4d';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI  2);
      ctx.fillStyle = '#ff4d4d';
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(x, y, b.r  0.45, 0, Math.PI  2);
      ctx.fillStyle = '#ffd6d6';
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

   Buff 光環：畫在角色本體下方；剩餘 2 秒內閃爍提醒
  function drawBuffAuras(p, x, y, now) {
    if (p.downed  !p.buffEnd) return;
    const R = config.playerRadius;
    const pulse = 0.5 + 0.5  Math.sin(now  180);
    const rings = [['spread', R + 7], ['speed', R + 13]];

    for (const [key, radius] of rings) {
      const remain = (p.buffEnd[key] - now)  1000;
      if (remain = 0) continue;
      if (remain  2 && Math.floor(now  150) % 2 === 0) continue;
      const info = config.dropTypes[key];
      if (!info) continue;

      ctx.save();
      ctx.shadowColor = info.color;
      ctx.shadowBlur = 14;
      ctx.globalAlpha = 0.55 + 0.35  pulse;
      ctx.beginPath();
      ctx.arc(x, y, radius + pulse  2, 0, Math.PI  2);
      ctx.strokeStyle = info.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawPlayer(id, p, now) {
    const isMe = id === myId;
    const R = config.playerRadius;
    const x = p.rx;
    const y = p.ry;
    const angle = isMe  getMyAngle()  p.rAngle;

     倒地的救援範圍與進度
    if (p.downed) {
      ctx.beginPath();
      ctx.arc(x, y, config.reviveRange, 0, Math.PI  2);
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(63, 185, 80, 0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);

      if (p.revive  0) {
        ctx.beginPath();
        ctx.arc(x, y, R + 8, -Math.PI  2, -Math.PI  2 + Math.PI  2  Math.min(1, p.revive));
        ctx.strokeStyle = '#3fb950';
        ctx.lineWidth = 5;
        ctx.stroke();
      }
    }

     Buff 光環
    drawBuffAuras(p, x, y, now);

     本體與槍管（倒地時半透明；無敵時閃爍）
    ctx.save();
    if (p.downed) {
      ctx.globalAlpha = 0.5;
    } else if (p.inv) {
      ctx.globalAlpha = Math.floor(now  80) % 2 === 0  0.45  1;
    }

    if (!p.downed) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = '#c9d1d9';
      ctx.fillRect(0, -4, R + 12, 8);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0d1117';
      ctx.strokeRect(0, -4, R + 12, 8);
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI  2);
    ctx.fillStyle = p.downed  '#6e7681'  p.color;
    ctx.fill();
    if (p.flash  0) {
      ctx.fillStyle = `rgba(255, 0, 0, ${p.flash  0.6})`;
      ctx.fill();
    }
    ctx.lineWidth = isMe  4  2;
    ctx.strokeStyle = isMe  '#ffffff'  'rgba(0, 0, 0, 0.45)';
    ctx.stroke();

     倒地叉叉
    if (p.downed) {
      ctx.beginPath();
      ctx.moveTo(x - 9, y - 9);
      ctx.lineTo(x + 9, y + 9);
      ctx.moveTo(x + 9, y - 9);
      ctx.lineTo(x - 9, y + 9);
      ctx.strokeStyle = '#f85149';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.restore();

     血條：最大血量提升後血條會跟著變長（最多 1.5 倍）
    const maxHp = p.maxHp  config.playerMaxHp;
    const barW = Math.min(72, 48  (maxHp  config.playerMaxHp));
    const barH = 6;
    const barX = x - barW  2;
    const barY = y - R - 14;
    const ratio = Math.max(0, Math.min(1, p.hp  maxHp));
    ctx.fillStyle = '#30363d';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = hpColor(ratio);
    ctx.fillRect(barX, barY, barW  ratio, barH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeRect(barX, barY, barW, barH);

     自訂暱稱（房主前面加皇冠；加描邊，淺色背景或怪物旁也看得清楚）
    const label = (id === hostId  '👑 '  '') + p.name;
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.strokeText(label, x, barY - 4);
    ctx.fillStyle = isMe  '#ffd43b'  '#ffffff';
    ctx.fillText(label, x, barY - 4);
    ctx.lineJoin = 'miter';

    if (p.downed) {
      ctx.fillStyle = '#f85149';
      ctx.font = `bold 13px ${FONT}`;
      ctx.fillText('倒地', x, y + R + 18);
    }
  }

   ----- HUD：波次（畫面中央上方）-----
  function drawWaveHud() {
    const w = 250;
    const h = 70;
    const x = (canvas.width - w)  2;
    const y = 12;

    ctx.fillStyle = 'rgba(13, 17, 23, 0.65)';
    ctx.fillRect(x, y, w, h);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd43b';
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillText(`WAVE ${wave}`, canvas.width  2, y + 30);

     距離下一波的進度條
    const barX = x + 14;
    const barY = y + 38;
    const barW = w - 28;
    const inWave = surviveTime - (wave - 1)  config.waveDuration;
    const frac = Math.max(0, Math.min(1, inWave  config.waveDuration));
    ctx.fillStyle = '#30363d';
    ctx.fillRect(barX, barY, barW, 6);
    ctx.fillStyle = '#ffd43b';
    ctx.fillRect(barX, barY, barW  frac, 6);

    ctx.fillStyle = '#8b949e';
    ctx.font = `12px ${FONT}`;
    ctx.fillText(
      `生存 ${formatTime(surviveTime)}・生成間隔 ${spawnInterval.toFixed(1)}s`,
      canvas.width  2,
      y + 61
    );
  }

   ----- HUD：Boss 血條（頂部大型，位於波次面板下方）-----
  function drawBossBar() {
    let boss = null;
    for (const m of monsters.values()) {
      const info = config.monsterTypes[m.type];
      if (info && info.boss) {
        boss = m;
        break;
      }
    }
    if (!boss  !boss.maxHp) return;

    const w = 640;
    const h = 20;
    const x = (canvas.width - w)  2;
    const panelY = 90;

    ctx.fillStyle = 'rgba(13, 17, 23, 0.72)';
    ctx.fillRect(x - 12, panelY, w + 24, 62);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd43b';
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillText(`BOSS　${Math.max(0, Math.ceil(boss.hp))}  ${boss.maxHp}`, canvas.width  2, panelY + 22);

    const by = panelY + 32;
    const ratio = Math.max(0, Math.min(1, boss.hp  boss.maxHp));
    const ghost = Math.max(ratio, Math.min(1, boss.shownHp  boss.maxHp));

    ctx.fillStyle = '#30363d';
    ctx.fillRect(x, by, w, h);

     殘影條：血量扣除後緩慢追上，讓玩家看出剛剛打掉多少
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(x, by, w  ghost, h);

    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#f5c542');
    grad.addColorStop(1, '#e8590c');
    ctx.fillStyle = grad;
    ctx.fillRect(x, by, w  ratio, h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.strokeRect(x, by, w, h);
  }

   ----- HUD：自己的 Buff 剩餘時間條（左下角）-----
  function drawBuffBars(now) {
    const me = players[myId];
    if (!me  me.downed  !me.buffEnd) return;

    const active = [];
    for (const key of BUFF_KEYS) {
      const remain = (me.buffEnd[key] - now)  1000;
      if (remain  0) active.push({ key, remain });
    }
    if (active.length === 0) return;

    const barW = 170;
    const rowH = 34;
    const panelW = barW + 24;
    const panelH = active.length  rowH + 10;
    const panelX = 10;
    const panelY = canvas.height - 14 - panelH;

    ctx.fillStyle = 'rgba(13, 17, 23, 0.65)';
    ctx.fillRect(panelX, panelY, panelW, panelH);

    active.forEach((b, i) = {
      const info = config.dropTypes[b.key];
      if (!info) return;
      const rowY = panelY + 8 + i  rowH;
      const x = panelX + 12;
      const frac = Math.max(0, Math.min(1, b.remain  config.buffDuration));

      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = info.color;
      ctx.fillText(BUFF_LABELS[b.key], x, rowY + 11);

      ctx.textAlign = 'right';
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(`${b.remain.toFixed(1)}s`, x + barW, rowY + 11);

      ctx.fillStyle = '#30363d';
      ctx.fillRect(x, rowY + 16, barW, 8);
      ctx.fillStyle = info.color;
      ctx.fillRect(x, rowY + 16, barW  frac, 8);
    });
  }

   ----- HUD：自己已獲得的永久升級（右下角）-----
  function drawUpgradeSummary() {
    const me = players[myId];
    if (!me  !me.up) return;

    const rows = [];
    config.upgradeOrder.forEach((key, i) = {
      const lv = me.up[i];
      const def = config.upgradeTypes[key];
      if (lv  0 && def) rows.push({ def, lv });
    });
    if (rows.length === 0) return;

    const rowH = 22;
    const w = 168;
    const h = rows.length  rowH + 12;
    const x = canvas.width - 10 - w;
    const y = canvas.height - 14 - h;

    ctx.fillStyle = 'rgba(13, 17, 23, 0.65)';
    ctx.fillRect(x, y, w, h);

    ctx.font = `13px ${FONT}`;
    ctx.textBaseline = 'middle';
    rows.forEach((r, i) = {
      const cy = y + 6 + i  rowH + rowH  2;

      ctx.fillStyle = r.def.color;
      ctx.fillRect(x + 10, cy - 5, 10, 10);

      ctx.textAlign = 'left';
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(r.def.label, x + 28, cy);

      ctx.textAlign = 'right';
      ctx.fillStyle = r.def.color;
      ctx.fillText(`Lv ${r.lv}`, x + w - 10, cy);
    });
    ctx.textBaseline = 'alphabetic';
  }

   ----- 橫幅（波次晉級  Boss  全員復活）-----
  function drawBanner(now) {
    if (!banner  now = banner.until) return;

    const fadeIn = Math.min(1, (now - banner.start)  150);
    const fadeOut = Math.min(1, (banner.until - now)  400);
    ctx.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut));

    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.font = `bold 52px ${FONT}`;
    ctx.strokeText(banner.text, canvas.width  2, 215);
    ctx.fillStyle = banner.color;
    ctx.fillText(banner.text, canvas.width  2, 215);

    if (banner.sub) {
      ctx.font = `bold 20px ${FONT}`;
      ctx.lineWidth = 4;
      ctx.strokeText(banner.sub, canvas.width  2, 249);
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(banner.sub, canvas.width  2, 249);
    }

    ctx.lineJoin = 'miter';
    ctx.globalAlpha = 1;
  }

  function drawOverlays(now) {
    const me = players[myId];

     全員倒地倒數
    if (wipeEndAt !== null) {
      const remain = Math.max(1, Math.ceil((wipeEndAt - now)  1000));
      const after = config.afterWipe === 'restart'
         `${remain} 秒後全員復活`
         `${remain} 秒後回到等待階段`;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f85149';
      ctx.font = `bold 48px ${FONT}`;
      ctx.fillText('全員倒地！', canvas.width  2, canvas.height  2 - 10);
      ctx.fillStyle = '#e6edf3';
      ctx.font = `22px ${FONT}`;
      ctx.fillText(`你們撐到了 WAVE ${wave}・${after}`, canvas.width  2, canvas.height  2 + 30);
    } else if (phase === 'upgrade' && !offer) {
       中途加入、本輪沒有選項的玩家
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd43b';
      ctx.font = `bold 22px ${FONT}`;
      ctx.fillText('隊友正在選擇強化…', canvas.width  2, canvas.height - 40);
    } else if (me && me.downed) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f85149';
      ctx.font = `bold 22px ${FONT}`;
      ctx.fillText('你倒下了！等待隊友靠近救援', canvas.width  2, canvas.height - 40);
    } else if (phase === 'playing' && me && Object.values(players).some((p) = p.downed)) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#3fb950';
      ctx.font = `18px ${FONT}`;
      ctx.fillText(`靠近倒地的隊友 ${config.reviveTime} 秒即可救起`, canvas.width  2, canvas.height - 40);
    }
  }

   =====================================================
    渲染迴圈
   =====================================================
  let lastFrame = performance.now();

  function render(now) {
    const dt = Math.min((now - lastFrame)  1000, 0.1);
    lastFrame = now;

     還在大廳：只清空畫布，等進入房間
    if (!inGame) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      requestAnimationFrame(render);
      return;
    }

    const k = 1 - Math.exp(-25  dt);  與幀率無關的平滑係數

     更新平滑座標與計時
    for (const id in players) {
      const p = players[id];
      p.rx += (p.x - p.rx)  k;
      p.ry += (p.y - p.ry)  k;
      p.rAngle = lerpAngle(p.rAngle, p.angle, k);
      if (p.flash  0) p.flash = Math.max(0, p.flash - dt  4);
    }
    for (const m of monsters.values()) {
      m.rx += (m.x - m.rx)  k;
      m.ry += (m.y - m.ry)  k;
      m.rAng = lerpAngle(m.rAng, m.ang, k);
      if (m.flash  0) m.flash = Math.max(0, m.flash - dt  6);
      m.shownHp += (m.hp - m.shownHp)  (1 - Math.exp(-4  dt));  Boss 血條殘影
    }
    for (const fx of effects) fx.life -= dt;
    effects = effects.filter((fx) = fx.life  0);

     震動：指數衰減；持續震動（Boss 登場  死亡）期間每幀補回幅度
    shakeMag = Math.exp(-dt  10);
    if (shakeMag  0.05) shakeMag = 0;
    if (now  rumbleUntil) addShake(rumbleMag);

    sendAimIfNeeded(now);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

     ----- 世界層（會跟著震動）：網格 → 掉落物 → 怪物 → 子彈 → 敵方子彈 → 玩家 → 特效 -----
    ctx.save();
    if (shakeMag  0) {
      ctx.translate((Math.random()  2 - 1)  shakeMag, (Math.random()  2 - 1)  shakeMag);
    }

    drawGrid();
    drawDrops(now);

    for (const m of monsters.values()) drawMonster(m, now);
    drawBullets(now);
    drawEnemyBullets(now);

     先畫倒地玩家，再畫存活玩家，最後畫自己（確保自己在最上層）
    const ids = Object.keys(players);
    ids.sort((a, b) = {
      const score = (id) = (id === myId  2  players[id].downed  0  1);
      return score(a) - score(b);
    });
    for (const id of ids) drawPlayer(id, players[id], now);

    drawEffects();
    ctx.restore();

     ----- HUD 層（不震動，確保文字穩定可讀）-----
     等待階段沒有波次與計時，所以不畫波次面板
    if (phase === 'playing'  phase === 'upgrade') drawWaveHud();
    drawBossBar();
    drawBuffBars(now);
    drawUpgradeSummary();
    drawBanner(now);
    drawOverlays(now);

    updateUpgradeUI(now);
    updateScoreboard(now, false);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
})();
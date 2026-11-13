(() => {
  // ===== DOM =====
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

  // ===== 常數 =====
  const MAX_NICKNAME_LENGTH = 12;
  const NICK_STORAGE_KEY = 'coop-shooter:nickname';
  const COPY_LABEL = '複製邀請連結';
  const HUD_HINT = 'WASD / 方向鍵移動・滑鼠瞄準・左鍵射擊・1 / 2 / 3 選擇強化・M 鍵切換音效';
  const FONT = 'system-ui, "Noto Sans TC", sans-serif';
  const BUFF_KEYS = ['spread', 'speed'];
  const BUFF_LABELS = { spread: '散彈強化', speed: '疾風加速' };
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // =====================================================
  //  音效（Web Audio API 程式化合成，不需要任何外部音檔）
  // =====================================================
  const Sound = (() => {
    const MUTE_KEY = 'coop-shooter:muted';
    const MASTER_VOLUME = 0.6;
    const MAX_VOICES = 36;      // 同時發聲上限，避免大量怪物同時死亡時爆音或卡頓

    let ac = null;
    let master = null;
    let noiseBuf = null;
    let voices = 0;
    let muted = false;
    const lastPlay = {};

    try {
      muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch (_) { /* 忽略 */ }

    // 必須在使用者操作（點擊 / 按鍵）之後呼叫，瀏覽器才允許開始播放
    function ensure() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try {
          ac = new AC();
        } catch (_) {
          return null;
        }
        const comp = ac.createDynamicsCompressor();
        master = ac.createGain();
        master.gain.value = muted ? 0 : MASTER_VOLUME;
        master.connect(comp);
        comp.connect(ac.destination);

        // 預先產生 1 秒白噪音，爆破聲重複使用
        noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (ac.state === 'suspended') {
        const r = ac.resume();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      }
      return ac;
    }

    function ready() {
      return !!ac && ac.state === 'running' && !muted && voices < MAX_VOICES;
    }

    // 限制同一種音效的最短間隔（毫秒）
    function gate(key, ms) {
      const t = performance.now();
      if (t - (lastPlay[key] || 0) < ms) return false;
      lastPlay[key] = t;
      return true;
    }

    // 單一振盪器音：頻率從 f0 滑到 f1，音量快速淡入、指數淡出
    function tone(o) {
      const t0 = ac.currentTime + (o.delay || 0);
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = o.type || 'square';
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
      osc.onended = () => { voices--; };
      osc.start(t0);
      osc.stop(t0 + o.dur + 0.03);
    }

    // 濾波白噪音：用來做爆破 / 撞擊的「沙沙」質感
    function noise(o) {
      const t0 = ac.currentTime + (o.delay || 0);
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const filter = ac.createBiquadFilter();
      filter.type = o.filter || 'lowpass';
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
      src.onended = () => { voices--; };
      src.start(t0);
      src.stop(t0 + o.dur + 0.03);
    }

    // 爆破：噪音下掃 + 低頻重擊；delay 讓 Boss 死亡可以疊多段
    function boom(big, delay) {
      noise({ f0: big ? 2400 : 1800, f1: 160, dur: big ? 0.5 : 0.28, vol: big ? 0.45 : 0.32, delay });
      tone({ type: 'sine', f0: big ? 110 : 150, f1: 38, dur: big ? 0.45 : 0.25, vol: big ? 0.45 : 0.3, delay });
    }

    return {
      unlock() { ensure(); },
      isMuted() { return muted; },
      setMuted(v) {
        muted = v;
        try {
          localStorage.setItem(MUTE_KEY, v ? '1' : '0');
        } catch (_) { /* 忽略 */ }
        if (master && ac) master.gain.setTargetAtTime(v ? 0 : MASTER_VOLUME, ac.currentTime, 0.02);
        if (!v) ensure();
      },

      // 射擊雷射聲（own = 自己的槍聲較大聲，隊友的較小聲且限頻）
      shoot(own) {
        if (!ready() || !gate(own ? 'shotOwn' : 'shotOther', own ? 40 : 70)) return;
        tone({ type: 'square', f0: 920, f1: 170, dur: 0.09, vol: own ? 0.1 : 0.035 });
      },

      // 擊殺怪物爆破聲
      explode(big) {
        if (!ready() || !gate('boom', 30)) return;
        boom(big, 0);
      },

      // 撿取道具：三連音，依道具類型改變音高
      pickup(type, own) {
        if (!ready() || !gate('pickup' + (own ? 'Own' : 'Other'), 60)) return;
        const notes = {
          heal: [523, 659, 784],
          spread: [440, 660, 880],
          speed: [660, 880, 1320],
        }[type] || [660, 880, 1100];
        notes.forEach((f, i) => {
          tone({ type: 'triangle', f0: f, f1: f * 1.02, dur: 0.1, vol: own ? 0.16 : 0.06, delay: i * 0.065 });
        });
      },

      // 波次晉級：上行小號
      wave() {
        if (!ready() || !gate('wave', 300)) return;
        [392, 523, 659, 784].forEach((f, i) => {
          tone({ type: 'square', f0: f, dur: 0.14, vol: 0.1, delay: i * 0.09 });
        });
        tone({ type: 'square', f0: 1047, dur: 0.35, vol: 0.1, delay: 0.36 });
      },

      // 玩家受傷：低沉悶響
      hurt() {
        if (!ready() || !gate('hurt', 90)) return;
        tone({ type: 'sawtooth', f0: 190, f1: 55, dur: 0.3, vol: 0.28 });
        noise({ f0: 700, f1: 90, dur: 0.2, vol: 0.25 });
      },

      // 敵方開火：較輕的下滑音
      enemyShot(isBoss) {
        if (!ready() || !gate('enemyShot', 70)) return;
        tone({ type: 'triangle', f0: isBoss ? 260 : 340, f1: 120, dur: 0.11, vol: isBoss ? 0.1 : 0.06 });
      },

      // Boss 登場：低頻怒吼 + 轟隆
      bossSpawn() {
        if (!ready() || !gate('bossSpawn', 500)) return;
        tone({ type: 'sawtooth', f0: 62, f1: 44, dur: 1.5, vol: 0.28 });
        tone({ type: 'sawtooth', f0: 66, f1: 50, dur: 1.5, vol: 0.2 });
        tone({ type: 'square', f0: 130, f1: 80, dur: 1.2, vol: 0.06, delay: 0.1 });
        noise({ f0: 380, f1: 50, dur: 1.4, vol: 0.32 });
      },

      // Boss 被擊破：連環爆破 + 上行勝利音
      bossDefeat() {
        if (!ready() || !gate('bossDefeat', 500)) return;
        [0, 0.13, 0.3, 0.48].forEach((d, i) => boom(i === 3, d));
        [523, 659, 784, 1047, 1319].forEach((f, i) => {
          tone({ type: 'triangle', f0: f, dur: 0.18, vol
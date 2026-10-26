const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// index.html のみ配信（server.js 等を公開しない）
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/healthz', (req, res) => res.send('ok'));

// ---------- 定数 ----------
const W = 1000, H = 640;
const TICK_RATE = 30;
const GAME_MS = 5 * 60 * 1000;
const SPEED = 200;        // px/s
const SPEED_CORE = 80;    // コア所持中（大幅低下）
const PR = 16;            // プレイヤー半径
const REACH = 70;         // 作業台・ステーション等の操作範囲
const SCRAP_MAX = 3;      // 鉄くず所持上限
const BOLT_MAX = 4;       // ボルト所持上限
const SCRAP_COUNT = 14;
const SCRAP_RESPAWN_MS = 8000;
const ACTION_MIN_INTERVAL = 60; // サーバー側の連打上限(ms)

const POS = {
  engine: { x: 120, y: 320 },
  wing: { x: 880, y: 320 },
  bench: { x: 500, y: 340 },
  coreBox: { x: 500, y: 90 },
};

// type: 'bolt' = ボルト消費 / 'core' = プラズマコア搬入
const TASKS = {
  engine: [
    { name: 'プラズマコア抽出', type: 'core', need: 1 },
    { name: '高圧パイプ接続', type: 'bolt', need: 5 },
    { name: '冷却液充填', type: 'bolt', need: 4 },
    { name: 'プラズマコア装填', type: 'core', need: 1 },
    { name: '点火システム調整', type: 'bolt', need: 3 },
  ],
  wing: [
    { name: '外壁フレーム溶接', type: 'bolt', need: 8 },
    { name: '駆動アーム交換', type: 'bolt', need: 8 },
    { name: '配線張り替え', type: 'bolt', need: 6 },
    { name: '翼面パネル固定', type: 'bolt', need: 6 },
  ],
};

const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f783ac'];

// ---------- 状態 ----------
const players = new Map();
let joinCounter = 0;

const game = {
  phase: 'lobby', // lobby | playing | win | lose
  endsAt: 0,
  remainAtEnd: GAME_MS,
  scraps: [],
  respawns: [],
  nextScrapId: 1,
  core: { state: 'box', x: 0, y: 0, holder: null }, // box | held | ground
  prog: { engine: { idx: 0, p: 0 }, wing: { idx: 0, p: 0 } },
  result: null,
};

// ---------- ユーティリティ ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (p, pos, r) => dist(p, pos) <= r;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const curTask = (route) => TASKS[route][game.prog[route].idx] || null;

function fx(type, x, y, text, snd) {
  io.emit('fx', { type, x: Math.round(x), y: Math.round(y), text, snd });
}

function spawnScrap() {
  for (let i = 0; i < 40; i++) {
    const x = 60 + Math.random() * (W - 120);
    const y = 60 + Math.random() * (H - 120);
    const pt = { x, y };
    if (dist(pt, POS.engine) < 110 || dist(pt, POS.wing) < 110 ||
        dist(pt, POS.bench) < 90 || dist(pt, POS.coreBox) < 90) continue;
    if (game.scraps.some(s => dist(s, pt) < 35)) continue;
    game.scraps.push({ id: game.nextScrapId++, x, y });
    return;
  }
}

function spawnPoint(index) {
  const a = (index * 1.1) % (Math.PI * 2);
  return { x: POS.bench.x + Math.cos(a) * 80, y: POS.bench.y + 110 + Math.sin(a) * 30 };
}

function resetPlayer(p, i) {
  const s = spawnPoint(i);
  p.x = s.x; p.y = s.y;
  p.scrap = 0; p.bolts = 0; p.hasCore = false;
  p.lastAct = 0;
}

function resetGame() {
  game.scraps = [];
  game.respawns = [];
  for (let i = 0; i < SCRAP_COUNT; i++) spawnScrap();
  game.core = { state: 'box', x: 0, y: 0, holder: null };
  game.prog = { engine: { idx: 0, p: 0 }, wing: { idx: 0, p: 0 } };
  game.result = null;
  game.remainAtEnd = GAME_MS;
  let i = 0;
  for (const p of players.values()) resetPlayer(p, i++);
}

function startGame() {
  resetGame();
  game.phase = 'playing';
  game.endsAt = Date.now() + GAME_MS;
}

function endGame(type, route) {
  if (game.phase !== 'playing') return;
  game.remainAtEnd = Math.max(0, game.endsAt - Date.now());
  game.phase = type;
  game.result = { type, route: route || null };
  for (const p of players.values()) p.input = { x: 0, y: 0 };
}

function dropCore(p) {
  game.core.state = 'ground';
  game.core.x = p.x;
  game.core.y = p.y;
  game.core.holder = null;
  p.hasCore = false;
}

function advance(route, p) {
  const r = game.prog[route];
  const t = curTask(route);
  r.p += 1;
  fx('repair', POS[route].x, POS[route].y - 20, '+1', 'repair');
  if (t && r.p >= t.need) {
    fx('done', POS[route].x, POS[route].y - 60, `${t.name} 完了!`, 'done');
    r.idx += 1;
    r.p = 0;
    if (r.idx >= TASKS[route].length) {
      endGame('win', route);
    }
  }
}

// ---------- アクション（Space） ----------
function doAction(p) {
  if (game.phase !== 'playing') return;
  const now = Date.now();
  if (now - p.lastAct < ACTION_MIN_INTERVAL) return;
  p.lastAct = now;

  // 1) コア所持中
  if (p.hasCore) {
    if (near(p, POS.engine, REACH)) {
      const t = curTask('engine');
      if (t && t.type === 'core') {
        p.hasCore = false;
        game.core = { state: 'box', x: 0, y: 0, holder: null };
        advance('engine', p);
        return;
      }
    }
    dropCore(p);
    fx('msg', p.x, p.y - 40, 'コアを置いた', 'drop');
    return;
  }

  // 2) 修理ステーション
  for (const route of ['engine', 'wing']) {
    if (near(p, POS[route], REACH)) {
      const t = curTask(route);
      if (!t) return;
      if (t.type === 'core') {
        fx('msg', p.x, p.y - 40, 'プラズマコアが必要!', 'error');
        return;
      }
      if (p.bolts <= 0) {
        fx('msg', p.x, p.y - 40, 'ボルトがない!', 'error');
        return;
      }
      p.bolts -= 1;
      advance(route, p);
      return;
    }
  }

  // 3) 作業台
  if (near(p, POS.bench, REACH)) {
    if (p.scrap < SCRAP_MAX) {
      fx('msg', p.x, p.y - 40, `鉄くずが足りない (${p.scrap}/${SCRAP_MAX})`, 'error');
      return;
    }
    if (p.bolts >= BOLT_MAX) {
      fx('msg', p.x, p.y - 40, 'ボルトを持ちすぎ!', 'error');
      return;
    }
    p.scrap -= SCRAP_MAX;
    p.bolts += 1;
    fx('craft', POS.bench.x, POS.bench.y - 30, 'ボルト完成!', 'craft');
    return;
  }

  // 4) コア拾得（地面）
  if (game.core.state === 'ground' && dist(p, game.core) <= 50) {
    game.core.state = 'held';
    game.core.holder = p.id;
    p.hasCore = true;
    fx('msg', p.x, p.y - 40, 'コアを持った (重い!)', 'pick');
    return;
  }

  // 5) コア箱
  if (game.core.state === 'box' && near(p, POS.coreBox, REACH)) {
    game.core.state = 'held';
    game.core.holder = p.id;
    p.hasCore = true;
    fx('msg', p.x, p.y - 40, 'コアを持った (重い!)', 'pick');
  }
}

// ---------- ゲームループ ----------
let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  if (game.phase === 'playing') {
    for (const p of players.values()) {
      const v = p.input;
      let dx = v.x, dy = v.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dx /= len; dy /= len;
        const sp = p.hasCore ? SPEED_CORE : SPEED;
        p.x = clamp(p.x + dx * sp * dt, 36, W - 36);
        p.y = clamp(p.y + dy * sp * dt, 36, H - 36);
      }
      // 鉄くず自動回収
      if (!p.hasCore && p.scrap < SCRAP_MAX) {
        for (let i = game.scraps.length - 1; i >= 0; i--) {
          const s = game.scraps[i];
          if (dist(p, s) < PR + 12) {
            game.scraps.splice(i, 1);
            p.scrap += 1;
            game.respawns.push(now + SCRAP_RESPAWN_MS);
            fx('pick', s.x, s.y - 10, `鉄くず ${p.scrap}/${SCRAP_MAX}`, 'pick');
            if (p.scrap >= SCRAP_MAX) break;
          }
        }
      }
    }
    // リスポーン
    for (let i = game.respawns.length - 1; i >= 0; i--) {
      if (now >= game.respawns[i]) {
        game.respawns.splice(i, 1);
        spawnScrap();
      }
    }
    // 時間切れ
    if (now >= game.endsAt) endGame('lose', null);
  }

  if (players.size > 0) broadcast();
}

function broadcast() {
  const now = Date.now();
  let remain = GAME_MS;
  if (game.phase === 'playing') remain = Math.max(0, game.endsAt - now);
  else if (game.phase === 'win' || game.phase === 'lose') remain = game.remainAtEnd;

  let core = { state: game.core.state, x: 0, y: 0 };
  if (game.core.state === 'ground') { core.x = game.core.x; core.y = game.core.y; }
  else if (game.core.state === 'held') {
    const h = players.get(game.core.holder);
    if (h) { core.x = h.x; core.y = h.y; }
  }

  io.volatile.emit('state', {
    phase: game.phase,
    remain,
    result: game.result,
    players: [...players.values()].map(p => ({
      id: p.id, n: p.num, c: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
      s: p.scrap, b: p.bolts, h: p.hasCore,
    })),
    scraps: game.scraps.map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y) })),
    core,
    prog: game.prog,
  });
}

setInterval(tick, 1000 / TICK_RATE);

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  joinCounter += 1;
  const p = {
    id: socket.id,
    num: joinCounter,
    color: COLORS[(joinCounter - 1) % COLORS.length],
    x: 0, y: 0, scrap: 0, bolts: 0, hasCore: false,
    input: { x: 0, y: 0 }, lastAct: 0,
  };
  resetPlayer(p, players.size);
  players.set(socket.id, p);

  socket.emit('init', {
    you: socket.id, W, H, POS, TASKS, REACH, SCRAP_MAX, BOLT_MAX, GAME_MS,
  });

  socket.on('input', (d) => {
    if (!d || typeof d !== 'object') return;
    const x = (d.right ? 1 : 0) - (d.left ? 1 : 0);
    const y = (d.down ? 1 : 0) - (d.up ? 1 : 0);
    p.input = { x, y };
  });

  socket.on('action', () => doAction(p));

  socket.on('start', () => {
    if (game.phase === 'lobby') startGame();
  });

  socket.on('toTitle', () => {
    if (game.phase === 'win' || game.phase === 'lose') {
      game.phase = 'lobby';
      game.result = null;
      game.remainAtEnd = GAME_MS;
    }
  });

  socket.on('disconnect', () => {
    if (p.hasCore) dropCore(p);
    players.delete(socket.id);
    if (players.size === 0) {
      game.phase = 'lobby';
      game.result = null;
    }
  });
});

server.listen(PORT, () => console.log(`Destroy or Avoid running on :${PORT}`));

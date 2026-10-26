const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/healthz', (req, res) => res.send('ok'));

// ---------- 定数 ----------
const W = 1600, H = 1000;
const CELL = 50;
const COLS = W / CELL, ROWS = H / CELL;
const TICK_RATE = 30;
const GAME_MS = 5 * 60 * 1000;
const SPEED = 210;        // px/s
const SPEED_CORE = 70;    // コア所持中（激低下）
const PR = 16;            // プレイヤー半径
const REACH = 70;
const SLOT_MAX = 3;       // 所持スロット数
const SCRAP_STACK = 6;    // 金属くず 1スロットの最大スタック
const CORE_SLOTS = 2;     // プラズマコアが占有するスロット数
const SCRAP_COUNT = 28;
const SCRAP_RESPAWN_MS = 7000;
const ACTION_MIN_INTERVAL = 60;

const POS = {
  engine: { x: 200, y: 500 },
  wing: { x: 1400, y: 500 },
  bench: { x: 800, y: 500 },
  coreBox: { x: 800, y: 150 },
  battBox: { x: 800, y: 860 },
};
const SPAWN = { x: 800, y: 680 };

// クリアゾーン（壁を生成しない矩形：中心 + 半幅/半高）
const ZONES = [
  { x: POS.engine.x, y: POS.engine.y, hw: 170, hh: 210 },
  { x: POS.wing.x, y: POS.wing.y, hw: 170, hh: 210 },
  { x: POS.bench.x, y: POS.bench.y, hw: 150, hh: 120 },
  { x: POS.coreBox.x, y: POS.coreBox.y, hw: 120, hh: 100 },
  { x: POS.battBox.x, y: POS.battBox.y, hw: 120, hh: 100 },
  { x: SPAWN.x, y: SPAWN.y, hw: 160, hh: 80 },
];

// type: 'bolt' = ボルト消費 / 'torch' = 溶接トーチ消費 / 'core' = プラズマコア搬入
const TASKS = {
  engine: [
    { name: 'プラズマコア抽出', type: 'core', need: 1 },
    { name: '高圧パイプ接続', type: 'bolt', need: 4 },
    { name: '冷却液充填', type: 'bolt', need: 4 },
    { name: 'プラズマコア装填', type: 'core', need: 1 },
    { name: '点火システム調整', type: 'bolt', need: 3 },
  ],
  wing: [
    { name: '外壁フレーム溶接', type: 'torch', need: 5 },
    { name: '駆動アーム交換', type: 'torch', need: 5 },
    { name: '配線張り替え', type: 'torch', need: 4 },
    { name: '翼面パネル固定', type: 'torch', need: 4 },
  ],
};
const NEED_ITEM_NAME = { bolt: 'ボルト', torch: '溶接トーチ' };

const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f783ac'];

// ---------- マップ（迷路壁）生成 ----------
let grid = [];       // grid[r][c] = true なら壁
let openCells = [];  // 通行可能セル一覧
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (c, r) => r * COLS + c;
const cellOf = (pos) => ({ c: Math.floor(pos.x / CELL), r: Math.floor(pos.y / CELL) });

function component(g, start) {
  const seen = new Uint8Array(COLS * ROWS);
  const q = [key(start.c, start.r)];
  seen[q[0]] = 1;
  for (let i = 0; i < q.length; i++) {
    const k = q[i], c = k % COLS, r = (k - c) / COLS;
    for (const [dc, dr] of DIRS) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      if (g[nr][nc]) continue;
      const nk = key(nc, nr);
      if (seen[nk]) continue;
      seen[nk] = 1; q.push(nk);
    }
  }
  return seen;
}

function carve(g, from, comp) {
  const dist = new Array(COLS * ROWS).fill(Infinity);
  const prev = new Array(COLS * ROWS).fill(-1);
  const q = [key(from.c, from.r)];
  dist[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const k = q[i], c = k % COLS, r = (k - c) / COLS;
    for (const [dc, dr] of DIRS) {
      const nc = c + dc, nr = r + dr;
      if (nc < 1 || nr < 1 || nc >= COLS - 1 || nr >= ROWS - 1) continue;
      const nk = key(nc, nr);
      const nd = dist[k] + (g[nr][nc] ? 1 : 0);
      if (nd < dist[nk]) { dist[nk] = nd; prev[nk] = k; q.push(nk); }
    }
  }
  let best = -1, bd = Infinity;
  for (let k = 0; k < comp.length; k++) if (comp[k] && dist[k] < bd) { bd = dist[k]; best = k; }
  while (best !== -1) {
    const c = best % COLS, r = (best - c) / COLS;
    g[r][c] = false;
    best = prev[best];
  }
}

function genMap() {
  const g = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: COLS }, (_, c) => r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1));

  // 迷路状のランダム壁セグメントを配置
  const interior = (COLS - 2) * (ROWS - 2);
  const target = Math.floor(interior * 0.36);
  let cnt = 0, tries = 0;
  while (cnt < target && tries < 4000) {
    tries++;
    const hz = Math.random() < 0.5;
    const len = 2 + Math.floor(Math.random() * 6);
    const sc = 1 + Math.floor(Math.random() * (COLS - 2));
    const sr = 1 + Math.floor(Math.random() * (ROWS - 2));
    for (let i = 0; i < len; i++) {
      const c = sc + (hz ? i : 0), r = sr + (hz ? 0 : i);
      if (c >= 1 && c < COLS - 1 && r >= 1 && r < ROWS - 1 && !g[r][c]) { g[r][c] = true; cnt++; }
    }
  }

  // クリアゾーン（スポーン・主要設備の周囲）
  for (const z of ZONES) {
    const c0 = Math.max(1, Math.floor((z.x - z.hw) / CELL));
    const c1 = Math.min(COLS - 2, Math.floor((z.x + z.hw) / CELL));
    const r0 = Math.max(1, Math.floor((z.y - z.hh) / CELL));
    const r1 = Math.min(ROWS - 2, Math.floor((z.y + z.hh) / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = false;
  }

  // 導線の確保：スポーンから全設備へ到達可能に（塞がれていたら壁を掘って接続）
  const spawnCell = cellOf(SPAWN);
  let comp = component(g, spawnCell);
  for (const name of ['engine', 'wing', 'bench', 'coreBox', 'battBox']) {
    const f = cellOf(POS[name]);
    if (!comp[key(f.c, f.r)]) {
      carve(g, f, comp);
      comp = component(g, spawnCell);
    }
  }
  // 到達不能な空きセル（孤立ポケット）は壁で埋める
  for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) {
    if (!g[r][c] && !comp[key(c, r)]) g[r][c] = true;
  }

  grid = g;
  openCells = [];
  for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) if (!g[r][c]) openCells.push({ c, r });
}

const mapRows = () => grid.map(row => row.map(v => (v ? '1' : '0')).join(''));
const isWall = (c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : grid[r][c];

// 円(プレイヤー) vs 矩形(壁セル) の押し出しコリジョン
function resolveWalls(p) {
  for (let it = 0; it < 4; it++) {
    let moved = false;
    const c0 = Math.floor((p.x - PR) / CELL), c1 = Math.floor((p.x + PR) / CELL);
    const r0 = Math.floor((p.y - PR) / CELL), r1 = Math.floor((p.y + PR) / CELL);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!isWall(c, r)) continue;
        const rx = c * CELL, ry = r * CELL;
        const cx = Math.max(rx, Math.min(rx + CELL, p.x));
        const cy = Math.max(ry, Math.min(ry + CELL, p.y));
        const dx = p.x - cx, dy = p.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= PR * PR) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          p.x += dx / d * (PR - d);
          p.y += dy / d * (PR - d);
        } else {
          // 中心が壁の内部：最も近い辺から押し出す
          const l = p.x - rx, rt = rx + CELL - p.x, t = p.y - ry, b = ry + CELL - p.y;
          const m = Math.min(l, rt, t, b);
          if (m === l) p.x = rx - PR;
          else if (m === rt) p.x = rx + CELL + PR;
          else if (m === t) p.y = ry - PR;
          else p.y = ry + CELL + PR;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

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

// ----- インベントリ（スロット制） -----
const usedSlots = (p) => p.slots.length + (p.hasCore ? CORE_SLOTS : 0);
const freeSlots = (p) => SLOT_MAX - usedSlots(p);
const countItem = (p, t) => p.slots.reduce((a, s) => a + (s.t === t ? s.n : 0), 0);

function canTakeScrap(p) {
  return p.slots.some(s => s.t === 'scrap' && s.n < SCRAP_STACK) || freeSlots(p) > 0;
}
function addScrap(p) {
  let st = p.slots.find(s => s.t === 'scrap' && s.n < SCRAP_STACK);
  if (!st) {
    if (freeSlots(p) <= 0) return false;
    st = { t: 'scrap', n: 0 };
    p.slots.push(st);
  }
  st.n += 1;
  return true;
}
function removeScrap(p, n) {
  if (countItem(p, 'scrap') < n) return false;
  for (let i = p.slots.length - 1; i >= 0 && n > 0; i--) {
    const s = p.slots[i];
    if (s.t !== 'scrap') continue;
    const take = Math.min(n, s.n);
    s.n -= take; n -= take;
    if (s.n <= 0) p.slots.splice(i, 1);
  }
  return true;
}
function addItem(p, t) {
  if (freeSlots(p) <= 0) return false;
  p.slots.push({ t, n: 1 });
  return true;
}
function removeItem(p, t) {
  const i = p.slots.findIndex(s => s.t === t);
  if (i < 0) return false;
  p.slots.splice(i, 1);
  return true;
}

// ----- スクラップ -----
function wallNeighbors(c, r) {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dc || dr) && isWall(c + dc, r + dr)) n++;
  return n;
}
function spawnScrap() {
  if (!openCells.length) return;
  for (let i = 0; i < 80; i++) {
    const cell = openCells[Math.floor(Math.random() * openCells.length)];
    const pt = { x: cell.c * CELL + 12 + Math.random() * 26, y: cell.r * CELL + 12 + Math.random() * 26 };
    if (Object.values(POS).some(pos => dist(pt, pos) < 85)) continue;
    if (game.scraps.some(s => dist(s, pt) < 40)) continue;
    // 迷路の壁際を優先（広場にはやや出にくい）
    if (wallNeighbors(cell.c, cell.r) === 0 && Math.random() > 0.3) continue;
    game.scraps.push({ id: game.nextScrapId++, x: pt.x, y: pt.y });
    return;
  }
}

function resetPlayer(p, i) {
  p.x = SPAWN.x + ((i % 6) - 2.5) * 44;
  p.y = SPAWN.y + (Math.floor(i / 6) % 2) * 44 - 22;
  p.slots = [];
  p.hasCore = false;
  p.input = { x: 0, y: 0 };
  p.lastAct = 0;
  p.lastDisc = 0;
}

function regenMap() {
  genMap();
  io.emit('map', { rows: mapRows() });
}

function resetGame() {
  regenMap(); // リセット時に迷路を再生成
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

function advance(route) {
  const r = game.prog[route];
  const t = curTask(route);
  r.p += 1;
  fx('repair', POS[route].x, POS[route].y - 20, '+1', 'repair');
  if (t && r.p >= t.need) {
    fx('done', POS[route].x, POS[route].y - 60, `${t.name} 完了!`, 'done');
    r.idx += 1;
    r.p = 0;
    if (r.idx >= TASKS[route].length) endGame('win', route);
  }
}

// ---------- アクション（Space） ----------
function doAction(p) {
  if (game.phase !== 'playing') return;
  const now = Date.now();
  if (now - p.lastAct < ACTION_MIN_INTERVAL) return;
  p.lastAct = now;
  const msg = (text, snd) => fx('msg', p.x, p.y - 44, text, snd);

  // 1) コア所持中：エンジンのコアタスクなら搬入、それ以外は足元に置く
  if (p.hasCore) {
    if (near(p, POS.engine, REACH)) {
      const t = curTask('engine');
      if (t && t.type === 'core') {
        p.hasCore = false;
        game.core = { state: 'box', x: 0, y: 0, holder: null };
        advance('engine');
        return;
      }
    }
    dropCore(p);
    msg('コアを置いた', 'drop');
    return;
  }

  // 2) 修理ステーション（エンジン=ボルト / 羽=溶接トーチ）
  for (const route of ['engine', 'wing']) {
    if (!near(p, POS[route], REACH)) continue;
    const t = curTask(route);
    if (!t) return;
    if (t.type === 'core') { msg('プラズマコアが必要!', 'error'); return; }
    if (!removeItem(p, t.type)) { msg(`${NEED_ITEM_NAME[t.type]}が必要!`, 'error'); return; }
    advance(route);
    return;
  }

  // 3) 作業台：バッテリー所持 → 溶接トーチ / それ以外 → ボルト
  if (near(p, POS.bench, REACH)) {
    const scrap = countItem(p, 'scrap');
    const hasBatt = p.slots.some(s => s.t === 'battery');
    if (hasBatt) {
      if (scrap < 2) { msg(`トーチには金属くず×2が必要 (${scrap}/2)`, 'error'); return; }
      removeScrap(p, 2);
      removeItem(p, 'battery'); // バッテリーが空けたスロットに入る
      addItem(p, 'torch');
      fx('craft', POS.bench.x, POS.bench.y - 30, '溶接トーチ完成!', 'craft');
      return;
    }
    if (scrap < 3) { msg(`金属くずが足りない (${scrap}/3)`, 'error'); return; }
    const backup = p.slots.map(s => ({ ...s }));
    removeScrap(p, 3);
    if (!addItem(p, 'bolt')) {
      p.slots = backup;
      msg('スロットがいっぱい!', 'error');
      return;
    }
    fx('craft', POS.bench.x, POS.bench.y - 30, 'ボルト完成!', 'craft');
    return;
  }

  // 4) バッテリー箱
  if (near(p, POS.battBox, REACH)) {
    if (!addItem(p, 'battery')) { msg('スロットがいっぱい!', 'error'); return; }
    fx('pick', POS.battBox.x, POS.battBox.y - 30, 'バッテリー取得', 'pick');
    return;
  }

  // 5) コア拾得（地面） / 6) コア箱
  const coreNearGround = game.core.state === 'ground' && dist(p, game.core) <= 50;
  const coreNearBox = game.core.state === 'box' && near(p, POS.coreBox, REACH);
  if (coreNearGround || coreNearBox) {
    if (freeSlots(p) < CORE_SLOTS) { msg(`コアはスロット${CORE_SLOTS}つ必要!`, 'error'); return; }
    game.core.state = 'held';
    game.core.holder = p.id;
    p.hasCore = true;
    msg('コアを持った (重い!)', 'pick');
  }
}

function doDiscard(p, idx) {
  if (game.phase !== 'playing') return;
  const now = Date.now();
  if (now - p.lastDisc < 150) return;
  p.lastDisc = now;
  idx = idx | 0;
  if (idx >= 0 && idx < p.slots.length) {
    p.slots.splice(idx, 1);
    fx('msg', p.x, p.y - 44, 'アイテムを捨てた', 'drop');
  } else if (p.hasCore) {
    dropCore(p);
    fx('msg', p.x, p.y - 44, 'コアを置いた', 'drop');
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
      let dx = p.input.x, dy = p.input.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dx /= len; dy /= len;
        const sp = p.hasCore ? SPEED_CORE : SPEED;
        p.x += dx * sp * dt;
        p.y += dy * sp * dt;
        resolveWalls(p); // 壁との衝突（めり込み防止・滑り移動）
        p.x = clamp(p.x, PR, W - PR);
        p.y = clamp(p.y, PR, H - PR);
      }
      // 金属くず自動回収（スタック or 空きスロット）
      for (let i = game.scraps.length - 1; i >= 0; i--) {
        if (!canTakeScrap(p)) break;
        const s = game.scraps[i];
        if (dist(p, s) < PR + 12) {
          game.scraps.splice(i, 1);
          addScrap(p);
          game.respawns.push(now + SCRAP_RESPAWN_MS);
          fx('pick', s.x, s.y - 10, `金属くず ${countItem(p, 'scrap')}`, 'pick');
        }
      }
    }
    for (let i = game.respawns.length - 1; i >= 0; i--) {
      if (now >= game.respawns[i]) {
        game.respawns.splice(i, 1);
        spawnScrap();
      }
    }
    if (now >= game.endsAt) endGame('lose', null);
  }

  if (players.size > 0) broadcast();
}

function broadcast() {
  const now = Date.now();
  let remain = GAME_MS;
  if (game.phase === 'playing') remain = Math.max(0, game.endsAt - now);
  else if (game.phase === 'win' || game.phase === 'lose') remain = game.remainAtEnd;

  const core = { state: game.core.state, x: 0, y: 0 };
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
      sl: p.slots.map(s => [s.t, s.n]),
      h: p.hasCore,
    })),
    scraps: game.scraps.map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y) })),
    core,
    prog: game.prog,
  });
}

genMap();
setInterval(tick, 1000 / TICK_RATE);

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  joinCounter += 1;
  const p = {
    id: socket.id,
    num: joinCounter,
    color: COLORS[(joinCounter - 1) % COLORS.length],
    x: 0, y: 0, slots: [], hasCore: false,
    input: { x: 0, y: 0 }, lastAct: 0, lastDisc: 0,
  };
  resetPlayer(p, players.size);
  players.set(socket.id, p);

  socket.emit('init', {
    you: socket.id, W, H, CELL, POS, SPAWN, TASKS, REACH, SLOT_MAX, SCRAP_STACK, CORE_SLOTS, GAME_MS,
    rows: mapRows(),
  });

  socket.on('input', (d) => {
    if (!d || typeof d !== 'object') return;
    p.input = {
      x: (d.right ? 1 : 0) - (d.left ? 1 : 0),
      y: (d.down ? 1 : 0) - (d.up ? 1 : 0),
    };
  });
  socket.on('action', () => doAction(p));
  socket.on('discard', (i) => doDiscard(p, i));
  socket.on('start', () => { if (game.phase === 'lobby') startGame(); });
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

server.listen(PORT, () => console.log(`Destroy or Avoid v2 running on :${PORT}`));

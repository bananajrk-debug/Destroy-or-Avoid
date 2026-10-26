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
const GAME_MS = 10 * 60 * 1000;   // 制限時間 10分
const SPEED = 210;
const SPEED_CORE = 70;            // コア所持中は激低下
const PR = 16;
const REACH = 70;
const SLOT_MAX = 3;
const SCRAP_STACK = 6;
const CORE_SLOTS = 2;
const SCRAP_COUNT = 30;
const SCRAP_RESPAWN_MS = 7000;
const ACTION_MIN_INTERVAL = 60;
const WELD_MIN_MS = 10000;        // ミニゲーム結果の最短受理時間（不正対策）
const WELD_TIMEOUT_MS = 50000;
const ACTIVE_TASKS = 3;

const cp = (c, r) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 });

const POS = {
  bench: cp(16, 9),
  coreBox: cp(16, 3),
  battBox: cp(28, 16),
  fuseBox: cp(3, 16),
};
const SPAWN = cp(16, 12);

// ---------- タスクプール（全15個） ----------
// kind: core=コア搬入 / fuse=ヒューズ装着 / weld=溶接ミニゲーム(トーチ) / bolt=ボルト消費 / battery=バッテリー装着 / press=SPACE作業
const TASK_DEFS = [
  { id: 1,  name: 'プラズマコアの搬入',     pct: 20, kind: 'core',    need: 1,  icon: '⚛️', c: 3,  r: 9 },
  { id: 2,  name: 'ヒューズの運搬・装着',   pct: 10, kind: 'fuse',    need: 1,  icon: '🔌', c: 28, r: 3 },
  { id: 3,  name: '外壁フレーム溶接',       pct: 10, kind: 'weld',    need: 1,  icon: '🔥', c: 8,  r: 4 },
  { id: 4,  name: '駆動アームの交換',       pct: 10, kind: 'weld',    need: 1,  icon: '🦾', c: 24, r: 5 },
  { id: 5,  name: '高圧パイプの接続',       pct: 10, kind: 'bolt',    need: 3,  icon: '🛢️', c: 7,  r: 14 },
  { id: 6,  name: '冷却液の充填',           pct: 5,  kind: 'bolt',    need: 2,  icon: '🧊', c: 24, r: 14 },
  { id: 7,  name: '配線の張り替え',         pct: 5,  kind: 'press',   need: 6,  icon: '🧵', c: 12, r: 6 },
  { id: 8,  name: '翼面パネルの固定',       pct: 5,  kind: 'press',   need: 8,  icon: '🪽', c: 28, r: 9 },
  { id: 9,  name: '回路のショート復旧',     pct: 5,  kind: 'press',   need: 6,  icon: '⚡', c: 20, r: 6 },
  { id: 10, name: 'メインバルブの調整',     pct: 5,  kind: 'press',   need: 8,  icon: '🎛️', c: 12, r: 13 },
  { id: 11, name: '冷却ファンの清掃',       pct: 5,  kind: 'press',   need: 6,  icon: '🌀', c: 20, r: 13 },
  { id: 12, name: '通信モジュールの再起動', pct: 5,  kind: 'press',   need: 5,  icon: '📡', c: 3,  r: 3 },
  { id: 13, name: '予備バッテリーの装着',   pct: 5,  kind: 'battery', need: 1,  icon: '🔋', c: 10, r: 17 },
  { id: 14, name: 'センサーの校正',         pct: 5,  kind: 'press',   need: 6,  icon: '🎯', c: 21, r: 17 },
  { id: 15, name: '点火システム最終調整',   pct: 5,  kind: 'press',   need: 10, icon: '🚀', c: 28, r: 12 },
].map(d => ({ ...d, ...cp(d.c, d.r) }));
const defOf = (id) => TASK_DEFS.find(d => d.id === id);

const KIND_ITEM = { fuse: 'fuse', weld: 'torch', bolt: 'bolt', battery: 'battery' };
const ITEM_NAME = { fuse: 'ヒューズ', torch: '溶接トーチ', bolt: 'ボルト', battery: 'バッテリー' };

// クリアゾーン（壁を生成しない矩形）
const ZONES = [
  { ...POS.bench, hw: 100, hh: 80 },
  { ...POS.coreBox, hw: 100, hh: 100 },
  { ...POS.battBox, hw: 100, hh: 100 },
  { ...POS.fuseBox, hw: 100, hh: 100 },
  { ...SPAWN, hw: 160, hh: 60 },
  ...TASK_DEFS.map(d => ({ x: d.x, y: d.y, hw: 60, hh: 60 })),
];
const FAC_POINTS = [...Object.values(POS), ...TASK_DEFS];

const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f783ac'];

// ---------- 迷路マップ生成 ----------
let grid = [];
let openCells = [];
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
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS || g[nr][nc]) continue;
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

  const interior = (COLS - 2) * (ROWS - 2);
  const target = Math.floor(interior * 0.5);
  let cnt = 0, tries = 0;
  while (cnt < target && tries < 6000) {
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

  // 主要設備・スポーン周囲のクリアゾーン
  for (const z of ZONES) {
    const c0 = Math.max(1, Math.floor((z.x - z.hw) / CELL));
    const c1 = Math.min(COLS - 2, Math.floor((z.x + z.hw) / CELL));
    const r0 = Math.max(1, Math.floor((z.y - z.hh) / CELL));
    const r1 = Math.min(ROWS - 2, Math.floor((z.y + z.hh) / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = false;
  }

  // 導線確保：スポーンから全設備・全タスク拠点へ到達可能にする
  const spawnCell = cellOf(SPAWN);
  let comp = component(g, spawnCell);
  for (const f of FAC_POINTS) {
    const fc = cellOf(f);
    if (!comp[key(fc.c, fc.r)]) {
      carve(g, fc, comp);
      comp = component(g, spawnCell);
    }
  }
  for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) {
    if (!g[r][c] && !comp[key(c, r)]) g[r][c] = true; // 孤立ポケットは埋める
  }

  grid = g;
  openCells = [];
  for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) if (!g[r][c]) openCells.push({ c, r });
}

const mapRows = () => grid.map(row => row.map(v => (v ? '1' : '0')).join(''));
const isWall = (c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : grid[r][c];

// 円(プレイヤー) vs 矩形(壁セル) の押し出し
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
  core: { state: 'box', x: 0, y: 0, holder: null },
  active: [],          // [{id, p}] 常時3つ
  done: new Set(),
  progress: 0,         // 0..100
  result: null,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (p, pos, r) => dist(p, pos) <= r;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fx(type, x, y, text, snd) {
  io.emit('fx', { type, x: Math.round(x), y: Math.round(y), text, snd });
}

// ----- インベントリ -----
const usedSlots = (p) => p.slots.length + (p.hasCore ? CORE_SLOTS : 0);
const freeSlots = (p) => SLOT_MAX - usedSlots(p);
const countItem = (p, t) => p.slots.reduce((a, s) => a + (s.t === t ? s.n : 0), 0);
const hasItem = (p, t) => p.slots.some(s => s.t === t);

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
    if (FAC_POINTS.some(f => dist(pt, f) < 85)) continue;
    if (game.scraps.some(s => dist(s, pt) < 40)) continue;
    if (wallNeighbors(cell.c, cell.r) === 0 && Math.random() > 0.3) continue;
    game.scraps.push({ id: game.nextScrapId++, x: pt.x, y: pt.y });
    return;
  }
}

// ----- タスク管理 -----
function pickTaskId() {
  const pool = TASK_DEFS.filter(d => !game.done.has(d.id) && !game.active.some(a => a.id === d.id));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)].id;
}
function fillActive() {
  const added = [];
  while (game.active.length < ACTIVE_TASKS) {
    const id = pickTaskId();
    if (id == null) break;
    game.active.push({ id, p: 0 });
    added.push(id);
  }
  return added;
}
function completeTask(act) {
  const d = defOf(act.id);
  game.active = game.active.filter(a => a !== act);
  game.done.add(d.id);
  game.progress = Math.min(100, game.progress + d.pct);
  fx('done', d.x, d.y - 60, `${d.name} 完了! +${d.pct}%`, 'done');
  if (game.progress >= 100) { endGame('win'); return; }
  const added = fillActive(); // 重複なしで補充
  for (const id of added) io.emit('toast', { text: `新タスク: ${defOf(id).name}` });
}

// ----- ゲーム進行 -----
function resetPlayer(p, i) {
  p.x = SPAWN.x + ((i % 6) - 2.5) * 44;
  p.y = SPAWN.y + (Math.floor(i / 6) % 2) * 44 - 22;
  p.slots = [];
  p.hasCore = false;
  p.input = { x: 0, y: 0 };
  p.weld = null;
  p.lastAct = 0;
  p.lastDisc = 0;
}

function regenMap() {
  genMap();
  io.emit('map', { rows: mapRows() });
}

function resetGame() {
  regenMap();
  game.scraps = [];
  game.respawns = [];
  for (let i = 0; i < SCRAP_COUNT; i++) spawnScrap();
  game.core = { state: 'box', x: 0, y: 0, holder: null };
  game.active = [];
  game.done = new Set();
  game.progress = 0;
  fillActive();
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

function endGame(type) {
  if (game.phase !== 'playing') return;
  game.remainAtEnd = Math.max(0, game.endsAt - Date.now());
  game.phase = type;
  game.result = { type, progress: Math.round(game.progress) };
  for (const p of players.values()) { p.input = { x: 0, y: 0 }; p.weld = null; }
}

function dropCore(p) {
  game.core.state = 'ground';
  game.core.x = p.x;
  game.core.y = p.y;
  game.core.holder = null;
  p.hasCore = false;
}

// ---------- アクション（Space） ----------
function doAction(p) {
  if (game.phase !== 'playing' || p.weld) return;
  const now = Date.now();
  if (now - p.lastAct < ACTION_MIN_INTERVAL) return;
  p.lastAct = now;
  const msg = (text, snd) => fx('msg', p.x, p.y - 44, text, snd);

  const act = game.active.find(a => near(p, defOf(a.id), REACH));

  // コア所持中
  if (p.hasCore) {
    if (act && defOf(act.id).kind === 'core') {
      p.hasCore = false;
      game.core = { state: 'box', x: 0, y: 0, holder: null };
      completeTask(act);
      return;
    }
    dropCore(p);
    msg('コアを置いた', 'drop');
    return;
  }

  // 現在のタスク拠点
  if (act) {
    const d = defOf(act.id);
    if (d.kind === 'core') { msg('プラズマコアが必要!', 'error'); return; }
    if (d.kind === 'press') {
      act.p += 1;
      fx('repair', d.x, d.y - 20, `${act.p}/${d.need}`, 'repair');
      if (act.p >= d.need) completeTask(act);
      return;
    }
    if (d.kind === 'bolt') {
      if (!removeItem(p, 'bolt')) { msg('ボルトが必要!', 'error'); return; }
      act.p += 1;
      fx('repair', d.x, d.y - 20, `${act.p}/${d.need}`, 'repair');
      if (act.p >= d.need) completeTask(act);
      return;
    }
    if (d.kind === 'fuse' || d.kind === 'battery') {
      const it = KIND_ITEM[d.kind];
      if (!removeItem(p, it)) { msg(`${ITEM_NAME[it]}が必要!`, 'error'); return; }
      completeTask(act);
      return;
    }
    if (d.kind === 'weld') {
      if (!hasItem(p, 'torch')) { msg('溶接トーチが必要!', 'error'); return; }
      p.weld = { taskId: d.id, start: now };
      p.input = { x: 0, y: 0 };
      io.to(p.id).emit('weldStart', { taskId: d.id, name: d.name });
      return;
    }
  }

  // 現在のタスクではない拠点
  const idle = TASK_DEFS.find(d => near(p, d, REACH));
  if (idle) {
    msg(game.done.has(idle.id) ? '修理済み' : '今は必要ないタスク', 'error');
    return;
  }

  // 作業台：バッテリー所持 → 溶接トーチ / それ以外 → ボルト
  if (near(p, POS.bench, REACH)) {
    const scrap = countItem(p, 'scrap');
    if (hasItem(p, 'battery')) {
      if (scrap < 2) { msg(`トーチには金属くず×2が必要 (${scrap}/2)`, 'error'); return; }
      removeScrap(p, 2);
      removeItem(p, 'battery');
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

  // バッテリー箱
  if (near(p, POS.battBox, REACH)) {
    if (!addItem(p, 'battery')) { msg('スロットがいっぱい!', 'error'); return; }
    fx('pick', POS.battBox.x, POS.battBox.y - 30, 'バッテリー取得', 'pick');
    return;
  }

  // ヒューズ箱
  if (near(p, POS.fuseBox, REACH)) {
    if (!addItem(p, 'fuse')) { msg('スロットがいっぱい!', 'error'); return; }
    fx('pick', POS.fuseBox.x, POS.fuseBox.y - 30, 'ヒューズ取得', 'pick');
    return;
  }

  // コア拾得（地面 / コア箱）
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
  if (game.phase !== 'playing' || p.weld) return;
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

// 溶接ミニゲームの結果
function doWeldEnd(p, d) {
  const w = p.weld;
  if (!w) return;
  p.weld = null;
  if (game.phase !== 'playing' || !d || d.cancel) return;
  const msg = (text, snd) => fx('msg', p.x, p.y - 44, text, snd);
  const act = game.active.find(a => a.id === w.taskId);
  if (!act) { msg('このタスクは既に完了していた', 'error'); return; }
  if (!d.ok) { msg('溶接失敗… (トーチは無事・再挑戦OK)', 'error'); return; }
  if (Date.now() - w.start < WELD_MIN_MS) { msg('溶接が速すぎる?', 'error'); return; }
  if (!removeItem(p, 'torch')) { msg('溶接トーチがない!', 'error'); return; }
  completeTask(act);
}

// ---------- ゲームループ ----------
let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  if (game.phase === 'playing') {
    for (const p of players.values()) {
      if (p.weld && now - p.weld.start > WELD_TIMEOUT_MS) p.weld = null;
      if (p.weld) continue; // 溶接中は動けない
      let dx = p.input.x, dy = p.input.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dx /= len; dy /= len;
        const sp = p.hasCore ? SPEED_CORE : SPEED;
        p.x += dx * sp * dt;
        p.y += dy * sp * dt;
        resolveWalls(p);
        p.x = clamp(p.x, PR, W - PR);
        p.y = clamp(p.y, PR, H - PR);
      }
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
    if (now >= game.endsAt) endGame('lose');
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
      w: !!p.weld,
    })),
    scraps: game.scraps.map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y) })),
    core,
    tk: {
      a: game.active.map(a => [a.id, a.p]),
      d: [...game.done],
      pr: Math.round(game.progress),
    },
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
    x: 0, y: 0, slots: [], hasCore: false, weld: null,
    input: { x: 0, y: 0 }, lastAct: 0, lastDisc: 0,
  };
  resetPlayer(p, players.size);
  players.set(socket.id, p);

  socket.emit('init', {
    you: socket.id, W, H, CELL, POS, SPAWN, REACH, SLOT_MAX, SCRAP_STACK, CORE_SLOTS, GAME_MS,
    TASKS: TASK_DEFS.map(d => ({ id: d.id, name: d.name, pct: d.pct, kind: d.kind, need: d.need, icon: d.icon, x: d.x, y: d.y })),
    rows: mapRows(),
  });

  socket.on('input', (d) => {
    if (!d || typeof d !== 'object' || p.weld) { p.input = { x: 0, y: 0 }; return; }
    p.input = {
      x: (d.right ? 1 : 0) - (d.left ? 1 : 0),
      y: (d.down ? 1 : 0) - (d.up ? 1 : 0),
    };
  });
  socket.on('action', () => doAction(p));
  socket.on('discard', (i) => doDiscard(p, i));
  socket.on('weldEnd', (d) => doWeldEnd(p, d));
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

server.listen(PORT, () => console.log(`Destroy or Avoid v3 running on :${PORT}`));

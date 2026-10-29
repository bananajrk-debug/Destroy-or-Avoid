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
const CELL = 50, COLS = 64, ROWS = 40;
const W = COLS * CELL, H = ROWS * CELL;
const TICK_RATE = 30;
const GAME_MS = 10 * 60 * 1000;
const SPEED = 250, SPEED_CORE = 140, GHOST_MULT = 1.5, PR = 16, REACH = 70;
const SLOT_MAX = 3, MIN_PLAYERS = 2, MAX_PLAYERS = 10, MAX_IMP = 3;
const KILL_RANGE = 95, REPORT_RANGE = 110, BTN_RANGE = 90;
const KILL_CD = 20000, FIRST_KILL_CD = 15000, SAB_CD = 45000, SAB_PCT = 5;
const BTN_LOCK = 10000, FREEZE_MS = 3200;
const DISCUSS_MS = 20000, VOTE_MS = 30000, RESULT_MS = 6500, END_AUTO_MS = 25000;
const ACTIVE_TASKS = 3, ACTION_MIN = 60;
const MIN_MINI = { weld: 6000, seq: 1000, alt: 1200, space: 800 };
const MINI_TIMEOUT = 90000;
const THEME_COUNT = 12;

const cp = (c, r) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 });
const ITEM_NAME = { fuse: 'ヒューズ', battery: 'バッテリー', core: 'プラズマコア' };
const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f783ac', '#a9e34b', '#c08457'];
const ACCS = ['', '🐥', '💩', '👑', '🎩', '😎', '🌸', '🔥', '🎀', '🍕'];

// ---------- タスクプール（全15個。位置はマップ生成時に決まる） ----------
const TASK_DEFS = [
  { id: 1,  name: 'プラズマコアの搬入',   pct: 20, kind: 'carry', item: 'core',    icon: '⚛️' },
  { id: 2,  name: 'ヒューズの装着',       pct: 10, kind: 'carry', item: 'fuse',    icon: '🔌' },
  { id: 3,  name: '予備バッテリーの装着', pct: 10, kind: 'carry', item: 'battery', icon: '🔋' },
  { id: 4,  name: '外壁フレーム溶接',     pct: 10, kind: 'weld',  icon: '🔥' },
  { id: 5,  name: '駆動アームの溶接',     pct: 10, kind: 'weld',  icon: '🦾' },
  { id: 6,  name: '配電盤の番号入力',     pct: 5,  kind: 'seq',   n: 5, icon: '🔢' },
  { id: 7,  name: 'パスコード解除',       pct: 5,  kind: 'seq',   n: 6, icon: '🔐' },
  { id: 8,  name: '配線の接続コード入力', pct: 5,  kind: 'seq',   n: 5, icon: '🧵' },
  { id: 9,  name: '冷却ファンの回転',     pct: 5,  kind: 'alt',   n: 20, icon: '🌀' },
  { id: 10, name: '発電機のクランク',     pct: 10, kind: 'alt',   n: 30, icon: '⚙️' },
  { id: 11, name: 'ポンプの加圧',         pct: 5,  kind: 'alt',   n: 16, icon: '🛢️' },
  { id: 12, name: 'コンテナの封印',       pct: 5,  kind: 'space', n: 6, icon: '📦' },
  { id: 13, name: 'バルブの調整',         pct: 5,  kind: 'space', n: 8, icon: '🎛️' },
  { id: 14, name: 'アンテナの調整',       pct: 5,  kind: 'space', n: 6, icon: '📡' },
  { id: 15, name: '点火システムの調整',   pct: 5,  kind: 'space', n: 10, icon: '🚀' },
];
const defOf = (id) => TASK_DEFS.find(d => d.id === id);

// <<GENMAP
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// BSP + 幅3の廊下 + ループ廊下 で、毎回違う非対称の宇宙船レイアウトを生成
function genMap() {
  const seed = Math.floor(Math.random() * 2147483647);
  const rng = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const g = Array.from({ length: ROWS }, () => Array(COLS).fill(true));
  const wall = (c, r) => c < 0 || r < 0 || c >= COLS || r >= ROWS || g[r][c];
  const carve = (c0, r0, c1, r1) => {
    for (let r = Math.max(1, r0); r <= Math.min(ROWS - 2, r1); r++)
      for (let c = Math.max(1, c0); c <= Math.min(COLS - 2, c1); c++) g[r][c] = false;
  };
  const rooms = [];
  function bsp(x, y, w, h) {
    const node = {};
    const canV = w >= 24, canH = h >= 18, big = w > 22 || h > 17;
    if ((canV || canH) && (big || rng() < 0.3)) {
      const vert = canV && canH ? (w / h > 1.3 ? true : (h / w > 1.3 ? false : rng() < 0.5)) : canV;
      if (vert) { const s = ri(12, w - 12); node.a = bsp(x, y, s, h); node.b = bsp(x + s, y, w - s, h); }
      else { const s = ri(9, h - 9); node.a = bsp(x, y, w, s); node.b = bsp(x, y + s, w, h - s); }
    } else {
      const rw = ri(Math.max(6, Math.floor(w * 0.6)), w - 2), rh = ri(Math.max(6, Math.floor(h * 0.6)), h - 2);
      const rx = x + 1 + ri(0, w - 2 - rw), ry = y + 1 + ri(0, h - 2 - rh);
      carve(rx, ry, rx + rw - 1, ry + rh - 1);
      node.room = { x: rx, y: ry, w: rw, h: rh };
      rooms.push(node.room);
    }
    return node;
  }
  const root = bsp(1, 1, COLS - 2, ROWS - 2);
  const center = r => ({ c: r.x + (r.w >> 1), r: r.y + (r.h >> 1) });
  const pick = n => n.room ? n.room : pick(rng() < 0.5 ? n.a : n.b);
  const hcar = (c1, c2, r) => carve(Math.min(c1, c2), r - 1, Math.max(c1, c2), r + 1);
  const vcar = (r1, r2, c) => carve(c - 1, Math.min(r1, r2), c + 1, Math.max(r1, r2));
  function corridor(a, b) {
    const A = center(a), B = center(b);
    if (rng() < 0.5) { hcar(A.c, B.c, A.r); vcar(A.r, B.r, B.c); }
    else { vcar(A.r, B.r, A.c); hcar(A.c, B.c, B.r); }
  }
  (function connect(n) { if (!n.a) return; connect(n.a); connect(n.b); corridor(pick(n.a), pick(n.b)); })(root);
  for (let i = 0; i < 4; i++) { const a = rooms[ri(0, rooms.length - 1)], b = rooms[ri(0, rooms.length - 1)]; if (a !== b) corridor(a, b); }

  // 中央付近の大きめの部屋を「緊急会議ルーム」に
  const mid = { c: COLS / 2, r: ROWS / 2 };
  const dm = r => Math.hypot(center(r).c - mid.c, center(r).r - mid.r);
  let cands = rooms.filter(r => r.w >= 9 && r.h >= 7);
  if (!cands.length) cands = rooms.slice().sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 1);
  cands.sort((a, b) => dm(a) - dm(b));
  const hall = cands[0], bc = center(hall);

  // 柱 (2x2)
  for (const r of rooms) {
    if (r === hall || r.w < 10 || r.h < 8 || rng() > 0.7) continue;
    for (let k = ri(1, 2); k > 0; k--) {
      const px = ri(r.x + 3, r.x + r.w - 5), py = ri(r.y + 3, r.y + r.h - 5);
      g[py][px] = g[py][px + 1] = g[py + 1][px] = g[py + 1][px + 1] = true;
    }
  }
  // 会議ルーム中央のクリアゾーン
  const cr = Math.min(3.4, (Math.min(hall.w, hall.h) - 1) / 2);
  for (let r = hall.y; r < hall.y + hall.h; r++) for (let c = hall.x; c < hall.x + hall.w; c++)
    if (Math.hypot(c - bc.c, r - bc.r) <= cr) g[r][c] = false;

  // 飛び出し(突起・斜め接触)の除去
  for (let it = 0; it < 16; it++) {
    for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) {
      if (!g[r][c]) continue;
      const n = (wall(c - 1, r) ? 1 : 0) + (wall(c + 1, r) ? 1 : 0) + (wall(c, r - 1) ? 1 : 0) + (wall(c, r + 1) ? 1 : 0);
      if (n <= 1) g[r][c] = false;
    }
    for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS - 1; c++) {
      const a = wall(c, r), b = wall(c + 1, r), d = wall(c, r + 1), e = wall(c + 1, r + 1);
      let tr = -1, tc = -1;
      if (a && e && !b && !d) { tr = r; tc = c; } else if (b && d && !a && !e) { tr = r; tc = c + 1; }
      if (tr >= 1 && tc >= 1 && tr < ROWS - 1 && tc < COLS - 1) g[tr][tc] = false;
    }
  }
  // 到達性: 会議ルームから行けない空間は壁で埋める
  const reach = new Set([bc.r * COLS + bc.c]);
  const q = [[bc.c, bc.r]];
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (wall(nc, nr) || reach.has(nr * COLS + nc)) continue;
      reach.add(nr * COLS + nc); q.push([nc, nr]);
    }
  }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!g[r][c] && !reach.has(r * COLS + c)) g[r][c] = true;

  // 設備配置 (3x3が空いている到達可能セル、設備同士は離す)
  const open3 = (c, r) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (wall(c + dc, r + dr)) return false; return true; };
  const used = [];
  const order = rooms.slice().sort(() => rng() - 0.5);
  let k = 0;
  function spot() {
    let minD = 9;
    for (let t = 0; t < 1200; t++) {
      if (t % 150 === 149) minD = Math.max(3, minD - 1.5);
      const R = order[k++ % order.length];
      const c = ri(R.x + 1, R.x + R.w - 2), r = ri(R.y + 1, R.y + R.h - 2);
      if (!reach.has(r * COLS + c) || !open3(c, r)) continue;
      if (Math.hypot(c - bc.c, r - bc.r) < 5) continue;
      if (used.some(u => Math.hypot(u.c - c, u.r - r) < minD)) continue;
      used.push({ c, r }); return cp(c, r);
    }
    for (const idx of reach) {
      const c = idx % COLS, r = (idx / COLS) | 0;
      if (open3(c, r) && !used.some(u => u.c === c && u.r === r)) { used.push({ c, r }); return cp(c, r); }
    }
    return cp(bc.c, bc.r);
  }
  const stations = { fuse: spot(), battery: spot(), core: spot() };
  const tasks = {};
  for (const d of TASK_DEFS) tasks[d.id] = spot();

  const themes = Array.from({ length: THEME_COUNT }, (_, i) => i).sort(() => rng() - 0.5);
  return {
    seed, grid: g, rows: g.map(row => row.map(v => (v ? '1' : '0')).join('')),
    rooms: rooms.map((r, i) => [r.x, r.y, r.w, r.h, themes[i % THEME_COUNT]]),
    button: cp(bc.c, bc.r), stations, tasks,
  };
}
// GENMAP>>

const mapPayload = (m) => ({ seed: m.seed, rows: m.rows, rooms: m.rooms, BUTTON: m.button, STATIONS: m.stations, TPOS: m.tasks });

function resolveWalls(grid, p) {
  const isWall = (c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : grid[r][c];
  for (let it = 0; it < 16; it++) {
    let moved = false;
    const c0 = Math.floor((p.x - PR) / CELL), c1 = Math.floor((p.x + PR) / CELL);
    const r0 = Math.floor((p.y - PR) / CELL), r1 = Math.floor((p.y + PR) / CELL);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (!isWall(c, r)) continue;
      const rx = c * CELL, ry = r * CELL;
      const cx = Math.max(rx, Math.min(rx + CELL, p.x)), cy = Math.max(ry, Math.min(ry + CELL, p.y));
      const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
      if (d2 >= PR * PR) continue;
      if (d2 > 1e-6) { const d = Math.sqrt(d2); p.x += dx / d * (PR - d); p.y += dy / d * (PR - d); }
      else {
        const l = p.x - rx, rt = rx + CELL - p.x, t = p.y - ry, b = ry + CELL - p.y, m = Math.min(l, rt, t, b);
        if (m === l) p.x = rx - PR; else if (m === rt) p.x = rx + CELL + PR; else if (m === t) p.y = ry - PR; else p.y = ry + CELL + PR;
      }
      moved = true;
    }
    if (!moved) break;
  }
}

// ---------- ルーム管理 (5桁コード) ----------
const rooms = new Map();
const sockRoom = new Map();

function newRoom() {
  let code;
  do { code = String(Math.floor(Math.random() * 90000) + 10000); } while (rooms.has(code));
  const R = {
    code, players: new Map(), joinCounter: 0, impCount: 1, impN: 1,
    phase: 'lobby', endsAt: 0, remainAtEnd: GAME_MS, endedAt: 0, progress: 0, crewTotal: 1,
    result: null, bodies: [], nextBody: 1, meeting: null, noMeetingUntil: 0, freezeUntil: 0, map: null, mapMsg: null,
  };
  rooms.set(code, R);
  return R;
}

const rEmit = (R, ev, d) => io.to('r' + R.code).emit(ev, d);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (p, pos, r) => dist(p, pos) <= r;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toast = (p, text, kind) => io.to(p.id).emit('toast', { text, kind: kind || 'info' });
const participants = (R) => [...R.players.values()].filter(p => !p.late);
const hostId = (R) => { let h = null; for (const p of R.players.values()) if (!h || p.joinOrder < h.joinOrder) h = p; return h ? h.id : null; };
const maxImp = (n) => Math.min(MAX_IMP, Math.max(1, Math.floor((n - 1) / 2)));
const hasItem = (p, t) => p.slots.some(s => s.t === t);
const removeItem = (p, t) => { if (!hasItem(p, t)) return false; p.slots = p.slots.filter(s => s.t !== t); return true; };
function cancelMini(p) { if (p.mini) { p.mini = null; io.to(p.id).emit('miniCancel'); } }
const tpos = (R, id) => R.map.tasks[id];

function ringPos(R, i, n, rad) {
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  return { x: R.map.button.x + Math.cos(a) * rad, y: R.map.button.y + Math.sin(a) * rad };
}

// ---------- タスク ----------
function newTask(p) {
  let pool = TASK_DEFS.filter(t => !p.tasks.includes(t.id) && !p.doneTasks.has(t.id));
  if (!pool.length) { p.doneTasks.clear(); pool = TASK_DEFS.filter(t => !p.tasks.includes(t.id)); }
  return pool[Math.floor(Math.random() * pool.length)].id;
}
function fillTasks(p) { while (p.tasks.length < ACTIVE_TASKS) p.tasks.push(newTask(p)); }

function completeTask(R, p, id) {
  const d = defOf(id), idx = p.tasks.indexOf(id);
  if (!d || idx < 0) return;
  p.tasks.splice(idx, 1); p.doneTasks.add(id); fillTasks(p);
  io.to(p.id).emit('sfx', 'done');
  // インポスターがタスクを完了しても全体進捗が進む
  const k = clamp(4 / Math.max(1, R.crewTotal), 0.5, 1.5);
  const add = d.pct * k;
  R.progress = Math.min(100, R.progress + add);
  toast(p, `${d.name} 完了! 進捗 +${add.toFixed(1)}%`, 'good');
  checkWin(R);
}

// ---------- 開始・終了 ----------
function resetPlayer(R, p, i, n) {
  const pos = ringPos(R, i, n, 100);
  p.x = pos.x; p.y = pos.y;
  p.alive = true; p.slots = []; p.mini = null; p.input = { x: 0, y: 0 };
  p.tasks = []; p.doneTasks = new Set(); p.moving = false; p.emUsed = false;
}

function startGame(R) {
  const part = participants(R);
  if (part.length < MIN_PLAYERS) return;
  const now = Date.now();
  R.map = genMap();
  R.mapMsg = mapPayload(R.map);
  rEmit(R, 'map', R.mapMsg);
  R.phase = 'playing'; R.progress = 0; R.result = null; R.bodies = []; R.meeting = null;
  R.endsAt = now + GAME_MS; R.noMeetingUntil = now + BTN_LOCK; R.freezeUntil = now + FREEZE_MS;
  const n = part.length;
  R.impN = Math.min(R.impCount, maxImp(n));
  R.crewTotal = n;
  const imps = new Set(part.slice().sort(() => Math.random() - 0.5).slice(0, R.impN));
  part.forEach((p, i) => {
    resetPlayer(R, p, i, n);
    p.role = imps.has(p) ? 'imposter' : 'crew';
    p.killReady = now + FIRST_KILL_CD; p.sabReady = now + 30000;
    fillTasks(p);
  });
  rEmit(R, 'sfx', 'start');
}

function endGame(R, winner, reason) {
  if (R.phase === 'end' || R.phase === 'lobby') return true;
  const now = Date.now();
  R.remainAtEnd = Math.max(0, R.endsAt - (R.meeting ? R.meeting.startAt : now));
  R.phase = 'end'; R.meeting = null; R.endedAt = now; R.result = { winner, reason };
  for (const p of R.players.values()) { cancelMini(p); p.input = { x: 0, y: 0 }; p.moving = false; }
  rEmit(R, 'sfx', winner === 'crew' ? 'win' : 'lose');
  return true;
}

function toLobby(R) {
  R.phase = 'lobby'; R.meeting = null; R.bodies = []; R.result = null; R.remainAtEnd = GAME_MS; R.progress = 0;
  R.map = null; R.mapMsg = null;
  for (const p of R.players.values()) {
    p.late = false; p.ready = false; p.role = null; p.alive = true;
    p.slots = []; p.tasks = []; p.mini = null; p.input = { x: 0, y: 0 }; p.moving = false;
  }
}

function checkWin(R) {
  if (R.phase !== 'playing') return false;
  const part = participants(R);
  const imps = part.filter(p => p.role === 'imposter' && p.alive).length;
  const crews = part.filter(p => p.role === 'crew' && p.alive).length;
  if (R.progress >= 100) return endGame(R, 'crew', '全タスクが完了した! 進捗100%');
  if (imps === 0) return endGame(R, 'crew', 'インポスターを全員排除した!');
  if (crews <= imps) return endGame(R, 'imposter', 'クルーが全滅した…');
  return false;
}

// ---------- 会議 ----------
function startMeeting(R, caller, reason) {
  const now = Date.now();
  R.phase = 'meeting';
  R.meeting = { mode: 'discuss', startAt: now, modeEnds: now + DISCUSS_MS, votes: new Map(), reason, callerName: caller.name, result: null };
  if (reason === 'button') caller.emUsed = true;
  const part = participants(R);
  part.forEach((p, i) => {
    cancelMini(p); p.input = { x: 0, y: 0 }; p.moving = false;
    const pos = ringPos(R, i, part.length, 100); p.x = pos.x; p.y = pos.y;
  });
  rEmit(R, 'sfx', 'meeting');
}

function resolveVotes(R, now) {
  const m = R.meeting, counts = {};
  let skip = 0;
  for (const [vid, t] of m.votes) {
    if (!R.players.has(vid)) continue;
    if (t === 'skip') skip++; else counts[t] = (counts[t] || 0) + 1;
  }
  let max = 0, top = [];
  for (const id in counts) {
    if (counts[id] > max) { max = counts[id]; top = [id]; } else if (counts[id] === max) top.push(id);
  }
  let ej = null;
  if (top.length === 1 && max > skip) {
    const t = R.players.get(top[0]);
    if (t) { t.alive = false; cancelMini(t); ej = { id: t.id, name: t.name, c: t.color, acc: t.acc, imp: t.role === 'imposter' }; }
  }
  const left = participants(R).filter(p => p.role === 'imposter' && p.alive).length;
  m.result = { ej, tally: Object.entries(counts), skip, left };
  m.mode = 'result'; m.modeEnds = now + RESULT_MS;
}

function endMeeting(R, now) {
  const m = R.meeting;
  R.endsAt += now - m.startAt;
  R.phase = 'playing'; R.meeting = null; R.bodies = [];
  R.noMeetingUntil = now + BTN_LOCK;
  for (const p of participants(R)) if (p.role === 'imposter') p.killReady = Math.max(p.killReady, now + 10000);
  checkWin(R);
}

function tickMeeting(R, now) {
  const m = R.meeting;
  if (!m) { R.phase = 'playing'; return; }
  if (m.mode === 'discuss') { if (now >= m.modeEnds) { m.mode = 'vote'; m.modeEnds = now + VOTE_MS; } }
  else if (m.mode === 'vote') {
    const voters = participants(R).filter(p => p.alive);
    if (now >= m.modeEnds || voters.every(p => m.votes.has(p.id))) resolveVotes(R, now);
  } else if (m.mode === 'result') { if (now >= m.modeEnds) endMeeting(R, now); }
}

// ---------- アクション ----------
function doAction(R, p) {
  if (R.phase !== 'playing' || p.late || p.mini) return;
  const now = Date.now();
  if (now - p.lastAct < ACTION_MIN) return;
  p.lastAct = now;
  for (const id of p.tasks) {
    const d = defOf(id);
    if (!near(p, tpos(R, id), REACH)) continue;
    if (d.kind === 'carry') {
      if (!hasItem(p, d.item)) { toast(p, `${ITEM_NAME[d.item]}が必要! (運搬してこよう)`, 'error'); return; }
      removeItem(p, d.item); completeTask(R, p, id); return;
    }
    p.mini = { taskId: id, kind: d.kind, start: now };
    p.input = { x: 0, y: 0 }; p.moving = false;
    io.to(p.id).emit('miniStart', { taskId: id });
    return;
  }
  for (const id of p.tasks) {
    const d = defOf(id);
    if (d.kind !== 'carry' || !near(p, R.map.stations[d.item], REACH)) continue;
    if (hasItem(p, d.item)) { toast(p, 'すでに持っている', 'error'); return; }
    const need = d.item === 'core' ? 2 : 1;
    if (p.slots.length + need > SLOT_MAX) { toast(p, 'スロットがいっぱい!', 'error'); return; }
    for (let i = 0; i < need; i++) p.slots.push({ t: d.item });
    toast(p, `${ITEM_NAME[d.item]}を取得`, 'info'); io.to(p.id).emit('sfx', 'click');
    return;
  }
  if (near(p, R.map.button, BTN_RANGE)) {
    if (!p.alive) return;
    if (p.emUsed) { toast(p, '緊急会議は1人1回まで', 'error'); return; }
    if (now < R.noMeetingUntil) { toast(p, `まだ使えない (あと${Math.ceil((R.noMeetingUntil - now) / 1000)}秒)`, 'error'); return; }
    startMeeting(R, p, 'button');
  }
}

function doReport(R, p) {
  if (R.phase !== 'playing' || p.late || !p.alive) return;
  if (!R.bodies.find(b => dist(p, b) <= REPORT_RANGE)) { toast(p, '近くに死体がない', 'error'); return; }
  startMeeting(R, p, 'body');
}

function doKill(R, p) {
  if (R.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter') return;
  const now = Date.now();
  if (now < p.killReady || now < R.freezeUntil) return;
  let best = null, bd = KILL_RANGE;
  for (const v of participants(R)) {
    if (v === p || !v.alive || v.role === 'imposter') continue;
    const d = dist(p, v);
    if (d <= bd) { bd = d; best = v; }
  }
  if (!best) { toast(p, '範囲内にターゲットがいない', 'error'); return; }
  best.alive = false; cancelMini(best);
  R.bodies.push({ id: R.nextBody++, x: Math.round(best.x), y: Math.round(best.y), c: best.color });
  p.x = best.x; p.y = best.y; p.killReady = now + KILL_CD;
  // 被害者にだけキルカットシーン。実行者は演出なしで即操作可能
  io.to(best.id).emit('killCut', { kc: p.color, ka: p.acc, kn: p.name, vc: best.color, va: best.acc, vn: best.name });
  io.to(best.id).emit('sfx', 'kill');
  io.to(p.id).emit('sfx', 'click');
  checkWin(R);
}

function doSabotage(R, p) {
  if (R.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter') return;
  const now = Date.now();
  if (now < p.sabReady) return;
  p.sabReady = now + SAB_CD;
  R.progress = Math.max(0, R.progress - SAB_PCT);
  rEmit(R, 'sfx', 'alarm');
  rEmit(R, 'toast', { text: `⚠ 妨害工作! 進捗が${SAB_PCT}%低下`, kind: 'error' });
}

function doDiscard(R, p, idx) {
  if (R.phase !== 'playing' || p.mini) return;
  const now = Date.now();
  if (now - p.lastDisc < 150) return;
  p.lastDisc = now;
  const s = p.slots[idx | 0];
  if (!s) return;
  p.slots = p.slots.filter(x => x.t !== s.t);
  toast(p, `${ITEM_NAME[s.t]}を捨てた`, 'info');
}

// ---------- ループ ----------
function tickRoom(R, now, dt) {
  if (R.phase === 'playing') {
    for (const p of R.players.values()) {
      if (p.late) continue;
      if (p.mini && now - p.mini.start > MINI_TIMEOUT) cancelMini(p);
      if (p.mini || now < R.freezeUntil) { p.moving = false; continue; }
      const len = Math.hypot(p.input.x, p.input.y);
      p.moving = len > 0;
      if (len > 0) {
        const dx = p.input.x / len, dy = p.input.y / len;
        const ghost = !p.alive;
        const sp = (hasItem(p, 'core') ? SPEED_CORE : SPEED) * (ghost ? GHOST_MULT : 1);
        p.x += dx * sp * dt; p.y += dy * sp * dt;
        if (!ghost) resolveWalls(R.map.grid, p); // 幽霊は壁通り抜け
        p.x = clamp(p.x, PR, W - PR); p.y = clamp(p.y, PR, H - PR);
        if (dx !== 0) p.face = dx > 0 ? 1 : -1;
      }
    }
    if (now >= R.endsAt) endGame(R, 'imposter', '時間切れ… クルーは間に合わなかった');
  } else if (R.phase === 'meeting') tickMeeting(R, now);
  else if (R.phase === 'end') { if (now - R.endedAt > END_AUTO_MS) toLobby(R); }
  broadcast(R, now);
}

function broadcast(R, now) {
  let remain = GAME_MS;
  if (R.phase === 'playing') remain = Math.max(0, R.endsAt - now);
  else if (R.phase === 'meeting') remain = Math.max(0, R.endsAt - R.meeting.startAt);
  else if (R.phase === 'end') remain = R.remainAtEnd;
  const part = participants(R), host = hostId(R);
  const base = { ph: R.phase, remain, prog: Math.round(R.progress * 10) / 10, result: R.result, ic: R.impN, code: R.code };
  let lobby = null;
  if (R.phase === 'lobby') {
    lobby = {
      list: [...R.players.values()].sort((a, b) => a.joinOrder - b.joinOrder).map(p => ({ id: p.id, name: p.name, c: p.color, acc: p.acc, ready: p.ready, host: p.id === host })),
      imp: R.impCount, max: maxImp(R.players.size),
    };
  }
  const pv = R.phase === 'lobby' ? null : part.map(p => ({ id: p.id, name: p.name, c: p.color, acc: p.acc, x: Math.round(p.x), y: Math.round(p.y), a: p.alive, mv: p.moving, f: p.face }));
  for (const v of R.players.values()) {
    const ghost = !v.alive || v.late || R.phase === 'end';
    const msg = {
      ...base,
      me: {
        role: v.role, alive: v.alive, late: v.late, ready: v.ready, host: v.id === host,
        tasks: v.tasks, sl: v.slots.map(s => s.t),
        kcd: Math.max(0, (v.killReady || 0) - now), scd: Math.max(0, (v.sabReady || 0) - now),
        em: v.emUsed, emLock: Math.max(0, R.noMeetingUntil - now),
        mates: v.role === 'imposter' ? part.filter(x => x.role === 'imposter' && x !== v).map(x => x.id) : [],
      },
    };
    if (lobby) msg.lobby = lobby;
    else {
      msg.players = ghost ? pv : pv.filter(p => p.a);
      msg.bodies = R.bodies;
      if (R.phase === 'meeting') {
        const m = R.meeting;
        msg.meet = {
          mode: m.mode, t: Math.max(0, m.modeEnds - now), reason: m.reason, caller: m.callerName,
          roster: part.map(p => ({ id: p.id, name: p.name, c: p.color, a: p.alive, voted: m.votes.has(p.id) })),
          my: m.votes.get(v.id) || null, res: m.result,
        };
      }
      if (R.phase === 'end') msg.roster = part.map(p => ({ id: p.id, name: p.name, c: p.color, role: p.role, a: p.alive }));
    }
    io.to(v.id).volatile.emit('state', msg);
  }
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const R of rooms.values()) tickRoom(R, now, dt);
}, 1000 / TICK_RATE);

// ---------- Socket.io ----------
function addPlayer(socket, R, d) {
  R.joinCounter += 1;
  const used = new Set([...R.players.values()].map(p => p.color));
  const color = (d && COLORS.includes(d.color) && !used.has(d.color)) ? d.color : (COLORS.find(c => !used.has(c)) || COLORS[0]);
  const name = String((d && d.name) || '').replace(/[<>]/g, '').trim().slice(0, 10) || ('P' + R.joinCounter);
  const late = R.phase !== 'lobby';
  const p = {
    id: socket.id, joinOrder: R.joinCounter, name, color, acc: ACCS.includes(d && d.acc) ? d.acc : '',
    x: 0, y: 0, face: 1, moving: false, ready: false, late, role: null, alive: !late,
    tasks: [], doneTasks: new Set(), slots: [], mini: null,
    input: { x: 0, y: 0 }, lastAct: 0, lastDisc: 0, lastChat: 0, killReady: 0, sabReady: 0, emUsed: false,
  };
  R.players.set(socket.id, p);
  sockRoom.set(socket.id, R);
  socket.join('r' + R.code);
  socket.emit('joined', { code: R.code });
  if (late && R.mapMsg) socket.emit('map', R.mapMsg);
}

io.on('connection', (socket) => {
  socket.emit('init', {
    you: socket.id, W, H, CELL, COLS, ROWS, REACH, SLOT_MAX, GAME_MS, ITEM_NAME, ACCS, COLORS,
    TASKS: TASK_DEFS.map(d => ({ id: d.id, name: d.name, pct: d.pct, kind: d.kind, item: d.item || null, n: d.n || 0, icon: d.icon })),
  });

  socket.on('createRoom', (d) => {
    if (sockRoom.has(socket.id)) return;
    addPlayer(socket, newRoom(), d || {});
  });
  socket.on('joinRoom', (d) => {
    if (sockRoom.has(socket.id)) return;
    const code = String((d && d.code) || '').replace(/\D/g, '').slice(0, 5);
    const R = rooms.get(code);
    if (!R) { socket.emit('joinError', 'そのコードのロビーは見つかりません'); return; }
    if (R.players.size >= MAX_PLAYERS) { socket.emit('joinError', 'ロビーが満員です'); return; }
    addPlayer(socket, R, d);
  });

  const C = () => { const R = sockRoom.get(socket.id); return R ? { R, p: R.players.get(socket.id) } : {}; };

  socket.on('input', (d) => {
    const { R, p } = C(); if (!p) return;
    if (!d || typeof d !== 'object' || p.mini || R.phase !== 'playing') { p.input = { x: 0, y: 0 }; return; }
    p.input = { x: (d.right ? 1 : 0) - (d.left ? 1 : 0), y: (d.down ? 1 : 0) - (d.up ? 1 : 0) };
  });
  socket.on('action', () => { const { R, p } = C(); if (p) doAction(R, p); });
  socket.on('report', () => { const { R, p } = C(); if (p) doReport(R, p); });
  socket.on('kill', () => { const { R, p } = C(); if (p) doKill(R, p); });
  socket.on('sabotage', () => { const { R, p } = C(); if (p) doSabotage(R, p); });
  socket.on('discard', (i) => { const { R, p } = C(); if (p) doDiscard(R, p, i); });

  socket.on('miniEnd', (d) => {
    const { R, p } = C(); if (!p || !p.mini) return;
    const m = p.mini; p.mini = null;
    if (R.phase !== 'playing' || !d || d.cancel) return;
    if (!d.ok) { toast(p, '失敗… もう一度挑戦しよう', 'error'); return; }
    if (!p.tasks.includes(m.taskId)) return;
    if (Date.now() - m.start < MIN_MINI[m.kind]) { toast(p, '操作が速すぎる?', 'error'); return; }
    completeTask(R, p, m.taskId);
  });

  socket.on('ready', () => { const { R, p } = C(); if (p && R.phase === 'lobby' && p.id !== hostId(R)) p.ready = !p.ready; });
  socket.on('setImp', (n) => {
    const { R, p } = C();
    if (!p || R.phase !== 'lobby' || p.id !== hostId(R)) return;
    R.impCount = clamp(parseInt(n, 10) || 1, 1, MAX_IMP);
  });
  socket.on('start', () => {
    const { R, p } = C();
    if (!p || R.phase !== 'lobby' || p.id !== hostId(R)) return;
    const part = participants(R);
    if (part.length < MIN_PLAYERS) { toast(p, `最低${MIN_PLAYERS}人必要`, 'error'); return; }
    if (!part.every(x => x.id === p.id || x.ready)) { toast(p, '全員の準備が完了していない', 'error'); return; }
    startGame(R);
  });
  socket.on('toLobby', () => { const { R, p } = C(); if (p && R.phase === 'end') toLobby(R); });

  socket.on('chat', (t) => {
    const { R, p } = C(); const m = R && R.meeting;
    if (!p || R.phase !== 'meeting' || !m || m.mode === 'result' || !p.alive || p.late) return;
    const now = Date.now();
    if (now - p.lastChat < 300) return;
    p.lastChat = now;
    const text = String(t || '').replace(/[<>]/g, '').trim().slice(0, 60);
    if (text) rEmit(R, 'chat', { n: p.name, c: p.color, t: text });
  });
  socket.on('vote', (target) => {
    const { R, p } = C(); const m = R && R.meeting;
    if (!p || R.phase !== 'meeting' || !m || m.mode !== 'vote' || !p.alive || p.late || m.votes.has(p.id)) return;
    if (target !== 'skip') { const t = R.players.get(target); if (!t || t.late || !t.alive) return; }
    m.votes.set(p.id, target);
    io.to(p.id).emit('sfx', 'click');
  });

  socket.on('disconnect', () => {
    const { R, p } = C();
    sockRoom.delete(socket.id);
    if (!p) return;
    R.players.delete(socket.id);
    if (R.meeting) R.meeting.votes.delete(socket.id);
    if (R.players.size === 0) { rooms.delete(R.code); return; }
    if (R.phase === 'playing' || R.phase === 'meeting') {
      if (participants(R).length === 0) { toLobby(R); return; }
      if (R.phase === 'playing') checkWin(R);
    }
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`Destroy or Avoid v5 running on :${PORT}`));
module.exports = { genMap };

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

// ===== 宇宙船レイアウト（Among Us / The Skeld 風・左右非対称の手設計） =====
// 座標はセル単位 (COLS=64 x ROWS=40)。th は index.html の THEMES のインデックス。
// 0エンジン 1貯蔵庫 2医務室 3操舵室 4食堂(=中央ホール) 5ラボ 6電気室 7格納庫 8居住区 9通信室 10酸素室 11武器庫
const ROOMS = {
  hall:    { x: 26, y: 2,  w: 13, h: 10, th: 4 },  // 中央ホール(緊急会議ボタン) ※上寄り・中心から外す
  engine:  { x: 2,  y: 2,  w: 10, h: 7,  th: 0 },  // 左上エンジン
  reactor: { x: 2,  y: 15, w: 8,  h: 9,  th: 11 }, // 左端・武器庫(リアクター枠)
  hangar:  { x: 3,  y: 29, w: 10, h: 8,  th: 7 },  // 左下・格納庫
  medbay:  { x: 16, y: 10, w: 8,  h: 7,  th: 2 },  // 医務室 (基本は行き止まり)
  security:{ x: 13, y: 19, w: 6,  h: 5,  th: 8 },  // 居住区 (小部屋・行き止まり)
  electric:{ x: 18, y: 25, w: 9,  h: 8,  th: 6 },  // 電気室 (入口1つの袋小路＝キルスポット)
  storage: { x: 29, y: 24, w: 11, h: 11, th: 1 },  // 貯蔵庫 (大部屋・下中央)
  lab:     { x: 40, y: 14, w: 9,  h: 7,  th: 5 },  // ラボ (アドミン枠)
  oxygen:  { x: 44, y: 3,  w: 7,  h: 6,  th: 10 }, // 酸素室
  nav:     { x: 55, y: 12, w: 7,  h: 11, th: 3 },  // 操舵室 (右端に突き出す)
  comms:   { x: 45, y: 29, w: 9,  h: 7,  th: 9 },  // 通信室
};

// 幅3の通路。セル中心のウェイポイント列 (直角で折れる)
const CORRIDORS = [
  [[26, 5], [11, 5]],                         // ホール ⇔ エンジン (上の長廊下)
  [[19, 5], [19, 10]],                        // 上の長廊下 → 医務室 (枝)
  [[6, 8], [6, 15]],                          // エンジン ⇔ 武器庫
  [[5, 23], [5, 29]],                         // 武器庫 ⇔ 格納庫
  [[9, 20], [13, 20]],                        // 武器庫 → 居住区 (袋小路)
  [[12, 34], [29, 34]],                       // 格納庫 ⇔ 貯蔵庫 (下の長廊下)
  [[22, 32], [22, 34]],                       // 下の長廊下 → 電気室 (唯一の入口)
  [[33, 11], [33, 24]],                       // ホール ⇔ 貯蔵庫 (中央スパイン)
  [[33, 17], [40, 17]],                       // スパイン → ラボ (枝)
  [[38, 6], [44, 6]],                         // ホール ⇔ 酸素室
  [[50, 5], [58, 5], [58, 12]],               // 酸素室 ⇔ 操舵室 (L字)
  [[58, 22], [58, 32], [53, 32]],             // 操舵室 ⇔ 通信室 (L字)
  [[45, 32], [39, 32]],                       // 通信室 ⇔ 貯蔵庫
];

// 毎試合ランダムで一部だけ開通する抜け道 (迂回路・逃走ルートのバリエーション)
const OPTIONAL_CORRIDORS = [
  [[21, 16], [21, 25]],                       // 医務室 ⇔ 電気室
  [[48, 18], [55, 18]],                       // ラボ ⇔ 操舵室
  [[16, 16], [16, 19]],                       // 医務室 ⇔ 居住区
  [[46, 20], [46, 29]],                       // ラボ ⇔ 通信室
  [[9, 16], [14, 16], [14, 14], [16, 14]],    // 武器庫 ⇔ 医務室 (クランク)
  [[39, 27], [44, 27], [44, 22]],             // 貯蔵庫 ⇔ ラボ (裏道)
];

// 固定の柱・仕切り壁 [x, y, w, h]。部屋を「ただの箱」にしない
const PILLARS = [
  [33, 27, 1, 4],   // 貯蔵庫の中仕切り (左右に回り込める)
  [36, 30, 2, 2],   // 貯蔵庫のコンテナ
  [6, 18, 2, 2],    // 武器庫の炉心
  [57, 16, 2, 1],   // 操舵室のコンソール
  [21, 28, 1, 3],   // 電気室の配電盤 (死角を作る)
  [28, 9, 1, 2], [37, 9, 1, 2], // ホールのテーブル脚
];

// タスク/供給所を置く優先部屋 (部屋内の具体位置はシードでランダム)
const TASK_ROOMS = {
  stations: { fuse: 'electric', battery: 'hangar', core: 'reactor' },
  1: 'nav', 2: 'lab', 3: 'oxygen', 4: 'engine', 5: 'storage', 6: 'electric', 7: 'comms', 8: 'security',
  9: 'medbay', 10: 'engine', 11: 'oxygen', 12: 'storage', 13: 'reactor', 14: 'comms', 15: 'nav',
};

function genMap() {
  const seed = Math.floor(Math.random() * 2147483647);
  const rng = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  // 毎試合 左右/上下反転をランダム適用 (非対称なので反転すると別マップとして遊べる)
  const fx = rng() < 0.5, fy = rng() < 0.5;
  const tc = c => fx ? COLS - 1 - c : c, tr = r => fy ? ROWS - 1 - r : r;
  const trect = ([x, y, w, h]) => [fx ? COLS - x - w : x, fy ? ROWS - y - h : y, w, h];

  const g = Array.from({ length: ROWS }, () => Array(COLS).fill(true));
  const wall = (c, r) => c < 0 || r < 0 || c >= COLS || r >= ROWS || g[r][c];
  const carve = (c0, r0, c1, r1) => {
    for (let r = Math.max(1, Math.min(r0, r1)); r <= Math.min(ROWS - 2, Math.max(r0, r1)); r++)
      for (let c = Math.max(1, Math.min(c0, c1)); c <= Math.min(COLS - 2, Math.max(c0, c1)); c++) g[r][c] = false;
  };
  const carvePath = (pts) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = [tc(pts[i][0]), tr(pts[i][1])], b = [tc(pts[i + 1][0]), tr(pts[i + 1][1])];
      carve(a[0] - 1, a[1] - 1, b[0] + 1, b[1] + 1);
    }
  };

  // 部屋 (サイズを ±1 セル揺らして毎回少し違う形に)
  const R = {};
  for (const key in ROOMS) {
    const o = ROOMS[key];
    const jx = key === 'hall' ? 0 : ri(-1, 0), jw = key === 'hall' ? 0 : ri(0, 1);
    const jy = key === 'hall' ? 0 : ri(-1, 0), jh = key === 'hall' ? 0 : ri(0, 1);
    const [x, y, w, h] = trect([o.x + jx, o.y + jy, o.w + jw - jx, o.h + jh - jy]);
    R[key] = { key, x, y, w, h, th: o.th };
    carve(x, y, x + w - 1, y + h - 1);
  }
  for (const p of CORRIDORS) carvePath(p);
  // 抜け道は 2〜4 本をランダムに開通
  const opt = OPTIONAL_CORRIDORS.slice().sort(() => rng() - 0.5).slice(0, ri(2, 4));
  for (const p of opt) carvePath(p);

  // 柱・仕切り
  for (const pr of PILLARS) {
    const [x, y, w, h] = trect(pr);
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (r > 0 && c > 0 && r < ROWS - 1 && c < COLS - 1) g[r][c] = true;
  }
  // 大部屋にランダムな木箱 (1x1) を少し
  for (const key of ['storage', 'engine', 'hangar', 'comms']) {
    const rm = R[key];
    for (let n = ri(0, 2); n > 0; n--) {
      const c = ri(rm.x + 2, rm.x + rm.w - 3), r = ri(rm.y + 2, rm.y + rm.h - 3);
      g[r][c] = true;
    }
  }

  const hall = R.hall;
  const bc = { c: hall.x + (hall.w >> 1), r: hall.y + (hall.h >> 1) };
  // 会議ルーム中央のクリアゾーン (ボタンとスポーンリング用)
  for (let r = hall.y; r < hall.y + hall.h; r++) for (let c = hall.x; c < hall.x + hall.w; c++)
    if (Math.hypot(c - bc.c, r - bc.r) <= 3.4) g[r][c] = false;

  // 斜め接触(角だけで接する壁)の除去。※柱や1マス幅の仕切りを侵食しないよう、突起削りは行わない
  for (let it = 0; it < 4; it++) {
    let changed = false;
    for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS - 1; c++) {
      const a = wall(c, r), b = wall(c + 1, r), d = wall(c, r + 1), e = wall(c + 1, r + 1);
      let tr2 = -1, tc2 = -1;
      if (a && e && !b && !d) { tr2 = r; tc2 = c; } else if (b && d && !a && !e) { tr2 = r; tc2 = c + 1; }
      if (tr2 >= 1 && tc2 >= 1 && tr2 < ROWS - 1 && tc2 < COLS - 1) { g[tr2][tc2] = false; changed = true; }
    }
    if (!changed) break;
  }

  // 到達性チェック: 会議ルームから行けない空間は壁で埋める (スタック防止)
  const flood = () => {
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
    return reach;
  };
  let reach = flood();
  // 万一ある部屋が孤立したら、その部屋からホールへ直線通路を掘って救済
  for (const key in R) {
    const rm = R[key], cc = rm.x + (rm.w >> 1), cr = rm.y + (rm.h >> 1);
    let ok = false;
    for (let r = rm.y; r < rm.y + rm.h && !ok; r++) for (let c = rm.x; c < rm.x + rm.w; c++) if (reach.has(r * COLS + c)) { ok = true; break; }
    if (!ok) { carve(cc - 1, cr - 1, bc.c + 1, cr + 1); carve(bc.c - 1, cr - 1, bc.c + 1, bc.r + 1); reach = flood(); }
  }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!g[r][c] && !reach.has(r * COLS + c)) g[r][c] = true;

  // 設備配置: 指定部屋の中で 3x3 が空いている到達可能セル。設備同士は離す
  const open3 = (c, r) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (wall(c + dc, r + dr)) return false; return true; };
  const used = [];
  const okCell = (c, r, minD) => reach.has(r * COLS + c) && open3(c, r) && Math.hypot(c - bc.c, r - bc.r) >= 5 && !used.some(u => Math.hypot(u.c - c, u.r - r) < minD);
  const roomList = Object.values(R).filter(r => r !== hall);
  function spot(prefKey) {
    const tryRoom = (rm, minD, tries) => {
      for (let t = 0; t < tries; t++) {
        const c = ri(rm.x + 1, rm.x + rm.w - 2), r = ri(rm.y + 1, rm.y + rm.h - 2);
        if (okCell(c, r, minD)) { used.push({ c, r }); return cp(c, r); }
      }
      return null;
    };
    const pref = R[prefKey];
    for (const minD of [4, 3, 2.5]) { const p = pref && tryRoom(pref, minD, 200); if (p) return p; }
    for (const minD of [5, 3]) for (const rm of roomList.slice().sort(() => rng() - 0.5)) { const p = tryRoom(rm, minD, 60); if (p) return p; }
    for (const idx of reach) {
      const c = idx % COLS, r = (idx / COLS) | 0;
      if (okCell(c, r, 1)) { used.push({ c, r }); return cp(c, r); }
    }
    return cp(bc.c + 4, bc.r);
  }
  const stations = {};
  for (const it in TASK_ROOMS.stations) stations[it] = spot(TASK_ROOMS.stations[it]);
  const tasks = {};
  for (const d of TASK_DEFS) tasks[d.id] = spot(TASK_ROOMS[d.id]);

  return {
    seed, grid: g, rows: g.map(row => row.map(v => (v ? '1' : '0')).join('')),
    rooms: Object.values(R).map(r => [r.x, r.y, r.w, r.h, r.th]),
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

if (require.main === module) server.listen(PORT, () => console.log(`Destroy or Avoid v7.1 running on :${PORT}`));
module.exports = { genMap };

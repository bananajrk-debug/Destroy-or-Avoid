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
// マップ: ブロック配置による固定の宇宙船 (41 x 27)。部屋・通路・柱・斜めブロックで構成
const CELL = 50, COLS = 41, ROWS = 27;
const W = COLS * CELL, H = ROWS * CELL;
const CX = (COLS - 1) / 2, CY = (ROWS - 1) / 2;  // 中央セル (20, 13) = カフェテリアの中心 (緊急会議ボタン)
const GHOST_MULT = 1.5;                          // 幽霊の移動速度倍率 (壁も通り抜け可能)
const TICK_RATE = 30;
const GAME_MS = 10 * 60 * 1000;
const SPEED = 230, SPEED_CORE = 130, PR = 16, REACH = 70;
const SLOT_MAX = 3, MIN_PLAYERS = 2, MAX_PLAYERS = 10, MAX_IMPOSTERS = 3;
const KILL_RANGE = 95, REPORT_RANGE = 110, BTN_RANGE = 90;
const KILL_CD = 20000, FIRST_KILL_CD = 15000, SAB_CD = 45000, SAB_PCT = 5;
const BTN_LOCK = 10000;
const DISCUSS_MS = 20000, VOTE_MS = 30000, END_AUTO_MS = 25000;
const RESULT_EJ_MS = 9500;   // 追放あり: 票の集計表示(約3秒) + 宇宙追放アニメ(約6秒)
const RESULT_NO_MS = 4500;   // 追放なし
const REVEAL_MS = 5800;      // ロール発表アニメの長さ (この間は全員停止・タイマー停止)
const KILL_FX_MS = 2000;     // キル演出の長さ (加害者・被害者のみ停止)
const ACTIVE_TASKS = 3, ACTION_MIN = 60;
const MIN_MINI = { weld: 6000, seq: 700, alt: 1200, space: 800 }; // ミニゲーム最短受理時間
const MINI_TIMEOUT = 90000;

const cp = (c, r) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 });
const ITEM_NAME = { fuse: 'ヒューズ', battery: 'バッテリー', core: 'プラズマコア' };
const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f783ac', '#a9e34b', '#c08457'];
// 頭の上のアクセサリー
const ACCS = ['none', 'duck', 'poop', 'crown', 'halo', 'tophat', 'sprout'];

// ---------- タスクプール（全15個。固定の宇宙船マップ上の決まった場所） ----------
// kind: carry(運搬) / weld(溶接) / seq(数字順押し) / alt(K/O交互連打) / space(SPACE連打)
// goal: 画面右側の「次にやること」リストに出す簡潔な目標文
const TASK_BASE = [
  { id: 1,  name: 'プラズマコアの搬入',   goal: 'プラズマコアを運ぶ',     pct: 20, kind: 'carry', item: 'core',    icon: '⚛️' },
  { id: 2,  name: 'ヒューズの装着',       goal: 'ヒューズを運ぶ',         pct: 10, kind: 'carry', item: 'fuse',    icon: '🔌' },
  { id: 3,  name: '予備バッテリーの装着', goal: 'バッテリーを運ぶ',       pct: 10, kind: 'carry', item: 'battery', icon: '🔋' },
  { id: 4,  name: '外壁フレーム溶接',     goal: '外壁フレームを溶接する', pct: 10, kind: 'weld',  icon: '🔥' },
  { id: 5,  name: '駆動アームの溶接',     goal: '駆動アームを溶接する',   pct: 10, kind: 'weld',  icon: '🦾' },
  { id: 6,  name: '配電盤の番号入力',     goal: '配電盤の番号を入力する', pct: 5,  kind: 'seq',   icon: '🔢' },
  { id: 7,  name: 'パスコード入力',       goal: 'パスコードを入力する',   pct: 5,  kind: 'seq',   icon: '🔐' },
  { id: 8,  name: 'コンテナ番号の照合',   goal: 'コンテナ番号を照合する', pct: 5,  kind: 'seq',   icon: '📦' },
  { id: 9,  name: '冷却ファンの回転',     goal: '冷却ファンを回す',       pct: 5,  kind: 'alt',   n: 20, icon: '🌀' },
  { id: 10, name: '発電機のクランク',     goal: '発電機を回す',           pct: 10, kind: 'alt',   n: 30, icon: '⚙️' },
  { id: 11, name: 'ポンプの加圧',         goal: 'ポンプを加圧する',       pct: 5,  kind: 'alt',   n: 16, icon: '🛢️' },
  { id: 12, name: '配線の張り替え',       goal: '配線を張り替える',       pct: 5,  kind: 'space', n: 6,  icon: '🧵' },
  { id: 13, name: 'バルブの調整',         goal: 'バルブを調整する',       pct: 5,  kind: 'space', n: 8,  icon: '🎛️' },
  { id: 14, name: 'アンテナの調整',       goal: 'アンテナを調整する',     pct: 5,  kind: 'space', n: 6,  icon: '📡' },
  { id: 15, name: '点火システムの調整',   goal: '点火システムを調整する', pct: 5,  kind: 'space', n: 10, icon: '🚀' },
];

// ---------- 乱数ユーティリティ ----------
const rand = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- 宇宙船マップ (ブロック配置による固定マップ) ----------
// grid[r][c]: false=床 / true=壁ブロック / 'A''B''C''D'=斜めブロック(三角形の壁)
//   A=左上が壁 / B=右上が壁 / C=左下が壁 / D=右下が壁 (斜辺の反対側が床)
// 各部屋の四隅は斜めブロックで面取りされる。中央のカフェテリア中心(3x3)は絶対に壁を置かない。
const ROOMS = [ // [c0, r0, c1, r1]
  { n: 'ブリッジ',         r: [16, 2, 24, 5] },
  { n: 'ナビゲーション',   r: [2, 2, 9, 6] },
  { n: '通信室',           r: [31, 2, 38, 6] },
  { n: 'エンジンルーム',   r: [2, 9, 9, 17] },
  { n: 'カフェテリア',     r: [14, 9, 26, 17] },
  { n: 'リアクター',       r: [31, 9, 38, 17] },
  { n: '医務室',           r: [2, 20, 9, 24] },
  { n: '貨物室',           r: [16, 21, 24, 24] },
  { n: '兵器室',           r: [31, 20, 38, 24] },
];
const CORRIDORS = [
  [19, 6, 21, 8], [19, 18, 21, 20], [10, 12, 13, 14], [27, 12, 30, 14],   // カフェテリアから四方へ
  [4, 7, 6, 8], [33, 7, 35, 8], [4, 18, 6, 19], [33, 18, 35, 19],         // 左右の縦通路
  [10, 3, 15, 5], [25, 3, 30, 5], [10, 21, 15, 23], [25, 21, 30, 23],     // 上下の横通路
];
const PILLARS = [ // 柱・テーブルなどの壁ブロック
  [17, 11, 17, 11], [23, 11, 23, 11], [17, 15, 17, 15], [23, 15, 23, 15], // カフェテリアのテーブル
  [4, 12, 5, 14], [35, 12, 36, 14],                                        // エンジン / リアクターの機械
];
const TASK_POS = { 1: [36, 11], 2: [4, 4], 3: [36, 4], 4: [18, 23], 5: [3, 11], 6: [18, 4], 7: [22, 4], 8: [22, 23],
  9: [34, 16], 10: [7, 16], 11: [4, 22], 12: [15, 14], 13: [25, 11], 14: [12, 4], 15: [36, 22] };
const STATION_POS = { core: [7, 10], fuse: [32, 10], battery: [8, 21] };

const roomName = (c, r) => { const o = ROOMS.find(o => c >= o.r[0] && c <= o.r[2] && r >= o.r[1] && r <= o.r[3]); return o ? o.n : '通路'; };

function buildShip() {
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(true));
  const carve = (c0, r0, c1, r1, v = false) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r][c] = v; };
  ROOMS.forEach(o => carve(...o.r));
  CORRIDORS.forEach(r => carve(...r));
  ROOMS.forEach(o => { const [c0, r0, c1, r1] = o.r; grid[r0][c0] = 'A'; grid[r0][c1] = 'B'; grid[r1][c0] = 'C'; grid[r1][c1] = 'D'; });
  PILLARS.forEach(r => carve(...r, true));
  const button = cp(CX, CY);
  const stations = {}, stationLoc = {};
  for (const k in STATION_POS) { stations[k] = cp(...STATION_POS[k]); stationLoc[k] = roomName(...STATION_POS[k]); }
  const taskDefs = TASK_BASE.map(d => ({ ...d, ...cp(...TASK_POS[d.id]), loc: roomName(...TASK_POS[d.id]) }));
  // 検証: 中央3x3が床 / 設備が床 / 全設備がボタンから到達可能
  for (let r = CY - 1; r <= CY + 1; r++) for (let c = CX - 1; c <= CX + 1; c++) if (grid[r][c] !== false) throw new Error('center must be open');
  const seen = new Set([CY * COLS + CX]), q = [[CX, CY]];
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS || grid[nr][nc] !== false || seen.has(nr * COLS + nc)) continue;
      seen.add(nr * COLS + nc); q.push([nc, nr]);
    }
  }
  for (const d of [...taskDefs, ...Object.values(stations)]) {
    const c = Math.floor(d.x / CELL), r = Math.floor(d.y / CELL);
    if (grid[r][c] !== false || !seen.has(r * COLS + c)) throw new Error('unreachable facility at ' + c + ',' + r);
  }
  return { grid, button, stations, stationLoc, taskDefs };
}
const SHIP = buildShip();

function applyLayout(room) {
  room.grid = SHIP.grid;
  room.rows = SHIP.grid.map(row => row.map(v => (v === true ? '1' : v === false ? '0' : v)).join(''));
  room.button = SHIP.button;
  room.stations = SHIP.stations;
  room.stationLoc = SHIP.stationLoc;
  room.taskDefs = SHIP.taskDefs;
}

const cellAt = (room, c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : room.grid[r][c];
const defOf = (room, id) => room.taskDefs.find(d => d.id === id);

function mapPayload(room) {
  return {
    W, H, CELL, rows: room.rows, BUTTON: room.button, STATIONS: room.stations, SLOC: room.stationLoc,
    TASKS: room.taskDefs.map(d => ({ id: d.id, name: d.name, goal: d.goal, loc: d.loc, pct: d.pct, kind: d.kind, item: d.item || null, n: d.n || 0, icon: d.icon, x: d.x, y: d.y })),
  };
}

// 斜めブロックの三角形頂点
function triPts(t, x, y) {
  const X = x + CELL, Y = y + CELL;
  if (t === 'A') return [[x, y], [X, y], [x, Y]];
  if (t === 'B') return [[x, y], [X, y], [X, Y]];
  if (t === 'C') return [[x, y], [x, Y], [X, Y]];
  return [[X, y], [X, Y], [x, Y]];
}
// 円(プレイヤー) vs 三角形 の押し出し
function pushTri(p, pts) {
  const gx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, gy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
  let bd = Infinity, bq = null, be = null, neg = 0, pos = 0;
  for (let i = 0; i < 3; i++) {
    const a = pts[i], b = pts[(i + 1) % 3];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const t = clamp(((p.x - a[0]) * ex + (p.y - a[1]) * ey) / (ex * ex + ey * ey), 0, 1);
    const qx = a[0] + ex * t, qy = a[1] + ey * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bd) { bd = d; bq = [qx, qy]; be = [ex, ey]; }
    const cr = ex * (p.y - a[1]) - ey * (p.x - a[0]);
    if (cr < 0) neg++; else pos++;
  }
  const inside = neg === 0 || pos === 0;
  if (inside) { // 三角形の中にめり込んだ: 最寄りの辺から外へ押し出す
    let nx = be[1], ny = -be[0];
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    if (nx * (bq[0] - gx) + ny * (bq[1] - gy) < 0) { nx = -nx; ny = -ny; }
    p.x = bq[0] + nx * PR; p.y = bq[1] + ny * PR;
    return true;
  }
  if (bd >= PR) return false;
  if (bd > 1e-6) { p.x = bq[0] + (p.x - bq[0]) / bd * PR; p.y = bq[1] + (p.y - bq[1]) / bd * PR; }
  return true;
}

// 円(プレイヤー) vs 壁セル(矩形 / 斜めブロック) の押し出し (生存者のみ。幽霊は呼ばれない)
function resolveWalls(room, p) {
  for (let it = 0; it < 4; it++) {
    let moved = false;
    const c0 = Math.floor((p.x - PR) / CELL), c1 = Math.floor((p.x + PR) / CELL);
    const r0 = Math.floor((p.y - PR) / CELL), r1 = Math.floor((p.y + PR) / CELL);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const v = cellAt(room, c, r);
        if (v === false) continue;
        const rx = c * CELL, ry = r * CELL;
        if (v !== true) { if (pushTri(p, triPts(v, rx, ry))) moved = true; continue; }
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

// ---------- ルーム管理 ----------
const rooms = new Map();

function newCode() {
  for (;;) {
    const c = String(10000 + rand(90000));
    if (!rooms.has(c)) return c;
  }
}

function createRoom() {
  const room = {
    code: newCode(),
    players: new Map(),
    joinCounter: 0,
    impCount: 1,
    game: {
      phase: 'lobby', // lobby | playing | meeting | end
      endsAt: 0, remainAtEnd: GAME_MS, endedAt: 0,
      progress: 0, result: null,
      bodies: [], nextBody: 1, meeting: null, noMeetingUntil: 0,
    },
  };
  applyLayout(room);
  rooms.set(room.code, room);
  return room;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (p, pos, r) => dist(p, pos) <= r;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toast = (p, text, kind) => io.to(p.id).emit('toast', { text, kind: kind || 'info' });
const emitRoom = (room, ev, data) => io.to(room.code).emit(ev, data);
const participants = (room) => [...room.players.values()].filter(p => !p.late);
const hostId = (room) => { let h = null; for (const p of room.players.values()) if (!h || p.joinOrder < h.joinOrder) h = p; return h ? h.id : null; };
const impMax = (n) => Math.max(1, Math.min(MAX_IMPOSTERS, Math.floor((n - 1) / 2)));
const brief = (p) => ({ id: p.id, name: p.name, c: p.color, ac: p.acc });
const frozen = (p, now) => now < (p.frozenUntil || 0);

const hasItem = (p, t) => p.slots.some(s => s.t === t);
const removeItem = (p, t) => { if (!hasItem(p, t)) return false; p.slots = p.slots.filter(s => s.t !== t); return true; };
function cancelMini(p) { if (p.mini) { p.mini = null; io.to(p.id).emit('miniCancel'); } }

function ringPos(room, i, n, rad) {
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  return { x: room.button.x + Math.cos(a) * rad, y: room.button.y + Math.sin(a) * rad };
}
const RING = 90; // 広場(7x5)の内側に収まる半径

// ---------- タスク割り当て ----------
function newTask(room, p) {
  let pool = room.taskDefs.filter(t => !p.tasks.includes(t.id) && !p.doneTasks.has(t.id));
  if (!pool.length) { p.doneTasks.clear(); pool = room.taskDefs.filter(t => !p.tasks.includes(t.id)); }
  return pool[rand(pool.length)].id;
}
function fillTasks(room, p) { while (p.tasks.length < ACTIVE_TASKS) p.tasks.push(newTask(room, p)); }

function completeTask(room, p, id) {
  const g = room.game;
  const d = defOf(room, id);
  const idx = p.tasks.indexOf(id);
  if (!d || idx < 0) return;
  p.tasks.splice(idx, 1);
  p.doneTasks.add(id);
  fillTasks(room, p);
  io.to(p.id).emit('sfx', 'done');
  // クルーもインポスターも同じように全体進捗を進める
  const k = clamp(4 / Math.max(1, participants(room).length), 0.5, 1.5);
  const add = d.pct * k;
  g.progress = Math.min(100, g.progress + add);
  toast(p, `${d.name} 完了! 進捗 +${add.toFixed(1)}%`, 'good');
  checkWin(room, false);
}

// ---------- 開始・終了 ----------
function resetPlayer(room, p, i, n) {
  const pos = ringPos(room, i, n, RING);
  p.x = pos.x; p.y = pos.y;
  p.alive = true; p.slots = []; p.mini = null; p.input = { x: 0, y: 0 };
  p.tasks = []; p.doneTasks = new Set(); p.moving = false;
  p.emUsed = false; p.frozenUntil = 0;
}

function startGame(room) {
  const g = room.game;
  const part = participants(room);
  if (part.length < MIN_PLAYERS) return;
  const now = Date.now();
  const start = now + REVEAL_MS;           // ロール発表アニメが終わるまで全員停止・タイマー停止
  applyLayout(room);                       // 固定の宇宙船マップを適用 (クライアントへ再送)
  emitRoom(room, 'map', mapPayload(room));
  g.phase = 'playing';
  g.progress = 0; g.result = null; g.bodies = []; g.meeting = null;
  g.endsAt = start + GAME_MS;
  g.noMeetingUntil = start + BTN_LOCK;
  const nImp = Math.min(room.impCount, impMax(part.length));
  const imps = new Set(shuffle([...part]).slice(0, nImp));
  part.forEach((p, i) => {
    resetPlayer(room, p, i, part.length);
    p.role = imps.has(p) ? 'imposter' : 'crew';
    p.killReady = start + FIRST_KILL_CD;
    p.sabReady = start + 30000;
    p.frozenUntil = start;
    fillTasks(room, p);
  });
  const impList = part.filter(p => p.role === 'imposter');
  for (const p of part) {
    io.to(p.id).emit('roleReveal', {
      role: p.role, me: brief(p), nImp: impList.length, nPlayers: part.length, ms: REVEAL_MS,
      team: p.role === 'imposter' ? impList.filter(x => x !== p).map(brief) : [],
    });
  }
  emitRoom(room, 'sfx', 'start');
}

function endGame(room, winner, reason) {
  const g = room.game;
  if (g.phase === 'end' || g.phase === 'lobby') return true;
  const now = Date.now();
  g.remainAtEnd = Math.max(0, Math.min(GAME_MS, g.endsAt - (g.meeting ? g.meeting.startAt : now)));
  g.phase = 'end';
  g.meeting = null;
  g.endedAt = now;
  g.result = { winner, reason };
  for (const p of room.players.values()) { cancelMini(p); p.input = { x: 0, y: 0 }; p.moving = false; p.frozenUntil = 0; }
  emitRoom(room, 'sfx', winner === 'crew' ? 'win' : 'lose');
  return true;
}

function toLobby(room) {
  const g = room.game;
  g.phase = 'lobby'; g.meeting = null; g.bodies = []; g.result = null;
  g.remainAtEnd = GAME_MS; g.progress = 0;
  for (const p of room.players.values()) {
    p.late = false; p.ready = false; p.role = null; p.alive = true; p.frozenUntil = 0;
    p.slots = []; p.tasks = []; p.mini = null; p.input = { x: 0, y: 0 }; p.moving = false;
  }
}

// full=false のときは進捗100%のみ判定 (タスク完了時に人数勝敗を誤判定しないため)
function checkWin(room, full = true) {
  const g = room.game;
  if (g.phase !== 'playing') return false;
  const part = participants(room);
  const imps = part.filter(p => p.role === 'imposter' && p.alive).length;
  const crews = part.filter(p => p.role === 'crew' && p.alive).length;
  if (g.progress >= 100) return endGame(room, 'crew', '全タスクが完了した! 進捗100%');
  if (!full) return false;
  if (imps === 0) return endGame(room, 'crew', 'インポスターを全員排除した!');
  if (crews <= imps) return endGame(room, 'imposter', 'クルーが全滅した…');
  return false;
}

// ---------- 会議 ----------
function startMeeting(room, caller, reason) {
  const g = room.game;
  const now = Date.now();
  g.phase = 'meeting';
  g.meeting = { mode: 'discuss', startAt: now, modeEnds: now + DISCUSS_MS, votes: new Map(), reason, callerName: caller.name, result: null, dur: 0 };
  if (reason === 'button') caller.emUsed = true;
  const part = participants(room);
  part.forEach((p, i) => {
    cancelMini(p); p.input = { x: 0, y: 0 }; p.moving = false; p.frozenUntil = 0;
    const pos = ringPos(room, i, part.length, RING);
    p.x = pos.x; p.y = pos.y;
  });
  emitRoom(room, 'sfx', 'meeting');
}

function resolveVotes(room, now) {
  const m = room.game.meeting;
  const counts = {};
  let skip = 0;
  for (const [vid, t] of m.votes) {
    if (!room.players.has(vid)) continue;
    if (t === 'skip') skip++; else counts[t] = (counts[t] || 0) + 1;
  }
  let max = 0, top = [];
  for (const id in counts) {
    if (counts[id] > max) { max = counts[id]; top = [id]; }
    else if (counts[id] === max) top.push(id);
  }
  let ej = null;
  if (top.length === 1 && max > skip) {
    const t = room.players.get(top[0]);
    if (t) {
      t.alive = false; cancelMini(t);
      const left = participants(room).filter(x => x.alive && x.role === 'imposter').length;
      ej = { id: t.id, name: t.name, c: t.color, ac: t.acc, imp: t.role === 'imposter', left };
    }
  }
  m.result = { ej, tally: Object.entries(counts), skip };
  m.mode = 'result';
  m.dur = ej ? RESULT_EJ_MS : RESULT_NO_MS;
  m.modeEnds = now + m.dur;
}

function endMeeting(room, now) {
  const g = room.game, m = g.meeting;
  g.endsAt += now - m.startAt; // 会議中は制限時間を止める
  g.phase = 'playing';
  g.meeting = null;
  g.bodies = [];
  g.noMeetingUntil = now + BTN_LOCK;
  for (const p of participants(room)) if (p.role === 'imposter') p.killReady = Math.max(p.killReady, now + 10000);
  checkWin(room, true);
}

function tickMeeting(room, now) {
  const g = room.game, m = g.meeting;
  if (!m) { g.phase = 'playing'; return; }
  if (m.mode === 'discuss') {
    if (now >= m.modeEnds) { m.mode = 'vote'; m.modeEnds = now + VOTE_MS; }
  } else if (m.mode === 'vote') {
    const voters = participants(room).filter(p => p.alive);
    if (now >= m.modeEnds || voters.every(p => m.votes.has(p.id))) resolveVotes(room, now);
  } else if (m.mode === 'result') {
    if (now >= m.modeEnds) endMeeting(room, now);
  }
}

// ---------- アクション ----------
// 注: 幽霊(alive=false)でも供給所での取得・スロット保持・運搬設置・ミニゲーム完了が可能 (緊急会議ボタンのみ生存者限定)
function doAction(room, p) {
  const g = room.game;
  if (g.phase !== 'playing' || p.late || p.mini) return;
  const now = Date.now();
  if (frozen(p, now)) return;
  if (now - p.lastAct < ACTION_MIN) return;
  p.lastAct = now;

  // 1) 自分のタスク拠点
  for (const id of p.tasks) {
    const d = defOf(room, id);
    if (!near(p, d, REACH)) continue;
    if (d.kind === 'carry') {
      if (!hasItem(p, d.item)) { toast(p, `${ITEM_NAME[d.item]}が必要! (運搬してこよう)`, 'error'); return; }
      removeItem(p, d.item);
      completeTask(room, p, id);
      return;
    }
    p.mini = { taskId: id, kind: d.kind, start: now };
    p.input = { x: 0, y: 0 }; p.moving = false;
    const payload = { taskId: id };
    if (d.kind === 'seq') {
      // 毎回ランダムな5〜6個の数字列 (サーバーが生成)
      const len = 5 + rand(2);
      payload.seq = Array.from({ length: len }, () => rand(10));
      p.mini.seq = payload.seq;
    }
    io.to(p.id).emit('miniStart', payload);
    return;
  }

  // 2) 運搬アイテムの供給所
  for (const id of p.tasks) {
    const d = defOf(room, id);
    if (d.kind !== 'carry' || !near(p, room.stations[d.item], REACH)) continue;
    if (hasItem(p, d.item)) { toast(p, 'すでに持っている', 'error'); return; }
    const need = d.item === 'core' ? 2 : 1;
    if (p.slots.length + need > SLOT_MAX) { toast(p, 'スロットがいっぱい!', 'error'); return; }
    for (let i = 0; i < need; i++) p.slots.push({ t: d.item });
    toast(p, `${ITEM_NAME[d.item]}を取得`, 'info');
    io.to(p.id).emit('sfx', 'click');
    return;
  }

  // 3) 緊急会議ボタン
  if (near(p, room.button, BTN_RANGE)) {
    if (!p.alive) return;
    if (p.emUsed) { toast(p, '緊急会議は1人1回まで', 'error'); return; }
    if (now < g.noMeetingUntil) { toast(p, `まだ使えない (あと${Math.ceil((g.noMeetingUntil - now) / 1000)}秒)`, 'error'); return; }
    startMeeting(room, p, 'button');
  }
}

function doReport(room, p) {
  const g = room.game;
  if (g.phase !== 'playing' || p.late || !p.alive || frozen(p, Date.now())) return;
  const b = g.bodies.find(b => dist(p, b) <= REPORT_RANGE);
  if (!b) { toast(p, '近くに死体がない', 'error'); return; }
  startMeeting(room, p, 'body');
}

function doKill(room, p) {
  const g = room.game;
  if (g.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter') return;
  const now = Date.now();
  if (frozen(p, now) || now < p.killReady) return;
  let best = null, bd = KILL_RANGE;
  for (const v of participants(room)) {
    if (v === p || !v.alive || v.role === 'imposter') continue;
    const d = dist(p, v);
    if (d <= bd) { bd = d; best = v; }
  }
  if (!best) { toast(p, '範囲内にターゲットがいない', 'error'); return; }
  best.alive = false;
  cancelMini(best);
  best.input = { x: 0, y: 0 }; best.moving = false;
  g.bodies.push({ id: g.nextBody++, x: Math.round(best.x), y: Math.round(best.y), c: best.color, ac: best.acc });
  p.x = best.x; p.y = best.y;
  p.input = { x: 0, y: 0 }; p.moving = false;
  p.killReady = now + KILL_CD;
  // キル演出: 加害者と被害者だけに赤いカットインを再生 (その間は2人とも停止)
  p.frozenUntil = now + KILL_FX_MS;
  best.frozenUntil = now + KILL_FX_MS;
  const base = { killer: brief(p), victim: brief(best), ms: KILL_FX_MS };
  io.to(p.id).emit('killCut', { ...base, you: 'killer' });
  io.to(best.id).emit('killCut', { ...base, you: 'victim' });
  io.to(best.id).emit('toast', { text: 'あなたはキルされた… (霊としてタスクは続けられる)', kind: 'error' });
  checkWin(room, true);
}

function doSabotage(room, p) {
  const g = room.game;
  if (g.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter') return;
  const now = Date.now();
  if (frozen(p, now) || now < p.sabReady) return;
  p.sabReady = now + SAB_CD;
  g.progress = Math.max(0, g.progress - SAB_PCT);
  emitRoom(room, 'sfx', 'alarm');
  emitRoom(room, 'toast', { text: `⚠ 妨害工作! 進捗が${SAB_PCT}%低下`, kind: 'error' });
}

function doDiscard(room, p, idx) {
  if (room.game.phase !== 'playing' || p.mini) return;
  const now = Date.now();
  if (now - p.lastDisc < 150) return;
  p.lastDisc = now;
  const s = p.slots[idx | 0];
  if (!s) return;
  p.slots = p.slots.filter(x => x.t !== s.t);
  toast(p, `${ITEM_NAME[s.t]}を捨てた`, 'info');
}

// ---------- ゲームループ ----------
let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const room of rooms.values()) tickRoom(room, now, dt);
}

function tickRoom(room, now, dt) {
  const g = room.game;
  if (g.phase === 'playing') {
    for (const p of room.players.values()) {
      if (p.late) continue;
      if (p.mini && now - p.mini.start > MINI_TIMEOUT) cancelMini(p);
      if (frozen(p, now)) { p.moving = false; continue; } // 演出中は動けない
      if (p.mini) { p.moving = false; continue; }
      const len = Math.hypot(p.input.x, p.input.y);
      p.moving = len > 0;
      if (len > 0) {
        const dx = p.input.x / len, dy = p.input.y / len;
        const ghost = !p.alive;                       // 霊: 壁を通り抜け、移動速度1.5倍 (アイテム所持・運搬もOK)
        const sp = (hasItem(p, 'core') ? SPEED_CORE : SPEED) * (ghost ? GHOST_MULT : 1);
        p.x += dx * sp * dt;
        p.y += dy * sp * dt;
        if (!ghost) resolveWalls(room, p);
        p.x = clamp(p.x, PR, W - PR);
        p.y = clamp(p.y, PR, H - PR);
        if (dx !== 0) p.face = dx > 0 ? 1 : -1;
      }
    }
    if (now >= g.endsAt) endGame(room, 'imposter', '時間切れ… クルーは間に合わなかった');
  } else if (g.phase === 'meeting') {
    tickMeeting(room, now);
  } else if (g.phase === 'end') {
    if (now - g.endedAt > END_AUTO_MS) toLobby(room);
  }
  if (room.players.size > 0) broadcast(room, now);
}

function meetView(room, v, now, part) {
  const m = room.game.meeting;
  return {
    mode: m.mode, t: Math.max(0, m.modeEnds - now), dur: m.dur || 0, reason: m.reason, caller: m.callerName,
    roster: part.map(p => ({ id: p.id, name: p.name, c: p.color, ac: p.acc, a: p.alive, voted: m.votes.has(p.id) })),
    my: m.votes.get(v.id) || null,
    res: m.result,
  };
}

function broadcast(room, now) {
  const g = room.game;
  let remain = GAME_MS;
  if (g.phase === 'playing') remain = Math.min(GAME_MS, Math.max(0, g.endsAt - now));
  else if (g.phase === 'meeting') remain = Math.min(GAME_MS, Math.max(0, g.endsAt - g.meeting.startAt));
  else if (g.phase === 'end') remain = g.remainAtEnd;

  const part = participants(room);
  const host = hostId(room);
  const base = { code: room.code, ph: g.phase, remain, prog: Math.round(g.progress * 10) / 10, result: g.result };
  let lobby = null;
  if (g.phase === 'lobby') {
    lobby = [...room.players.values()].sort((a, b) => a.joinOrder - b.joinOrder)
      .map(p => ({ id: p.id, name: p.name, c: p.color, ac: p.acc, ready: p.ready, host: p.id === host }));
    const mx = impMax(room.players.size);
    base.cfg = { imp: Math.min(room.impCount, mx), impMax: mx };
  }
  const bodies = g.bodies;
  const playersView = g.phase === 'lobby' ? null : part.map(p => ({
    id: p.id, name: p.name, c: p.color, ac: p.acc, x: Math.round(p.x), y: Math.round(p.y), a: p.alive, mv: p.moving, f: p.face,
  }));
  const roleOf = new Map(part.map(p => [p.id, p.role]));

  for (const v of room.players.values()) {
    const ghost = !v.alive || v.late || g.phase === 'end';
    const msg = {
      ...base,
      me: {
        role: v.role, alive: v.alive, late: v.late, ready: v.ready, host: v.id === host,
        tasks: v.tasks, sl: v.slots.map(s => s.t),
        kcd: Math.max(0, (v.killReady || 0) - now), scd: Math.max(0, (v.sabReady || 0) - now),
        em: v.emUsed, emLock: Math.max(0, g.noMeetingUntil - now),
      },
    };
    if (lobby) msg.lobby = lobby;
    else {
      let list = ghost ? playersView : playersView.filter(p => p.a);
      // インポスター同士は仲間として識別できる
      if (v.role === 'imposter') list = list.map(p => (roleOf.get(p.id) === 'imposter' ? { ...p, i: 1 } : p));
      msg.players = list;
      msg.bodies = bodies;
      if (g.phase === 'meeting') msg.meet = meetView(room, v, now, part);
      if (g.phase === 'end') msg.roster = part.map(p => ({ id: p.id, name: p.name, c: p.color, ac: p.acc, role: p.role, a: p.alive }));
    }
    io.to(v.id).volatile.emit('state', msg);
  }
}

setInterval(tick, 1000 / TICK_RATE);

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.emit('init', { you: socket.id, REACH, SLOT_MAX, GAME_MS, ITEM_NAME, COLORS, ACCS });

  const R = () => rooms.get(socket.data.code);
  const P = () => { const r = R(); return r ? r.players.get(socket.id) : null; };

  function enter(room, d) {
    if (room.players.size >= MAX_PLAYERS) { socket.emit('joinError', 'ロビーが満員です (最大10人)'); return false; }
    room.joinCounter += 1;
    const used = new Set([...room.players.values()].map(p => p.color));
    const name = String((d && d.name) || '').replace(/[<>]/g, '').trim().slice(0, 10) || ('P' + room.joinCounter);
    let color = d && COLORS.includes(d.color) && !used.has(d.color) ? d.color : null;
    if (!color) color = COLORS.find(c => !used.has(c)) || COLORS[room.joinCounter % COLORS.length];
    const acc = d && ACCS.includes(d.acc) ? d.acc : 'none';
    const late = room.game.phase !== 'lobby';
    const p = {
      id: socket.id, num: room.joinCounter, joinOrder: room.joinCounter, name, color, acc,
      x: room.button.x, y: room.button.y + 100, face: 1, moving: false,
      ready: false, late, role: null, alive: !late,
      tasks: [], doneTasks: new Set(), slots: [], mini: null,
      input: { x: 0, y: 0 }, lastAct: 0, lastDisc: 0, lastChat: 0,
      killReady: 0, sabReady: 0, emUsed: false, frozenUntil: 0,
    };
    room.players.set(socket.id, p);
    socket.join(room.code);
    socket.data.code = room.code;
    socket.emit('joined', { code: room.code });
    socket.emit('map', mapPayload(room));
    return true;
  }

  socket.on('createLobby', (d) => {
    if (R()) return;
    const room = createRoom();
    if (!enter(room, d)) rooms.delete(room.code);
  });

  socket.on('joinLobby', (d) => {
    if (R()) return;
    const code = String((d && d.code) || '').trim();
    if (!/^\d{5}$/.test(code)) { socket.emit('joinError', '5桁の数字コードを入力してください'); return; }
    const room = rooms.get(code);
    if (!room) { socket.emit('joinError', 'そのコードのロビーは見つかりません'); return; }
    enter(room, d);
  });

  // ロビー中のみアクセサリー変更可
  socket.on('setAcc', (id) => {
    const p = P(), room = R();
    if (!p || room.game.phase !== 'lobby' || !ACCS.includes(id)) return;
    p.acc = id;
  });

  socket.on('input', (d) => {
    const p = P(), room = R(); if (!p) return;
    if (!d || typeof d !== 'object' || p.mini || room.game.phase !== 'playing') { p.input = { x: 0, y: 0 }; return; }
    p.input = { x: (d.right ? 1 : 0) - (d.left ? 1 : 0), y: (d.down ? 1 : 0) - (d.up ? 1 : 0) };
  });
  socket.on('action', () => { const p = P(); if (p) doAction(R(), p); });
  socket.on('report', () => { const p = P(); if (p) doReport(R(), p); });
  socket.on('kill', () => { const p = P(); if (p) doKill(R(), p); });
  socket.on('sabotage', () => { const p = P(); if (p) doSabotage(R(), p); });
  socket.on('discard', (i) => { const p = P(); if (p) doDiscard(R(), p, i); });

  socket.on('miniEnd', (d) => {
    const p = P(), room = R(); if (!p || !p.mini) return;
    const m = p.mini;
    p.mini = null;
    if (room.game.phase !== 'playing' || !d || d.cancel) return;
    if (!d.ok) { toast(p, '失敗… もう一度挑戦しよう', 'error'); return; }
    if (!p.tasks.includes(m.taskId)) return;
    if (Date.now() - m.start < MIN_MINI[m.kind]) { toast(p, '操作が速すぎる?', 'error'); return; }
    completeTask(room, p, m.taskId);
  });

  socket.on('setImp', (n) => {
    const p = P(), room = R();
    if (!p || room.game.phase !== 'lobby' || p.id !== hostId(room)) return;
    room.impCount = clamp(parseInt(n, 10) || 1, 1, MAX_IMPOSTERS);
  });

  socket.on('ready', () => {
    const p = P(), room = R();
    if (p && room.game.phase === 'lobby' && p.id !== hostId(room)) p.ready = !p.ready;
  });
  socket.on('start', () => {
    const p = P(), room = R();
    if (!p || room.game.phase !== 'lobby' || p.id !== hostId(room)) return;
    const part = participants(room);
    if (part.length < MIN_PLAYERS) { toast(p, `最低${MIN_PLAYERS}人必要`, 'error'); return; }
    if (!part.every(x => x.id === p.id || x.ready)) { toast(p, '全員の準備が完了していない', 'error'); return; }
    startGame(room);
  });
  socket.on('toLobby', () => { const room = R(); if (P() && room.game.phase === 'end') toLobby(room); });

  socket.on('chat', (t) => {
    const p = P(), room = R(); if (!p) return;
    const m = room.game.meeting;
    if (room.game.phase !== 'meeting' || !m || m.mode === 'result' || !p.alive || p.late) return;
    const now = Date.now();
    if (now - p.lastChat < 300) return;
    p.lastChat = now;
    const text = String(t || '').replace(/[<>]/g, '').trim().slice(0, 60);
    if (text) emitRoom(room, 'chat', { n: p.name, c: p.color, t: text });
  });
  socket.on('vote', (target) => {
    const p = P(), room = R(); if (!p) return;
    const m = room.game.meeting;
    if (room.game.phase !== 'meeting' || !m || m.mode !== 'vote' || !p.alive || p.late || m.votes.has(p.id)) return;
    if (target !== 'skip') {
      const t = room.players.get(target);
      if (!t || t.late || !t.alive) return;
    }
    m.votes.set(p.id, target);
    io.to(p.id).emit('sfx', 'click');
  });

  socket.on('disconnect', () => {
    const room = R();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    room.players.delete(socket.id);
    if (room.game.meeting) room.game.meeting.votes.delete(socket.id);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    const g = room.game;
    if (g.phase === 'playing' || g.phase === 'meeting') {
      if (participants(room).length === 0) { toLobby(room); return; }
      if (g.phase === 'playing') checkWin(room, true);
    }
  });
});

server.listen(PORT, () => console.log(`Destroy or Avoid v7 (fixed ship map + ghost carry + task markers) running on :${PORT}`));

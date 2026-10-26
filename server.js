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
// マップ: 正方形に近いコンパクトな横長 (33 x 21)。迷路ノードは「通路幅3マス + 壁1マス」の周期4で構成
const CELL = 50, COLS = 33, ROWS = 21;
const W = COLS * CELL, H = ROWS * CELL;
const NX = (COLS - 1) / 4, NY = (ROWS - 1) / 4; // 8 x 5 ノード
const CX = (COLS - 1) / 2, CY = (ROWS - 1) / 2;  // 中央セル (16, 10)
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

// ---------- タスクプール（全15個。座標はマップ生成ごとにランダム配置） ----------
// kind: carry(運搬) / weld(溶接) / seq(数字順押し) / alt(K/O交互連打) / space(SPACE連打)
const TASK_BASE = [
  { id: 1,  name: 'プラズマコアの搬入',   pct: 20, kind: 'carry', item: 'core',    icon: '⚛️' },
  { id: 2,  name: 'ヒューズの装着',       pct: 10, kind: 'carry', item: 'fuse',    icon: '🔌' },
  { id: 3,  name: '予備バッテリーの装着', pct: 10, kind: 'carry', item: 'battery', icon: '🔋' },
  { id: 4,  name: '外壁フレーム溶接',     pct: 10, kind: 'weld',  icon: '🔥' },
  { id: 5,  name: '駆動アームの溶接',     pct: 10, kind: 'weld',  icon: '🦾' },
  { id: 6,  name: '配電盤の番号入力',     pct: 5,  kind: 'seq',   icon: '🔢' },
  { id: 7,  name: 'パスコード入力',       pct: 5,  kind: 'seq',   icon: '🔐' },
  { id: 8,  name: 'コンテナ番号の照合',   pct: 5,  kind: 'seq',   icon: '📦' },
  { id: 9,  name: '冷却ファンの回転',     pct: 5,  kind: 'alt',   n: 20, icon: '🌀' },
  { id: 10, name: '発電機のクランク',     pct: 10, kind: 'alt',   n: 30, icon: '⚙️' },
  { id: 11, name: 'ポンプの加圧',         pct: 5,  kind: 'alt',   n: 16, icon: '🛢️' },
  { id: 12, name: '配線の張り替え',       pct: 5,  kind: 'space', n: 6,  icon: '🧵' },
  { id: 13, name: 'バルブの調整',         pct: 5,  kind: 'space', n: 8,  icon: '🎛️' },
  { id: 14, name: 'アンテナの調整',       pct: 5,  kind: 'space', n: 6,  icon: '📡' },
  { id: 15, name: '点火システムの調整',   pct: 5,  kind: 'space', n: 10, icon: '🚀' },
];

// ---------- 乱数ユーティリティ ----------
const rand = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- ランダム迷路生成 ----------
// 1) 8x5 のノード(3x3の部屋)を再帰バックトラックで接続(必ず全ノードが連結)
// 2) ループ追加(braid) + 行き止まり除去で回遊しやすくする
// 3) ランダムな大部屋と、マップ真中央の広場(7x5、中央3x3は絶対に壁なし)を開放し、中心に緊急招集ボタン
// 4) 設備(供給所3 + タスク15)をノード中心に間隔を空けて配置、到達性を検証
function buildLayout() {
  const hE = Array.from({ length: NY }, () => Array(NX - 1).fill(false)); // hE[j][i]: (i,j)-(i+1,j)
  const vE = Array.from({ length: NY - 1 }, () => Array(NX).fill(false)); // vE[j][i]: (i,j)-(i,j+1)
  const arr = (t) => (t === 'h' ? hE : vE);
  const nbrs = (i, j) => {
    const a = [];
    if (i > 0) a.push([i - 1, j, 'h', i - 1, j]);
    if (i < NX - 1) a.push([i + 1, j, 'h', i, j]);
    if (j > 0) a.push([i, j - 1, 'v', i, j - 1]);
    if (j < NY - 1) a.push([i, j + 1, 'v', i, j]);
    return a; // [隣i, 隣j, 辺種別, 辺i, 辺j]
  };
  const isOpen = (n) => arr(n[2])[n[4]][n[3]];
  const open = (n) => { arr(n[2])[n[4]][n[3]] = true; };
  const deg = (i, j) => nbrs(i, j).filter(isOpen).length;

  // 1) 迷路(全域木)
  const vis = Array.from({ length: NY }, () => Array(NX).fill(false));
  const st = [[rand(NX), rand(NY)]];
  vis[st[0][1]][st[0][0]] = true;
  while (st.length) {
    const [i, j] = st[st.length - 1];
    const cand = shuffle(nbrs(i, j).filter(n => !vis[n[1]][n[0]]));
    if (!cand.length) { st.pop(); continue; }
    open(cand[0]);
    vis[cand[0][1]][cand[0][0]] = true;
    st.push([cand[0][0], cand[0][1]]);
  }
  // 2) ループ追加 & 行き止まり除去
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX - 1; i++) if (!hE[j][i] && Math.random() < 0.12) hE[j][i] = true;
  for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX; i++) if (!vE[j][i] && Math.random() < 0.12) vE[j][i] = true;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    if (deg(i, j) <= 1 && Math.random() < 0.6) {
      const closed = nbrs(i, j).filter(n => !isOpen(n));
      if (closed.length) open(shuffle(closed)[0]);
    }
  }

  // ラスタライズ
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(true));
  const carve = (c0, r0, c1, r1) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r][c] = false; };
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) carve(4 * i + 1, 4 * j + 1, 4 * i + 3, 4 * j + 3);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX - 1; i++) if (hE[j][i]) carve(4 * (i + 1), 4 * j + 1, 4 * (i + 1), 4 * j + 3);
  for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX; i++) if (vE[j][i]) carve(4 * i + 1, 4 * (j + 1), 4 * i + 3, 4 * (j + 1));
  // 3) 大部屋(7x7)をランダムに2つ
  for (let k = 0; k < 2; k++) { const i = rand(NX - 1), j = rand(NY - 1); carve(4 * i + 1, 4 * j + 1, 4 * i + 7, 4 * j + 7); }
  // 中央広場 (7x5)。中央3x3は絶対に壁を置かない。ここに緊急招集ボタン
  carve(CX - 3, CY - 2, CX + 3, CY + 2);
  carve(CX - 1, CY - 1, CX + 1, CY + 1);
  const button = cp(CX, CY);

  // 4) 設備配置 (広場のノードは除外)
  const inPlaza = (i, j) => (i === 3 || i === 4) && j === 2;
  const cand = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) if (!inPlaza(i, j)) cand.push([i, j]);
  shuffle(cand);
  const need = 3 + TASK_BASE.length;
  const picked = [];
  for (let dmin = 3; dmin >= 1 && picked.length < need; dmin--) {
    for (const n of cand) {
      if (picked.length >= need) break;
      if (picked.includes(n)) continue;
      if (picked.every(p => Math.max(Math.abs(p[0] - n[0]), Math.abs(p[1] - n[1])) >= dmin)) picked.push(n);
    }
  }
  if (picked.length < need) return null;
  shuffle(picked);
  const at = (n) => cp(4 * n[0] + 2, 4 * n[1] + 2);
  const stations = { fuse: at(picked[0]), battery: at(picked[1]), core: at(picked[2]) };
  const taskDefs = TASK_BASE.map((d, k) => ({ ...d, ...at(picked[3 + k]) }));

  // 到達性チェック
  const seen = new Set();
  const q = [[CX, CY]];
  seen.add(CY * COLS + CX);
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS || grid[nr][nc] || seen.has(nr * COLS + nc)) continue;
      seen.add(nr * COLS + nc); q.push([nc, nr]);
    }
  }
  const all = [...taskDefs, ...Object.values(stations)];
  if (!all.every(d => seen.has(Math.floor(d.y / CELL) * COLS + Math.floor(d.x / CELL)))) return null;
  // 中央3x3に壁が無いことの最終確認
  for (let r = CY - 1; r <= CY + 1; r++) for (let c = CX - 1; c <= CX + 1; c++) if (grid[r][c]) return null;
  return { grid, button, stations, taskDefs };
}

function applyLayout(room) {
  let L = null;
  for (let i = 0; i < 30 && !L; i++) L = buildLayout();
  if (!L) throw new Error('map generation failed');
  room.grid = L.grid;
  room.rows = L.grid.map(row => row.map(v => (v ? '1' : '0')).join(''));
  room.button = L.button;
  room.stations = L.stations;
  room.taskDefs = L.taskDefs;
}

const isWall = (room, c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : room.grid[r][c];
const defOf = (room, id) => room.taskDefs.find(d => d.id === id);

function mapPayload(room) {
  return {
    W, H, CELL, rows: room.rows, BUTTON: room.button, STATIONS: room.stations,
    TASKS: room.taskDefs.map(d => ({ id: d.id, name: d.name, pct: d.pct, kind: d.kind, item: d.item || null, n: d.n || 0, icon: d.icon, x: d.x, y: d.y })),
  };
}

// 円(プレイヤー) vs 矩形(壁セル) の押し出し
function resolveWalls(room, p) {
  for (let it = 0; it < 4; it++) {
    let moved = false;
    const c0 = Math.floor((p.x - PR) / CELL), c1 = Math.floor((p.x + PR) / CELL);
    const r0 = Math.floor((p.y - PR) / CELL), r1 = Math.floor((p.y + PR) / CELL);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!isWall(room, c, r)) continue;
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
  applyLayout(room);                       // 毎ゲーム新しいランダム迷路
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
        const sp = hasItem(p, 'core') ? SPEED_CORE : SPEED;
        p.x += dx * sp * dt;
        p.y += dy * sp * dt;
        resolveWalls(room, p);
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

server.listen(PORT, () => console.log(`Destroy or Avoid v6 (cutscenes + accessories + compact maze) running on :${PORT}`));

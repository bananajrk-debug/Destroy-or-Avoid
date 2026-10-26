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
const CELL = 50, COLS = 32, ROWS = 20;
const W = COLS * CELL, H = ROWS * CELL;
const TICK_RATE = 30;
const GAME_MS = 10 * 60 * 1000;
const SPEED = 230, SPEED_CORE = 130, PR = 16, REACH = 70;
const SLOT_MAX = 3, MIN_PLAYERS = 2;
const KILL_RANGE = 95, REPORT_RANGE = 110, BTN_RANGE = 90;
const KILL_CD = 20000, FIRST_KILL_CD = 15000, SAB_CD = 45000, SAB_PCT = 5;
const BTN_LOCK = 10000;
const DISCUSS_MS = 20000, VOTE_MS = 30000, RESULT_MS = 6000, END_AUTO_MS = 25000;
const ACTIVE_TASKS = 3, ACTION_MIN = 60;
const MIN_MINI = { weld: 6000, seq: 1000, alt: 1200, space: 800 }; // ミニゲーム最短受理時間
const MINI_TIMEOUT = 90000;

const cp = (c, r) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 });
const BUTTON = cp(16, 10);
const STATIONS = { fuse: cp(3, 6), battery: cp(28, 6), core: cp(16, 16) };
const ITEM_NAME = { fuse: 'ヒューズ', battery: 'バッテリー', core: 'プラズマコア' };

// ---------- タスクプール（全15個） ----------
// kind: carry(運搬) / weld(溶接) / seq(数字順押し) / alt(K/O交互連打) / space(SPACE連打)
const TASK_DEFS = [
  { id: 1,  name: 'プラズマコアの搬入',   pct: 20, kind: 'carry', item: 'core',    icon: '⚛️', c: 3,  r: 10 },
  { id: 2,  name: 'ヒューズの装着',       pct: 10, kind: 'carry', item: 'fuse',    icon: '🔌', c: 16, r: 2 },
  { id: 3,  name: '予備バッテリーの装着', pct: 10, kind: 'carry', item: 'battery', icon: '🔋', c: 28, r: 10 },
  { id: 4,  name: '外壁フレーム溶接',     pct: 10, kind: 'weld',  icon: '🔥', c: 3,  r: 3 },
  { id: 5,  name: '駆動アームの溶接',     pct: 10, kind: 'weld',  icon: '🦾', c: 28, r: 3 },
  { id: 6,  name: '配電盤の番号入力',     pct: 5,  kind: 'seq',   n: 5,  icon: '🔢', c: 10, r: 3 },
  { id: 7,  name: 'パスコード入力',       pct: 5,  kind: 'seq',   n: 6,  icon: '🔐', c: 21, r: 3 },
  { id: 8,  name: 'コンテナ番号の照合',   pct: 5,  kind: 'seq',   n: 4,  icon: '📦', c: 7,  r: 10 },
  { id: 9,  name: '冷却ファンの回転',     pct: 5,  kind: 'alt',   n: 20, icon: '🌀', c: 24, r: 10 },
  { id: 10, name: '発電機のクランク',     pct: 10, kind: 'alt',   n: 30, icon: '⚙️', c: 3,  r: 17 },
  { id: 11, name: 'ポンプの加圧',         pct: 5,  kind: 'alt',   n: 16, icon: '🛢️', c: 28, r: 17 },
  { id: 12, name: '配線の張り替え',       pct: 5,  kind: 'space', n: 6,  icon: '🧵', c: 10, r: 17 },
  { id: 13, name: 'バルブの調整',         pct: 5,  kind: 'space', n: 8,  icon: '🎛️', c: 21, r: 17 },
  { id: 14, name: 'アンテナの調整',       pct: 5,  kind: 'space', n: 6,  icon: '📡', c: 13, r: 12 },
  { id: 15, name: '点火システムの調整',   pct: 5,  kind: 'space', n: 10, icon: '🚀', c: 16, r: 7 },
].map(d => ({ ...d, ...cp(d.c, d.r) }));
const defOf = (id) => TASK_DEFS.find(d => d.id === id);

const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f783ac', '#a9e34b', '#c08457'];

// ---------- シンプル迷路（通路幅3マス以上・行き止まりなし） ----------
const BLOCKS = [ // [c0, r0, c1, r1]
  [5, 4, 8, 5], [23, 4, 26, 5], [5, 14, 8, 15], [23, 14, 26, 15],
  [12, 5, 19, 5], [12, 14, 19, 14], [10, 8, 10, 11], [21, 8, 21, 11],
];
const grid = Array.from({ length: ROWS }, (_, r) =>
  Array.from({ length: COLS }, (_, c) => r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1));
for (const [c0, r0, c1, r1] of BLOCKS)
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r][c] = true;
const mapRows = () => grid.map(row => row.map(v => (v ? '1' : '0')).join(''));
const isWall = (c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : grid[r][c];

// 到達性チェック（起動時）
(function checkMap() {
  const seen = new Set(), q = [[16, 10]];
  seen.add(10 * COLS + 16);
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (isWall(nc, nr) || seen.has(nr * COLS + nc)) continue;
      seen.add(nr * COLS + nc); q.push([nc, nr]);
    }
  }
  for (const d of [...TASK_DEFS, ...Object.values(STATIONS).map(p => ({ ...p, name: 'station', c: Math.floor(p.x / CELL), r: Math.floor(p.y / CELL) }))])
    if (!seen.has(d.r * COLS + d.c)) console.warn('[map] unreachable:', d.name, d.c, d.r);
})();

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
  phase: 'lobby', // lobby | playing | meeting | end
  endsAt: 0,
  remainAtEnd: GAME_MS,
  endedAt: 0,
  progress: 0,
  crewTotal: 1,
  result: null,
  bodies: [],
  nextBody: 1,
  meeting: null,
  noMeetingUntil: 0,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (p, pos, r) => dist(p, pos) <= r;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toast = (p, text, kind) => io.to(p.id).emit('toast', { text, kind: kind || 'info' });
const participants = () => [...players.values()].filter(p => !p.late);
const hostId = () => { let h = null; for (const p of players.values()) if (!h || p.joinOrder < h.joinOrder) h = p; return h ? h.id : null; };

const hasItem = (p, t) => p.slots.some(s => s.t === t);
const removeItem = (p, t) => { if (!hasItem(p, t)) return false; p.slots = p.slots.filter(s => s.t !== t); return true; };
function cancelMini(p) { if (p.mini) { p.mini = null; io.to(p.id).emit('miniCancel'); } }

function ringPos(i, n, rad) {
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  return { x: BUTTON.x + Math.cos(a) * rad, y: BUTTON.y + Math.sin(a) * rad };
}

// ---------- タスク割り当て ----------
function newTask(p) {
  let pool = TASK_DEFS.filter(t => !p.tasks.includes(t.id) && !p.doneTasks.has(t.id));
  if (!pool.length) { p.doneTasks.clear(); pool = TASK_DEFS.filter(t => !p.tasks.includes(t.id)); }
  return pool[Math.floor(Math.random() * pool.length)].id;
}
function fillTasks(p) { while (p.tasks.length < ACTIVE_TASKS) p.tasks.push(newTask(p)); }

function completeTask(p, id) {
  const d = defOf(id);
  const idx = p.tasks.indexOf(id);
  if (!d || idx < 0) return;
  p.tasks.splice(idx, 1);
  p.doneTasks.add(id);
  fillTasks(p);
  io.to(p.id).emit('sfx', 'done');
  if (p.role === 'imposter') {
    toast(p, `${d.name} (偽装タスク・進捗には影響なし)`, 'info');
    return;
  }
  const k = clamp(4 / Math.max(1, game.crewTotal), 0.5, 1.5);
  const add = d.pct * k;
  game.progress = Math.min(100, game.progress + add);
  toast(p, `${d.name} 完了! 進捗 +${add.toFixed(1)}%`, 'good');
  checkWin();
}

// ---------- 開始・終了 ----------
function resetPlayer(p, i, n) {
  const pos = ringPos(i, n, 110);
  p.x = pos.x; p.y = pos.y;
  p.alive = true; p.slots = []; p.mini = null; p.input = { x: 0, y: 0 };
  p.tasks = []; p.doneTasks = new Set(); p.moving = false;
  p.emUsed = false;
}

function startGame() {
  const part = participants();
  if (part.length < MIN_PLAYERS) return;
  const now = Date.now();
  game.phase = 'playing';
  game.progress = 0; game.result = null; game.bodies = []; game.meeting = null;
  game.endsAt = now + GAME_MS;
  game.noMeetingUntil = now + BTN_LOCK;
  const imp = part[Math.floor(Math.random() * part.length)];
  game.crewTotal = part.length - 1;
  part.forEach((p, i) => {
    resetPlayer(p, i, part.length);
    p.role = p === imp ? 'imposter' : 'crew';
    p.killReady = now + FIRST_KILL_CD;
    p.sabReady = now + 30000;
    fillTasks(p);
  });
  io.emit('sfx', 'start');
}

function endGame(winner, reason) {
  if (game.phase === 'end' || game.phase === 'lobby') return true;
  const now = Date.now();
  game.remainAtEnd = Math.max(0, game.endsAt - (game.meeting ? game.meeting.startAt : now));
  game.phase = 'end';
  game.meeting = null;
  game.endedAt = now;
  game.result = { winner, reason };
  for (const p of players.values()) { cancelMini(p); p.input = { x: 0, y: 0 }; p.moving = false; }
  io.emit('sfx', winner === 'crew' ? 'win' : 'lose');
  return true;
}

function toLobby() {
  game.phase = 'lobby'; game.meeting = null; game.bodies = []; game.result = null;
  game.remainAtEnd = GAME_MS; game.progress = 0;
  for (const p of players.values()) {
    p.late = false; p.ready = false; p.role = null; p.alive = true;
    p.slots = []; p.tasks = []; p.mini = null; p.input = { x: 0, y: 0 }; p.moving = false;
  }
}

function checkWin() {
  if (game.phase !== 'playing') return false;
  const part = participants();
  const imps = part.filter(p => p.role === 'imposter' && p.alive).length;
  const crews = part.filter(p => p.role === 'crew' && p.alive).length;
  if (game.progress >= 100) return endGame('crew', '全タスクが完了した! 進捗100%');
  if (imps === 0) return endGame('crew', 'インポスターを排除した!');
  if (crews <= imps) return endGame('imposter', 'クルーが全滅した…');
  return false;
}

// ---------- 会議 ----------
function startMeeting(caller, reason) {
  const now = Date.now();
  game.phase = 'meeting';
  game.meeting = { mode: 'discuss', startAt: now, modeEnds: now + DISCUSS_MS, votes: new Map(), reason, callerName: caller.name, result: null };
  if (reason === 'button') caller.emUsed = true;
  const part = participants();
  part.forEach((p, i) => {
    cancelMini(p); p.input = { x: 0, y: 0 }; p.moving = false;
    const pos = ringPos(i, part.length, 120);
    p.x = pos.x; p.y = pos.y;
  });
  io.emit('sfx', 'meeting');
}

function resolveVotes(now) {
  const m = game.meeting;
  const counts = {};
  let skip = 0;
  for (const [vid, t] of m.votes) {
    if (!players.has(vid)) continue;
    if (t === 'skip') skip++; else counts[t] = (counts[t] || 0) + 1;
  }
  let max = 0, top = [];
  for (const id in counts) {
    if (counts[id] > max) { max = counts[id]; top = [id]; }
    else if (counts[id] === max) top.push(id);
  }
  let ej = null;
  if (top.length === 1 && max > skip) {
    const t = players.get(top[0]);
    if (t) { t.alive = false; cancelMini(t); ej = { id: t.id, name: t.name, c: t.color, imp: t.role === 'imposter' }; }
  }
  m.result = { ej, tally: Object.entries(counts), skip };
  m.mode = 'result';
  m.modeEnds = now + RESULT_MS;
}

function endMeeting(now) {
  const m = game.meeting;
  game.endsAt += now - m.startAt; // 会議中は制限時間を止める
  game.phase = 'playing';
  game.meeting = null;
  game.bodies = [];
  game.noMeetingUntil = now + BTN_LOCK;
  for (const p of participants()) if (p.role === 'imposter') p.killReady = Math.max(p.killReady, now + 10000);
  checkWin();
}

function tickMeeting(now) {
  const m = game.meeting;
  if (!m) { game.phase = 'playing'; return; }
  if (m.mode === 'discuss') {
    if (now >= m.modeEnds) { m.mode = 'vote'; m.modeEnds = now + VOTE_MS; }
  } else if (m.mode === 'vote') {
    const voters = participants().filter(p => p.alive);
    if (now >= m.modeEnds || voters.every(p => m.votes.has(p.id))) resolveVotes(now);
  } else if (m.mode === 'result') {
    if (now >= m.modeEnds) endMeeting(now);
  }
}

// ---------- アクション ----------
function doAction(p) {
  if (game.phase !== 'playing' || p.late || p.mini) return;
  const now = Date.now();
  if (now - p.lastAct < ACTION_MIN) return;
  p.lastAct = now;

  // 1) 自分のタスク拠点
  for (const id of p.tasks) {
    const d = defOf(id);
    if (!near(p, d, REACH)) continue;
    if (d.kind === 'carry') {
      if (!hasItem(p, d.item)) { toast(p, `${ITEM_NAME[d.item]}が必要! (運搬してこよう)`, 'error'); return; }
      removeItem(p, d.item);
      completeTask(p, id);
      return;
    }
    p.mini = { taskId: id, kind: d.kind, start: now };
    p.input = { x: 0, y: 0 }; p.moving = false;
    io.to(p.id).emit('miniStart', { taskId: id });
    return;
  }

  // 2) 運搬アイテムの供給所
  for (const id of p.tasks) {
    const d = defOf(id);
    if (d.kind !== 'carry' || !near(p, STATIONS[d.item], REACH)) continue;
    if (hasItem(p, d.item)) { toast(p, 'すでに持っている', 'error'); return; }
    const need = d.item === 'core' ? 2 : 1;
    if (p.slots.length + need > SLOT_MAX) { toast(p, 'スロットがいっぱい!', 'error'); return; }
    for (let i = 0; i < need; i++) p.slots.push({ t: d.item });
    toast(p, `${ITEM_NAME[d.item]}を取得`, 'info');
    io.to(p.id).emit('sfx', 'click');
    return;
  }

  // 3) 緊急会議ボタン
  if (near(p, BUTTON, BTN_RANGE)) {
    if (!p.alive) return;
    if (p.emUsed) { toast(p, '緊急会議は1人1回まで', 'error'); return; }
    if (now < game.noMeetingUntil) { toast(p, `まだ使えない (あと${Math.ceil((game.noMeetingUntil - now) / 1000)}秒)`, 'error'); return; }
    startMeeting(p, 'button');
  }
}

function doReport(p) {
  if (game.phase !== 'playing' || p.late || !p.alive) return;
  const b = game.bodies.find(b => dist(p, b) <= REPORT_RANGE);
  if (!b) { toast(p, '近くに死体がない', 'error'); return; }
  startMeeting(p, 'body');
}

function doKill(p) {
  if (game.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter') return;
  const now = Date.now();
  if (now < p.killReady) return;
  let best = null, bd = KILL_RANGE;
  for (const v of participants()) {
    if (v === p || !v.alive || v.role === 'imposter') continue;
    const d = dist(p, v);
    if (d <= bd) { bd = d; best = v; }
  }
  if (!best) { toast(p, '範囲内にターゲットがいない', 'error'); return; }
  best.alive = false;
  cancelMini(best);
  game.bodies.push({ id: game.nextBody++, x: Math.round(best.x), y: Math.round(best.y), c: best.color });
  p.x = best.x; p.y = best.y;
  p.killReady = now + KILL_CD;
  io.to(best.id).emit('sfx', 'kill');
  io.to(best.id).emit('toast', { text: 'あなたはキルされた… (霊としてタスクは続けられる)', kind: 'error' });
  io.to(p.id).emit('sfx', 'kill');
  checkWin();
}

function doSabotage(p) {
  if (game.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter') return;
  const now = Date.now();
  if (now < p.sabReady) return;
  p.sabReady = now + SAB_CD;
  game.progress = Math.max(0, game.progress - SAB_PCT);
  io.emit('sfx', 'alarm');
  io.emit('toast', { text: `⚠ 妨害工作! 進捗が${SAB_PCT}%低下`, kind: 'error' });
}

function doDiscard(p, idx) {
  if (game.phase !== 'playing' || p.mini) return;
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

  if (game.phase === 'playing') {
    for (const p of players.values()) {
      if (p.late) continue;
      if (p.mini && now - p.mini.start > MINI_TIMEOUT) cancelMini(p);
      if (p.mini) { p.moving = false; continue; }
      const len = Math.hypot(p.input.x, p.input.y);
      p.moving = len > 0;
      if (len > 0) {
        const dx = p.input.x / len, dy = p.input.y / len;
        const sp = hasItem(p, 'core') ? SPEED_CORE : SPEED;
        p.x += dx * sp * dt;
        p.y += dy * sp * dt;
        resolveWalls(p);
        p.x = clamp(p.x, PR, W - PR);
        p.y = clamp(p.y, PR, H - PR);
        if (dx !== 0) p.face = dx > 0 ? 1 : -1;
      }
    }
    if (now >= game.endsAt) endGame('imposter', '時間切れ… クルーは間に合わなかった');
  } else if (game.phase === 'meeting') {
    tickMeeting(now);
  } else if (game.phase === 'end') {
    if (now - game.endedAt > END_AUTO_MS) toLobby();
  }
  if (players.size > 0) broadcast(now);
}

function meetView(v, now, part) {
  const m = game.meeting;
  return {
    mode: m.mode, t: Math.max(0, m.modeEnds - now), reason: m.reason, caller: m.callerName,
    roster: part.map(p => ({ id: p.id, name: p.name, c: p.color, a: p.alive, voted: m.votes.has(p.id) })),
    my: m.votes.get(v.id) || null,
    res: m.result,
  };
}

function broadcast(now) {
  let remain = GAME_MS;
  if (game.phase === 'playing') remain = Math.max(0, game.endsAt - now);
  else if (game.phase === 'meeting') remain = Math.max(0, game.endsAt - game.meeting.startAt);
  else if (game.phase === 'end') remain = game.remainAtEnd;

  const part = participants();
  const host = hostId();
  const base = { ph: game.phase, remain, prog: Math.round(game.progress * 10) / 10, result: game.result };
  let lobby = null;
  if (game.phase === 'lobby') {
    lobby = [...players.values()].sort((a, b) => a.joinOrder - b.joinOrder)
      .map(p => ({ id: p.id, name: p.name, c: p.color, ready: p.ready, host: p.id === host }));
  }
  const bodies = game.bodies;
  const playersView = game.phase === 'lobby' ? null : part.map(p => ({
    id: p.id, name: p.name, c: p.color, x: Math.round(p.x), y: Math.round(p.y), a: p.alive, mv: p.moving, f: p.face,
  }));

  for (const v of players.values()) {
    const ghost = !v.alive || v.late || game.phase === 'end';
    const msg = {
      ...base,
      me: {
        role: v.role, alive: v.alive, late: v.late, ready: v.ready, host: v.id === host,
        tasks: v.tasks, sl: v.slots.map(s => s.t),
        kcd: Math.max(0, (v.killReady || 0) - now), scd: Math.max(0, (v.sabReady || 0) - now),
        em: v.emUsed, emLock: Math.max(0, game.noMeetingUntil - now),
      },
    };
    if (lobby) msg.lobby = lobby;
    else {
      msg.players = ghost ? playersView : playersView.filter(p => p.a);
      msg.bodies = bodies;
      if (game.phase === 'meeting') msg.meet = meetView(v, now, part);
      if (game.phase === 'end') msg.roster = part.map(p => ({ id: p.id, name: p.name, c: p.color, role: p.role, a: p.alive }));
    }
    io.to(v.id).volatile.emit('state', msg);
  }
}

setInterval(tick, 1000 / TICK_RATE);

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.emit('init', {
    you: socket.id, W, H, CELL, REACH, SLOT_MAX, GAME_MS, BUTTON, STATIONS, ITEM_NAME,
    TASKS: TASK_DEFS.map(d => ({ id: d.id, name: d.name, pct: d.pct, kind: d.kind, item: d.item || null, n: d.n || 0, icon: d.icon, x: d.x, y: d.y })),
    rows: mapRows(),
  });

  socket.on('join', (d) => {
    if (players.has(socket.id)) return;
    joinCounter += 1;
    const used = new Set([...players.values()].map(p => p.color));
    const name = String((d && d.name) || '').replace(/[<>]/g, '').trim().slice(0, 10) || ('P' + joinCounter);
    const late = game.phase !== 'lobby';
    const p = {
      id: socket.id, num: joinCounter, joinOrder: joinCounter, name,
      color: COLORS.find(c => !used.has(c)) || COLORS[joinCounter % COLORS.length],
      x: BUTTON.x, y: BUTTON.y + 100, face: 1, moving: false,
      ready: false, late, role: null, alive: !late,
      tasks: [], doneTasks: new Set(), slots: [], mini: null,
      input: { x: 0, y: 0 }, lastAct: 0, lastDisc: 0, lastChat: 0,
      killReady: 0, sabReady: 0, emUsed: false,
    };
    players.set(socket.id, p);
  });

  const P = () => players.get(socket.id);

  socket.on('input', (d) => {
    const p = P(); if (!p) return;
    if (!d || typeof d !== 'object' || p.mini || game.phase !== 'playing') { p.input = { x: 0, y: 0 }; return; }
    p.input = { x: (d.right ? 1 : 0) - (d.left ? 1 : 0), y: (d.down ? 1 : 0) - (d.up ? 1 : 0) };
  });
  socket.on('action', () => { const p = P(); if (p) doAction(p); });
  socket.on('report', () => { const p = P(); if (p) doReport(p); });
  socket.on('kill', () => { const p = P(); if (p) doKill(p); });
  socket.on('sabotage', () => { const p = P(); if (p) doSabotage(p); });
  socket.on('discard', (i) => { const p = P(); if (p) doDiscard(p, i); });

  socket.on('miniEnd', (d) => {
    const p = P(); if (!p || !p.mini) return;
    const m = p.mini;
    p.mini = null;
    if (game.phase !== 'playing' || !d || d.cancel) return;
    if (!d.ok) { toast(p, '失敗… もう一度挑戦しよう', 'error'); return; }
    if (!p.tasks.includes(m.taskId)) return;
    if (Date.now() - m.start < MIN_MINI[m.kind]) { toast(p, '操作が速すぎる?', 'error'); return; }
    completeTask(p, m.taskId);
  });

  socket.on('ready', () => {
    const p = P();
    if (p && game.phase === 'lobby' && p.id !== hostId()) p.ready = !p.ready;
  });
  socket.on('start', () => {
    const p = P();
    if (!p || game.phase !== 'lobby' || p.id !== hostId()) return;
    const part = participants();
    if (part.length < MIN_PLAYERS) { toast(p, `最低${MIN_PLAYERS}人必要`, 'error'); return; }
    if (!part.every(x => x.id === p.id || x.ready)) { toast(p, '全員の準備が完了していない', 'error'); return; }
    startGame();
  });
  socket.on('toLobby', () => { if (P() && game.phase === 'end') toLobby(); });

  socket.on('chat', (t) => {
    const p = P(); const m = game.meeting;
    if (!p || game.phase !== 'meeting' || !m || m.mode === 'result' || !p.alive || p.late) return;
    const now = Date.now();
    if (now - p.lastChat < 300) return;
    p.lastChat = now;
    const text = String(t || '').replace(/[<>]/g, '').trim().slice(0, 60);
    if (text) io.emit('chat', { n: p.name, c: p.color, t: text });
  });
  socket.on('vote', (target) => {
    const p = P(); const m = game.meeting;
    if (!p || game.phase !== 'meeting' || !m || m.mode !== 'vote' || !p.alive || p.late || m.votes.has(p.id)) return;
    if (target !== 'skip') {
      const t = players.get(target);
      if (!t || t.late || !t.alive) return;
    }
    m.votes.set(p.id, target);
    io.to(p.id).emit('sfx', 'click');
  });

  socket.on('disconnect', () => {
    const p = P();
    if (!p) return;
    players.delete(socket.id);
    if (game.meeting) game.meeting.votes.delete(socket.id);
    if (players.size === 0) { toLobby(); return; }
    if (game.phase === 'playing' || game.phase === 'meeting') {
      if (participants().length === 0) { toLobby(); return; }
      if (game.phase === 'playing') checkWin();
    }
  });
});

server.listen(PORT, () => console.log(`Destroy or Avoid v4 (Among-style) running on :${PORT}`));

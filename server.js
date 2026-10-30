const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
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
const SPEED = 250, GHOST_MULT = 1.5, PR = 16, REACH = 70;
const MIN_PLAYERS = 2, MAX_PLAYERS = 10, MAX_IMP = 3;
const KILL_RANGE = 95, REPORT_RANGE = 110, BTN_RANGE = 90;
const KILL_CD = 20000, FIRST_KILL_CD = 15000;
// 妨害: 「進捗妨害」は単体の独立した妨害 (進捗 -20% / 専用クールタイム30秒)
//       暗闇・電気のショート・水の氾濫は別枠 (進捗は減らさない / 共通クールタイム30秒 / 同時に1つまで)
const SAB_CD = 30000, SAB_PCT = 20, PROG_CD = 30000;
const DARK_MS = 30000;                       // 暗闇の長さ
const SHORT_MS = 120000, SHORT_NEED = 5;     // 電気のショート: 2分以内に5か所直さないとクルー全滅
const FLOOD_N = 3, BAIL_NEED = 30, FLOOD_MAX_MS = 150000; // 水の氾濫: 3か所。SPACE30回で1か所解消 (150秒で自然に引く)
const WARP_CD = 6000, WARP_RANGE = 70;       // インポスター専用ワープ
// 探偵: キルが起きると、探偵だけに被害者の直前5秒の移動軌跡が届く
const TRAIL_MS = 5000, TRAIL_STEP = 100, MAX_DET = 2, DET_TRACE_MS = 45000;
const SABS = { prog: { name: '進捗妨害', theme: null }, dark: { name: '暗闇', theme: null }, short: { name: '電気のショート', theme: 'space' }, flood: { name: '水の氾濫', theme: 'island' } };
const BTN_LOCK = 10000, FREEZE_MS = 3200;
const DISCUSS_MS = process.env.DOA_TEST === '1' ? 4000 : 20000; // 自動テスト時だけ議論を短く
const VOTE_MS = 30000, RESULT_MS = 9500, END_AUTO_MS = 25000;
const ACTIVE_TASKS = 3, ACTION_MIN = 60;
const MIN_MINI = { weld: 6000, seq: 1000, alt: 1200, space: 800, fire: 1800, vine: 2000, compass: 1500, wire: 1500 };
const MINI_TIMEOUT = 90000;
// ロビー: 正方形の床 (640x640) + 奥(上)の壁にクローゼット
const LOBBY = { x0: 60, y0: 120, x1: 700, y1: 760 };
const CLOSET = { x: 380, y: 92, range: 130 };
const LOBBY_C = { x: (LOBBY.x0 + LOBBY.x1) / 2, y: (LOBBY.y0 + LOBBY.y1) / 2 + 40 };
function lobbySpawn(i, n) {
  const a = (i / Math.max(1, n)) * Math.PI * 2 + Math.random() * 0.3;
  return { x: LOBBY_C.x + Math.cos(a) * 120, y: LOBBY_C.y + Math.sin(a) * 120 };
}

const cp = (c, r) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 });
// 運搬アイテム (孤島サバイバル)
// 運搬アイテム: 孤島 (薪など) + 宇宙船 (ヒューズなど)
const ITEM_NAME = { wood: '薪', nut: '木の実', sos: 'SOS信号機', scrap: '漂流資材', fuse: 'ヒューズ', battery: 'バッテリー', core: 'プラズマコア' };
const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22b8cf', '#f783ac', '#a9e34b', '#c08457'];
const ACCS = ['', '🐥', '💩', '👑', '🎩', '😎', '🌸', '🔥', '🎀', '🍕'];

// ---------- タスクプール（全15個。位置はマップ生成時に決まる） ----------
// kind: carry=運搬 / fire=火おこし(連打) / vine=蔓切り(長押し) / compass=方位合わせ(角度) / weld=ノコギリ(なぞり) / seq=番号入力 / alt=K・O交互 / space=SPACE連打
const TASK_DEFS = [
  { id: 1,  name: '薪を拠点へ運ぶ',           pct: 15, kind: 'carry',   item: 'wood',  icon: '🪵' },
  { id: 2,  name: '木の実を拠点へ運ぶ',       pct: 10, kind: 'carry',   item: 'nut',   icon: '🌰' },
  { id: 3,  name: 'SOS信号機を灯台に設置',    pct: 15, kind: 'carry',   item: 'sos',   icon: '📡' },
  { id: 4,  name: '漂流資材で見張り台を補修', pct: 10, kind: 'carry',   item: 'scrap', icon: '🧰' },
  { id: 5,  name: 'キャンプファイアの火おこし', pct: 10, kind: 'fire',  icon: '🔥' },
  { id: 6,  name: '絡まった蔓を切り払う',     pct: 5,  kind: 'vine',    n: 4, icon: '🌿' },
  { id: 7,  name: '茂みの道を切り開く',       pct: 5,  kind: 'vine',    n: 5, icon: '🎋' },
  { id: 8,  name: '方位磁針の調整',           pct: 5,  kind: 'compass', n: 3, icon: '🧭' },
  { id: 9,  name: '現在地の方角を測る',       pct: 5,  kind: 'compass', n: 2, icon: '🗺️' },
  { id: 10, name: '丸太をノコギリで切る',     pct: 10, kind: 'weld',    icon: '🪚' },
  { id: 11, name: '無線機の周波数合わせ',     pct: 5,  kind: 'seq',     n: 5, icon: '📻' },
  { id: 12, name: '宝箱のダイヤル錠',         pct: 5,  kind: 'seq',     n: 6, icon: '🔐' },
  { id: 13, name: '井戸のポンプを漕ぐ',       pct: 10, kind: 'alt',     n: 24, icon: '💧' },
  { id: 14, name: '魚を釣り上げる',           pct: 5,  kind: 'space',   n: 8, icon: '🎣' },
  { id: 15, name: 'ヤシの実を割る',           pct: 5,  kind: 'space',   n: 6, icon: '🥥' },
];
TASK_DEFS.forEach(d => d.theme = 'island');
// 宇宙船のタスク (id 101〜)
const SPACE_TASKS = [
  { id: 101, name: 'プラズマコアの搬入',   pct: 20, kind: 'carry', item: 'core',    icon: '⚛️' },
  { id: 102, name: 'ヒューズの装着',       pct: 10, kind: 'carry', item: 'fuse',    icon: '🔌' },
  { id: 103, name: '予備バッテリーの装着', pct: 10, kind: 'carry', item: 'battery', icon: '🔋' },
  { id: 104, name: '外壁フレーム溶接',     pct: 10, kind: 'weld',  icon: '🔥' },
  { id: 105, name: '駆動アームの溶接',     pct: 10, kind: 'weld',  icon: '🦾' },
  { id: 106, name: '配電盤の番号入力',     pct: 5,  kind: 'seq',   n: 5, icon: '🔢' },
  { id: 107, name: 'パスコード解除',       pct: 5,  kind: 'seq',   n: 6, icon: '🔐' },
  { id: 108, name: '配線の接続コード入力', pct: 5,  kind: 'seq',   n: 5, icon: '🧵' },
  { id: 109, name: '冷却ファンの回転',     pct: 5,  kind: 'alt',   n: 20, icon: '🌀' },
  { id: 110, name: '発電機のクランク',     pct: 10, kind: 'alt',   n: 30, icon: '⚙️' },
  { id: 111, name: 'ポンプの加圧',         pct: 5,  kind: 'alt',   n: 16, icon: '🛢️' },
  { id: 112, name: 'コンテナの封印',       pct: 5,  kind: 'space', n: 6, icon: '📦' },
  { id: 113, name: 'バルブの調整',         pct: 5,  kind: 'space', n: 8, icon: '🎛️' },
  { id: 114, name: 'アンテナの調整',       pct: 5,  kind: 'space', n: 6, icon: '📡' },
  { id: 115, name: '点火システムの調整',   pct: 5,  kind: 'space', n: 10, icon: '🚀' },
];
SPACE_TASKS.forEach(d => { d.theme = 'space'; TASK_DEFS.push(d); });
const tasksOf = (theme) => TASK_DEFS.filter(d => d.theme === theme);
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

// ===== 孤島レイアウト (3種・どれも11部屋: 大2 中4 小5) =====
// 部屋のテーマ番号 th (クライアントの THEMES と対応) とゾーン
//  0 キャンプ(拠点)[camp] 1 大きな浜辺[beach] 2 深い森[forest] 3 竹林[forest] 4 滝つぼ[forest]
//  5 難破船[beach] 6 灯台[beach] 7 岩場の入り江[beach] 8 マングローブ[forest] 9 見張り台[forest] 10 漂着物の浜[beach]
// 大: camp, beach / 中: forest, bamboo, wreck, light / 小: falls, mangrove, tower, rocks, drift
const ROOM_TH = { camp: 0, beach: 1, forest: 2, bamboo: 3, falls: 4, wreck: 5, light: 6, rocks: 7, mangrove: 8, tower: 9, drift: 10,
  // 宇宙船の部屋 (クライアントの THEMES[20〜30])
  cafeteria: 20, storage: 21, upperEngine: 22, lowerEngine: 23, reactor: 24, nav: 25, medbay: 26, security: 27, electrical: 28, o2: 29, comms: 30 };
const LAYOUTS = [
  {
    theme: 'island', name: 'ヤシの入り江', desc: '拠点が北にある基本の島。南に大きな浜辺、西に灯台と難破船。',
    rooms: {
      camp:     { x: 22, y: 2,  w: 14, h: 10 }, // 【大】拠点 (集合の鐘)
      beach:    { x: 28, y: 22, w: 12, h: 12 }, // 【大】大きな浜辺
      wreck:    { x: 2,  y: 2,  w: 10, h: 8 },  // 【中】難破船
      forest:   { x: 2,  y: 16, w: 9,  h: 9 },  // 【中】深い森
      light:    { x: 2,  y: 29, w: 11, h: 9 },  // 【中】灯台
      bamboo:   { x: 44, y: 10, w: 10, h: 10 }, // 【中】竹林
      falls:    { x: 14, y: 11, w: 7,  h: 6 },  // 【小】滝つぼ (行き止まり)
      mangrove: { x: 12, y: 20, w: 6,  h: 5 },  // 【小】マングローブ (行き止まり)
      tower:    { x: 16, y: 27, w: 8,  h: 7 },  // 【小】見張り台 (袋小路)
      rocks:    { x: 37, y: 2,  w: 7,  h: 6 },  // 【小】岩場の入り江
      drift:    { x: 38, y: 28, w: 8,  h: 7 },  // 【小】漂着物の浜
    },
    corridors: [
      [[22, 5], [11, 5]], [[17, 5], [17, 11]], [[6, 9], [6, 16]], [[5, 24], [5, 29]], [[8, 21], [12, 21]],
      [[11, 33], [28, 33]], [[20, 31], [20, 33]], [[30, 11], [30, 22]], [[36, 5], [44, 5], [44, 10]],
      [[53, 15], [53, 30], [45, 30]], [[38, 30], [39, 30]],
    ],
    optional: [
      [[20, 16], [20, 24]], [[18, 16], [18, 20]], [[30, 16], [37, 16], [37, 10]], [[49, 17], [49, 28]],
      [[7, 17], [12, 17], [12, 15], [14, 15]], [[37, 28], [37, 33]],
    ],
    pillars: [[31, 26, 1, 4], [34, 29, 2, 2], [5, 18, 2, 2], [46, 14, 2, 1], [18, 30, 1, 2], [26, 8, 1, 2], [33, 8, 1, 2]],
  },
  {
    theme: 'island', name: '双子の浜', desc: '拠点が島の真ん中。北東の灯台と南東の浜辺、2つの海岸を結ぶ環状ルート。',
    rooms: {
      camp:     { x: 25, y: 14, w: 14, h: 11 },
      beach:    { x: 46, y: 27, w: 15, h: 11 },
      wreck:    { x: 2,  y: 2,  w: 11, h: 9 },
      forest:   { x: 4,  y: 16, w: 10, h: 10 },
      light:    { x: 51, y: 2,  w: 11, h: 9 },
      bamboo:   { x: 48, y: 14, w: 10, h: 9 },
      falls:    { x: 17, y: 3,  w: 7,  h: 6 },
      tower:    { x: 36, y: 3,  w: 7,  h: 6 },
      mangrove: { x: 16, y: 30, w: 8,  h: 6 },
      rocks:    { x: 2,  y: 31, w: 8,  h: 7 },
      drift:    { x: 33, y: 31, w: 8,  h: 6 },
    },
    corridors: [
      [[25, 19], [13, 19]], [[8, 16], [8, 10]], [[12, 5], [17, 5]], [[20, 8], [20, 12], [28, 12], [28, 14]],
      [[36, 14], [36, 11], [39, 11], [39, 8]], [[42, 5], [51, 5]], [[55, 10], [55, 14]], [[48, 18], [38, 18]],
      [[52, 22], [52, 27]], [[46, 33], [40, 33]], [[36, 31], [36, 24]], [[6, 25], [6, 31]], [[9, 33], [16, 33]],
    ],
    optional: [
      [[23, 33], [33, 33]], [[23, 4], [36, 4]], [[28, 24], [28, 28], [20, 28], [20, 30]], [[60, 10], [60, 27]],
      [[11, 16], [11, 12], [19, 12], [19, 9]],
    ],
    pillars: [[29, 16, 1, 2], [35, 22, 1, 2], [50, 31, 2, 2], [56, 29, 1, 3], [8, 20, 2, 2], [55, 5, 2, 1], [6, 5, 1, 2]],
  },
  {
    theme: 'island', name: '霧の密林', desc: '西半分が深い森。道が細く曲がりくねり、見通しの悪い行き止まりが多い。',
    rooms: {
      camp:     { x: 25, y: 15, w: 14, h: 10 },
      beach:    { x: 44, y: 27, w: 17, h: 11 },
      forest:   { x: 3,  y: 14, w: 11, h: 11 },
      bamboo:   { x: 22, y: 2,  w: 11, h: 9 },
      wreck:    { x: 50, y: 3,  w: 11, h: 9 },
      light:    { x: 20, y: 29, w: 11, h: 9 },
      falls:    { x: 5,  y: 3,  w: 8,  h: 7 },
      tower:    { x: 38, y: 3,  w: 7,  h: 6 },
      mangrove: { x: 44, y: 15, w: 7,  h: 7 },
      drift:    { x: 54, y: 16, w: 7,  h: 6 },
      rocks:    { x: 4,  y: 30, w: 8,  h: 7 },
    },
    corridors: [
      [[25, 20], [13, 20]], [[8, 14], [8, 9]], [[12, 6], [22, 6]], [[28, 10], [28, 15]], [[32, 5], [38, 5]],
      [[44, 6], [50, 6]], [[57, 11], [57, 16]], [[57, 21], [57, 27]], [[44, 33], [30, 33]], [[20, 33], [11, 33]],
      [[7, 30], [7, 24]], [[38, 18], [44, 18]],
    ],
    optional: [
      [[50, 18], [54, 18]], [[30, 24], [30, 29]], [[41, 8], [41, 12], [47, 12], [47, 15]],
      [[13, 23], [17, 23], [17, 31], [20, 31]], [[48, 21], [48, 27]],
    ],
    pillars: [[27, 6, 1, 1], [30, 4, 1, 2], [48, 31, 2, 2], [55, 34, 2, 1], [7, 18, 2, 2], [54, 6, 1, 2], [24, 32, 1, 1]],
  },
];

// ===== 宇宙船レイアウト (船の形: 左が機関部、右端が艦橋。11部屋: 大2 中4 小5) =====
LAYOUTS.push({
  theme: 'space', name: '宇宙船', desc: 'SF風の宇宙船。左に2基のエンジンと原子炉、右端に操舵室。中央の食堂に緊急会議ボタン。',
  hub: 'cafeteria', crates: ['storage', 'upperEngine', 'lowerEngine', 'comms'],
  rooms: {
    cafeteria:   { x: 24, y: 4,  w: 14, h: 10 }, // 【大】食堂 (緊急会議ボタン)
    storage:     { x: 26, y: 24, w: 13, h: 11 }, // 【大】貯蔵庫
    upperEngine: { x: 2,  y: 4,  w: 10, h: 8 },  // 【中】上部エンジン
    lowerEngine: { x: 2,  y: 28, w: 10, h: 8 },  // 【中】下部エンジン
    reactor:     { x: 2,  y: 15, w: 9,  h: 10 }, // 【中】原子炉
    nav:         { x: 52, y: 14, w: 10, h: 11 }, // 【中】操舵室 (船首)
    medbay:      { x: 15, y: 12, w: 7,  h: 6 },  // 【小】医務室
    security:    { x: 14, y: 19, w: 6,  h: 5 },  // 【小】警備室
    electrical:  { x: 15, y: 26, w: 8,  h: 5 },  // 【小】電気室 (袋小路)
    o2:          { x: 42, y: 6,  w: 7,  h: 6 },  // 【小】酸素室
    comms:       { x: 42, y: 28, w: 8,  h: 6 },  // 【小】通信室
  },
  corridors: [
    [[24, 8], [12, 8]], [[6, 12], [6, 15]], [[6, 25], [6, 28]], [[12, 33], [26, 33]], [[18, 8], [18, 12]],
    [[11, 21], [14, 21]], [[19, 30], [19, 33]], [[31, 14], [31, 24]], [[38, 8], [42, 8]],
    [[48, 9], [55, 9], [55, 14]], [[56, 25], [56, 31], [50, 31]], [[42, 30], [39, 30]],
  ],
  optional: [[[17, 17], [17, 19]], [[39, 19], [52, 19]], [[23, 28], [26, 28]], [[50, 29], [53, 29], [53, 25]], [[8, 12], [8, 13], [12, 13], [12, 12]]],
  pillars: [[27, 6, 1, 2], [34, 6, 1, 2], [27, 11, 1, 1], [35, 11, 1, 1], [29, 27, 2, 2], [34, 30, 2, 2], [8, 19, 2, 2], [57, 18, 2, 1], [4, 6, 2, 1], [4, 31, 2, 1]],
  taskRooms: {
    stations: { fuse: 'electrical', battery: 'lowerEngine', core: 'reactor' },
    101: 'nav', 102: 'nav', 103: 'o2', 104: 'upperEngine', 105: 'storage', 106: 'electrical', 107: 'comms', 108: 'security',
    109: 'medbay', 110: 'upperEngine', 111: 'o2', 112: 'storage', 113: 'reactor', 114: 'comms', 115: 'lowerEngine',
  },
});

// タスク・置き場をどの部屋に置くか (森ゾーン: forest/bamboo/falls/mangrove/tower)
const TASK_ROOMS = {
  stations: { wood: 'forest', nut: 'falls', sos: 'wreck', scrap: 'drift' }, // 拾う場所
  1: 'camp', 2: 'camp',       // 薪・木の実は中央の拠点へ届ける
  3: 'light', 4: 'tower',
  5: 'forest', 6: 'forest', 7: 'bamboo', 8: 'tower', 9: 'mangrove', 10: 'bamboo', 13: 'falls',
  11: 'wreck', 12: 'rocks', 14: 'rocks', 15: 'beach',
};

function genMap(layoutIdx, seedIn) {
  const L = LAYOUTS[layoutIdx] || LAYOUTS[0];
  const seed = seedIn != null ? seedIn : Math.floor(Math.random() * 2147483647);
  const rng = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  // プレビューと一致させるため反転はしない (通路と部屋サイズだけ毎試合少し変わる)
  const tc = c => c, tr = r => r;
  const trect = ([x, y, w, h]) => [x, y, w, h];

  const g = Array.from({ length: ROWS }, () => Array(COLS).fill(true));
  const wall = (c, r) => c < 0 || r < 0 || c >= COLS || r >= ROWS || g[r][c];
  const carve = (c0, r0, c1, r1) => {
    for (let r = Math.max(1, Math.min(r0, r1)); r <= Math.min(ROWS - 2, Math.max(r0, r1)); r++)
      for (let c = Math.max(1, Math.min(c0, c1)); c <= Math.min(COLS - 2, Math.max(c0, c1)); c++) g[r][c] = false;
  };
  const carvePath = (pts) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = [tc(pts[i][0]), tr(pts[i][1])], b = [tc(pts[i + 1][0]), tr(pts[i + 1][1])];
      // 区間の向き(右→左/下→上)に関係なく、両端を1マスずつ広げて3マス幅で掘る (以前は逆向き区間の端が縮み、宇宙船右下が行き止まりになっていた)
      carve(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1, Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1);
    }
  };

  // 部屋 (サイズを ±1 セル揺らして毎回少し違う形に)
  const R = {};
  for (const key in L.rooms) {
    const o = L.rooms[key];
    const fixed = key === (L.hub || 'camp');
    const jx = fixed ? 0 : ri(-1, 0), jw = fixed ? 0 : ri(0, 1);
    const jy = fixed ? 0 : ri(-1, 0), jh = fixed ? 0 : ri(0, 1);
    const [x, y, w, h] = trect([o.x + jx, o.y + jy, o.w + jw - jx, o.h + jh - jy]);
    R[key] = { key, x, y, w, h, th: ROOM_TH[key] };
    carve(x, y, x + w - 1, y + h - 1);
  }
  for (const p of L.corridors) carvePath(p);
  // 抜け道は 2〜4 本をランダムに開通
  const opt = L.optional.slice().sort(() => rng() - 0.5).slice(0, ri(2, 4));
  for (const p of opt) carvePath(p);

  // 柱・仕切り
  for (const pr of L.pillars) {
    const [x, y, w, h] = trect(pr);
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (r > 0 && c > 0 && r < ROWS - 1 && c < COLS - 1) g[r][c] = true;
  }
  // 大部屋にランダムな木箱 (1x1) を少し
  for (const key of (L.crates || ['beach', 'forest', 'light', 'drift'])) {
    const rm = R[key];
    for (let n = ri(0, 2); n > 0; n--) {
      const c = ri(rm.x + 2, rm.x + rm.w - 3), r = ri(rm.y + 2, rm.y + rm.h - 3);
      g[r][c] = true;
    }
  }

  const hall = R[L.hub || 'camp'];
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
  const TR = L.taskRooms || TASK_ROOMS, theme = L.theme || 'island';
  for (const it in TR.stations) stations[it] = spot(TR.stations[it]);
  const tasks = {};
  for (const d of tasksOf(theme)) tasks[d.id] = spot(TR[d.id]);
  // インポスター専用のワープ地点 (6か所。クルーには見えない)
  const WR = theme === 'space' ? ['upperEngine', 'lowerEngine', 'reactor', 'nav', 'security', 'comms'] : ['wreck', 'forest', 'light', 'bamboo', 'rocks', 'drift'];
  const warps = WR.filter(k => R[k]).map(k => ({ ...spot(k), th: R[k].th }));
  // 宇宙船: 電気のショートで火花が散る配線 (5か所)
  const shorts = theme === 'space' ? ['electrical', 'upperEngine', 'nav', 'comms', 'storage'].map(k => ({ ...spot(k), th: R[k].th })) : [];
  // 孤島: 水が氾濫しうる通路 (通路の途中の 3x3 マス)
  const floods = [];
  const inAnyRoom = (c, r) => Object.values(R).some(rm => c >= rm.x && c < rm.x + rm.w && r >= rm.y && r < rm.y + rm.h);
  if (theme === 'island') for (const pts of [...L.corridors, ...opt]) for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 4) continue;
    const mc = Math.round((a[0] + b[0]) / 2), mr = Math.round((a[1] + b[1]) / 2), z = { c0: mc - 1, r0: mr - 1, c1: mc + 1, r1: mr + 1 };
    let ok = true; for (let r = z.r0; r <= z.r1; r++) for (let c = z.c0; c <= z.c1; c++) if (wall(c, r) || !reach.has(r * COLS + c) || inAnyRoom(c, r)) ok = false;
    if (ok && !floods.some(f => Math.abs(f.c0 - z.c0) < 3 && Math.abs(f.r0 - z.r0) < 3)) floods.push(z);
  }

  return {
    seed, layout: layoutIdx, name: L.name, theme, grid: g, rows: g.map(row => row.map(v => (v ? '1' : '0')).join('')),
    rooms: Object.values(R).map(r => [r.x, r.y, r.w, r.h, r.th]),
    button: cp(bc.c, bc.r), stations, tasks, warps, shorts, floods,
  };
}
// GENMAP>>

// ロビーのプレビュー用 (固定シードで1回だけ生成)
let MAP_PREVIEWS = null;
const mapPayload = (m) => ({ seed: m.seed, layout: m.layout, name: m.name, theme: m.theme, rows: m.rows, rooms: m.rooms, BUTTON: m.button, STATIONS: m.stations, TPOS: m.tasks });

function resolveWalls(grid, p, extra) {
  const isWall = (c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : (grid[r][c] || (extra ? extra(c, r) : false));
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
    code, players: new Map(), joinCounter: 0, impCount: 1, impN: 1, detCount: 1, mapIdx: 0, lchat: [],
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
const hasItem = (p, t) => p.item === t;
const removeItem = (p, t) => { if (!hasItem(p, t)) return false; p.item = null; return true; };
function cancelMini(p) { if (p.mini) { p.mini = null; io.to(p.id).emit('miniCancel'); } }
const tpos = (R, id) => R.map.tasks[id];

function ringPos(R, i, n, rad) {
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  return { x: R.map.button.x + Math.cos(a) * rad, y: R.map.button.y + Math.sin(a) * rad };
}

// ---------- タスク ----------
function newTask(p) {
  const all = tasksOf(p.theme || 'island'); // 試合のマップのテーマのタスクだけ
  let pool = all.filter(t => !p.tasks.includes(t.id) && !p.doneTasks.has(t.id));
  if (!pool.length) { p.doneTasks.clear(); pool = all.filter(t => !p.tasks.includes(t.id)); }
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
  p.alive = true; p.item = null; p.mini = null; p.input = { x: 0, y: 0 };
  p.tasks = []; p.doneTasks = new Set(); p.moving = false; p.emUsed = false;
}

function startGame(R) {
  const part = participants(R);
  if (part.length < MIN_PLAYERS) return;
  const now = Date.now();
  R.map = genMap(R.mapIdx);
  R.mapMsg = mapPayload(R.map);
  rEmit(R, 'map', R.mapMsg);
  R.phase = 'playing'; R.progress = 0; R.result = null; R.bodies = []; R.meeting = null; resetSab(R);
  R.endsAt = now + GAME_MS; R.noMeetingUntil = now + BTN_LOCK; R.freezeUntil = now + FREEZE_MS;
  const n = part.length;
  R.impN = Math.min(R.impCount, maxImp(n));
  R.crewTotal = n;
  const imps = new Set(part.slice().sort(() => Math.random() - 0.5).slice(0, R.impN));
  // クルーの中からランダムに探偵を選ぶ (役職はクルー陣営のまま)
  const dets = new Set(part.filter(p => !imps.has(p)).sort(() => Math.random() - 0.5).slice(0, R.detCount));
  part.forEach((p, i) => {
    resetPlayer(R, p, i, n); p.theme = R.map.theme;
    p.role = imps.has(p) ? 'imposter' : 'crew';
    p.sub = dets.has(p) ? 'detective' : null; p.trail = []; p.lastTrail = 0;
    p.killReady = now + FIRST_KILL_CD; p.sabReady = now + SAB_CD; p.progReady = now + PROG_CD; p.warpReady = 0;
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
  R.phase = 'lobby'; R.meeting = null; R.bodies = []; R.result = null; R.remainAtEnd = GAME_MS; R.progress = 0; resetSab(R);
  R.map = null; R.mapMsg = null;
  const all = [...R.players.values()];
  all.forEach((p, i) => {
    p.late = false; p.ready = false; p.role = null; p.sub = null; p.trail = []; p.alive = true;
    p.item = null; p.tasks = []; p.mini = null; p.input = { x: 0, y: 0 }; p.moving = false;
    const s = lobbySpawn(i, all.length); p.x = s.x; p.y = s.y;
  });
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
  // 死体報告の場合は直近の死体を犠牲者として記録
  const victim = reason === 'body' && R.bodies.length > 0 ? R.bodies[R.bodies.length - 1] : null;
  R.meeting = { mode: 'discuss', startAt: now, modeEnds: now + DISCUSS_MS, votes: new Map(), reason, callerName: caller.name, result: null, victim };
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
  const votes = [...m.votes].filter(([vid]) => R.players.has(vid)); // 結果発表で全員の指さしを公開する
  m.result = { ej, tally: Object.entries(counts), skip, left, votes };
  m.mode = 'result'; m.modeEnds = now + RESULT_MS;
}

function endMeeting(R, now) {
  const m = R.meeting;
  const paused = now - m.startAt;
  R.endsAt += paused;
  if (R.sab.dark > m.startAt) R.sab.dark += paused;      // 会議中は妨害のタイマーも止まる
  if (R.sab.short) R.sab.short.endsAt += paused;
  if (R.sab.flood) R.sab.flood.endsAt += paused;
  R.phase = 'playing'; R.meeting = null; R.bodies = [];
  for (const q of R.players.values()) q.trail = []; // 会議で円形に並べ直したぶんの移動は記録しない
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
  const sb = R.sab;
  // 水の氾濫: 水たまりの前で SPACE を連打して掻き出す (30回で1か所解消。複数人で協力可)
  if (sb.flood && p.alive) {
    const z = sb.flood.zones.find(z => !z.done && nearRect(p, z, REACH));
    if (z) {
      z.bail++;
      if (z.bail >= BAIL_NEED) {
        z.done = true; rebuildFlood(R);
        rEmit(R, 'toast', { text: `🌊 ${p.name}が水を掻き出した! 通路が通れるようになった`, kind: 'good' }); rEmit(R, 'sfx', 'done');
        if (sb.flood.zones.every(q => q.done)) { sb.flood = null; rebuildFlood(R); rEmit(R, 'toast', { text: '🌊 氾濫がすべておさまった!', kind: 'good' }); }
      } else if (z.bail % 5 === 0) io.to(p.id).emit('sfx', 'click');
      return;
    }
  }
  // 電気のショート中: 通常タスク・会議ボタンは使えず、配線の修理だけができる
  if (sb.short) {
    const i = sb.short.spots.findIndex(q => !q.done && near(p, q, REACH));
    if (i >= 0) {
      if (!p.alive) { toast(p, '幽霊は修理できない', 'error'); return; }
      if (p.role === 'imposter') { toast(p, 'インポスターは配線を修理できない', 'error'); return; }
      p.mini = { wire: i, kind: 'wire', start: now }; p.input = { x: 0, y: 0 }; p.moving = false;
      io.to(p.id).emit('miniStart', { wire: i }); return;
    }
    if (p.tasks.some(id => near(p, tpos(R, id), REACH)) || near(p, R.map.button, BTN_RANGE) || Object.values(R.map.stations).some(st => near(p, st, REACH)))
      toast(p, '⚡ 電気がショート中! 先にショートした配線を直そう', 'error');
    return;
  }
  // 運搬中: 届け先に着いたら設置。それ以外のミニゲーム系タスクは手がふさがっていて行えない
  if (p.item) {
    const dest = p.tasks.find(id => defOf(id).item === p.item && near(p, tpos(R, id), REACH));
    if (dest) { removeItem(p, p.item); completeTask(R, p, dest); return; }
    const other = p.tasks.find(id => defOf(id).kind !== 'carry' && near(p, tpos(R, id), REACH));
    if (other) { toast(p, `${ITEM_NAME[p.item]}を運搬中は他の作業ができない (Q長押しで運搬をやめる)`, 'error'); return; }
  }
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
    if (p.item) { toast(p, '手がふさがっている! 先に設置しよう', 'error'); return; }
    p.item = d.item;
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
  R.bodies.push({ id: R.nextBody++, x: Math.round(best.x), y: Math.round(best.y), c: best.color, name: best.name });
  sendDetTrace(R, best, now);
  p.x = best.x; p.y = best.y; p.killReady = now + KILL_CD;
  // 被害者にだけキルカットシーン。実行者は演出なしで即操作可能
  io.to(best.id).emit('killCut', { kc: p.color, ka: p.acc, kn: p.name, vc: best.color, va: best.acc, vn: best.name });
  io.to(best.id).emit('sfx', 'kill');
  io.to(p.id).emit('sfx', 'click');
  checkWin(R);
}

// ---------- 探偵 ----------
function sendDetTrace(R, victim, now) {
  const path = (victim.trail || []).filter(q => now - q.t <= TRAIL_MS).map(q => [q.x, q.y, now - q.t]); // [x, y, 死亡の何ms前か]
  path.push([Math.round(victim.x), Math.round(victim.y), 0]);
  const msg = { id: victim.id, name: victim.name, c: victim.color, path, ttl: DET_TRACE_MS };
  for (const d of participants(R)) if (d.sub === 'detective' && d.alive && d !== victim) io.to(d.id).emit('detTrace', msg);
}
// ---------- 妨害 (サボタージュ) ----------
function resetSab(R) { R.sab = { dark: 0, short: null, flood: null, cells: new Set() }; }
const sabActive = (R, now) => R.sab.dark > now || !!R.sab.short || !!R.sab.flood;
function nearRect(p, z, rng) { // 点と矩形(マス単位)の距離
  const x0 = z.c0 * CELL, y0 = z.r0 * CELL, x1 = (z.c1 + 1) * CELL, y1 = (z.r1 + 1) * CELL;
  return Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(y0 - p.y, 0, p.y - y1)) <= rng;
}
function rebuildFlood(R) {
  R.sab.cells = new Set();
  if (R.sab.flood) for (const z of R.sab.flood.zones) if (!z.done) for (let r = z.r0; r <= z.r1; r++) for (let c = z.c0; c <= z.c1; c++) R.sab.cells.add(r * COLS + c);
}
function doSabotage(R, p, kind) {
  if (R.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter') return;
  const now = Date.now(), def = SABS[kind];
  if (!def) return;
  if (def.theme && def.theme !== R.map.theme) { toast(p, `「${def.name}」はこのマップでは使えない`, 'error'); return; }
  if (kind === 'prog') { // 独立した進捗妨害: ほかの妨害が進行中でも使える
    if (now < (p.progReady || 0)) { toast(p, `進捗妨害はあと${Math.ceil((p.progReady - now) / 1000)}秒で使える`, 'error'); return; }
    for (const q of participants(R)) if (q.role === 'imposter') q.progReady = now + PROG_CD;
    R.progress = Math.max(0, R.progress - SAB_PCT);
    rEmit(R, 'sfx', 'alarm'); rEmit(R, 'toast', { text: `📉 妨害工作! タスク進捗が${SAB_PCT}%低下`, kind: 'error' });
    return;
  }
  if (now < p.sabReady) { toast(p, `妨害はあと${Math.ceil((p.sabReady - now) / 1000)}秒で使える`, 'error'); return; }
  if (sabActive(R, now)) { toast(p, 'ほかの妨害が進行中', 'error'); return; }
  let zones = null;
  if (kind === 'flood') { // 誰も立っていない通路を選んで水没させる
    const empty = R.map.floods.filter(z => !participants(R).some(q => nearRect(q, z, PR + 4)));
    zones = empty.sort(() => Math.random() - .5).slice(0, FLOOD_N).map(z => ({ ...z, bail: 0, done: false }));
    if (!zones.length) { toast(p, '今は水を氾濫させられる通路がない', 'error'); return; }
  }
  for (const q of participants(R)) if (q.role === 'imposter') q.sabReady = now + SAB_CD; // インポスター共通のクールタイム (進捗は減らさない)
  if (kind === 'dark') R.sab.dark = now + DARK_MS;
  else if (kind === 'short') {
    R.sab.short = { endsAt: now + SHORT_MS, need: SHORT_NEED, fixed: 0, spots: R.map.shorts.slice(0, SHORT_NEED).map(q => ({ x: q.x, y: q.y, th: q.th, done: false })) };
    for (const q of participants(R)) if (q.mini) cancelMini(q); // 作業中のタスクは中断
  } else if (kind === 'flood') { R.sab.flood = { endsAt: now + FLOOD_MAX_MS, zones }; rebuildFlood(R); }
  rEmit(R, 'sfx', 'alarm');
  const msg = { dark: '🌑 暗闇! 視界がほとんど効かない', short: `⚡ 電気がショート! 2分以内に配線を${SHORT_NEED}か所直さないと酸素が尽きる`, flood: '🌊 水が氾濫! 水たまりの前で SPACE を連打して掻き出そう' }[kind];
  rEmit(R, 'toast', { text: msg, kind: 'error' });
}
function tickSab(R, now) {
  const sb = R.sab;
  if (sb.short && now >= sb.short.endsAt) { // 時間切れ: 酸素が尽きてクルー全滅
    sb.short = null;
    for (const q of participants(R)) if (q.role === 'crew' && q.alive) { q.alive = false; cancelMini(q); }
    endGame(R, 'imposter', '⚡ ショートを直しきれず酸素が尽きた… クルー全滅');
  }
  if (sb.flood && now >= sb.flood.endsAt) { sb.flood = null; rebuildFlood(R); rEmit(R, 'toast', { text: '🌊 水が自然に引いた', kind: 'info' }); }
}
function doWarp(R, p, idx) {
  if (R.phase !== 'playing' || p.late || !p.alive || p.role !== 'imposter' || p.mini) return;
  const now = Date.now(), ws = R.map.warps, to = ws[idx | 0];
  if (!to) return;
  if (!ws.some(w => near(p, w, WARP_RANGE))) { toast(p, 'ワープ地点の上で使おう', 'error'); return; }
  if (now < (p.warpReady || 0)) { toast(p, `ワープはあと${Math.ceil((p.warpReady - now) / 1000)}秒`, 'error'); return; }
  p.x = to.x; p.y = to.y + 20; p.warpReady = now + WARP_CD;
  io.to(p.id).emit('sfx', 'click');
}
function sabView(R, now) {
  const sb = R.sab; if (!sb) return null;
  return {
    dark: Math.max(0, sb.dark - now),
    short: sb.short ? { left: Math.max(0, sb.short.endsAt - now), need: sb.short.need, fixed: sb.short.fixed, spots: sb.short.spots } : null,
    flood: sb.flood ? { zones: sb.flood.zones.filter(z => !z.done).map(({ c0, r0, c1, r1, bail }) => ({ c0, r0, c1, r1, bail })), need: BAIL_NEED } : null,
  };
}

// ---------- ループ ----------
function tickLobby(R, dt) {
  for (const p of R.players.values()) {
    const len = Math.hypot(p.input.x, p.input.y);
    p.moving = len > 0;
    if (!len) continue;
    const dx = p.input.x / len, dy = p.input.y / len;
    p.x = clamp(p.x + dx * SPEED * dt, LOBBY.x0 + PR, LOBBY.x1 - PR);
    p.y = clamp(p.y + dy * SPEED * dt, LOBBY.y0 + PR, LOBBY.y1 - PR);
    if (dx !== 0) p.face = dx > 0 ? 1 : -1;
  }
}
function tickRoom(R, now, dt) {
  if (R.phase === 'lobby') tickLobby(R, dt);
  else if (R.phase === 'playing') {
    for (const p of R.players.values()) {
      if (p.late) continue;
      if (p.alive && now - (p.lastTrail || 0) >= TRAIL_STEP) { // 探偵用: 直近5秒の座標ログ (サーバーだけが保持)
        p.lastTrail = now - (p.lastTrail || 0) > TRAIL_STEP * 2 ? now : p.lastTrail + TRAIL_STEP; // 平均してちょうど100msごと (サーバーは30回/秒)
        (p.trail = p.trail || []).push({ x: Math.round(p.x), y: Math.round(p.y), t: now });
        while (p.trail.length && now - p.trail[0].t > TRAIL_MS) p.trail.shift();
      }
      if (p.mini && now - p.mini.start > MINI_TIMEOUT) cancelMini(p);
      if (p.mini || now < R.freezeUntil) { p.moving = false; continue; }
      const len = Math.hypot(p.input.x, p.input.y);
      p.moving = len > 0;
      if (len > 0) {
        const dx = p.input.x / len, dy = p.input.y / len;
        const ghost = !p.alive;
        const sp = SPEED * (ghost ? GHOST_MULT : 1);
        p.x += dx * sp * dt; p.y += dy * sp * dt;
        if (!ghost) resolveWalls(R.map.grid, p, R.sab.flood ? (c, r) => R.sab.cells.has(r * COLS + c) : null); // 幽霊は壁も水も通り抜け
        p.x = clamp(p.x, PR, W - PR); p.y = clamp(p.y, PR, H - PR);
        if (dx !== 0) p.face = dx > 0 ? 1 : -1;
      }
    }
    tickSab(R, now);
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
  const base = { ph: R.phase, remain, prog: Math.round(R.progress * 10) / 10, result: R.result, ic: R.impN, code: R.code, sab: R.phase === 'lobby' ? null : sabView(R, now) };
  let lobby = null;
  if (R.phase === 'lobby') {
    lobby = {
      list: [...R.players.values()].sort((a, b) => a.joinOrder - b.joinOrder).map(p => ({ id: p.id, name: p.name, c: p.color, acc: p.acc, ready: p.ready, host: p.id === host,
        x: Math.round(p.x), y: Math.round(p.y), mv: p.moving, f: p.face, a: true, pid: p.pid })),
      imp: R.impCount, max: maxImp(R.players.size), map: R.mapIdx, det: R.detCount,
    };
  }
  const pv = R.phase === 'lobby' ? null : part.map(p => ({ id: p.id, name: p.name, c: p.color, acc: p.acc, x: Math.round(p.x), y: Math.round(p.y), a: p.alive, mv: p.moving, f: p.face, item: p.item || null, pid: p.pid }));
  for (const v of R.players.values()) {
    const ghost = !v.alive || v.late || R.phase === 'end';
    const msg = {
      ...base,
      me: {
        role: v.role, det: v.sub === 'detective', alive: v.alive, late: v.late, ready: v.ready, host: v.id === host,
        tasks: v.tasks, item: v.item || null,
        kcd: Math.max(0, (v.killReady || 0) - now), scd: Math.max(0, (v.sabReady || 0) - now), pcd: Math.max(0, (v.progReady || 0) - now),
        em: v.emUsed, emLock: Math.max(0, R.noMeetingUntil - now),
        mates: v.role === 'imposter' ? part.filter(x => x.role === 'imposter' && x !== v).map(x => x.id) : [],
        warps: v.role === 'imposter' && R.map ? R.map.warps : null, wcd: Math.max(0, (v.warpReady || 0) - now), // ワープ地点はインポスターだけに送る
      },
    };
    if (lobby) msg.lobby = lobby;
    else {
      msg.players = ghost ? pv : pv.filter(p => p.a);
      msg.bodies = R.bodies;
      if (R.phase === 'meeting') {
        const m = R.meeting;
        msg.meet = {
          mode: m.mode, t: Math.max(0, m.modeEnds - now), reason: m.reason, caller: m.callerName, victim: m.victim || null,
          roster: part.map(p => ({ id: p.id, name: p.name, c: p.color, acc: p.acc, a: p.alive, voted: m.votes.has(p.id) })), theme: R.map.theme,
          my: m.votes.get(v.id) || null, res: m.result,
        };
      }
      if (R.phase === 'end') msg.roster = part.map(p => ({ id: p.id, name: p.name, c: p.color, role: p.role, det: p.sub === 'detective', a: p.alive }));
    }
    io.to(v.id).volatile.emit('state', msg);
  }
}

MAP_PREVIEWS = LAYOUTS.map((L, i) => ({ name: L.name, desc: L.desc, ...mapPayload(genMap(i, 12345 + i)) })); // theme も含む

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const R of rooms.values()) tickRoom(R, now, dt);
}, 1000 / TICK_RATE);

// ---------- ロビーチャット / エモート ----------
const EMOTES = ['wave', 'heart', 'angry', 'wow', 'good', 'lol', 'sad', 'q'];
function lobbySys(R, t) { const m = { sys: true, t }; R.lchat.push(m); R.lchat = R.lchat.slice(-40); rEmit(R, 'lchat', m); }
// ---------- Socket.io ----------
function sendReqs(pid) { // 届いているフレンド申請を本人に送る
  const u = userOf(pid), e = presence.get(pid); if (!u || !e) return;
  io.to(e.sid).emit('friendReqs', (u.reqs || []).map(x => ({ pid: x, name: nameOf(x) })).filter(r => r.name));
}
function sendAcks(pid) { // 承認された通知を本人に送って消す
  const u = userOf(pid), e = presence.get(pid); if (!u || !e || !(u.acks || []).length) return;
  io.to(e.sid).emit('friendAcks', u.acks); u.acks = []; saveUsers();
}
const presence = new Map(); // pid -> { sid, name, known:Set<pid> }

// ---------- ユーザーネーム登録 (全体で重複禁止。サーバーのファイルに保存) ----------
// 比較は NFKC 正規化 + 小文字化 + 空白除去 (例: 「Ｋｅｉｔａ」「keita」「KEITA」は同じ名前とみなす)
const DATA_DIR = process.env.DOA_DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = { byName: {}, byPid: {} }; // byName[norm] = { pid, name, reqs:[pid], acks:[{pid,name}] } / byPid[pid] = norm
try { const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); if (j && j.byName && j.byPid) users = j; } catch (e) {}
let saveT = 0;
function saveUsers() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = USERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(users)); fs.renameSync(tmp, USERS_FILE); }
    catch (e) { console.error('users.json save failed', e.message); }
  }, 500);
}
const normName = (n) => String(n || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const NAME_RE = /^[\p{L}\p{N}_ー・]{2,10}$/u;
const userOf = (pid) => { const k = users.byPid[pid]; return k ? users.byName[k] : null; };
const nameOf = (pid) => { const u = userOf(pid); return u ? u.name : null; };
const validPid = (v) => typeof v === 'string' && /^[a-z0-9]{8,40}$/i.test(v);
const cleanName = (v) => String(v || '').replace(/[<>]/g, '').trim().slice(0, 10);
function addPlayer(socket, R, d) {
  R.joinCounter += 1;
  const used = new Set([...R.players.values()].map(p => p.color));
  const color = (d && COLORS.includes(d.color) && !used.has(d.color)) ? d.color : (COLORS.find(c => !used.has(c)) || COLORS[0]);
  const name = String((d && d.name) || '').replace(/[<>]/g, '').trim().slice(0, 10) || ('P' + R.joinCounter);
  const late = R.phase !== 'lobby';
  const p = {
    id: socket.id, pid: socket.data.pid || null, joinOrder: R.joinCounter, name, color, acc: ACCS.includes(d && d.acc) ? d.acc : '',
    x: 0, y: 0, face: 1, moving: false, ready: false, late, role: null, alive: !late,
    tasks: [], doneTasks: new Set(), item: null, mini: null,
    input: { x: 0, y: 0 }, lastAct: 0, lastDisc: 0, lastChat: 0, killReady: 0, sabReady: 0, emUsed: false,
  };
  if (!late) { const s = lobbySpawn(R.players.size, R.players.size + 1); p.x = s.x; p.y = s.y; }
  R.players.set(socket.id, p);
  sockRoom.set(socket.id, R);
  socket.join('r' + R.code);
  socket.emit('joined', { code: R.code });
  socket.emit('lchatHist', R.lchat);
  lobbySys(R, `${p.name} が参加しました`);
  if (late && R.mapMsg) socket.emit('map', R.mapMsg);
}

io.on('connection', (socket) => {
  socket.emit('init', {
    you: socket.id, W, H, CELL, COLS, ROWS, REACH, GAME_MS, ITEM_NAME, ACCS, COLORS, LOBBY, CLOSET, MAPS: MAP_PREVIEWS,
    TASKS: TASK_DEFS.map(d => ({ id: d.id, name: d.name, pct: d.pct, kind: d.kind, item: d.item || null, n: d.n || 0, icon: d.icon, theme: d.theme })),
  });

  // ルームに入るときは登録済みのユーザーネームを使う
  const withName = (d) => { const nm = nameOf(socket.data.pid); if (!nm) { socket.emit('joinError', '先にユーザーネームを登録してください'); socket.emit('needName'); return null; } return { ...(d || {}), name: nm }; };
  socket.on('createRoom', (d) => {
    if (sockRoom.has(socket.id)) return;
    d = withName(d); if (!d) return;
    addPlayer(socket, newRoom(), d || {});
  });
  socket.on('joinRoom', (d) => {
    if (sockRoom.has(socket.id)) return;
    const code = String((d && d.code) || '').replace(/\D/g, '').slice(0, 5);
    d = withName(d); if (!d) return;
    const R = rooms.get(code);
    if (!R) { socket.emit('joinError', 'そのコードのロビーは見つかりません'); return; }
    if (R.players.size >= MAX_PLAYERS) { socket.emit('joinError', 'ロビーが満員です'); return; }
    addPlayer(socket, R, d);
  });

  const C = () => { const R = sockRoom.get(socket.id); return R ? { R, p: R.players.get(socket.id) } : {}; };

  // ---------- フレンド (端末ごとの永続ID = pid。コード入力なしで参加・招待) ----------
  socket.on('hello', (d) => {
    if (!d || !validPid(d.pid)) return;
    const old = presence.get(d.pid);
    socket.data.pid = d.pid;
    presence.set(d.pid, { sid: socket.id, name: cleanName(d.name), known: new Set((Array.isArray(d.known) ? d.known : []).filter(validPid).slice(0, 300)) });
    const { p } = C(); if (p) p.pid = d.pid;
    const reg = nameOf(d.pid);
    if (reg) presence.get(d.pid).name = reg;
    socket.emit('me', { name: reg });
    sendReqs(d.pid); sendAcks(d.pid);
    if (old && old.sid !== socket.id) { /* 別タブ/再接続: 新しい接続を優先 */ }
  });
  // ユーザーネームを登録/変更 (重複は拒否)
  socket.on('claimName', (d, ack) => {
    if (typeof ack !== 'function') return;
    const pid = socket.data.pid;
    if (!pid) return ack({ ok: false, msg: '接続を確認中です。もう一度押してください' });
    const name = String((d && d.name) || '').normalize('NFKC').replace(/[<>]/g, '').trim();
    if (!NAME_RE.test(name)) return ack({ ok: false, msg: '名前は2〜10文字 (文字・数字・_ のみ、空白や記号は不可)' });
    const key = normName(name), owner = users.byName[key], cur = users.byPid[pid];
    if (owner && owner.pid !== pid) return ack({ ok: false, msg: `「${name}」はすでに使われています。別の名前にしてください` });
    if (cur !== key && sockRoom.has(socket.id)) return ack({ ok: false, msg: 'ロビーやゲームの途中では名前を変えられません' });
    if (cur && cur !== key) { const old = users.byName[cur]; delete users.byName[cur]; users.byName[key] = { ...old, pid, name }; }
    else users.byName[key] = { reqs: [], acks: [], ...(owner || {}), pid, name };
    users.byPid[pid] = key; saveUsers();
    const e = presence.get(pid); if (e) e.name = name;
    ack({ ok: true, name });
  });
  // 名前でユーザーを探す (フレンド追加用)
  socket.on('findUser', (name, ack) => {
    if (typeof ack !== 'function') return;
    const u = users.byName[normName(name)];
    if (!u) return ack({ ok: false, msg: 'そのユーザーネームは見つかりません' });
    if (u.pid === socket.data.pid) return ack({ ok: false, msg: 'それはあなた自身の名前です' });
    ack({ ok: true, pid: u.pid, name: u.name });
  });
  // フレンド申請 → 相手が承認すると、お互いの一覧に登録される
  socket.on('friendReq', (pid, ack) => {
    const me = socket.data.pid, myName = nameOf(me), u = userOf(pid);
    const done = (r) => typeof ack === 'function' && ack(r);
    if (!myName) return done({ ok: false, msg: '先にユーザーネームを登録してください' });
    if (!u || pid === me) return done({ ok: false, msg: '相手が見つかりません' });
    u.reqs = (u.reqs || []).filter(x => x !== me); u.reqs.push(me); u.reqs = u.reqs.slice(-50); saveUsers();
    sendReqs(pid); done({ ok: true, name: u.name });
  });
  socket.on('friendAnswer', (d) => {
    const me = socket.data.pid, mine = userOf(me); if (!mine || !d || !validPid(d.pid)) return;
    mine.reqs = (mine.reqs || []).filter(x => x !== d.pid);
    if (d.ok) { const u = userOf(d.pid); if (u) { u.acks = (u.acks || []).filter(a => a.pid !== me); u.acks.push({ pid: me, name: mine.name }); sendAcks(d.pid); } }
    saveUsers();
  });
  socket.on('known', (arr) => { const e = presence.get(socket.data.pid); if (e && e.sid === socket.id && Array.isArray(arr)) e.known = new Set(arr.filter(validPid).slice(0, 300)); });
  socket.on('friendStatus', (pids, ack) => {
    if (typeof ack !== 'function' || !Array.isArray(pids)) return;
    const myR = sockRoom.get(socket.id);
    ack(pids.filter(validPid).slice(0, 80).map(pid => {
      const e = presence.get(pid), s = e && io.sockets.sockets.get(e.sid);
      if (!s) return { pid, st: 'off' };
      const R = sockRoom.get(e.sid);
      return { pid, name: e.name, st: !R ? 'title' : R.phase === 'lobby' ? 'lobby' : 'playing', same: !!R && R === myR, full: !!R && R.players.size >= MAX_PLAYERS, mutual: e.known.has(socket.data.pid) };
    }));
  });
  socket.on('joinFriend', (d) => {
    if (sockRoom.has(socket.id) || !d || !validPid(d.pid)) return;
    const fp = d.pid; d = withName(d); if (!d) return; d.pid = fp;
    const e = presence.get(d.pid), R = e && sockRoom.get(e.sid);
    if (!e || !io.sockets.sockets.get(e.sid)) { socket.emit('joinError', 'そのフレンドはオフラインです'); return; }
    if (!e.known.has(socket.data.pid)) { socket.emit('joinError', '相手のフレンドリストにまだ登録されていません (一度コードで一緒に遊ぶか、招待してもらおう)'); return; }
    if (!R) { socket.emit('joinError', `${e.name || 'フレンド'}さんはまだロビーにいません`); return; }
    if (R.players.size >= MAX_PLAYERS) { socket.emit('joinError', 'ロビーが満員です'); return; }
    addPlayer(socket, R, d);
  });
  socket.on('invite', (pid) => {
    const { R, p } = C(); if (!p || !validPid(pid)) return;
    const e = presence.get(pid), s = e && io.sockets.sockets.get(e.sid);
    if (!s) { toast(p, 'そのフレンドはオフラインです', 'error'); return; }
    if (sockRoom.has(e.sid)) { toast(p, `${e.name}さんは別のロビーにいます`, 'error'); return; }
    if (!e.known.has(p.pid)) { toast(p, `${e.name}さんのフレンドリストにあなたがいません`, 'error'); return; }
    io.to(e.sid).emit('invited', { from: p.name, fromPid: p.pid, code: R.code, map: (LAYOUTS[R.mapIdx] || {}).name });
    toast(p, `${e.name}さんを招待しました`, 'good');
  });
  // 前回いたロビーがまだあるか (リロード後の復帰用)
  socket.on('roomInfo', (code, ack) => {
    if (typeof ack !== 'function') return;
    const R = rooms.get(String(code || '').replace(/\D/g, '').slice(0, 5));
    ack(R ? { ok: true, phase: R.phase, n: R.players.size, full: R.players.size >= MAX_PLAYERS } : { ok: false });
  });
  // 運搬のキャンセル (Q長押し): アイテムだけ手放し、ミッションはそのまま残す
  socket.on('dropItem', () => {
    const { R, p } = C(); if (!p || R.phase !== 'playing' || !p.item) return;
    const name = ITEM_NAME[p.item]; p.item = null;
    toast(p, `${name}の運搬をやめた (ミッションはそのまま。置き場からもう一度取れる)`, 'info');
    io.to(p.id).emit('sfx', 'click');
  });

  socket.on('input', (d) => {
    const { R, p } = C(); if (!p) return;
    if (!d || typeof d !== 'object' || p.mini || (R.phase !== 'playing' && R.phase !== 'lobby')) { p.input = { x: 0, y: 0 }; return; }
    p.input = { x: (d.right ? 1 : 0) - (d.left ? 1 : 0), y: (d.down ? 1 : 0) - (d.up ? 1 : 0) };
  });
  socket.on('action', () => { const { R, p } = C(); if (p) doAction(R, p); });
  socket.on('report', () => { const { R, p } = C(); if (p) doReport(R, p); });
  socket.on('kill', () => { const { R, p } = C(); if (p) doKill(R, p); });
  socket.on('sabotage', (kind) => { const { R, p } = C(); if (p) doSabotage(R, p, kind); });
  socket.on('warp', (idx) => { const { R, p } = C(); if (p) doWarp(R, p, idx); });
  // discard廃止（スロットシステム廃止）

  // 自動テスト専用 (DOA_TEST=1 のときだけ有効): 指定タスク/置き場へワープ
  if (process.env.DOA_TEST === '1') socket.on('__tp', (d) => {
    const { R, p } = C(); if (!p || R.phase !== 'playing' || !d) return;
    if (d.button) R.noMeetingUntil = 0;
    if (d.role) p.role = d.role;
    if (d.resetCd) { p.sabReady = 0; p.progReady = 0; p.warpReady = 0; }
    if (d.resetProg) p.progReady = 0;
    if (d.die) { p.alive = false; cancelMini(p); }
    if (d.det != null) p.sub = d.det ? 'detective' : null;
    if (d.killNow) p.killReady = 0;
    if (d.shortLeft != null && R.sab.short) R.sab.short.endsAt = Date.now() + d.shortLeft;
    if (d.clearDark) R.sab.dark = 0;
    const fz = d.flood != null && R.sab.flood ? R.sab.flood.zones[d.flood] : null;
    const pos = d.button ? { x: R.map.button.x + 40, y: R.map.button.y } : d.short != null ? R.map.shorts[d.short] : d.warp != null ? R.map.warps[d.warp] : fz ? floodSide(R, fz) : d.pos ? d.pos : d.station ? R.map.stations[d.station] : R.map.tasks[d.task];
    const slot = () => { const i = p.tasks.findIndex(t => defOf(t).kind !== 'carry'); return i >= 0 ? i : p.tasks.length - 1; };
    if (d.task && !p.tasks.includes(d.task)) p.tasks[slot()] = d.task;
    if (d.station) { const t = TASK_DEFS.find(x => x.item === d.station); if (t && !p.tasks.includes(t.id)) p.tasks[slot()] = t.id; }
    if (pos) { p.x = pos.x; p.y = pos.y; }
  });
  // テスト用: 水たまりのすぐ外側 (通れる側) の位置
  const floodSide = (R, z) => { const mc = (z.c0 + z.c1) / 2, mr = (z.r0 + z.r1) / 2;
    for (const [c, r] of [[z.c0 - 1, mr], [z.c1 + 1, mr], [mc, z.r0 - 1], [mc, z.r1 + 1]]) { const cc = Math.round(c), rr = Math.round(r); if (!R.map.grid[rr][cc] && !R.sab.cells.has(rr * COLS + cc)) return cp(cc, rr); }
    return cp(z.c0 - 1, z.r0); };
  socket.on('miniEnd', (d) => {
    const { R, p } = C(); if (!p || !p.mini) return;
    const m = p.mini; p.mini = null;
    if (R.phase !== 'playing' || !d || d.cancel) return;
    if (!d.ok) { toast(p, '失敗… もう一度挑戦しよう', 'error'); return; }
    if (m.wire != null) { // ショートした配線の修理
      const sh = R.sab.short; if (!sh || sh.spots[m.wire].done) return;
      if (Date.now() - m.start < MIN_MINI.wire) { toast(p, '操作が速すぎる?', 'error'); return; }
      sh.spots[m.wire].done = true; sh.fixed++;
      rEmit(R, 'toast', { text: `⚡ ${p.name}が配線を修理 (${sh.fixed}/${sh.need})`, kind: 'good' });
      if (sh.fixed >= sh.need) { R.sab.short = null; rEmit(R, 'toast', { text: '⚡ ショートをすべて修理! 電気が復旧した', kind: 'good' }); rEmit(R, 'sfx', 'done'); }
      return;
    }
    if (!p.tasks.includes(m.taskId)) return;
    if (Date.now() - m.start < MIN_MINI[m.kind]) { toast(p, '操作が速すぎる?', 'error'); return; }
    completeTask(R, p, m.taskId);
  });

  // クローゼットでの着替え (ロビー内・クローゼット付近のみ)
  socket.on('setLook', (d) => {
    const { R, p } = C();
    if (!p || R.phase !== 'lobby' || !d) return;
    if (dist(p, CLOSET) > CLOSET.range + 30) { toast(p, 'クローゼットに近づこう', 'error'); return; }
    if (typeof d.acc === 'string' && ACCS.includes(d.acc)) p.acc = d.acc;
    if (typeof d.color === 'string' && COLORS.includes(d.color) && d.color !== p.color) {
      const taken = [...R.players.values()].some(x => x !== p && x.color === d.color);
      if (taken) toast(p, 'その色は他の人が使っています', 'error'); else p.color = d.color;
    }
  });
  socket.on('ready', () => { const { R, p } = C(); if (p && R.phase === 'lobby' && p.id !== hostId(R)) p.ready = !p.ready; });
  socket.on('setMap', (i) => { // ホストだけがマップを切り替えられる (全員に同期)
    const { R, p } = C();
    if (!p || R.phase !== 'lobby' || p.id !== hostId(R)) return;
    const n = LAYOUTS.length; R.mapIdx = (((parseInt(i, 10) || 0) % n) + n) % n;
    rEmit(R, 'sfx', 'click');
  });
  socket.on('setDet', (n) => { // ホストが探偵の人数 (0〜2) を設定
    const { R, p } = C();
    if (!p || R.phase !== 'lobby' || p.id !== hostId(R)) return;
    R.detCount = clamp(parseInt(n, 10) || 0, 0, MAX_DET);
  });
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

  // ロビーのテキストチャット (全員に同期・直近40件を新しく入った人にも送る)
  socket.on('lobbyChat', (t) => {
    const { R, p } = C(); if (!p || R.phase !== 'lobby') return;
    const now = Date.now(); if (now - (p.lastLChat || 0) < 400) return; p.lastLChat = now;
    const text = String(t || '').replace(/[<>]/g, '').trim().slice(0, 80); if (!text) return;
    const m = { id: p.id, n: p.name, c: p.color, t: text }; R.lchat.push(m); R.lchat = R.lchat.slice(-40); rEmit(R, 'lchat', m);
  });
  // エモート: 頭上に感情アイコンを出す (幽霊のエモートは幽霊・観戦者にだけ届く)
  socket.on('emote', (e) => {
    const { R, p } = C(); if (!p || !EMOTES.includes(e)) return;
    const now = Date.now(); if (now - (p.lastEmote || 0) < 900) return; p.lastEmote = now;
    const ghostOnly = (R.phase === 'playing' || R.phase === 'meeting') && (!p.alive || p.late);
    for (const v of R.players.values()) if (!ghostOnly || !v.alive || v.late) io.to(v.id).emit('emote', { id: p.id, e });
  });
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
    const pe = presence.get(socket.data.pid); if (pe && pe.sid === socket.id) presence.delete(socket.data.pid);
    const { R, p } = C();
    sockRoom.delete(socket.id);
    if (!p) return;
    R.players.delete(socket.id);
    if (R.meeting) R.meeting.votes.delete(socket.id);
    lobbySys(R, `${p.name} が退出しました`);
    if (R.players.size === 0) { rooms.delete(R.code); return; }
    if (R.phase === 'playing' || R.phase === 'meeting') {
      if (participants(R).length === 0) { toLobby(R); return; }
      if (R.phase === 'playing') checkWin(R);
    }
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`Destroy or Avoid v7.1 running on :${PORT}`));
module.exports = { genMap, LAYOUTS, TASK_ROOMS, TASK_DEFS, tasksOf, COLS, ROWS, CELL };

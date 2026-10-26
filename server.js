const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// ゲーム状態データ
let gameState = {
  status: 'TITLE', // 'TITLE', 'PLAYING', 'WIN', 'LOSE'
  timer: 300,      // 5分 (300秒)
  // マップ上に落ちている鉄くず
  scraps: [
    { id: 1, x: 200, y: 120, active: true },
    { id: 2, x: 600, y: 120, active: true },
    { id: 3, x: 200, y: 480, active: true },
    { id: 4, x: 600, y: 480, active: true }
  ],
  tasks: {
    // ⚙️ Destroy (エンジンルート): 5つのタスク
    destroy: [
      { id: 'd1', name: 'プラズマコア抽出', maxClicks: 30, clicks: 0, completed: false },
      { id: 'd2', name: '高圧パイプ接続', maxClicks: 30, clicks: 0, completed: false },
      { id: 'd3', name: '冷却液充填', maxClicks: 25, clicks: 0, completed: false },
      { id: 'd4', name: 'ボルト締め直し', maxClicks: 20, clicks: 0, completed: false },
      { id: 'd5', name: 'フィルター清掃', maxClicks: 20, clicks: 0, completed: false }
    ],
    // 🪽 Avoid (羽ルート): 4つのタスク
    avoid: [
      { id: 'a1', name: '外壁フレーム溶接', maxClicks: 40, clicks: 0, completed: false },
      { id: 'a2', name: '駆動アーム交換', maxClicks: 40, clicks: 0, completed: false },
      { id: 'a3', name: '制御ケーブル引直', maxClicks: 30, clicks: 0, completed: false },
      { id: 'a4', name: 'センサー再起動', maxClicks: 30, clicks: 0, completed: false }
    ]
  },
  players: {}
};

const COLORS = ['#FF4D4D', '#4D96FF', '#6BCB77', '#FFD93D'];
let gameInterval = null;

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  const pIndex = Object.keys(gameState.players).length;
  gameState.players[socket.id] = {
    id: socket.id,
    x: 380 + (pIndex % 2) * 40,
    y: 280 + Math.floor(pIndex / 2) * 40,
    color: COLORS[pIndex % COLORS.length],
    scrapCount: 0,      // 拾った鉄くずの数 (3つでボルト作成可能)
    holdingItem: null   // 'BOLT' または 'CORE'
  };

  io.emit('stateUpdate', gameState);

  // ゲームスタート
  socket.on('startGame', () => {
    if (gameState.status === 'TITLE') {
      gameState.status = 'PLAYING';
      gameState.timer = 300;
      startGameTimer();
      io.emit('stateUpdate', gameState);
    }
  });

  // 移動処理
  socket.on('move', (pos) => {
    const player = gameState.players[socket.id];
    if (!player || gameState.status !== 'PLAYING') return;

    const isHeavy = player.holdingItem === 'CORE';
    const speed = isHeavy ? 2.5 : 5; // コアを持っていると鈍足

    player.x = Math.max(30, Math.min(770, pos.x));
    player.y = Math.max(30, Math.min(570, pos.y));

    io.emit('stateUpdate', gameState);
  });

  // アクション処理（拾う、クラフト、スペース連打タスク）
  socket.on('action', (data) => {
    const player = gameState.players[socket.id];
    if (!player || gameState.status !== 'PLAYING') return;

    // 1. 道端の「鉄くず」を拾う
    gameState.scraps.forEach(scrap => {
      if (scrap.active && Math.hypot(player.x - scrap.x, player.y - scrap.y) < 40) {
        if (player.scrapCount < 3 && !player.holdingItem) {
          scrap.active = false;
          player.scrapCount++;
        }
      }
    });

    // 2. 作業台で鉄くず3つを「ボルト」にクラフト
    const benchDist = Math.hypot(player.x - 400, player.y - 80);
    if (benchDist < 60 && player.scrapCount >= 3 && !player.holdingItem) {
      player.scrapCount = 0;
      player.holdingItem = 'BOLT';
    }

    // 3. コア箱から「プラズマコア（重量物）」を取る
    const coreBoxDist = Math.hypot(player.x - 100, player.y - 500);
    if (coreBoxDist < 60 && !player.holdingItem && player.scrapCount === 0) {
      player.holdingItem = 'CORE';
    }

    // 4. 手放す（ドロップ）
    const dropDist = Math.hypot(player.x - 400, player.y - 300);
    if (dropDist < 50 && player.holdingItem) {
      player.holdingItem = null;
    }

    // 5. 修理ステーションで作業（スペース連打）
    // エンジンエリア (DESTROY)
    const destroyDist = Math.hypot(player.x - 150, player.y - 250);
    if (destroyDist < 70) {
      const target = gameState.tasks.destroy.find(t => !t.completed);
      if (target) {
        target.clicks++;
        if (target.clicks >= target.maxClicks) {
          target.completed = true;
        }
        checkWinCondition();
      }
    }

    // 羽エリア (AVOID)
    const avoidDist = Math.hypot(player.x - 650, player.y - 250);
    if (avoidDist < 70) {
      const target = gameState.tasks.avoid.find(t => !t.completed);
      if (target) {
        target.clicks++;
        if (target.clicks >= target.maxClicks) {
          target.completed = true;
        }
        checkWinCondition();
      }
    }

    io.emit('stateUpdate', gameState);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete gameState.players[socket.id];
    io.emit('stateUpdate', gameState);
  });
});

// 勝利条件チェック（どちらか片方のルートが全タスク完了すれば勝利）
function checkWinCondition() {
  const destroyDone = gameState.tasks.destroy.every(t => t.completed);
  const avoidDone = gameState.tasks.avoid.every(t => t.completed);

  if (destroyDone || avoidDone) {
    gameState.status = 'WIN';
    if (gameInterval) clearInterval(gameInterval);
  }
}

// 5分タイマー
function startGameTimer() {
  if (gameInterval) clearInterval(gameInterval);
  gameInterval = setInterval(() => {
    if (gameState.status === 'PLAYING') {
      gameState.timer--;
      if (gameState.timer <= 0) {
        gameState.timer = 0;
        gameState.status = 'LOSE';
        clearInterval(gameInterval);
      }
      io.emit('stateUpdate', gameState);
    }
  }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

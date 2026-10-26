const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// ゲーム状態データ
let gameState = {
  status: 'WAITING', // 'WAITING', 'PREPARATION', 'METEOR_APPROACH', 'WIN', 'LOSE'
  route: null,      // 'DESTROY' (エンジン) or 'AVOID' (羽)
  difficulty: 'NORMAL', // 'EASY', 'NORMAL', 'HARD'
  meteorTimer: 60,  // 隕石激突までのカウントダウン（秒）
  tasks: {
    // Destroyルート (エンジン): 重いタスク3, 軽いタスク2
    destroy: [
      { id: 'd1', name: 'プラズマコア抽出', heavy: true, completed: false, progress: 0 },
      { id: 'd2', name: '高圧パイプ再接続', heavy: true, completed: false, progress: 0 },
      { id: 'd3', name: '冷却液充填', heavy: true, completed: false, progress: 0 },
      { id: 'd4', name: 'ボルト締め直し', heavy: false, completed: false, progress: 0 },
      { id: 'd5', name: 'フィルター清掃', heavy: false, completed: false, progress: 0 }
    ],
    // Avoidルート (羽): 重いタスク4
    avoid: [
      { id: 'a1', name: '外壁フレーム溶接', heavy: true, completed: false, progress: 0 },
      { id: 'a2', name: 'メイン駆動アーム交換', heavy: true, completed: false, progress: 0 },
      { id: 'a3', name: '制御ケーブル引き直し', heavy: true, completed: false, progress: 0 },
      { id: 'a4', name: 'センサー再起動', heavy: true, completed: false, progress: 0 }
    ]
  },
  players: {}
};

// プレイヤーカラーのリスト
const COLORS = ['#FF4D4D', '#4D96FF', '#6BCB77', '#FFD93D'];

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 新規プレイヤー追加
  const playerIndex = Object.keys(gameState.players).length;
  gameState.players[socket.id] = {
    id: socket.id,
    x: 100 + (playerIndex % 2) * 80,
    y: 200 + Math.floor(playerIndex / 2) * 80,
    color: COLORS[playerIndex % COLORS.length],
    holdingItem: null // 持ち手アイテム
  };

  // 現在の状態を全送信
  io.emit('stateUpdate', gameState);

  // 難易度変更・ルート選択
  socket.on('setGameConfig', (data) => {
    if (data.difficulty) gameState.difficulty = data.difficulty;
    if (data.route) gameState.route = data.route;
    
    // 難易度によるタイマー初期化
    if (gameState.difficulty === 'EASY') gameState.meteorTimer = 90;
    if (gameState.difficulty === 'NORMAL') gameState.meteorTimer = 60;
    if (gameState.difficulty === 'HARD') gameState.meteorTimer = 45;

    io.emit('stateUpdate', gameState);
  });

  // ゲームスタート
  socket.on('startGame', () => {
    if (!gameState.route) return;
    gameState.status = 'PREPARATION';
    io.emit('stateUpdate', gameState);

    // 20秒後に警報・巨大隕石接近フェーズへ移行
    setTimeout(() => {
      if (gameState.status === 'PREPARATION') {
        gameState.status = 'METEOR_APPROACH';
        io.emit('stateUpdate', gameState);
        startMeteorTimer();
      }
    }, 20000);
  });

  // プレイヤー移動処理
  socket.on('move', (pos) => {
    const player = gameState.players[socket.id];
    if (!player) return;

    // 重いアイテム（プラズマコア）を持っていると移動速度低下
    const isHeavy = player.holdingItem === 'PLATINUM_CORE';
    const speedLimit = isHeavy ? 3 : 7;

    player.x = Math.max(20, Math.min(780, pos.x));
    player.y = Math.max(20, Math.min(580, pos.y));
    
    io.emit('stateUpdate', gameState);
  });

  // アクション処理（拾う・作業台でクラフト・タスク進行）
  socket.on('action', (data) => {
    const player = gameState.players[socket.id];
    if (!player) return;

    // 1. 資材置き場から「鉄くず」入手
    if (data.nearArea === 'SCRAP_BOX' && !player.holdingItem) {
      player.holdingItem = 'SCRAP_METAL';
    }
    // 2. プラズマコア（重量物）入手
    else if (data.nearArea === 'CORE_BOX' && !player.holdingItem) {
      player.holdingItem = 'PLATINUM_CORE';
    }
    // 3. 作業台で「鉄くず」→「スパナ」にクラフト
    else if (data.nearArea === 'CRAFT_BENCH' && player.holdingItem === 'SCRAP_METAL') {
      player.holdingItem = 'SPANNER';
    }
    // 4. ドロップ/手放す
    else if (data.nearArea === 'DROP') {
      player.holdingItem = null;
    }
    // 5. タスク実行
    else if (data.nearArea === 'WORK_STATION' && gameState.route) {
      const activeTaskList = gameState.route === 'DESTROY' ? gameState.tasks.destroy : gameState.tasks.avoid;
      const targetTask = activeTaskList.find(t => !t.completed);

      if (targetTask) {
        // スパナが必要な重いタスクか、素手でもできる簡単なタスクか
        if (targetTask.heavy && player.holdingItem === 'SPANNER') {
          targetTask.progress += 25;
        } else if (!targetTask.heavy) {
          targetTask.progress += 35;
        }

        if (targetTask.progress >= 100) {
          targetTask.progress = 100;
          targetTask.completed = true;
        }

        // 全タスク完了チェック
        const allDone = activeTaskList.every(t => t.completed);
        if (allDone) {
          gameState.status = 'WIN';
        }
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

// 隕石カウントダウンタイマー
let timerInterval = null;
function startMeteorTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (gameState.status === 'METEOR_APPROACH') {
      gameState.meteorTimer -= 1;
      if (gameState.meteorTimer <= 0) {
        gameState.meteorTimer = 0;
        gameState.status = 'LOSE';
        clearInterval(timerInterval);
      }
      io.emit('stateUpdate', gameState);
    } else {
      clearInterval(timerInterval);
    }
  }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
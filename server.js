'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

// Render のヘルスチェック用
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ゲーム本体
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// それ以外は 404
app.use((req, res) => {
  res.status(404).send('Not Found');
});

app.listen(PORT, () => {
  console.log(`パチットモンスター server running on port ${PORT}`);
});

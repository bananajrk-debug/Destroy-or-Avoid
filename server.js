// ---------- 入力 ----------
function sendInput(force) {
  const blocked = mini || !S || S.ph !== 'playing';
  const o = blocked ? { up: 0, down: 0, left: 0, right: 0 } : {
    up: !!(keysDown.w || keysDown.arrowup), down: !!(keysDown.s || keysDown.arrowdown),
    left: !!(keysDown.a || keysDown.arrowleft), right: !!(keysDown.d || keysDown.arrowright) };
  const j = JSON.stringify(o);
  if (force || j !== lastIn) { lastIn = j; socket.emit('input', o); }
}

const GAMEKEYS = [' ', 'space', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];

addEventListener('keydown', e => {
  if (!joined || !S) return;
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT') return;
  
  const k = e.key.toLowerCase();
  const code = e.code ? e.code.toLowerCase() : '';
  
  // iPadや外部キーボード環境に対応するため、keyとcodeの両方をチェック
  const isSpace = (k === ' ' || k === 'space' || code === 'space');
  const isUp = (k === 'arrowup' || code === 'arrowup');
  const isDown = (k === 'arrowdown' || code === 'arrowdown');
  const isLeft = (k === 'arrowleft' || code === 'arrowleft');
  const isRight = (k === 'arrowright' || code === 'arrowright');

  // 内部的なキー状態の保持を統一
  if (isSpace) keysDown[' '] = true;
  keysDown[k] = true;
  if (code) keysDown[code] = true;

  if (mini) { 
    e.preventDefault(); 
    if (k === 'escape' || code === 'escape') cancelMini(); 
    else miniKey(e, isSpace ? ' ' : k); 
    return; 
  }
  
  if (S.ph !== 'playing') return;
  
  if (isSpace || GAMEKEYS.includes(k) || GAMEKEYS.includes(code)) {
    e.preventDefault();
  }

  if (!e.repeat) {
    if (isSpace) socket.emit('action');
    else if (k === 'r') socket.emit('report');
    else if (k === 'e') socket.emit('kill');
    else if (k === 'f') socket.emit('sabotage');
    else if (k === 'q') socket.emit('discard', selSlot);
    else if (k === '1' || k === '2' || k === '3') selSlot = +k - 1;
  }
  sendInput();
});

addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  const code = e.code ? e.code.toLowerCase() : '';
  const isSpace = (k === ' ' || k === 'space' || code === 'space');
  
  keysDown[k] = false;
  if (code) keysDown[code] = false;
  if (isSpace) keysDown[' '] = false;
  
  if (isSpace && joined) e.preventDefault();
  sendInput();
});

addEventListener('blur', () => { for (const k in keysDown) keysDown[k] = false; sendInput(); });

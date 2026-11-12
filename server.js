'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const Engine = require('./public/engine.js');
const { createLogger } = require('./logger.js');

const log = createLogger();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const NAME_RE = /^[A-Za-z0-9_-]{2,16}$/;
const MAX_CHAT = 200;
const CHAT_LIMIT = 400;
const RECONNECT_GRACE = 120000;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ---------------------------------- avatar --------------------------------- */

function sniffMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', offset: 0 };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', offset: 0 };
  }
  if (buf.length > 2 && buf.toString('ascii', 0, 2) === 'BM') {
    return { mime: 'image/bmp', offset: 0 };
  }
  const png = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (png > 0) return { mime: 'image/png', offset: png };
  const jpg = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpg > 0) return { mime: 'image/jpeg', offset: jpg };
  return null;
}

function readImageAsDataUrl(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_AVATAR_BYTES || stat.size < 32) return null;
    const buf = fs.readFileSync(file);
    const info = sniffMime(buf);
    if (!info) return null;
    return 'data:' + info.mime + ';base64,' + buf.slice(info.offset).toString('base64');
  } catch (err) {
    return null;
  }
}

function collectAvatarFiles(user) {
  const out = [];
  const appData = process.env.APPDATA;
  const programData = process.env.ProgramData || 'C:\\ProgramData';

  if (appData) {
    const accountPictures = path.join(appData, 'Microsoft', 'Windows', 'AccountPictures');
    try {
      const entries = fs.readdirSync(accountPictures, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && /\.(png|jpe?g|bmp|dat)$/i.test(e.name))
        .map((e) => path.join(accountPictures, e.name))
        .map((f) => ({ file: f, mtime: fs.statSync(f).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const item of files) out.push(item.file);
    } catch (err) { /* нет папки — пропускаем */ }
  }

  const userPictures = path.join(programData, 'Microsoft', 'User Account Pictures');
  if (user) {
    for (const ext of ['.dat', '.png', '.bmp', '.jpg']) {
      out.push(path.join(userPictures, user + ext));
    }
  }
  for (const ext of ['.png', '.bmp']) out.push(path.join(userPictures, 'user' + ext));
  return out;
}

let avatarCache = { at: 0, user: null, dataUrl: null };

function getLocalIdentity() {
  const now = Date.now();
  if (avatarCache.user && now - avatarCache.at < 5 * 60 * 1000) return avatarCache;
  let user = '';
  try { user = os.userInfo().username; } catch (err) { user = ''; }
  let dataUrl = null;
  for (const file of collectAvatarFiles(user)) {
    dataUrl = readImageAsDataUrl(file);
    if (dataUrl) break;
  }
  avatarCache = { at: now, user, dataUrl };
  return avatarCache;
}

/* ------------------------------- networking -------------------------------- */

const VIRTUAL_IFACE = /virtual|vmware|vbox|hyper-v|radmin|loopback|tailscale|zerotier|vpn|tunnel|hamachi|vethernet/i;

let preferredAddress = null;

function detectPreferredAddress() {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      socket = dgram.createSocket('udp4');
    } catch (err) {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch (err) { /* уже закрыт */ }
      finish(null);
    }, 400);
    socket.on('error', () => {
      clearTimeout(timer);
      try { socket.close(); } catch (err) { /* уже закрыт */ }
      finish(null);
    });
    try {
      socket.connect(53, '8.8.8.8', () => {
        clearTimeout(timer);
        let address = null;
        try { address = socket.address().address; } catch (err) { address = null; }
        try { socket.close(); } catch (err) { /* уже закрыт */ }
        finish(address);
      });
    } catch (err) {
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* уже закрыт */ }
      finish(null);
    }
  });
}

function addressWeight(item) {
  if (preferredAddress && item.address === preferredAddress) return 0;
  let weight;
  if (/^192\.168\.56\./.test(item.address)) weight = 6;
  else if (/^192\.168\./.test(item.address)) weight = 1;
  else if (/^10\./.test(item.address)) weight = 2;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(item.address)) weight = 3;
  else weight = 4;
  if (VIRTUAL_IFACE.test(item.iface)) weight += 10;
  return weight;
}

function lanAddresses() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue;
      result.push({ iface: name, address: info.address });
    }
  }
  result.sort((a, b) => addressWeight(a) - addressWeight(b));
  return result;
}

function isLoopback(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  if (pathname === '/api/identity') {
    const local = isLoopback(req);
    const identity = getLocalIdentity();
    const body = JSON.stringify({
      user: local ? identity.user : null,
      avatar: local ? identity.dataUrl : null,
      lan: lanAddresses(),
      port: PORT
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return;
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(serveStatic);

/* ---------------------------------- room ----------------------------------- */

const room = {
  slots: [null, null],
  game: null,
  chat: [],
  nextId: 1
};

function resetIfEmpty() {
  const anyConnected = room.slots.some((s) => s && s.connected);
  if (!anyConnected && !room.game) {
    room.chat = [];
  }
}

function slotColor(slot) {
  const game = room.game;
  if (!game || !slot) return null;
  if (game.players.w === slot) return 'w';
  if (game.players.b === slot) return 'b';
  return null;
}

function slotOf(ws) {
  return room.slots.find((s) => s && s.ws === ws) || null;
}

function opponentOf(slot) {
  return room.slots.find((s) => s && s !== slot) || null;
}

function send(ws, message) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) { /* сокет уже закрыт */ }
}

function broadcast(message) {
  for (const slot of room.slots) {
    if (slot && slot.ws) send(slot.ws, message);
  }
}

function chatEntry(text, slot) {
  return {
    id: room.nextId++,
    ts: Date.now(),
    system: !slot,
    name: slot ? slot.name : null,
    color: slot ? slotColor(slot) : null,
    avatar: slot ? slot.avatar : null,
    text: text
  };
}

function pushChat(entry) {
  room.chat.push(entry);
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  broadcast({ type: 'chat', message: entry });
}

function systemMessage(text) {
  pushChat(chatEntry(text, null));
}

/* ---------------------------------- game ----------------------------------- */

const REASON_TEXT = {
  checkmate: 'мат',
  stalemate: 'пат',
  fifty: 'правило 50 ходов',
  insufficient: 'недостаточно материала',
  repetition: 'троекратное повторение',
  resign: 'сдача',
  abandon: 'соперник вышел',
  disconnect: 'соперник отключился'
};

function opposite(color) {
  return color === 'w' ? 'b' : 'w';
}

function resolveColors(a, b) {
  let ca = a.sidePref === 'random' ? null : a.sidePref;
  let cb = b.sidePref === 'random' ? null : b.sidePref;
  if (ca && cb) {
    if (ca === cb) {
      if (Math.random() < 0.5) cb = opposite(cb);
      else ca = opposite(ca);
    }
  } else if (ca) {
    cb = opposite(ca);
  } else if (cb) {
    ca = opposite(cb);
  } else if (Math.random() < 0.5) {
    ca = 'w';
    cb = 'b';
  } else {
    ca = 'b';
    cb = 'w';
  }
  return [ca, cb];
}

function publicPlayer(slot, color) {
  return {
    name: slot.name,
    avatar: slot.avatar || null,
    color: color,
    connected: !!slot.connected
  };
}

function statePayload() {
  const game = room.game;
  return {
    fen: Engine.toFen(game.state),
    history: game.state.history.map((h) => ({
      san: h.san,
      from: Engine.indexToSquare(h.from),
      to: Engine.indexToSquare(h.to),
      piece: h.piece,
      captured: h.captured,
      promo: h.promo,
      castle: h.castle
    })),
    turn: game.state.turn,
    lastMove: game.state.lastMove
      ? { from: Engine.indexToSquare(game.state.lastMove.from), to: Engine.indexToSquare(game.state.lastMove.to) }
      : null,
    status: game.status
  };
}

function broadcastState() {
  const game = room.game;
  if (!game) return;
  const payload = statePayload();
  for (const color of ['w', 'b']) {
    const slot = game.players[color];
    send(slot.ws, Object.assign({ type: 'state', you: color }, payload));
  }
}

function startGame(colorsOverride) {
  const [a, b] = room.slots;
  let ca;
  let cb;
  if (colorsOverride) {
    ca = 'w';
    cb = 'b';
  } else {
    const resolved = resolveColors(a, b);
    ca = resolved[0];
    cb = resolved[1];
  }
  const whiteSlot = colorsOverride ? colorsOverride.w : ca === 'w' ? a : b;
  const blackSlot = colorsOverride ? colorsOverride.b : ca === 'w' ? b : a;

  const state = Engine.fromFen(Engine.START_FEN);
  const game = {
    state: state,
    players: { w: whiteSlot, b: blackSlot },
    status: Engine.getStatus(state),
    over: false,
    rematch: { w: false, b: false },
    startedAt: Date.now()
  };
  whiteSlot.color = 'w';
  blackSlot.color = 'b';
  room.game = game;

  const base = statePayload();
  for (const color of ['w', 'b']) {
    const slot = game.players[color];
    const opp = game.players[opposite(color)];
    send(slot.ws, {
      type: 'start',
      you: publicPlayer(slot, color),
      opponent: publicPlayer(opp, opposite(color)),
      fen: base.fen,
      history: base.history,
      turn: base.turn,
      lastMove: base.lastMove,
      status: base.status
    });
  }
  systemMessage('Партия началась. ' + whiteSlot.name + ' играет белыми.');
  log.event('Партия началась: ' + whiteSlot.name + ' — белые, ' + blackSlot.name + ' — чёрные');
}

function startRematch() {
  const game = room.game;
  if (!game) return;
  const swapped = { w: game.players.b, b: game.players.w };
  room.game = null;
  startGame(swapped);
}

function endGame(result, reason, text) {
  const game = room.game;
  if (!game || game.over) return;
  game.over = true;
  game.result = result;
  game.reason = reason;
  broadcast({
    type: 'gameover',
    result: result,
    reason: reason,
    reasonText: REASON_TEXT[reason] || reason,
    message: text || null
  });
  if (text) systemMessage(text);
  log.event('Партия завершена: результат ' + result + ', причина ' + reason +
    ' (ходов: ' + game.state.history.length + ')');
}

function tryStart() {
  const [a, b] = room.slots;
  if (!a || !b || !a.connected || !b.connected) return false;
  if (!a.ws || !b.ws) return false;
  if (room.game && !room.game.over) return false;
  room.game = null;
  startGame();
  return true;
}

/* -------------------------------- connection ------------------------------- */

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function handleJoin(ws, msg) {
  if (slotOf(ws)) {
    send(ws, { type: 'error', message: 'Вы уже в игре' });
    return;
  }
  const name = String(msg.name || '').trim();
  if (!NAME_RE.test(name)) {
    send(ws, { type: 'error', message: 'Ник: 2–16 символов, латиница, цифры, «_» или «-»' });
    return;
  }
  const sidePref = ['w', 'b', 'random'].indexOf(msg.side) !== -1 ? msg.side : 'random';
  const local = isLoopback({ socket: ws._socket || {} });
  const identity = getLocalIdentity();
  const avatar = local && identity.dataUrl ? identity.dataUrl : null;

  const sameName = room.slots.find((s) => s && s.name.toLowerCase() === name.toLowerCase());

  let slot = null;
  if (sameName) {
    if (sameName.connected) {
      send(ws, { type: 'error', message: 'Этот ник уже занят в этом столе' });
      return;
    }
    slot = sameName;
    clearTimeout(slot.removeTimer);
    slot.removeTimer = null;
    slot.ws = ws;
    slot.connected = true;
    slot.avatar = avatar || slot.avatar;
  } else {
    const freeIndex = room.slots.indexOf(null);
    if (freeIndex === -1) {
      send(ws, { type: 'error', message: 'За этим столом уже играют двое' });
      return;
    }
    slot = {
      name: name,
      sidePref: sidePref,
      avatar: avatar,
      ws: ws,
      connected: true,
      color: null,
      removeTimer: null,
      lastChatAt: 0
    };
    room.slots[freeIndex] = slot;
  }

  ws._slot = slot;
  const remote = (ws._socket && ws._socket.remoteAddress) || '?';
  send(ws, {
    type: 'welcome',
    you: { name: slot.name, avatar: slot.avatar || null, sidePref: slot.sidePref },
    chat: room.chat.slice(-100)
  });
  log.event('Вход: ' + slot.name + ' (сторона: ' + slot.sidePref + ', слот ' +
    (room.slots.indexOf(slot) + 1) + ', ip ' + remote + ', аватар: ' + (slot.avatar ? 'есть' : 'нет') + ')');

  const game = room.game;
  if (game && !game.over) {
    const color = game.players.w === slot ? 'w' : game.players.b === slot ? 'b' : null;
    if (color) {
      const opp = game.players[opposite(color)];
      const base = statePayload();
      send(ws, {
        type: 'start',
        resumed: true,
        you: publicPlayer(slot, color),
        opponent: publicPlayer(opp, opposite(color)),
        fen: base.fen,
        history: base.history,
        turn: base.turn,
        lastMove: base.lastMove,
        status: base.status
      });
      send(opp.ws, { type: 'opponentBack', name: slot.name });
      systemMessage(slot.name + ' вернулся в игру.');
      log.event('Возврат в игру: ' + slot.name + ' (' + (color === 'w' ? 'белые' : 'чёрные') + ')');
      return;
    }
  }

  if (!tryStart()) {
    send(ws, { type: 'waiting', you: { name: slot.name } });
    log.event('Ожидание соперника: ' + slot.name);
  } else {
    systemMessage(slot.name + ' подключился.');
  }
}

function handleMove(ws, msg) {
  const slot = slotOf(ws);
  const game = room.game;
  if (!slot || !game || game.over) return;
  const color = slotColor(slot);
  if (!color) return;
  if (game.state.turn !== color) {
    send(ws, { type: 'error', message: 'Сейчас не ваш ход' });
    return;
  }
  const from = Engine.parseSquare(msg.from);
  const to = Engine.parseSquare(msg.to);
  if (from === null || to === null) {
    send(ws, { type: 'error', message: 'Некорректная клетка' });
    return;
  }
  const move = Engine.findMove(game.state, from, to, msg.promo);
  if (!move) {
    send(ws, { type: 'error', message: 'Так ходить нельзя' });
    broadcastState();
    return;
  }
  game.state = Engine.applyMove(game.state, move);
  game.status = Engine.getStatus(game.state);
  const lastMove = game.state.history[game.state.history.length - 1];
  log.event('Ход: ' + lastMove.san + ' — ' + slot.name + ' (' + (color === 'w' ? 'белые' : 'чёрные') + '), FEN ' + Engine.toFen(game.state));
  broadcastState();
  if (game.status.over) {
    const result = game.status.result;
    const text = result === 'draw'
      ? 'Ничья (' + (REASON_TEXT[game.status.reason] || game.status.reason) + ').'
      : 'Мат! Победили ' + (result === 'w' ? 'белые' : 'чёрные') + '.';
    endGame(result, game.status.reason, text);
  }
}

function handleChat(ws, msg) {
  const slot = slotOf(ws);
  if (!slot) return;
  const now = Date.now();
  if (now - (slot.lastChatAt || 0) < 250) return;
  slot.lastChatAt = now;
  const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_LIMIT);
  if (!text) return;
  pushChat(chatEntry(text, slot));
  log.event('Чат ' + slot.name + ': ' + text);
}

function handleResign(ws) {
  const slot = slotOf(ws);
  const game = room.game;
  if (!slot || !game || game.over) return;
  const color = slotColor(slot);
  if (!color) return;
  log.event('Сдача: ' + slot.name);
  endGame(opposite(color), 'resign', slot.name + ' сдался. Победил ' + game.players[opposite(color)].name + '.');
}

function handleRematch(ws) {
  const slot = slotOf(ws);
  const game = room.game;
  if (!slot || !game || !game.over) return;
  const color = slotColor(slot);
  if (!color) return;
  game.rematch[color] = true;
  const oppColor = opposite(color);
  log.event('Реванш: ' + slot.name + ' согласился (' + (game.rematch.w && game.rematch.b ? 'начинаем новую партию' : 'ждём соперника') + ')');
  send(game.players[oppColor].ws, { type: 'rematchOffered', name: slot.name });
  broadcast({ type: 'rematchState', w: !!game.rematch.w, b: !!game.rematch.b });
  if (game.rematch.w && game.rematch.b) {
    startRematch();
  }
}

function handleLeave(ws) {
  const slot = slotOf(ws);
  if (!slot) return;
  const game = room.game;
  if (game && !game.over && slotColor(slot)) {
    endGame(opposite(slotColor(slot)), 'abandon', slot.name + ' вышел из игры.');
  }
  log.event('Выход из стола: ' + slot.name);
  removeSlot(slot, true);
  ws._slot = null;
  send(ws, { type: 'left' });
}

function removeSlot(slot, notify) {
  const index = room.slots.indexOf(slot);
  if (index === -1) return;
  const opponent = room.slots[index === 0 ? 1 : 0];
  room.slots[index] = null;
  if (slot.removeTimer) {
    clearTimeout(slot.removeTimer);
    slot.removeTimer = null;
  }
  if (opponent) {
    if (notify) {
      send(opponent.ws, { type: 'opponentLeft', name: slot.name });
      systemMessage(slot.name + ' вышел из стола.');
    }
    clearTimeout(opponent.removeTimer);
    opponent.removeTimer = null;
  }
  if (room.game && !room.game.over) {
    const game = room.game;
    if (game.players.w === slot || game.players.b === slot) {
      const otherColor = game.players.w === slot ? 'b' : 'w';
      const other = game.players[otherColor];
      if (other && other.ws) {
        send(other.ws, { type: 'gameAborted', message: 'Соперник покинул игру' });
      }
      room.game = null;
    }
  }
  resetIfEmpty();
}

function scheduleSlotCleanup(slot) {
  if (slot.removeTimer) clearTimeout(slot.removeTimer);
  slot.removeTimer = setTimeout(() => {
    slot.removeTimer = null;
    if (!slot.connected) {
      removeSlot(slot, true);
      if (room.game && !room.game.over) {
        const game = room.game;
        if (game.players.w === slot || game.players.b === slot) {
          const otherColor = game.players.w === slot ? 'b' : 'w';
          const other = game.players[otherColor];
          if (other && other.ws) {
            send(other.ws, { type: 'gameAborted', message: 'Соперник отключился' });
          }
          room.game = null;
        }
      }
    }
  }, RECONNECT_GRACE);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws._slot = null;
  const local = isLoopback(req);
  const identity = getLocalIdentity();
  send(ws, {
    type: 'hello',
    localIdentity: local ? { user: identity.user, avatar: identity.dataUrl } : null,
    lan: lanAddresses(),
    port: PORT
  });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* игнорируем */ });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (err) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case 'join': handleJoin(ws, msg); break;
        case 'move': handleMove(ws, msg); break;
        case 'chat': handleChat(ws, msg); break;
        case 'resign': handleResign(ws); break;
        case 'rematch': handleRematch(ws); break;
        case 'leave': handleLeave(ws); break;
        case 'ping': send(ws, { type: 'pong' }); break;
        default: break;
      }
    } catch (err) {
      log.error('Ошибка обработки сообщения ' + msg.type + ': ' + (err && err.stack ? err.stack : err));
    }
  });

  ws.on('close', () => {
    const slot = slotOf(ws);
    if (!slot) return;
    slot.connected = false;
    slot.ws = null;
    log.event('Отключение: ' + slot.name);
    const game = room.game;
    if (game && !game.over && slotColor(slot)) {
      const otherColor = opposite(slotColor(slot));
      const other = game.players[otherColor];
      if (other && other.ws) {
        send(other.ws, { type: 'opponentOffline', name: slot.name });
        systemMessage(slot.name + ' потерял соединение. Ждём возвращения…');
      }
    }
    scheduleSlotCleanup(slot);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (err) { /* сокет закрыт */ }
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    const addresses = lanAddresses();
    const identity = getLocalIdentity();
    log.info('Chess запущен, файл лога: ' + log.file);
    log.info('Слушаем порт ' + PORT + ' на всех интерфейсах');
    log.info('Локально: http://localhost:' + PORT);
    for (const item of addresses) {
      log.info('Сеть: http://' + item.address + ':' + PORT + ' (' + item.iface + ')');
    }
    if (!addresses.length) log.warn('Не найден сетевой адрес — проверьте подключение к Wi-Fi/LAN');
    log.info('Аватар Windows: ' + (identity.dataUrl ? 'найден' : 'не найден, будут инициалы'));
  });
}

function shutdown(signal) {
  log.info('Сервер остановлен (' + signal + ')');
  log.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

detectPreferredAddress().then((address) => {
  preferredAddress = address;
  startServer();
});

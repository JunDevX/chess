(function () {
  'use strict';

  var E = window.ChessEngine;
  var NAME_RE = /^[A-Za-z0-9_-]{2,16}$/;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function pieceSvg(type) {
    return '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#pc-' + type + '"/></svg>';
  }

  function pieceNode(piece) {
    var el = document.createElement('span');
    el.className = 'piece' + (piece ? ' ' + piece[0] : '');
    el.innerHTML = piece ? pieceSvg(piece[1]) : '';
    return el;
  }

  function takenNode(piece) {
    var el = document.createElement('span');
    el.className = 'taken-icon ' + piece[0];
    el.innerHTML = pieceSvg(piece[1]);
    return el;
  }

  var app = {
    ws: null,
    online: false,
    phase: 'lobby',
    pendingJoin: null,
    reconnecting: false,
    me: { name: null, avatar: null, color: null },
    opponent: null,
    identity: null,
    lan: [],
    state: null,
    status: null,
    history: [],
    lastMove: null,
    selected: null,
    targets: new Map(),
    sound: true,
    sidePref: 'random',
    promo: null,
    rematchAsked: false
  };

  var boardEl, pieceEls = [], squareEls = [], drag = null, audioCtx = null;

  /* ------------------------------ utilities ------------------------------- */

  function initials(name) {
    if (!name) return '?';
    return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  }

  function hueFor(name) {
    var h = 0;
    var str = String(name || '');
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function makeAvatar(player) {
    var el = document.createElement('span');
    el.className = 'avatar';
    if (player && player.avatar) {
      var img = document.createElement('img');
      img.src = player.avatar;
      img.alt = '';
      el.appendChild(img);
    } else {
      el.style.setProperty('--hue', String(hueFor(player && player.name)));
      var span = document.createElement('span');
      span.className = 'avatar-initials';
      span.textContent = initials(player && player.name);
      el.appendChild(span);
    }
    return el;
  }

  function toast(text) {
    var stack = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    stack.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 320);
    }, 2400);
  }

  function parseLastMove(raw) {
    if (!raw || !raw.from || !raw.to) return null;
    var from = typeof raw.from === 'number' ? raw.from : E.parseSquare(raw.from);
    var to = typeof raw.to === 'number' ? raw.to : E.parseSquare(raw.to);
    if (from == null || to == null) return null;
    return { from: from, to: to };
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      return '';
    }
  }

  var LABEL = { w: 'белые', b: 'чёрные' };

  /* -------------------------------- audio -------------------------------- */

  function ensureAudio() {
    if (audioCtx) return;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try { audioCtx = new Ctor(); } catch (err) { audioCtx = null; }
  }

  function unlockAudio() {
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function tone(freq, dur, type, gain, delay) {
    if (!app.sound) return;
    ensureAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    var start = audioCtx.currentTime + (delay || 0);
    var osc = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain || 0.045, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // Свой ход — мягкий короткий щелчок, ход соперника — два отчётливых удара.
  function playMoveSound(entry, mine) {
    if (!app.sound) return;
    var capture = !!(entry && entry.captured);
    if (capture) {
      tone(170, 0.1, 'square', 0.055, 0);
      tone(110, 0.13, 'sine', 0.05, 0.045);
    } else if (mine) {
      tone(520, 0.05, 'sine', 0.03, 0);
    } else {
      tone(430, 0.09, 'triangle', 0.055, 0);
      tone(330, 0.11, 'triangle', 0.05, 0.11);
    }
    if (entry && entry.san && entry.san.indexOf('#') !== -1) return;
    if (entry && entry.san && entry.san.indexOf('+') !== -1) {
      tone(900, 0.14, 'sine', 0.05, 0.16);
    }
  }

  function playStartSound() {
    if (!app.sound) return;
    tone(392, 0.1, 'sine', 0.04, 0);
    tone(523, 0.12, 'sine', 0.04, 0.11);
    tone(659, 0.16, 'sine', 0.045, 0.23);
  }

  function playGameOverSound(won) {
    if (!app.sound) return;
    if (won) {
      tone(523, 0.13, 'sine', 0.05, 0);
      tone(659, 0.13, 'sine', 0.05, 0.13);
      tone(784, 0.22, 'sine', 0.05, 0.26);
    } else {
      tone(392, 0.16, 'sine', 0.05, 0);
      tone(311, 0.18, 'sine', 0.05, 0.15);
      tone(233, 0.26, 'sine', 0.05, 0.3);
    }
  }

  /* ------------------------------ connection ----------------------------- */

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function send(obj) {
    if (!app.ws || app.ws.readyState !== 1) return false;
    app.ws.send(JSON.stringify(obj));
    return true;
  }

  function connect() {
    if (app.ws && (app.ws.readyState === 0 || app.ws.readyState === 1)) return;
    var ws = new WebSocket(wsUrl());
    app.ws = ws;

    ws.onopen = function () {
      app.online = true;
      if (app.pendingJoin) {
        send({ type: 'join', name: app.pendingJoin.name, side: app.pendingJoin.side });
        app.pendingJoin = null;
      }
    };

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      handle(msg);
    };

    ws.onclose = function () {
      var wasOnline = app.online;
      app.online = false;
      if (app.phase === 'lobby') return;
      if (!wasOnline) return;
      toast('Соединение потеряно, переподключаюсь…');
      app.reconnecting = true;
      setTimeout(function () {
        if (app.phase === 'lobby' || app.online) return;
        app.pendingJoin = { name: app.me.name, side: 'random' };
        connect();
      }, 1200);
    };
  }

  function handle(msg) {
    switch (msg.type) {
      case 'hello': onHello(msg); break;
      case 'welcome': onWelcome(msg); break;
      case 'waiting': onWaiting(msg); break;
      case 'start': onStart(msg); break;
      case 'state': onState(msg); break;
      case 'gameover': onGameOver(msg); break;
      case 'opponentOffline': onOpponentOffline(msg); break;
      case 'opponentBack': onOpponentBack(msg); break;
      case 'opponentLeft': onOpponentLeft(msg); break;
      case 'gameAborted': onAborted(msg); break;
      case 'rematchOffered': onRematchOffered(msg); break;
      case 'rematchState': onRematchState(msg); break;
      case 'chat': addChat(msg.message); break;
      case 'left': onLeft(); break;
      case 'error': onError(msg.message); break;
      default: break;
    }
  }

  /* ------------------------------- lobby --------------------------------- */

  function onHello(msg) {
    app.identity = msg.localIdentity || null;
    app.lan = msg.lan || [];
    var avatarBox = $('#lobby-avatar');
    avatarBox.innerHTML = '';
    if (app.identity && app.identity.avatar) {
      var img = document.createElement('img');
      img.src = app.identity.avatar;
      img.alt = '';
      avatarBox.appendChild(img);
    } else {
      var span = document.createElement('span');
      span.className = 'avatar-initials';
      span.textContent = '?';
      avatarBox.appendChild(span);
    }

    var line = $('#lan-line');
    var ip = $('#lan-ip');
    if (app.lan.length) {
      var best = app.lan[0];
      line.innerHTML = 'Ссылка для друга: <b>http://' + best.address + ':' + (msg.port || location.port || 3000) + '</b>';
      ip.textContent = app.lan.length > 1 ? 'другие адреса: ' + app.lan.slice(1).map(function (x) { return x.address; }).join(', ') : '';
    } else {
      line.textContent = 'Сетевой адрес не найден — проверьте подключение к Wi-Fi или кабелю.';
      ip.textContent = '';
    }
  }

  function showLobbyError(text) {
    var el = $('#lobby-error');
    el.textContent = text;
    el.hidden = !text;
  }

  function selectSide(side) {
    app.sidePref = side;
    var buttons = document.querySelectorAll('#sides .side');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('is-active', buttons[i].dataset.side === side);
    }
  }

  function onSubmit(event) {
    event.preventDefault();
    var input = $('#nickname');
    var name = input.value.trim();
    if (!NAME_RE.test(name)) {
      input.classList.add('invalid');
      showLobbyError('Ник: 2–16 символов, только латиница, цифры, «_» или «-».');
      return;
    }
    input.classList.remove('invalid');
    showLobbyError('');
    $('#join-btn').disabled = true;
    app.pendingJoin = { name: name, side: app.sidePref };
    app.me.name = name;
    unlockAudio();
    connect();
    if (app.ws && app.ws.readyState === 1) {
      send({ type: 'join', name: name, side: app.sidePref });
      app.pendingJoin = null;
    }
  }

  function onWelcome(msg) {
    $('#join-btn').disabled = false;
    app.me.name = msg.you.name;
    app.me.avatar = msg.you.avatar || null;
    app.me.color = null;
    app.opponent = null;
    app.phase = 'waiting';
    app.history = [];
    app.lastMove = null;
    app.status = null;
    app.state = E.fromFen(E.START_FEN);
    app.selected = null;
    app.targets = new Map();
    app.rematchAsked = false;

    $('#lobby').hidden = true;
    $('#table').hidden = false;
    buildBoard();
    clearChat();
    (msg.chat || []).forEach(function (entry) { addChat(entry, true); });
    renderAll();
  }

  function onWaiting() {
    app.phase = 'waiting';
    app.opponent = null;
    renderAll();
    showWaitingOverlay('Ожидание подключения друга', 'Отправьте другу ссылку — он откроет её в браузере на этом же Wi-Fi.');
  }

  /* -------------------------------- game --------------------------------- */

  function onStart(msg) {
    app.phase = 'playing';
    app.me.color = msg.you.color;
    app.me.name = msg.you.name;
    app.me.avatar = msg.you.avatar || null;
    app.opponent = msg.opponent;
    app.status = msg.status;
    app.state = E.fromFen(msg.fen);
    app.history = msg.history || [];
    app.lastMove = parseLastMove(msg.lastMove);
    app.selected = null;
    app.targets = new Map();
    app.rematchAsked = false;

    $('#table').hidden = false;
    $('#lobby').hidden = true;
    hideOverlay();
    var rematchBtn = $('#btn-rematch');
    if (rematchBtn) {
      rematchBtn.disabled = false;
      rematchBtn.textContent = 'Реванш';
      rematchBtn.classList.remove('gold');
    }
    buildBoard();
    renderAll();
    if (msg.resumed) toast('Партия восстановлена');
    else playStartSound();
    var input = $('#chat-input');
    if (input) input.focus({ preventScroll: true });
  }

  function onState(msg) {
    var prevLen = app.history.length;
    app.phase = 'playing';
    app.state = E.fromFen(msg.fen);
    app.history = msg.history || [];
    app.status = msg.status;
    app.lastMove = parseLastMove(msg.lastMove);
    app.selected = null;
    app.targets = new Map();

    if (app.history.length > prevLen) {
      var entry = app.history[app.history.length - 1];
      if (entry && entry.piece && entry.piece[0] !== app.me.color) playMoveSound(entry, false);
    }
    renderAll();
  }

  function onGameOver(msg) {
    app.phase = 'over';
    app.selected = null;
    app.targets = new Map();
    app.status = app.status || {};
    app.status.over = true;

    var win = msg.result !== 'draw' && msg.result === app.me.color;
    var title;
    if (msg.result === 'draw') title = 'Ничья';
    else title = win ? 'Вы победили' : 'Вы проиграли';

    var details = msg.result === 'draw'
      ? (msg.reasonText ? 'Основание: ' + msg.reasonText : '')
      : 'Победа ' + (msg.result === 'w' ? 'белых' : 'чёрных') + (msg.reasonText ? ' · ' + msg.reasonText : '');

    showGameOverOverlay(title, details);
    playGameOverSound(win || msg.result === 'draw');
    renderSidebar();
    renderStatus();
  }

  function onOpponentOffline(msg) {
    if (app.opponent) app.opponent.connected = false;
    toast((msg.name || 'Соперник') + ' отключился');
    renderSidebar();
    renderStatus();
  }

  function onOpponentBack(msg) {
    if (app.opponent) app.opponent.connected = true;
    toast((msg.name || 'Соперник') + ' вернулся');
    renderSidebar();
    renderStatus();
  }

  function onOpponentLeft(msg) {
    app.phase = 'waiting';
    app.opponent = null;
    app.state = E.fromFen(E.START_FEN);
    app.history = [];
    app.lastMove = null;
    app.status = null;
    app.selected = null;
    app.targets = new Map();
    renderAll();
    showWaitingOverlay('Соперник вышел', 'Ждём нового игрока. Ссылка для подключения та же.', true);
  }

  function onAborted(msg) {
    app.phase = 'waiting';
    app.opponent = null;
    app.state = E.fromFen(E.START_FEN);
    app.history = [];
    app.lastMove = null;
    app.status = null;
    app.selected = null;
    app.targets = new Map();
    renderAll();
    showWaitingOverlay('Соперник покинул игру', msg.message || 'Ждём подключения друга.', true);
  }

  function onRematchOffered(msg) {
    toast((msg.name || 'Соперник') + ' предлагает реванш');
    var btn = $('#btn-rematch');
    if (btn && !btn.hidden) {
      btn.textContent = 'Согласиться';
      btn.classList.add('gold');
    }
  }

  function onRematchState(msg) {
    var mine = app.me.color === 'w' ? msg.w : msg.b;
    if (mine) {
      var btn = $('#btn-rematch');
      if (btn) { btn.disabled = true; btn.textContent = 'Ждём соперника…'; }
    }
  }

  function onError(text) {
    if (app.phase === 'lobby' || !app.me.name) {
      showLobbyError(text);
      $('#join-btn').disabled = false;
      return;
    }
    toast(text);
  }

  function onLeft() {
    resetToLobby();
  }

  function resetToLobby() {
    app.phase = 'lobby';
    app.me.color = null;
    app.opponent = null;
    app.state = null;
    app.status = null;
    app.history = [];
    app.lastMove = null;
    app.selected = null;
    app.targets = new Map();
    app.rematchAsked = false;
    if (app.ws) {
      try { app.ws.close(); } catch (err) { /* уже закрыт */ }
      app.ws = null;
    }
    app.online = false;
    $('#table').hidden = true;
    $('#lobby').hidden = false;
    $('#join-btn').disabled = false;
    hideOverlay();
    hidePromo();
    clearChat();
    renderAll();
  }

  /* -------------------------------- board -------------------------------- */

  function buildBoard() {
    boardEl = $('#board');
    boardEl.innerHTML = '';
    pieceEls = new Array(64);
    squareEls = new Array(64);
    var flipped = app.me.color === 'b';
    var order = [];
    for (var i = 0; i < 64; i++) order.push(i);
    if (flipped) order.reverse();

    for (var k = 0; k < order.length; k++) {
      (function (idx) {
        var row = idx >> 3;
        var col = idx & 7;
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'sq ' + ((row + col) % 2 === 0 ? 'light' : 'dark');
        cell.dataset.index = String(idx);
        cell.setAttribute('aria-label', E.indexToSquare(idx));

        if (col === (flipped ? 7 : 0)) {
          var rank = document.createElement('span');
          rank.className = 'coord rank';
          rank.textContent = String(8 - row);
          cell.appendChild(rank);
        }
        if (row === (flipped ? 0 : 7)) {
          var file = document.createElement('span');
          file.className = 'coord file';
          file.textContent = 'abcdefgh'[col];
          cell.appendChild(file);
        }

        var piece = document.createElement('span');
        piece.className = 'piece';
        cell.appendChild(piece);
        pieceEls[idx] = piece;
        squareEls[idx] = cell;
        boardEl.appendChild(cell);
      })(order[k]);
    }
    renderBoard();
  }

  function renderBoard() {
    if (!boardEl || !pieceEls.length) return;
    var board = app.state ? app.state.board : null;
    var checkIdx = -1;
    if (app.state && app.status && app.status.check) {
      checkIdx = E.findKing(app.state.board, app.state.turn);
    }
    for (var i = 0; i < 64; i++) {
      var cell = squareEls[i];
      if (!cell) continue;
      var p = board ? board[i] : null;
      var key = p || '';
      var pieceEl = pieceEls[i];
      if (pieceEl.dataset.piece !== key) {
        pieceEl.dataset.piece = key;
        pieceEl.innerHTML = p ? pieceSvg(p[1]) : '';
        pieceEl.className = 'piece' + (p ? ' ' + p[0] : '');
      }
      cell.classList.toggle('selected', app.selected === i);
      var target = app.targets.get(i);
      cell.classList.toggle('target', !!target);
      cell.classList.toggle('capture', !!target && !!target.capture);
      cell.classList.toggle('last', !!app.lastMove && (app.lastMove.from === i || app.lastMove.to === i));
      cell.classList.toggle('check', checkIdx === i);
    }
  }

  function isMyTurn() {
    return app.phase === 'playing' && !!app.state && !!app.status && !app.status.over &&
      !!app.me.color && app.state.turn === app.me.color;
  }

  function setSelection(from) {
    app.selected = from;
    app.targets = new Map();
    if (from != null && app.state && isMyTurn()) {
      var moves = E.legalMoves(app.state);
      for (var i = 0; i < moves.length; i++) {
        if (moves[i].from !== from) continue;
        var occupied = !!app.state.board[moves[i].to];
        var prev = app.targets.get(moves[i].to);
        app.targets.set(moves[i].to, { capture: occupied || (prev && prev.capture) || false });
      }
    }
    renderBoard();
  }

  function squareUnder(x, y) {
    var el = document.elementFromPoint(x, y);
    var cell = el && el.closest ? el.closest('.sq') : null;
    if (!cell) return null;
    return Number(cell.dataset.index);
  }

  function createGhost(idx) {
    var piece = app.state.board[idx];
    if (!piece) return null;
    var ghost = document.createElement('span');
    ghost.className = 'piece ' + piece[0] + ' piece-ghost';
    ghost.innerHTML = pieceSvg(piece[1]);
    var rect = boardEl ? boardEl.getBoundingClientRect() : null;
    var size = rect ? rect.width / 8 : 48;
    ghost.style.width = Math.round(size) + 'px';
    ghost.style.height = Math.round(size) + 'px';
    document.body.appendChild(ghost);
    return ghost;
  }

  function handleSquareTap(idx) {
    if (!app.state) return;
    if (app.targets.has(idx) && app.selected != null) {
      attemptMove(app.selected, idx);
      return;
    }
    var piece = app.state.board[idx];
    if (piece && piece[0] === app.me.color && isMyTurn()) {
      setSelection(idx);
      return;
    }
    setSelection(null);
  }

  function attemptMove(from, to) {
    if (!app.state || !isMyTurn()) return;
    var legal = E.legalMoves(app.state).filter(function (m) { return m.from === from && m.to === to; });
    if (!legal.length) return;
    if (legal.some(function (m) { return !!m.promo; })) {
      openPromo(from, to);
      return;
    }
    commitMove(from, to, null);
  }

  function commitMove(from, to, promo) {
    var move = E.findMove(app.state, from, to, promo);
    if (!move) return;

    app.state = E.applyMove(app.state, move);
    var entry = app.state.history[app.state.history.length - 1];
    app.history = app.history.concat([entry]);
    app.lastMove = { from: from, to: to };
    app.status = E.getStatus(app.state);
    app.selected = null;
    app.targets = new Map();

    playMoveSound(entry, true);
    renderAll();

    send({
      type: 'move',
      from: E.indexToSquare(from),
      to: E.indexToSquare(to),
      promo: promo || null
    });
  }

  function openPromo(from, to) {
    app.promo = { from: from, to: to };
    var box = $('#promo-choices');
    box.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach(function (type) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promo-' + type;
      var piece = document.createElement('span');
      piece.className = 'piece ' + (app.me.color || 'w');
      piece.innerHTML = pieceSvg(type);
      btn.appendChild(piece);
      btn.addEventListener('click', function () {
        hidePromo();
        commitMove(from, to, type);
      });
      box.appendChild(btn);
    });
    $('#promo-modal').hidden = false;
  }

  function hidePromo() {
    app.promo = null;
    $('#promo-modal').hidden = true;
  }

  /* ------------------------------- render -------------------------------- */

  function renderAll() {
    renderBoard();
    renderSidebar();
    renderStatus();
    renderMoves();
    renderButtons();
  }

  function fillPlayerCard(card, player, isSelf) {
    if (!card) return;
    var avatarHost = card.querySelector('[data-role="avatar"]');
    if (avatarHost) {
      var replacement = makeAvatar(player ? { name: player.name, avatar: player.avatar } : null);
      if (isSelf) replacement.classList.add('avatar-self');
      avatarHost.replaceWith(replacement);
      replacement.setAttribute('data-role', 'avatar');
    }

    var nameEl = card.querySelector('[data-role="name"]');
    var subEl = card.querySelector('[data-role="sub"]');
    var takenEl = card.querySelector('[data-role="taken"]');
    var badgeEl = card.querySelector('[data-role="badge"]');

    if (isSelf) {
      if (nameEl) nameEl.textContent = player && player.name ? player.name : (app.me.name || 'Вы');
      if (subEl) {
        subEl.innerHTML = '';
        var pill = document.createElement('span');
        pill.className = 'side-pill';
        var color = app.me.color;
        var dot = document.createElement('i');
        dot.className = 'side-dot ' + (color === 'w' ? 'side-w' : color === 'b' ? 'side-b' : 'side-r');
        pill.appendChild(dot);
        pill.appendChild(document.createTextNode(color ? LABEL[color] : 'сторона не выбрана'));
        subEl.appendChild(pill);
        if (app.phase === 'playing' || app.phase === 'over') {
          var status = document.createElement('span');
          status.textContent = app.online ? 'в сети' : 'нет связи';
          subEl.appendChild(status);
        }
      }
      if (badgeEl) badgeEl.textContent = 'вы';
      renderTaken(takenEl, app.me.color);
      card.classList.toggle('offline', !app.online && app.phase !== 'waiting');
    } else {
      var opp = app.opponent;
      if (nameEl) nameEl.textContent = opp && opp.name ? opp.name : 'Соперник';
      if (subEl) {
        subEl.innerHTML = '';
        if (opp) {
          var p2 = document.createElement('span');
          p2.className = 'side-pill';
          var d2 = document.createElement('i');
          d2.className = 'side-dot ' + (opp.color === 'w' ? 'side-w' : 'side-b');
          p2.appendChild(d2);
          p2.appendChild(document.createTextNode(LABEL[opp.color] || ''));
          subEl.appendChild(p2);
          var st = document.createElement('span');
          st.textContent = opp.connected === false ? 'отключён' : app.phase === 'waiting' ? 'ожидание' : 'в сети';
          subEl.appendChild(st);
        } else {
          subEl.textContent = app.phase === 'waiting' ? 'ожидание подключения…' : 'не подключён';
        }
      }
      if (badgeEl) badgeEl.textContent = '';
      renderTaken(takenEl, opp ? opp.color : null);
      card.classList.toggle('offline', !!opp && opp.connected === false);
    }
  }

  function renderTaken(el, color) {
    if (!el) return;
    el.innerHTML = '';
    if (!color) return;
    var taken = [];
    for (var i = 0; i < app.history.length; i++) {
      var h = app.history[i];
      if (!h || !h.piece || !h.captured) continue;
      if (h.piece[0] !== color) continue;
      taken.push(h.captured);
    }
    for (var j = 0; j < taken.length; j++) el.appendChild(takenNode(taken[j]));
    el.title = taken.length ? 'взято фигур: ' + taken.length : '';
  }

  function renderSidebar() {
    fillPlayerCard($('#player-self'), { name: app.me.name, avatar: app.me.avatar }, true);
    fillPlayerCard($('#player-opp'), app.opponent, false);

    var oppCard = $('#player-opp');
    var selfCard = $('#player-self');
    if (oppCard) oppCard.classList.toggle('is-turn', app.phase === 'playing' && !isMyTurn());
    if (selfCard) selfCard.classList.toggle('is-turn', isMyTurn());
  }

  function renderStatus() {
    var chip = $('#turn-chip');
    var text = $('#status-text');
    var count = $('#move-count');
    if (!chip || !text) return;

    chip.className = 'turn-chip';
    var label = '';
    var moves = Math.ceil(app.history.length / 2);

    if (app.phase === 'lobby') {
      label = 'Лобби';
    } else if (app.phase === 'waiting') {
      chip.classList.add('is-waiting');
      label = 'Ожидание соперника';
    } else if (app.phase === 'over') {
      chip.classList.add('is-over');
      label = 'Партия завершена';
    } else if (isMyTurn()) {
      chip.classList.add('is-mine');
      label = app.status && app.status.check ? 'Ваш ход — шах!' : 'Ваш ход';
    } else {
      chip.classList.add('is-theirs');
      label = 'Ход соперника';
    }
    text.textContent = label;
    if (count) count.textContent = 'Ходов: ' + moves;

    var resign = $('#btn-resign');
    var rematch = $('#btn-rematch');
    var leave = $('#btn-leave');
    if (resign) resign.hidden = app.phase !== 'playing';
    if (rematch) rematch.hidden = app.phase !== 'over';
    if (leave) leave.hidden = app.phase === 'lobby';
  }

  function renderButtons() {
    renderStatus();
  }

  function renderMoves() {
    var box = $('#moves');
    if (!box) return;
    if (!app.history.length) {
      box.innerHTML = '<span class="moves-empty">Ходы появятся здесь</span>';
      return;
    }
    box.innerHTML = '';
    for (var i = 0; i < app.history.length; i += 2) {
      var num = document.createElement('span');
      num.className = 'move-num';
      num.textContent = (i / 2 + 1) + '.';
      box.appendChild(num);
      for (var j = i; j < Math.min(i + 2, app.history.length); j++) {
        var san = document.createElement('span');
        san.className = 'move-san' + (j === app.history.length - 1 ? ' is-last' : '');
        san.textContent = app.history[j].san;
        box.appendChild(san);
      }
    }
    box.scrollTop = box.scrollHeight;
  }

  /* -------------------------------- chat --------------------------------- */

  function clearChat() {
    var log = $('#chat-log');
    if (log) log.innerHTML = '';
  }

  function addChat(msg, silentScroll) {
    if (!msg) return;
    var log = $('#chat-log');
    if (!log) return;

    if (msg.system) {
      var sys = document.createElement('div');
      sys.className = 'msg system';
      sys.textContent = msg.text;
      log.appendChild(sys);
    } else {
      var mine = msg.name && app.me.name && msg.name === app.me.name;
      var row = document.createElement('div');
      row.className = 'msg' + (mine ? ' mine' : '');

      row.appendChild(makeAvatar({ name: msg.name, avatar: msg.avatar }));

      var body = document.createElement('div');
      body.className = 'msg-body';

      var head = document.createElement('div');
      head.className = 'msg-head';
      var nameEl = document.createElement('span');
      nameEl.className = 'msg-name' + (mine ? ' me' : '');
      nameEl.textContent = msg.name || '—';
      var time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = formatTime(msg.ts);
      head.appendChild(nameEl);
      head.appendChild(time);

      var text = document.createElement('div');
      text.className = 'msg-text';
      text.textContent = msg.text;

      body.appendChild(head);
      body.appendChild(text);
      row.appendChild(body);
      log.appendChild(row);
    }

    if (!silentScroll) log.scrollTop = log.scrollHeight;
  }

  function sendChat(event) {
    if (event) event.preventDefault();
    var input = $('#chat-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    if (!send({ type: 'chat', text: text })) {
      toast('Нет соединения с сервером');
      return;
    }
    input.value = '';
    input.focus();
  }

  /* ------------------------------- overlay -------------------------------- */

  function showWaitingOverlay(title, text) {
    var overlay = $('#overlay');
    overlay.hidden = false;
    $('#overlay-spinner').hidden = false;
    $('#overlay-title').textContent = title;
    $('#overlay-text').textContent = text;
    $('#link-row').hidden = false;
    $('#share-link').value = location.origin;

    var actions = $('#overlay-actions');
    actions.innerHTML = '';
    var leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.className = 'btn ghost';
    leaveBtn.textContent = 'Выйти';
    leaveBtn.addEventListener('click', function () { leaveTable(); });
    actions.appendChild(leaveBtn);
  }

  function showGameOverOverlay(title, details) {
    var overlay = $('#overlay');
    overlay.hidden = false;
    $('#overlay-spinner').hidden = true;
    $('#overlay-title').textContent = title;
    $('#overlay-text').textContent = details || '';
    $('#link-row').hidden = true;

    var actions = $('#overlay-actions');
    actions.innerHTML = '';

    var rematch = document.createElement('button');
    rematch.type = 'button';
    rematch.className = 'btn gold';
    rematch.textContent = 'Реванш';
    rematch.addEventListener('click', function () { askRematch(rematch); });
    actions.appendChild(rematch);

    var leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'btn ghost';
    leave.textContent = 'Выйти';
    leave.addEventListener('click', function () { leaveTable(); });
    actions.appendChild(leave);
  }

  function hideOverlay() {
    var overlay = $('#overlay');
    if (overlay) overlay.hidden = true;
  }

  function askRematch(button) {
    if (app.rematchAsked) return;
    if (!send({ type: 'rematch' })) { toast('Нет соединения'); return; }
    app.rematchAsked = true;
    if (button) { button.disabled = true; button.textContent = 'Ждём соперника…'; }
    var btn = $('#btn-rematch');
    if (btn) { btn.disabled = true; btn.textContent = 'Ждём соперника…'; }
  }

  function leaveTable() {
    if (!send({ type: 'leave' })) {
      resetToLobby();
      return;
    }
    app.phase = 'lobby';
    setTimeout(function () {
      if (app.phase === 'lobby') resetToLobby();
    }, 1500);
  }

  /* ------------------------------ interactions ---------------------------- */

  function bindEvents() {
    $('#join-form').addEventListener('submit', onSubmit);

    document.addEventListener('pointerdown', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });

    $('#sides').addEventListener('click', function (event) {
      var btn = event.target.closest('.side');
      if (!btn) return;
      selectSide(btn.dataset.side);
    });

    $('#nickname').addEventListener('input', function () {
      this.classList.remove('invalid');
      showLobbyError('');
    });

    $('#chat-form').addEventListener('submit', sendChat);

    $('#btn-leave').addEventListener('click', leaveTable);

    $('#btn-resign').addEventListener('click', function () {
      if (window.confirm('Сдаться и завершить партию?')) send({ type: 'resign' });
    });

    $('#btn-rematch').addEventListener('click', function () { askRematch(this); });

    $('#btn-sound').addEventListener('click', function () {
      app.sound = !app.sound;
      this.classList.toggle('off', !app.sound);
      this.textContent = app.sound ? 'Звук: вкл' : 'Звук: выкл';
      if (app.sound) tone(440, 0.08, 'sine', 0.04);
    });

    $('#copy-link').addEventListener('click', function () {
      var link = location.origin;
      var btn = this;
      var done = function () {
        btn.textContent = 'Скопировано';
        setTimeout(function () { btn.textContent = 'Копировать'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, function () { fallbackCopy(link, done); });
      } else {
        fallbackCopy(link, done);
      }
    });

    $('#promo-modal').addEventListener('click', function (event) {
      if (event.target === this) hidePromo();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (!app.promo) hidePromo();
        if (app.selected != null && app.state) setSelection(null);
      }
    });

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', function () { cancelDrag(); });
  }

  function fallbackCopy(text, done) {
    var input = $('#share-link');
    if (input) {
      input.value = text;
      input.select();
      try { document.execCommand('copy'); done(); } catch (err) { toast('Скопируйте ссылку вручную'); }
    }
  }

  function onPointerMove(event) {
    if (!drag) return;
    var dx = event.clientX - drag.x;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.sqrt(dx * dx + dy * dy) > 6) {
      drag.moved = true;
      setSelection(drag.from);
      drag.ghost = createGhost(drag.from);
      boardEl.classList.add('dragging');
    }
    if (!drag.moved) return;
    if (drag.ghost) {
      drag.ghost.style.left = event.clientX + 'px';
      drag.ghost.style.top = event.clientY + 'px';
    }
    var target = squareUnder(event.clientX, event.clientY);
    if (drag.hover !== target) {
      if (drag.hover != null && boardEl.children.length) {
        var prev = boardEl.querySelector('.sq[data-index="' + drag.hover + '"]');
        if (prev) prev.classList.remove('hover');
      }
      drag.hover = target;
      if (target != null) {
        var next = boardEl.querySelector('.sq[data-index="' + target + '"]');
        if (next) next.classList.add('hover');
      }
    }
  }

  function onPointerUp(event) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.hover != null) {
      var prev = boardEl.querySelector('.sq[data-index="' + d.hover + '"]');
      if (prev) prev.classList.remove('hover');
    }
    if (boardEl) boardEl.classList.remove('dragging');
    if (d.ghost) d.ghost.remove();

    if (d.moved) {
      var target = squareUnder(event.clientX, event.clientY);
      if (target != null && app.targets.has(target)) {
        attemptMove(d.from, target);
      } else if (target !== d.from) {
        setSelection(null);
      } else {
        setSelection(d.from);
      }
    } else if (app.selected === d.from) {
      setSelection(null);
    } else {
      setSelection(d.from);
    }
    renderBoard();
  }

  function cancelDrag() {
    if (drag) {
      if (drag.ghost) drag.ghost.remove();
      drag = null;
    }
    if (boardEl) boardEl.classList.remove('dragging');
  }

  function bindBoard() {
    boardEl = $('#board');
    boardEl.addEventListener('pointerdown', onBoardPointerDown);
  }

  /* --------------------------------- boot --------------------------------- */

  function boot() {
    bindEvents();
    bindBoard();
    connect();
  }

  function onBoardPointerDown(event) {
    if (event.button !== 0) return;
    if (app.phase !== 'playing' || !app.state || app.promo) return;
    var cell = event.target.closest('.sq');
    if (!cell) return;
    var idx = Number(cell.dataset.index);
    var piece = app.state.board[idx];

    if (!piece || piece[0] !== app.me.color || !isMyTurn()) {
      handleSquareTap(idx);
      return;
    }
    drag = { from: idx, x: event.clientX, y: event.clientY, moved: false, ghost: null, hover: null };
    event.preventDefault();
  }

  boot();
})();

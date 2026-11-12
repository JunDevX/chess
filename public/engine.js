(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChessEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var FILES = 'abcdefgh';

  var KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  var KING_DELTAS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
  var BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  var ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  var QUEEN_DIRS = BISHOP_DIRS.concat(ROOK_DIRS);

  function indexToSquare(i) {
    return FILES[i % 8] + (8 - Math.floor(i / 8));
  }

  function squareToIndex(s) {
    var col = FILES.indexOf(s[0]);
    var row = 8 - Number(s[1]);
    return row * 8 + col;
  }

  function fromFen(fen) {
    var parts = String(fen || START_FEN).trim().split(/\s+/);
    var board = new Array(64).fill(null);
    var i = 0;
    var layout = parts[0] || '';
    for (var k = 0; k < layout.length; k++) {
      var ch = layout[k];
      if (ch === '/') continue;
      if (ch >= '1' && ch <= '8') { i += Number(ch); continue; }
      var lower = ch.toLowerCase();
      var isWhite = ch === ch.toUpperCase();
      board[i++] = (isWhite ? 'w' : 'b') + lower;
    }
    var st = {
      board: board,
      turn: parts[1] === 'b' ? 'b' : 'w',
      castling: !parts[2] || parts[2] === '-' ? '' : parts[2],
      ep: parts[3] && parts[3] !== '-' ? squareToIndex(parts[3]) : null,
      halfmove: Number(parts[4] || 0),
      fullmove: Number(parts[5] || 1),
      history: [],
      counts: {},
      lastMove: null
    };
    st.counts[positionKey(st)] = 1;
    return st;
  }

  function toFen(s) {
    var out = '';
    for (var r = 0; r < 8; r++) {
      var empty = 0;
      for (var c = 0; c < 8; c++) {
        var p = s.board[r * 8 + c];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += p[0] === 'w' ? p[1].toUpperCase() : p[1];
      }
      if (empty) out += empty;
      if (r < 7) out += '/';
    }
    return [
      out,
      s.turn,
      s.castling || '-',
      s.ep == null ? '-' : indexToSquare(s.ep),
      s.halfmove,
      s.fullmove
    ].join(' ');
  }

  function positionKey(s) {
    return toFen(s).split(' ').slice(0, 4).join(' ');
  }

  function findKing(board, color) {
    var target = color + 'k';
    for (var i = 0; i < 64; i++) if (board[i] === target) return i;
    return -1;
  }

  function isAttacked(board, target, by) {
    if (target < 0) return false;
    var row = target >> 3;
    var col = target & 7;
    var pawnRow = by === 'w' ? row + 1 : row - 1;
    if (pawnRow >= 0 && pawnRow < 8) {
      for (var d = -1; d <= 1; d += 2) {
        var pc = col + d;
        if (pc < 0 || pc > 7) continue;
        if (board[pawnRow * 8 + pc] === by + 'p') return true;
      }
    }
    var i, r, c;
    for (i = 0; i < KNIGHT_DELTAS.length; i++) {
      r = row + KNIGHT_DELTAS[i][1];
      c = col + KNIGHT_DELTAS[i][0];
      if (r < 0 || r > 7 || c < 0 || c > 7) continue;
      if (board[r * 8 + c] === by + 'n') return true;
    }
    for (i = 0; i < KING_DELTAS.length; i++) {
      r = row + KING_DELTAS[i][1];
      c = col + KING_DELTAS[i][0];
      if (r < 0 || r > 7 || c < 0 || c > 7) continue;
      if (board[r * 8 + c] === by + 'k') return true;
    }
    var sliding = [[BISHOP_DIRS, 'bq'], [ROOK_DIRS, 'rq']];
    for (var sIdx = 0; sIdx < sliding.length; sIdx++) {
      var dirs = sliding[sIdx][0];
      var pieces = sliding[sIdx][1];
      for (i = 0; i < dirs.length; i++) {
        r = row + dirs[i][1];
        c = col + dirs[i][0];
        while (r >= 0 && r < 8 && c >= 0 && c < 8) {
          var p = board[r * 8 + c];
          if (p) {
            if (p[0] === by && pieces.indexOf(p[1]) !== -1) return true;
            break;
          }
          r += dirs[i][1];
          c += dirs[i][0];
        }
      }
    }
    return false;
  }

  function pushIfOk(moves, board, from, row, col, color) {
    if (row < 0 || row > 7 || col < 0 || col > 7) return;
    var t = row * 8 + col;
    var p = board[t];
    if (p && p[0] === color) return;
    moves.push({ from: from, to: t });
  }

  function addPawnMove(moves, from, to, promo) {
    if (!promo) { moves.push({ from: from, to: to }); return; }
    var promos = ['q', 'r', 'b', 'n'];
    for (var i = 0; i < promos.length; i++) moves.push({ from: from, to: to, promo: promos[i] });
  }

  function generatePseudo(s, color) {
    var moves = [];
    var board = s.board;
    var opponent = color === 'w' ? 'b' : 'w';
    for (var i = 0; i < 64; i++) {
      var p = board[i];
      if (!p || p[0] !== color) continue;
      var type = p[1];
      var row = i >> 3;
      var col = i & 7;
      var j, dirs, r, c, t;

      if (type === 'p') {
        var dir = color === 'w' ? -1 : 1;
        var startRow = color === 'w' ? 6 : 1;
        var promoRow = color === 'w' ? 0 : 7;
        var oneRow = row + dir;
        if (oneRow >= 0 && oneRow <= 7) {
          var one = oneRow * 8 + col;
          if (!board[one]) {
            addPawnMove(moves, i, one, oneRow === promoRow);
            var twoRow = row + 2 * dir;
            if (row === startRow && !board[twoRow * 8 + col]) {
              moves.push({ from: i, to: twoRow * 8 + col });
            }
          }
          for (var dc = -1; dc <= 1; dc += 2) {
            var c2 = col + dc;
            if (c2 < 0 || c2 > 7) continue;
            t = oneRow * 8 + c2;
            if (board[t] && board[t][0] !== color) addPawnMove(moves, i, t, oneRow === promoRow);
            else if (s.ep === t && !board[t]) moves.push({ from: i, to: t, enpassant: true });
          }
        }
      } else if (type === 'n') {
        for (j = 0; j < KNIGHT_DELTAS.length; j++) {
          pushIfOk(moves, board, i, row + KNIGHT_DELTAS[j][1], col + KNIGHT_DELTAS[j][0], color);
        }
      } else if (type === 'k') {
        for (j = 0; j < KING_DELTAS.length; j++) {
          pushIfOk(moves, board, i, row + KING_DELTAS[j][1], col + KING_DELTAS[j][0], color);
        }
        var homeRow = color === 'w' ? 7 : 0;
        if (row === homeRow && col === 4) {
          var kingSide = color === 'w' ? 'K' : 'k';
          var queenSide = color === 'w' ? 'Q' : 'q';
          if (s.castling.indexOf(kingSide) !== -1 &&
              board[homeRow * 8 + 7] === color + 'r' &&
              !board[homeRow * 8 + 5] && !board[homeRow * 8 + 6] &&
              !isAttacked(board, homeRow * 8 + 4, opponent) &&
              !isAttacked(board, homeRow * 8 + 5, opponent) &&
              !isAttacked(board, homeRow * 8 + 6, opponent)) {
            moves.push({ from: i, to: homeRow * 8 + 6, castle: 'K' });
          }
          if (s.castling.indexOf(queenSide) !== -1 &&
              board[homeRow * 8 + 0] === color + 'r' &&
              !board[homeRow * 8 + 1] && !board[homeRow * 8 + 2] && !board[homeRow * 8 + 3] &&
              !isAttacked(board, homeRow * 8 + 4, opponent) &&
              !isAttacked(board, homeRow * 8 + 3, opponent) &&
              !isAttacked(board, homeRow * 8 + 2, opponent)) {
            moves.push({ from: i, to: homeRow * 8 + 2, castle: 'Q' });
          }
        }
      } else {
        dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
        for (j = 0; j < dirs.length; j++) {
          r = row + dirs[j][1];
          c = col + dirs[j][0];
          while (r >= 0 && r < 8 && c >= 0 && c < 8) {
            t = r * 8 + c;
            var target = board[t];
            if (!target) moves.push({ from: i, to: t });
            else {
              if (target[0] !== color) moves.push({ from: i, to: t });
              break;
            }
            r += dirs[j][1];
            c += dirs[j][0];
          }
        }
      }
    }
    return moves;
  }

  function doMove(s, move) {
    var ns = {
      board: s.board.slice(),
      turn: s.turn === 'w' ? 'b' : 'w',
      castling: s.castling,
      ep: null,
      halfmove: s.halfmove + 1,
      fullmove: s.fullmove + (s.turn === 'b' ? 1 : 0),
      history: s.history,
      counts: s.counts,
      lastMove: { from: move.from, to: move.to }
    };
    var piece = ns.board[move.from];
    var color = piece[0];
    var type = piece[1];
    var captured = ns.board[move.to];

    ns.board[move.from] = null;
    if (move.enpassant) {
      var capSq = move.to + (color === 'w' ? 8 : -8);
      captured = ns.board[capSq];
      ns.board[capSq] = null;
    }
    ns.board[move.to] = move.promo ? color + move.promo : piece;

    if (type === 'p' || captured) ns.halfmove = 0;
    if (type === 'p' && Math.abs(move.to - move.from) === 16) ns.ep = (move.from + move.to) / 2;

    if (move.castle) {
      var homeRow = move.to >> 3;
      if (move.castle === 'K') {
        ns.board[homeRow * 8 + 5] = ns.board[homeRow * 8 + 7];
        ns.board[homeRow * 8 + 7] = null;
      } else {
        ns.board[homeRow * 8 + 3] = ns.board[homeRow * 8 + 0];
        ns.board[homeRow * 8 + 0] = null;
      }
    }

    var cast = ns.castling;
    function drop(flag) { cast = cast.split(flag).join(''); }
    if (type === 'k') {
      if (color === 'w') { drop('K'); drop('Q'); } else { drop('k'); drop('q'); }
    }
    if (move.from === 63 || move.to === 63) drop('K');
    if (move.from === 56 || move.to === 56) drop('Q');
    if (move.from === 7 || move.to === 7) drop('k');
    if (move.from === 0 || move.to === 0) drop('q');
    ns.castling = cast;

    return ns;
  }

  function legalMoves(s) {
    var color = s.turn;
    var opponent = color === 'w' ? 'b' : 'w';
    var pseudo = generatePseudo(s, color);
    var out = [];
    for (var i = 0; i < pseudo.length; i++) {
      var ns = doMove(s, pseudo[i]);
      var k = findKing(ns.board, color);
      if (k === -1 || !isAttacked(ns.board, k, opponent)) out.push(pseudo[i]);
    }
    return out;
  }

  function moveToSan(s, move) {
    var piece = s.board[move.from];
    if (!piece) return '';
    var type = piece[1];
    var target = indexToSquare(move.to);
    var capture = !!s.board[move.to] || !!move.enpassant;
    var san;

    if (move.castle) {
      san = move.castle === 'K' ? 'O-O' : 'O-O-O';
    } else if (type === 'p') {
      san = (capture ? FILES[move.from % 8] + 'x' : '') + target;
      if (move.promo) san += '=' + move.promo.toUpperCase();
    } else {
      var others = legalMoves(s).filter(function (m) {
        if (m === move || m.from === move.from || m.to !== move.to) return false;
        var other = s.board[m.from];
        return other && other[1] === type;
      });
      var disamb = '';
      if (others.length) {
        var sameFile = others.some(function (m) { return (m.from % 8) === (move.from % 8); });
        var sameRank = others.some(function (m) { return (m.from >> 3) === (move.from >> 3); });
        if (!sameFile) disamb = FILES[move.from % 8];
        else if (!sameRank) disamb = String(8 - (move.from >> 3));
        else disamb = indexToSquare(move.from);
      }
      san = type.toUpperCase() + disamb + (capture ? 'x' : '') + target;
    }

    var ns = doMove(s, move);
    var opp = ns.turn;
    var k = findKing(ns.board, opp);
    if (k !== -1 && isAttacked(ns.board, k, opp === 'w' ? 'b' : 'w')) {
      san += legalMoves(ns).length ? '+' : '#';
    }
    return san;
  }

  function applyMove(s, move) {
    var san = moveToSan(s, move);
    var captured = s.board[move.to];
    if (move.enpassant) captured = s.board[move.to + (s.turn === 'w' ? 8 : -8)];
    var ns = doMove(s, move);
    ns.history = s.history.concat([{
      san: san,
      from: move.from,
      to: move.to,
      piece: s.board[move.from],
      captured: captured || null,
      promo: move.promo || null,
      castle: move.castle || null
    }]);
    var key = positionKey(ns);
    var counts = {};
    for (var k in s.counts) if (Object.prototype.hasOwnProperty.call(s.counts, k)) counts[k] = s.counts[k];
    counts[key] = (counts[key] || 0) + 1;
    ns.counts = counts;
    return ns;
  }

  function insufficientMaterial(board) {
    var counts = { w: {}, b: {} };
    var bishops = [];
    for (var i = 0; i < 64; i++) {
      var p = board[i];
      if (!p) continue;
      var type = p[1];
      if (type === 'k') continue;
      counts[p[0]][type] = (counts[p[0]][type] || 0) + 1;
      if (type === 'p' || type === 'r' || type === 'q') return false;
      if (type === 'b') bishops.push({ color: p[0], squareColor: ((i >> 3) + (i & 7)) % 2 });
    }
    var total = (counts.w.n || 0) + (counts.b.n || 0) + bishops.length;
    if (total === 0) return true;
    if (total === 1) return true;
    if ((counts.w.n || 0) === 0 && (counts.b.n || 0) === 0) {
      var sameColor = bishops.every(function (b) { return b.squareColor === bishops[0].squareColor; });
      if (sameColor) return true;
    }
    return false;
  }

  function getStatus(s) {
    var moves = legalMoves(s);
    var k = findKing(s.board, s.turn);
    var inCheck = k !== -1 && isAttacked(s.board, k, s.turn === 'w' ? 'b' : 'w');
    if (!moves.length) {
      return {
        over: true,
        check: inCheck,
        type: inCheck ? 'checkmate' : 'stalemate',
        result: inCheck ? (s.turn === 'w' ? 'b' : 'w') : 'draw',
        reason: inCheck ? 'checkmate' : 'stalemate'
      };
    }
    if (s.halfmove >= 100) return { over: true, check: inCheck, type: 'draw', result: 'draw', reason: 'fifty' };
    if (insufficientMaterial(s.board)) return { over: true, check: inCheck, type: 'draw', result: 'draw', reason: 'insufficient' };
    if (s.counts && (s.counts[positionKey(s)] || 0) >= 3) {
      return { over: true, check: inCheck, type: 'draw', result: 'draw', reason: 'repetition' };
    }
    return { over: false, check: inCheck, type: 'playing', result: null, reason: null };
  }

  function findMove(s, from, to, promo) {
    var moves = legalMoves(s);
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (m.from !== from || m.to !== to) continue;
      var needPromo = s.board[m.from][1] === 'p' && (m.to >> 3) === (s.turn === 'w' ? 0 : 7);
      if (needPromo) {
        if (!promo) continue;
        if (m.promo !== String(promo).toLowerCase()) continue;
      } else if (m.promo) continue;
      return m;
    }
    return null;
  }

  function moveToPayload(m) {
    return { from: indexToSquare(m.from), to: indexToSquare(m.to), promo: m.promo || null };
  }

  function parseSquare(value) {
    if (typeof value !== 'string' || !/^[a-h][1-8]$/.test(value)) return null;
    return squareToIndex(value);
  }

  return {
    START_FEN: START_FEN,
    fromFen: fromFen,
    toFen: toFen,
    legalMoves: legalMoves,
    applyMove: applyMove,
    getStatus: getStatus,
    findMove: findMove,
    findKing: findKing,
    isAttacked: isAttacked,
    indexToSquare: indexToSquare,
    squareToIndex: squareToIndex,
    parseSquare: parseSquare,
    moveToPayload: moveToPayload,
    insufficientMaterial: insufficientMaterial
  };
});

/* 8x4 Draft Chess – Alternating Placement */

// ---------- Constants ----------
const ROWS = 5; // rows
const COLS = 5; // columns
const START_MS = 90_000; // 1.5 minutes per player

// Piece catalog (same abilities as before)
const PIECE_TYPES = [
  {
    id: 'warrior', abbr: 'Wa', name: 'Warrior',
    description: 'Moves 1 orthogonally. Special: Bash – capture adjacent orthogonal without moving.',
    getMoves: (s, p) => stepMoves(s, p, [[1,0],[-1,0],[0,1],[0,-1]], 1),
    getSpecialTargets: (s, p) => adjEnemies(s, p, [[1,0],[-1,0],[0,1],[0,-1]]),
    applySpecial: (s, p, t) => specialCapture(s, p, t),
  },
  {
    id: 'ranger', abbr: 'Ra', name: 'Ranger',
    description: 'Moves 1 any direction. Special: Shoot – capture at distance 2 straight if path clear.',
    getMoves: (s, p) => stepMoves(s, p, [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]], 1),
    getSpecialTargets: (s, p) => {
      const out = [];
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const r1 = p.row + dr, c1 = p.col + dc;
        const r2 = p.row + 2*dr, c2 = p.col + 2*dc;
        if (!inBounds(r1,c1) || !inBounds(r2,c2)) continue;
        if (s.board[r1][c1] !== null) continue;
        const t = s.board[r2][c2];
        if (t && t.owner !== p.owner) out.push({ r: r2, c: c2, kind: 'capture' });
      }
      return out;
    },
    applySpecial: (s, p, t) => specialCapture(s, p, t),
  },
  {
    id: 'mage', abbr: 'Mg', name: 'Mage',
    description: 'Diagonals any distance. Special: Blink up to 3 diagonally to empty.',
    getMoves: (s, p) => rayMoves(s, p, [[1,1],[1,-1],[-1,1],[-1,-1]]),
    getSpecialTargets: (s, p) => {
      const out = [];
      for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
        for (let k = 1; k <= 3; k++) {
          const r = p.row + dr*k, c = p.col + dc*k;
          if (!inBounds(r,c)) break;
          if (s.board[r][c] !== null) break;
          out.push({ r, c, kind: 'move' });
        }
      }
      return out;
    },
    applySpecial: (s, p, t) => specialTeleport(s, p, t),
  },
  {
    id: 'rogue', abbr: 'Ro', name: 'Rogue',
    description: 'Knight-like jumps. Special: Leap to any empty square at Chebyshev distance 2.',
    getMoves: (s, p) => {
      const out = [];
      for (const [dr, dc] of [[2,1],[1,2],[-1,2],[-2,1],[-2,-1],[-1,-2],[1,-2],[2,-1]]) {
        const r = p.row + dr, c = p.col + dc;
        if (!inBounds(r,c)) continue;
        const t = s.board[r][c];
        if (!t || t.owner !== p.owner) out.push({ r, c });
      }
      return out;
    },
    getSpecialTargets: (s, p) => {
      const out = [];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== 2) continue;
          const r = p.row + dr, c = p.col + dc;
          if (!inBounds(r,c)) continue;
          if (s.board[r][c] === null) out.push({ r, c, kind: 'move' });
        }
      }
      return out;
    },
    applySpecial: (s, p, t) => specialTeleport(s, p, t),
  },
  {
    id: 'sentinel', abbr: 'Se', name: 'Sentinel',
    description: 'Orthogonals any distance. Special: Fortify – cannot be captured during next enemy turn.',
    getMoves: (s, p) => rayMoves(s, p, [[1,0],[-1,0],[0,1],[0,-1]]),
    getSpecialTargets: () => [{ self: true, kind: 'status' }],
    applySpecial: (_s, p) => { p.fortifiedTurnsLeft = 1; return true; },
  },
];

const TYPE_BY_ID = Object.fromEntries(PIECE_TYPES.map(t => [t.id, t]));

// ---------- State ----------
const state = {
  phase: 'draft',
  board: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null)),
  nextPieceId: 1,
  players: {
    P1: { drafted: [], bench: [], timeMs: START_MS, name: 'Player 1' },
    P2: { drafted: [], bench: [], timeMs: START_MS, name: 'Player 2' },
  },
  currentDraftPlayer: 'P1',
  placementTurn: 'P1', // alternating placement
  activePlayer: null,
  selected: null,
  winner: null,
  intervalHandle: null,
  lastTick: null,
  ai: { P1: false, P2: false },
  aiBusy: false,
  captainsAssigned: false,
};

// ---------- DOM ----------
const boardEl = document.getElementById('board');
const sidebarEl = document.getElementById('sidebar');
const statusEl = document.getElementById('status');
const controlsEl = document.getElementById('controls');
const logEl = document.getElementById('log');
const appRootEl = document.getElementById('appRoot');
const timeP1El = document.getElementById('timeP1');
const timeP2El = document.getElementById('timeP2');
const clockP1 = document.getElementById('clockP1');
const clockP2 = document.getElementById('clockP2');

// ---------- Helpers ----------
const otherPlayer = (p) => (p === 'P1' ? 'P2' : 'P1');
const inBounds = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const fmtTime = (ms) => {
  const clamped = Math.max(0, ms);
  const s = Math.floor(clamped / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  const ds = Math.floor((clamped % 1000) / 100);
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}.${ds}`;
};
function log(msg) { const div = document.createElement('div'); div.className='entry'; div.textContent=msg; logEl.prepend(div); }

// Movement helpers
function stepMoves(state, piece, deltas, maxSteps) {
  const moves = [];
  for (const [dr, dc] of deltas) {
    for (let k = 1; k <= maxSteps; k++) {
      const r = piece.row + dr*k, c = piece.col + dc*k;
      if (!inBounds(r,c)) break;
      const t = state.board[r][c];
      if (t === null) moves.push({ r, c }); else { if (t.owner !== piece.owner) moves.push({ r, c }); break; }
    }
  }
  return moves;
}
function rayMoves(state, piece, rays) {
  const moves = [];
  for (const [dr, dc] of rays) {
    for (let k = 1; ; k++) {
      const r = piece.row + dr*k, c = piece.col + dc*k;
      if (!inBounds(r,c)) break;
      const t = state.board[r][c];
      if (t === null) moves.push({ r, c }); else { if (t.owner !== piece.owner) moves.push({ r, c }); break; }
    }
  }
  return moves;
}
function adjEnemies(state, piece, deltas) {
  const out = [];
  for (const [dr, dc] of deltas) {
    const r = piece.row + dr, c = piece.col + dc;
    if (!inBounds(r,c)) continue;
    const t = state.board[r][c];
    if (t && t.owner !== piece.owner) out.push({ r, c, kind: 'capture' });
  }
  return out;
}
function specialCapture(state, piece, target) {
  if (!target) return false;
  const { r, c } = target;
  const enemy = state.board[r][c];
  if (enemy && enemy.owner !== piece.owner && enemy.fortifiedTurnsLeft <= 0) {
    capturePiece(state, enemy);
    return true;
  }
  return false;
}
function specialTeleport(state, piece, target) {
  if (!target) return false;
  const { r, c } = target;
  if (!inBounds(r,c)) return false;
  if (state.board[r][c] !== null) return false;
  movePieceTo(state, piece, r, c);
  return true;
}

// Piece utils
function createPiece(typeId, owner) {
  const id = state.nextPieceId++;
  return { id, typeId, owner, row: null, col: null, isCaptain: false, specialUsed: false, fortifiedTurnsLeft: 0 };
}
function placePiece(state, piece, r, c) {
  if (!inBounds(r,c)) return false;
  if (state.board[r][c] !== null) return false;
  piece.row = r; piece.col = c; state.board[r][c] = piece; return true;
}
function movePieceTo(state, piece, r, c) {
  if (!inBounds(r,c)) return false;
  const fromR = piece.row, fromC = piece.col; if (fromR === null || fromC === null) return false;
  const target = state.board[r][c];
  if (target && target.owner !== piece.owner) {
    if (target.fortifiedTurnsLeft > 0) return false;
    capturePiece(state, target);
  } else if (target) return false;
  state.board[fromR][fromC] = null; piece.row = r; piece.col = c; state.board[r][c] = piece; return true;
}
function capturePiece(state, piece) {
  if (piece.row !== null && piece.col !== null) { state.board[piece.row][piece.col] = null; piece.row = null; piece.col = null; }
  log(`${piece.owner} ${TYPE_BY_ID[piece.typeId].name}${piece.isCaptain ? ' (Captain)' : ''} was captured!`);
  if (piece.isCaptain) endGame(otherPlayer(piece.owner), `${otherPlayer(piece.owner)} wins by capturing the captain!`);
}

// Clock
function startClock(forPlayer) {
  stopClock(); state.activePlayer = forPlayer; state.lastTick = performance.now(); setClockActive(forPlayer);
  state.intervalHandle = setInterval(() => {
    const now = performance.now(); const dt = now - state.lastTick; state.lastTick = now; const p = state.players[state.activePlayer];
    p.timeMs -= dt;
    if (p.timeMs <= 0) { p.timeMs = 0; updateClocks(); endGame(otherPlayer(state.activePlayer), `${otherPlayer(state.activePlayer)} wins on time!`); }
    else updateClocks();
  }, 100);
}
function stopClock() { if (state.intervalHandle) clearInterval(state.intervalHandle); state.intervalHandle = null; setClockActive(null); }
function setClockActive(player) { clockP1.classList.toggle('active', player === 'P1'); clockP2.classList.toggle('active', player === 'P2'); }
function updateClocks() { timeP1El.textContent = fmtTime(state.players.P1.timeMs); timeP2El.textContent = fmtTime(state.players.P2.timeMs); }
function endGame(winner, message) { state.phase = 'gameover'; state.winner = winner; stopClock(); statusEl.textContent = message; render(); }

// ---------- Rendering ----------
function render() { 
  // Set data-phase for responsive styling of draft panel width
  appRootEl?.setAttribute('data-phase', state.phase);
  document.body?.setAttribute('data-phase', state.phase);
  renderBoard(); renderSidebar(); renderControls(); updateClocks(); 
  maybeRunAi();
  wireModeModalIfNeeded();
}
function renderBoard() {
  boardEl.innerHTML = '';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const sq = document.createElement('div');
      sq.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
      sq.dataset.r = r; sq.dataset.c = c;

      // Placement highlighting: current player's full home row
      if (state.phase === 'placement') {
        const homeRow = (state.placementTurn === 'P1') ? ROWS - 1 : 0;
        if (r === homeRow && state.board[r][c] === null) sq.classList.add('highlight');
      }

      // Play highlights
      const selected = state.selected?.piece || null;
      let legalMoves = [], specialTargets = [];
      if (state.phase === 'play' && selected) {
        if (state.selected.specialMode) {
          const type = TYPE_BY_ID[selected.typeId];
          specialTargets = (type.getSpecialTargets?.(state, selected) || []);
        } else {
          // For previewing opponent piece, show its potential moves too
          legalMoves = getLegalMoves(state, selected);
        }
      }
      const isMove = legalMoves.some(m => m.r === r && m.c === c);
      let isSpecial = specialTargets.some(m => m.r === r && m.c === c);
      // If a self-target special exists (e.g., Sentinel Fortify), also highlight the piece's own square
      if (!isSpecial && state.phase === 'play' && state.selected?.specialMode && selected && specialTargets.some(t => t.self)) {
        if (r === selected.row && c === selected.col) isSpecial = true;
      }
      const targetObj = state.board[r][c];
      const isCapturable = !!(selected && targetObj && targetObj.owner !== selected.owner && (isMove || isSpecial));
      if (selected && (isMove || isSpecial)) sq.classList.add(isSpecial ? 'special' : 'move');
      if (isCapturable) sq.classList.add('capturable');

      const piece = state.board[r][c];
      if (piece) {
        const pEl = document.createElement('div');
        pEl.className = `piece ${piece.owner} ${piece.isCaptain ? 'captain' : ''} ${piece.fortifiedTurnsLeft>0 ? 'fortified':''}`;
        const abbr = document.createElement('div'); abbr.className = 'abbr'; abbr.textContent = TYPE_BY_ID[piece.typeId].abbr;
        pEl.title = `${piece.owner} ${TYPE_BY_ID[piece.typeId].name}${piece.isCaptain ? ' (Captain)' : ''}`;
        pEl.appendChild(abbr); sq.appendChild(pEl);
      }
      sq.addEventListener('click', () => onSquareClick(r, c));
      boardEl.appendChild(sq);
    }
  }
}

function renderSidebar() {
  const phase = state.phase; const sidebar = [];
  sidebar.push(`<div class="phase">Phase: ${phase.toUpperCase()}</div>`);
  if (phase === 'draft') {
    sidebar.push(`<h2>Draft – ${state.players[state.currentDraftPlayer].name}</h2>`);
    sidebar.push(`<div>Pick unique pieces (4 total). Alternate picks.</div>`);
    sidebar.push('<div class="card-grid">');
    for (const t of PIECE_TYPES) {
      const picked = state.players[state.currentDraftPlayer].drafted.includes(t.id);
      const disabled = picked || state.players[state.currentDraftPlayer].drafted.length >= 4;
      sidebar.push(`
        <div class="card">
          <div class="name">${t.name} <span class="meta">(${t.abbr})</span></div>
          <div class="desc">${t.description}</div>
          <button class="btn pick" data-pick="${t.id}" ${disabled ? 'disabled' : ''}>${picked ? 'Picked' : 'Pick'}</button>
        </div>`);
    }
    sidebar.push('</div>');
    sidebar.push(`<div class="bench">
      <span class="chip P1">P1: ${state.players.P1.drafted.map(id => TYPE_BY_ID[id].abbr).join(' ') || '-'}</span>
      <span class="chip P2">P2: ${state.players.P2.drafted.map(id => TYPE_BY_ID[id].abbr).join(' ') || '-'}</span>
    </div>`);
  } else if (phase === 'captain') {
    sidebar.push('<h2>Assign Captains</h2>');
    sidebar.push('<div>Select one drafted piece per player as the Captain.</div>');
    const section = (playerKey) => {
      const p = state.players[playerKey];
      const options = p.drafted.map(id => `<label><input type="radio" name="cap-${playerKey}" value="${id}"> ${TYPE_BY_ID[id].name} (${TYPE_BY_ID[id].abbr})</label>`).join('<br/>');
      return `<div class="card"><div class="name">${p.name}</div><div class="desc">${options}</div></div>`;
    };
    sidebar.push('<div class="card-grid">');
    sidebar.push(section('P1'));
    sidebar.push(section('P2'));
    sidebar.push('</div>');
    sidebar.push('<button class="btn primary" id="confirmCaptains">Confirm Captains</button>');
  } else if (phase === 'placement') {
    const placer = state.placementTurn;
    sidebar.push(`<h2>Placement – ${state.players[placer].name}</h2>`);
    sidebar.push(`<div>Alternate placement: ${state.players[placer].name} to place one piece on ${placer==='P1'?'bottom':'top'} home row.</div>`);
    const bench = state.players[placer].bench;
    if (bench.length === 0) sidebar.push(`<div class="desc">No pieces left for ${state.players[placer].name}.</div>`);
    sidebar.push('<div class="bench" id="bench">');
    for (const p of bench) sidebar.push(`<button class="chip ${p.owner}" data-bench-id="${p.id}">${TYPE_BY_ID[p.typeId].name}${p.isCaptain ? ' ★' : ''}</button>`);
    sidebar.push('</div>');
    sidebar.push(`<div class="phase">Click a bench piece, then a highlighted square on your home row.</div>`);
  } else if (phase === 'play') {
    const turn = state.activePlayer; sidebar.push(`<h2>Turn – ${state.players[turn].name}</h2>`);
    const sel = state.selected?.piece;
    if (sel) {
      const type = TYPE_BY_ID[sel.typeId];
      sidebar.push(`<div class="card"><div class="name">Selected: ${type.name} ${sel.isCaptain ? '★' : ''}</div><div class="desc">${type.description}</div><div class="meta">Special: ${sel.specialUsed ? 'USED' : 'Ready'}</div><div class="meta">Pos: (${sel.row}, ${sel.col})</div></div>`);
    }
  } else if (phase === 'gameover') {
    sidebar.push('<h2>Game Over</h2>');
    sidebar.push(`<div>${state.winner ? state.players[state.winner].name : '—'} wins.</div>`);
    sidebar.push('<button class="btn" id="restartBtn">New Game</button>');
  }
  sidebarEl.innerHTML = sidebar.join('');

  if (state.phase === 'draft') {
    // Wire AI toggles
    const aiP1 = document.getElementById('aiP1');
    const aiP2 = document.getElementById('aiP2');
    aiP1?.addEventListener('change', () => { state.ai.P1 = aiP1.checked; maybeRunAi(); });
    aiP2?.addEventListener('change', () => { state.ai.P2 = aiP2.checked; maybeRunAi(); });
    sidebarEl.querySelectorAll('[data-pick]').forEach(btn => btn.addEventListener('click', () => { onPick(btn.getAttribute('data-pick')); }));
  } else if (state.phase === 'captain') {
    document.getElementById('confirmCaptains')?.addEventListener('click', () => {
      const p1Sel = sidebarEl.querySelector('input[name="cap-P1"]:checked')?.value;
      const p2Sel = sidebarEl.querySelector('input[name="cap-P2"]:checked')?.value;
      if (!p1Sel || !p2Sel) { alert('Select both captains.'); return; }
      assignCaptains(p1Sel, p2Sel); beginPlacement();
    });
  } else if (state.phase === 'placement') {
    sidebarEl.querySelectorAll('[data-bench-id]')?.forEach(btn => btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-bench-id'));
      state.selected = { piece: state.players[state.placementTurn].bench.find(p => p.id === id), specialMode: false };
      statusEl.textContent = `Selected ${TYPE_BY_ID[state.selected.piece.typeId].name}. Click a highlighted square on your home row.`;
      renderBoard();
    }));
  } else if (state.phase === 'gameover') {
    document.getElementById('restartBtn')?.addEventListener('click', () => window.location.reload());
  }
}

function renderControls() {
  controlsEl.innerHTML = '';
  if (state.phase !== 'play') return;
  const turn = state.activePlayer; const sel = state.selected?.piece;
  const canUseSpecial = sel && sel.owner === turn && !sel.specialUsed;
  const specialBtn = document.createElement('button'); specialBtn.className='btn'; specialBtn.textContent = state.selected?.specialMode ? 'Cancel Special' : 'Use Special'; specialBtn.disabled = !canUseSpecial;
  specialBtn.addEventListener('click', () => { if (!sel) return; state.selected.specialMode = !state.selected.specialMode; statusEl.textContent = state.selected.specialMode ? 'Select a special target.' : ''; renderBoard(); });
  controlsEl.appendChild(specialBtn);
  const quickBtn = document.createElement('button'); quickBtn.className='btn'; quickBtn.textContent='Activate Self Special';
  quickBtn.disabled = !(sel && !sel.specialUsed && TYPE_BY_ID[sel.typeId].getSpecialTargets?.(state, sel)?.some(t => t.self));
  quickBtn.addEventListener('click', () => { if (!sel) return; if (TYPE_BY_ID[sel.typeId].applySpecial?.(state, sel, { self: true })) { sel.specialUsed = true; afterAction(); } render(); });
  controlsEl.appendChild(quickBtn);
}

// ---------- Mode Modal ----------
function wireModeModalIfNeeded() {
  const modal = document.getElementById('modeModal');
  if (!modal) return;
  // Show only at very start of app on first render of draft phase
  if (state.phase === 'draft' && state.players.P1.drafted.length === 0 && state.players.P2.drafted.length === 0) {
    modal.hidden = false;
    const btnLocal = document.getElementById('modeLocal');
    const btnAi = document.getElementById('modeVsAi');
    const randomDraft = document.getElementById('randomDraft');
    const closeAll = () => { modal.hidden = true; };
    const startFlow = (aiP2) => {
      state.ai.P1 = false; state.ai.P2 = !!aiP2;
      closeAll();
      if (randomDraft?.checked) {
        runRandomDraftAndStart();
      } else {
        maybeRunAi();
      }
    };
    btnLocal?.addEventListener('click', () => startFlow(false));
    btnAi?.addEventListener('click', () => startFlow(true));
  } else {
    modal.hidden = true;
  }
}

function runRandomDraftAndStart() {
  // Randomly pick 4 unique types PER SIDE (types may overlap between sides)
  const ids = PIECE_TYPES.map(t => t.id);
  const pickFour = () => ids
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(4, ids.length));
  state.players.P1.drafted = pickFour();
  state.players.P2.drafted = pickFour();
  // Assign captains randomly among each side's drafted list
  const cap1 = state.players.P1.drafted[Math.floor(Math.random() * state.players.P1.drafted.length)];
  const cap2 = state.players.P2.drafted[Math.floor(Math.random() * state.players.P2.drafted.length)];
  assignCaptains(cap1, cap2);
  // Go straight to placement
  beginPlacement();
}

// ---------- Flow ----------
function onPick(typeId) {
  if (state.phase !== 'draft') return;
  const p = state.players[state.currentDraftPlayer];
  if (p.drafted.length >= 4) return;
  if (p.drafted.includes(typeId)) return;
  p.drafted.push(typeId);
  log(`${p.name} picked ${TYPE_BY_ID[typeId].name}.`);
  if (state.players.P1.drafted.length === 4 && state.players.P2.drafted.length === 4) {
    state.phase = 'captain';
  } else {
    state.currentDraftPlayer = otherPlayer(state.currentDraftPlayer);
  }
  render();
}

function assignCaptains(p1TypeId, p2TypeId) {
  state.players.P1.bench = state.players.P1.drafted.map(id => createPiece(id, 'P1'));
  state.players.P2.bench = state.players.P2.drafted.map(id => createPiece(id, 'P2'));
  const p1Cap = state.players.P1.bench.find(p => p.typeId === p1TypeId);
  const p2Cap = state.players.P2.bench.find(p => p.typeId === p2TypeId);
  if (!p1Cap || !p2Cap) { alert('Captain selection invalid.'); return; }
  p1Cap.isCaptain = true; p2Cap.isCaptain = true;
  log(`Captains assigned: P1 – ${TYPE_BY_ID[p1Cap.typeId].name}, P2 – ${TYPE_BY_ID[p2Cap.typeId].name}.`);
}

function beginPlacement() {
  state.phase = 'placement';
  state.placementTurn = 'P1';
  state.selected = null;
  statusEl.textContent = 'Placement: Alternate placing pieces. P1 starts on bottom row.';
  render();
  maybeRunAi();
}

function beginPlay() {
  state.phase = 'play'; state.selected = null; statusEl.textContent = 'Game start! P1 to move.'; startClock('P1'); render();
  maybeRunAi();
}

function getCaptain(player) {
  const inBench = state.players[player].bench.find(p => p.isCaptain);
  if (inBench) return inBench;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const piece = state.board[r][c]; if (piece && piece.owner === player && piece.isCaptain) return piece; }
  return null;
}

function onSquareClick(r, c) {
  if (state.phase === 'placement') {
    const placer = state.placementTurn;
    const homeRow = placer === 'P1' ? ROWS - 1 : 0;
    if (r !== homeRow) { statusEl.textContent = 'Place on your home row (highlighted squares).'; return; }
    const selectedBenchPiece = state.selected?.piece;
    if (!selectedBenchPiece) { statusEl.textContent = 'Select a bench piece to place.'; return; }
    if (selectedBenchPiece.owner !== placer) { statusEl.textContent = 'Selected piece is not yours to place this turn.'; return; }
    if (state.board[r][c] !== null) { statusEl.textContent = 'Square occupied.'; return; }
    placePiece(state, selectedBenchPiece, r, c);
    // remove from bench
    state.players[placer].bench = state.players[placer].bench.filter(p => p.id !== selectedBenchPiece.id);
    state.selected = null;
    // Check if both benches empty -> play
    if (state.players.P1.bench.length === 0 && state.players.P2.bench.length === 0) { beginPlay(); return; }
    // If current player still has pieces and opponent also has, alternate turn
    state.placementTurn = otherPlayer(state.placementTurn);
    render();
    return;
  }

  if (state.phase !== 'play') return;
  const turn = state.activePlayer; const piece = state.board[r][c]; const selected = state.selected?.piece;

  // If an own piece is already selected, attempt action (special or move) BEFORE any preview logic
  if (selected && selected.owner === turn) {
    if (state.selected.specialMode) {
      const type = TYPE_BY_ID[selected.typeId];
      const targets = type.getSpecialTargets?.(state, selected) || [];
      const target = targets.find(t => t.r === r && t.c === c);
      if (target) { if (type.applySpecial?.(state, selected, target)) { selected.specialUsed = true; afterAction(); render(); } return; }
      // Support self-target specials by clicking the piece's own square
      if (targets.some(t => t.self) && r === selected.row && c === selected.col) {
        if (type.applySpecial?.(state, selected, { self: true })) { selected.specialUsed = true; afterAction(); render(); }
      }
      return;
    }
    const moves = getLegalMoves(state, selected);
    if (moves.some(m => m.r === r && m.c === c)) { if (movePieceTo(state, selected, r, c)) { afterAction(); render(); } }
    // If clicked an own piece instead, change selection below; otherwise stop here
    // Do not fall through to preview if a capture/move was intended
    if (!(piece && piece.owner === turn)) return;
  }

  // Selecting own piece (or changing selection)
  if (piece && piece.owner === turn) { state.selected = { piece, specialMode: false }; render(); return; }

  // Allow previewing opponent piece potential moves/specials only when no own piece is selected
  if (!selected && piece && piece.owner !== turn) {
    state.selected = { piece, specialMode: false, previewOnly: true };
    statusEl.textContent = `Preview: ${piece.owner} ${TYPE_BY_ID[piece.typeId].name}`;
    render();
    return;
  }

  if (!selected) return;
  // If previewing opponent piece, clicking elsewhere clears preview
  if (selected.owner !== turn) { state.selected = null; statusEl.textContent = ''; renderBoard(); return; }
  // Otherwise nothing to do
}

// ---------- Simple AI ----------
function maybeRunAi() {
  if (state.phase === 'gameover' || state.aiBusy) return;
  if (state.phase === 'draft') {
    const current = state.currentDraftPlayer;
    if (state.ai[current]) {
      state.aiBusy = true;
      setTimeout(() => {
        const available = PIECE_TYPES.map(t => t.id).filter(id => !state.players[current].drafted.includes(id));
        const pick = available[Math.floor(Math.random() * available.length)];
        if (pick) onPick(pick);
        state.aiBusy = false;
      }, 400);
    }
    return;
  }
  if (state.phase === 'captain') {
    // Auto-select first drafted as captain for AI sides when both not yet assigned
    const p1 = state.players.P1; const p2 = state.players.P2;
    if (!state.captainsAssigned && ((state.ai.P1 && p1.drafted.length) || (state.ai.P2 && p2.drafted.length))) {
      const p1Cap = p1.drafted[0]; const p2Cap = p2.drafted[0];
      assignCaptains(p1Cap, p2Cap);
      beginPlacement();
    }
    return;
  }
  if (state.phase === 'placement') {
    const current = state.placementTurn;
    if (state.ai[current] && state.players[current].bench.length > 0) {
      state.aiBusy = true;
      setTimeout(() => {
        const benchPiece = state.players[current].bench[0];
        const homeRow = current === 'P1' ? ROWS - 1 : 0;
        // place in first available column
        for (let c = 0; c < COLS; c++) {
          if (state.board[homeRow][c] === null) { placePiece(state, benchPiece, homeRow, c); break; }
        }
        state.players[current].bench = state.players[current].bench.filter(p => p.id !== benchPiece.id);
        if (state.players.P1.bench.length === 0 && state.players.P2.bench.length === 0) { beginPlay(); state.aiBusy = false; return; }
        state.placementTurn = otherPlayer(state.placementTurn);
        state.aiBusy = false;
        render();
      }, 400);
    }
    return;
  }
  if (state.phase === 'play') {
    const current = state.activePlayer;
    if (!state.ai[current]) return;
    state.aiBusy = true;
    setTimeout(() => {
      // naive: pick first movable piece, try capture else first move; occasionally use special
      const moves = collectAllMoves(current);
      const specials = collectAllSpecials(current);
      let action = null;
      // prefer captures or winning specials
      const captureMove = moves.find(m => m.capturesCaptain || m.captures);
      const specialCapture = specials.find(s => s.capturesCaptain || s.captures);
      if (specialCapture) action = { type: 'special', ...specialCapture };
      else if (captureMove) action = { type: 'move', ...captureMove };
      else if (Math.random() < 0.25 && specials.length) action = { type: 'special', ...specials[0] };
      else if (moves.length) action = { type: 'move', ...moves[0] };
      if (!action) { state.aiBusy = false; return; }
      if (action.type === 'move') {
        movePieceTo(state, action.piece, action.r, action.c);
        afterAction(); render(); state.aiBusy = false; return;
      }
      if (action.type === 'special') {
        const type = TYPE_BY_ID[action.piece.typeId];
        type.applySpecial?.(state, action.piece, action.target || { self: true });
        action.piece.specialUsed = true; afterAction(); render(); state.aiBusy = false; return;
      }
      state.aiBusy = false;
    }, 400);
  }
}

function collectAllMoves(owner) {
  const all = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const piece = state.board[r][c]; if (!piece || piece.owner !== owner) continue;
    const legal = getLegalMoves(state, piece);
    for (const m of legal) {
      const target = state.board[m.r][m.c];
      all.push({ piece, r: m.r, c: m.c, captures: !!(target && !target.isCaptain && target.owner !== owner), capturesCaptain: !!(target && target.isCaptain && target.owner !== owner) });
    }
  }
  return all;
}

function collectAllSpecials(owner) {
  const all = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const piece = state.board[r][c]; if (!piece || piece.owner !== owner || piece.specialUsed) continue;
    const type = TYPE_BY_ID[piece.typeId];
    const targets = type.getSpecialTargets?.(state, piece) || [];
    for (const t of targets) {
      if (t.self) all.push({ piece, target: { self: true }, captures: false, capturesCaptain: false });
      else {
        const target = state.board[t.r][t.c];
        all.push({ piece, target: t, captures: !!(target && !target.isCaptain && target.owner !== owner), capturesCaptain: !!(target && target.isCaptain && target.owner !== owner) });
      }
    }
  }
  return all;
}

function getLegalMoves(state, piece) {
  const type = TYPE_BY_ID[piece.typeId]; const raw = type.getMoves(state, piece);
  return raw.filter(({ r, c }) => { const t = state.board[r][c]; if (t && t.owner !== piece.owner && t.fortifiedTurnsLeft > 0) return false; return true; });
}

function afterAction() {
  // If the action resulted in gameover (e.g., captain captured), do not toggle clocks
  if (state.phase === 'gameover') return;
  const actedBy = state.activePlayer; state.selected = null;
  const opponent = otherPlayer(actedBy);
  forEachPiece(state, opponent, (p) => { if (p.fortifiedTurnsLeft > 0) p.fortifiedTurnsLeft -= 1; });
  const next = otherPlayer(actedBy); startClock(next);
  maybeRunAi();
}

function forEachPiece(state, owner, fn) { for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const piece = state.board[r][c]; if (piece && (!owner || piece.owner === owner)) fn(piece); } }

// ---------- Init ----------
render();
statusEl.textContent = 'Draft Phase: P1 begins picking. 4 unique pieces per team.';



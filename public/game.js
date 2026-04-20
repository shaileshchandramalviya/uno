/* ═══════════════════════════════════════════════════
   UNO Multiplayer — Client JS
   ═══════════════════════════════════════════════════ */

const socket = io();

// ── State ────────────────────────────────────────────
let myId = null;
let isLeader = false;
let myHand = [];
let currentPlayerId = null;
let pendingDraw = 0;
let drawnCardPending = null;  // card that was drawn and can optionally be played
let awaitingColorChoice = null; // callback waiting for color pick
let topCard = null;

// ── DOM refs ─────────────────────────────────────────
const screenLobby   = document.getElementById('screen-lobby');
const screenGame    = document.getElementById('screen-game');
const inputName     = document.getElementById('player-name');
const inputRoom     = document.getElementById('room-code');
const btnJoin       = document.getElementById('btn-join');
const btnStart      = document.getElementById('btn-start');
const lobbyError    = document.getElementById('lobby-error');
const waitingArea   = document.getElementById('waiting-area');
const playerListLobby = document.getElementById('player-list-lobby');
const waitingHint   = document.getElementById('waiting-hint');

// Game DOM
const playerListGame  = document.getElementById('player-list-game');
const topCardEl       = document.getElementById('top-card');
const handCards       = document.getElementById('hand-cards');
const handCountBadge  = document.getElementById('hand-count-badge');
const deckCountEl     = document.getElementById('deck-count');
const directionLabel  = document.getElementById('direction-label');
const turnIndicator   = document.getElementById('turn-indicator');
const actionLogInner  = document.getElementById('action-log-inner');
const pendingBanner   = document.getElementById('pending-draw-banner');
const pendingText     = document.getElementById('pending-draw-text');
const drawPileVisual  = document.getElementById('draw-pile-visual');

const btnDraw   = document.getElementById('btn-draw');
const btnPass   = document.getElementById('btn-pass');

// Modals
const colorModal   = document.getElementById('color-modal');
const colorBtns    = document.querySelectorAll('.color-btn');
const gameoverModal = document.getElementById('gameover-modal');
const gameoverTitle = document.getElementById('gameover-title');
const gameoverMsg   = document.getElementById('gameover-msg');
const drawnModal    = document.getElementById('drawn-modal');
const drawnCardDisplay = document.getElementById('drawn-card-display');
const drawnCardMsg  = document.getElementById('drawn-card-msg');
const btnPlayDrawn  = document.getElementById('btn-play-drawn');
const btnSkipDrawn  = document.getElementById('btn-skip-drawn');

// ── Helpers: Card rendering ───────────────────────────
const CARD_SYMBOLS = {
  'skip': '⊘', 'reverse': '↺', '+2': '+2', '+4': '+4', 'wild': '🌈',
};

function cardLabel(card) {
  return CARD_SYMBOLS[card.value] || card.value;
}

function cardColorClass(card) {
  if (card.color === 'wild' || card.type === 'wild' || card.type === 'draw4') return 'c-wild';
  return `c-${card.color}`;
}

function buildCardEl(card, clickable = false, index = -1) {
  const el = document.createElement('div');
  el.className = `hand-card ${cardColorClass(card)}`;
  el.textContent = cardLabel(card);
  el.dataset.index = index;

  if (!clickable) {
    el.classList.add('invalid-card');
  } else {
    el.classList.add('valid-card');
    el.addEventListener('click', () => onCardClick(card, index));
  }
  return el;
}

function renderTopCard(card) {
  topCardEl.className = `card-display ${cardColorClass(card)}`;
  topCardEl.textContent = cardLabel(card);
}

// ── Helpers: Lobby ────────────────────────────────────
function showError(msg) {
  lobbyError.textContent = msg;
  lobbyError.classList.remove('hidden');
  setTimeout(() => lobbyError.classList.add('hidden'), 4000);
}

function addLog(msg) {
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = msg;
  actionLogInner.innerHTML = '';
  actionLogInner.appendChild(div);
}

function showUNOCall(name) {
  const el = document.createElement('div');
  el.className = 'uno-call-anim';
  el.textContent = `${name} — UNO!`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// Avatar colors
const AVATAR_COLORS = ['#ff4757','#ffd32a','#2ed573','#1e90ff','#ff6b81','#7bed9f','#70a1ff','#eccc68'];
function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Lobby Events ──────────────────────────────────────
btnJoin.addEventListener('click', joinGame);
inputName.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });

function joinGame() {
  const name = inputName.value.trim();
  const room = inputRoom.value.trim();
  if (!name) { showError('Please enter your name.'); return; }
  if (!room) { showError('Please enter a room code.'); return; }
  socket.emit('join_game', { name, room });
  btnJoin.disabled = true;
  inputName.disabled = true;
  inputRoom.disabled = true;
}

btnStart.addEventListener('click', () => {
  socket.emit('start_game');
});

// ── Socket: Lobby ─────────────────────────────────────
socket.on('joined', ({ playerId, isLeader: leader, roomId }) => {
  myId = playerId;
  isLeader = leader;
  waitingArea.classList.remove('hidden');
  if (isLeader) {
    btnStart.classList.remove('hidden');
    waitingHint.innerHTML = `You are the host of room <b style="color:var(--accent)">${roomId}</b>. Press Start when everyone has joined.`;
  } else {
    waitingHint.innerHTML = `Waiting for the host to start room <b style="color:var(--accent)">${roomId}</b>…`;
  }
});

socket.on('lobby_update', ({ players, leaderId, roomId }) => {
  isLeader = (myId === leaderId);
  if (isLeader) {
    btnStart.classList.remove('hidden');
    waitingHint.innerHTML = `You are the host of room <b style="color:var(--accent)">${roomId}</b>. Press Start when everyone has joined.`;
  } else {
    btnStart.classList.add('hidden');
    waitingHint.innerHTML = `Waiting for the host to start room <b style="color:var(--accent)">${roomId}</b>…`;
  }

  playerListLobby.innerHTML = '';
  players.forEach(p => {
    const li = document.createElement('li');
    const isL = p.id === leaderId;
    li.innerHTML = `<span style="font-size:1.3rem">${isL ? '👑' : '🃏'}</span> ${p.name}${isL ? ' <span style="color:#ffd32a;font-size:0.8rem">(Host)</span>' : ''}`;
    playerListLobby.appendChild(li);
  });
});

socket.on('error_msg', (msg) => {
  if (screenLobby.classList.contains('active')) {
    showError(msg);
    btnJoin.disabled = false;
    inputName.disabled = false;
    inputRoom.disabled = false;
  } else {
    addLog('⚠ ' + msg);
  }
});

// ── Socket: Game start ────────────────────────────────
socket.on('game_started', () => {
  screenLobby.classList.remove('active');
  screenLobby.classList.add('hidden');
  screenGame.classList.remove('hidden');
  addLog('🎮 Game started! Good luck!');
});

// ── Socket: Game state update ─────────────────────────
socket.on('game_state', (state) => {
  topCard = state.topCard;
  myHand = state.myHand;
  currentPlayerId = state.currentPlayerId;
  pendingDraw = state.pendingDraw;

  renderTopCard(state.topCard);
  deckCountEl.textContent = state.deckCount;
  directionLabel.textContent = state.direction === 1 ? '→' : '←';

  // Player list
  playerListGame.innerHTML = '';
  state.playerList.forEach(p => {
    const li = document.createElement('li');
    if (p.id === currentPlayerId) li.classList.add('active-player');
    li.innerHTML = `
      <div class="player-avatar" style="background:${avatarColor(p.name)}">${p.name.charAt(0).toUpperCase()}</div>
      <div class="player-info">
        <span class="player-name-side">${p.name}${p.id === myId ? ' (You)' : ''}</span>
        <span class="player-cards-side">${p.cardCount} card${p.cardCount !== 1 ? 's' : ''}</span>
      </div>
    `;
    playerListGame.appendChild(li);
  });

  // Turn indicator
  const cp = state.playerList.find(p => p.id === currentPlayerId);
  const isMyTurn = currentPlayerId === myId;
  turnIndicator.textContent = isMyTurn
    ? '🎯 Your turn!'
    : `⏳ ${cp?.name || '?'}'s turn`;
  turnIndicator.style.color = isMyTurn ? '#ffd32a' : '#8890aa';

  // Pending draw banner
  if (pendingDraw > 0) {
    pendingBanner.classList.remove('hidden');
    pendingText.textContent = `⚠ Accumulated Draw: +${pendingDraw} cards!`;
  } else {
    pendingBanner.classList.add('hidden');
  }

  // Render hand
  renderHand(state.myHand, state.topCard, isMyTurn);

  // Buttons
  if (isMyTurn) {
    btnDraw.classList.remove('hidden');
    btnPass.classList.add('hidden');
    drawPileVisual.style.cursor = 'pointer';
  } else {
    btnDraw.classList.add('hidden');
    btnPass.classList.add('hidden');
    drawPileVisual.style.cursor = 'default';
  }

  // UNO call check
  state.playerList.forEach(p => {
    if (p.cardCount === 1) showUNOCall(p.name);
  });
});

function renderHand(hand, top, isMyTurn) {
  handCards.innerHTML = '';
  handCountBadge.textContent = hand.length;
  if (!hand || hand.length === 0) {
    handCards.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No cards</p>';
    return;
  }
  hand.forEach((card, i) => {
    const valid = isMyTurn && isClientValidPlay(card, top);
    const el = buildCardEl(card, valid, i);
    handCards.appendChild(el);
  });
}

// Client-side validity check (mirrors server logic)
function isClientValidPlay(card, topCard) {
  if (pendingDraw > 0) return card.type === 'draw2' || card.type === 'draw4';
  if (card.type === 'wild' || card.type === 'draw4') return true;
  return card.color === topCard.color || card.value === topCard.value;
}

// ── Card click ────────────────────────────────────────
function onCardClick(card, index) {
  if (currentPlayerId !== myId) return;
  if (card.type === 'wild' || card.type === 'draw4') {
    pickColor((color) => {
      socket.emit('play_card', { cardIndex: index, chosenColor: color });
    });
  } else {
    socket.emit('play_card', { cardIndex: index, chosenColor: null });
  }
}

// ── Draw button ───────────────────────────────────────
btnDraw.addEventListener('click', () => {
  btnDraw.classList.add('hidden');
  socket.emit('draw_card');
});

// Click on deck pile also draws
drawPileVisual.addEventListener('click', () => {
  if (currentPlayerId !== myId) return;
  btnDraw.classList.add('hidden');
  socket.emit('draw_card');
});

// ── Pass button ────────────────────────────────────────
btnPass.addEventListener('click', () => {
  btnPass.classList.add('hidden');
  socket.emit('pass_turn');
  drawnModal.classList.add('hidden');
});

// ── Socket: drew_card (normal draw, can optionally play) ──
socket.on('drew_card', ({ card, canPlay }) => {
  drawnCardPending = card;

  // Show drawn card modal
  drawnCardDisplay.className = `card-display-lg ${cardColorClass(card)}`;
  drawnCardDisplay.textContent = cardLabel(card);

  if (canPlay) {
    drawnCardMsg.textContent = 'This card can be played! Would you like to play it?';
    btnPlayDrawn.classList.remove('hidden');
    btnSkipDrawn.textContent = 'Keep & Pass Turn';
  } else {
    drawnCardMsg.textContent = 'This card cannot be played. Your turn ends.';
    btnPlayDrawn.classList.add('hidden');
    btnSkipDrawn.textContent = 'Okay, Pass Turn';
  }

  drawnModal.classList.remove('hidden');
});

btnPlayDrawn.addEventListener('click', () => {
  drawnModal.classList.add('hidden');
  if (!drawnCardPending) return;
  const card = drawnCardPending;
  drawnCardPending = null;

  if (card.type === 'wild' || card.type === 'draw4') {
    pickColor((color) => {
      socket.emit('play_drawn_card', { chosenColor: color });
    });
  } else {
    socket.emit('play_drawn_card', { chosenColor: null });
  }
});

btnSkipDrawn.addEventListener('click', () => {
  drawnModal.classList.add('hidden');
  drawnCardPending = null;
  socket.emit('pass_turn');
});

// ── Socket: card_played ─────────────────────────────────
socket.on('card_played', ({ playerName, card }) => {
  addLog(`🃏 ${playerName} played ${cardLabel(card)} (${card.color})`);
});

socket.on('player_drew', ({ playerName, count, forced }) => {
  addLog(forced
    ? `💥 ${playerName} drew ${count} cards (forced!)`
    : `📥 ${playerName} drew ${count} card`);
});

socket.on('player_left', ({ name }) => {
  addLog(`👋 ${name} left the game`);
});

// ── Socket: game over ─────────────────────────────────
socket.on('game_over', ({ winnerId, winnerName, reason }) => {
  if (reason === 'disconnect') {
    gameoverTitle.textContent = 'Player Left';
    gameoverMsg.textContent = `${winnerName || 'Someone'} won by default (opponent disconnected).`;
  } else if (winnerId === myId) {
    gameoverTitle.textContent = '🎉 You Win!';
    gameoverMsg.textContent = `Congratulations! You played all your cards first!`;
  } else {
    gameoverTitle.textContent = 'Game Over';
    gameoverMsg.textContent = `${winnerName} won the game! Better luck next time.`;
  }
  gameoverModal.classList.remove('hidden');
});

// ── Color Picker ──────────────────────────────────────
function pickColor(cb) {
  awaitingColorChoice = cb;
  colorModal.classList.remove('hidden');
}

colorBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (awaitingColorChoice) {
      awaitingColorChoice(btn.dataset.color);
      awaitingColorChoice = null;
    }
    colorModal.classList.add('hidden');
  });
});

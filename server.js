const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Card Generation ───────────────────────────────────────────────────────────
function generateDeck() {
  const colors = ['red', 'yellow', 'green', 'blue'];
  const numbers = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const specials = ['skip', 'reverse', '+2'];
  const deck = [];

  for (const color of colors) {
    // one 0 per color
    deck.push({ color, value: '0', type: 'number' });
    // two of each 1-9
    for (const num of numbers.slice(1)) {
      deck.push({ color, value: num, type: 'number' });
      deck.push({ color, value: num, type: 'number' });
    }
    // two of each special per color
    for (const sp of specials) {
      deck.push({ color, value: sp, type: sp === '+2' ? 'draw2' : sp });
      deck.push({ color, value: sp, type: sp === '+2' ? 'draw2' : sp });
    }
  }
  // 4 wild + 4 wild+4
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild', type: 'wild' });
    deck.push({ color: 'wild', value: '+4', type: 'draw4' });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── State ──────────────────────────────────────────────────────────────────────
// rooms[roomId] = { players, deck, discardPile, currentPlayerIndex, direction,
//                   pendingDraw, gameStarted, leaderId }
const rooms = {};
const DEFAULT_ROOM = 'uno-room';

function getOrCreateRoom(roomId = DEFAULT_ROOM) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [],       // { id, name, hand }
      deck: [],
      discardPile: [],
      currentPlayerIndex: 0,
      direction: 1,       // 1 = forward, -1 = reverse
      pendingDraw: 0,     // accumulated +2/+4 cards
      gameStarted: false,
      leaderId: null,
    };
  }
  return rooms[roomId];
}

function getTopCard(room) {
  return room.discardPile[room.discardPile.length - 1];
}

function isValidPlay(card, topCard, room) {
  // During a pending draw chain, only +2/+4 can be stacked
  if (room.pendingDraw > 0) {
    return card.type === 'draw2' || card.type === 'draw4';
  }

  // Always skip colour check for wilds
  if (card.type === 'wild' || card.type === 'draw4') return true;

  // Normal play: match color OR value
  return card.color === topCard.color || card.value === topCard.value;
}

function drawFromDeck(room, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      // Reshuffle discard pile (keep top card)
      const top = room.discardPile.pop();
      room.deck = shuffle(room.discardPile);
      room.discardPile = [top];
      if (room.deck.length === 0) break; // truly out of cards
    }
    drawn.push(room.deck.pop());
  }
  return drawn;
}

function nextPlayerIndex(room, skip = false) {
  const n = room.players.length;
  let idx = (room.currentPlayerIndex + room.direction + n) % n;
  if (skip) idx = (idx + room.direction + n) % n;
  return idx;
}

function broadcastGameState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const top = getTopCard(room);
  const currentPlayerId = room.players[room.currentPlayerIndex]?.id;

  room.players.forEach((p) => {
    io.to(p.id).emit('game_state', {
      topCard: top,
      currentPlayerId,
      pendingDraw: room.pendingDraw,
      direction: room.direction,
      playerList: room.players.map((pl) => ({
        id: pl.id,
        name: pl.name,
        cardCount: pl.hand.length,
      })),
      myHand: p.hand,
      deckCount: room.deck.length,
    });
  });
}

function broadcastLobby(roomId) {
  const room = rooms[roomId];
  const playerList = room.players.map((p) => ({ id: p.id, name: p.name }));
  io.to(roomId).emit('lobby_update', {
    players: playerList,
    leaderId: room.leaderId,
    roomId: roomId,
  });
}

// ─── Socket Handlers ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Player joins lobby
  socket.on('join_game', ({ name, room }) => {
    const roomId = room ? room.toLowerCase() : DEFAULT_ROOM;
    const currentRoom = getOrCreateRoom(roomId);
    if (currentRoom.gameStarted) {
      socket.emit('error_msg', 'Game already in progress.');
      return;
    }

    // Check duplicate name
    const exists = currentRoom.players.find(
      (p) => p.name.toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      socket.emit('error_msg', 'Name already taken. Choose another.');
      return;
    }

    if (currentRoom.players.length === 0) {
      currentRoom.leaderId = socket.id;
    }

    currentRoom.players.push({ id: socket.id, name, hand: [] });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = name;

    broadcastLobby(roomId);
    socket.emit('joined', { playerId: socket.id, isLeader: socket.id === currentRoom.leaderId, roomId });
    console.log(`${name} joined room ${roomId}`);
  });

  // Leader starts game
  socket.on('start_game', () => {
    const roomId = socket.data.roomId;
    const room = getOrCreateRoom(roomId);
    if (socket.id !== room.leaderId) {
      socket.emit('error_msg', 'Only the leader can start the game.');
      return;
    }
    if (room.players.length < 2) {
      socket.emit('error_msg', 'Need at least 2 players to start.');
      return;
    }
    if (room.gameStarted) {
      socket.emit('error_msg', 'Game already started.');
      return;
    }

    // Build & shuffle deck
    room.deck = shuffle(generateDeck());

    // Deal 8 cards each
    for (const p of room.players) {
      p.hand = drawFromDeck(room, 8);
    }

    // Start discard pile — ensure first card is a number card
    let startCard;
    do {
      startCard = room.deck.pop();
      if (startCard.type !== 'number') room.deck.unshift(startCard); // put back at bottom
    } while (startCard.type !== 'number');
    room.discardPile = [startCard];

    room.currentPlayerIndex = 0;
    room.direction = 1;
    room.pendingDraw = 0;
    room.gameStarted = true;

    io.to(roomId).emit('game_started');
    broadcastGameState(roomId);
    console.log(`Game started in room ${roomId}!`);
  });

  // Player plays a card
  socket.on('play_card', ({ cardIndex, chosenColor }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error_msg', "It's not your turn!");
      return;
    }

    const card = currentPlayer.hand[cardIndex];
    if (!card) {
      socket.emit('error_msg', 'Invalid card index.');
      return;
    }

    const topCard = getTopCard(room);
    if (!isValidPlay(card, topCard, room)) {
      socket.emit('error_msg', 'Invalid move! Card must match color or value.');
      return;
    }

    // Remove card from hand
    currentPlayer.hand.splice(cardIndex, 1);

    // Apply chosen color for wilds
    if ((card.type === 'wild' || card.type === 'draw4') && chosenColor) {
      card.color = chosenColor;
    }

    room.discardPile.push(card);

    // Check win
    if (currentPlayer.hand.length === 0) {
      io.to(roomId).emit('game_over', { winnerId: socket.id, winnerName: currentPlayer.name });
      room.gameStarted = false;
      return;
    }

    // Handle special cards
    if (card.type === 'reverse') {
      room.direction *= -1;
      if (room.players.length === 2) {
        // In 2-player, reverse acts like skip
        room.currentPlayerIndex = nextPlayerIndex(room);
      } else {
        room.currentPlayerIndex = nextPlayerIndex(room);
      }
    } else if (card.type === 'skip') {
      room.currentPlayerIndex = nextPlayerIndex(room, true); // skip next
    } else if (card.type === 'draw2') {
      room.pendingDraw += 2;
      room.currentPlayerIndex = nextPlayerIndex(room);
    } else if (card.type === 'draw4') {
      room.pendingDraw += 4;
      room.currentPlayerIndex = nextPlayerIndex(room);
    } else {
      room.currentPlayerIndex = nextPlayerIndex(room);
    }

    io.to(roomId).emit('card_played', {
      playerName: currentPlayer.name,
      card,
    });

    broadcastGameState(roomId);
  });

  // Player draws a card (when no valid card to play)
  socket.on('draw_card', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error_msg', "It's not your turn!");
      return;
    }

    if (room.pendingDraw > 0) {
      // Forced draw due to stacking
      const drawn = drawFromDeck(room, room.pendingDraw);
      currentPlayer.hand.push(...drawn);
      room.pendingDraw = 0;
      room.currentPlayerIndex = nextPlayerIndex(room);
      io.to(roomId).emit('player_drew', {
        playerName: currentPlayer.name,
        count: drawn.length,
        forced: true,
      });
    } else {
      // Normal draw: draw 1
      const drawn = drawFromDeck(room, 1);
      currentPlayer.hand.push(...drawn);

      // Check if the drawn card can be played
      const drawnCard = drawn[0];
      const topCard = getTopCard(room);
      const canPlay = drawnCard && isValidPlay(drawnCard, topCard, room);

      socket.emit('drew_card', { card: drawnCard, canPlay });

      if (!canPlay) {
        room.currentPlayerIndex = nextPlayerIndex(room);
        io.to(roomId).emit('player_drew', {
          playerName: currentPlayer.name,
          count: 1,
          forced: false,
        });
      }
      // If canPlay, frontend will let the player decide to play it via play_drawn_card
    }

    broadcastGameState(roomId);
  });

  // Player chooses to play the just-drawn card
  socket.on('play_drawn_card', ({ chosenColor }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) return;

    // The drawn card is always the last card in hand
    const cardIndex = currentPlayer.hand.length - 1;
    socket.emit('play_card_request', { cardIndex, chosenColor });

    // Re-emit as play_card internally
    const card = currentPlayer.hand[cardIndex];
    const topCard = getTopCard(room);
    if (!isValidPlay(card, topCard, room)) {
      room.currentPlayerIndex = nextPlayerIndex(room);
      broadcastGameState(roomId);
      return;
    }

    currentPlayer.hand.splice(cardIndex, 1);
    if ((card.type === 'wild' || card.type === 'draw4') && chosenColor) {
      card.color = chosenColor;
    }
    room.discardPile.push(card);

    if (currentPlayer.hand.length === 0) {
      io.to(roomId).emit('game_over', { winnerId: socket.id, winnerName: currentPlayer.name });
      room.gameStarted = false;
      return;
    }

    if (card.type === 'reverse') {
      room.direction *= -1;
      room.currentPlayerIndex = nextPlayerIndex(room);
    } else if (card.type === 'skip') {
      room.currentPlayerIndex = nextPlayerIndex(room, true);
    } else if (card.type === 'draw2') {
      room.pendingDraw += 2;
      room.currentPlayerIndex = nextPlayerIndex(room);
    } else if (card.type === 'draw4') {
      room.pendingDraw += 4;
      room.currentPlayerIndex = nextPlayerIndex(room);
    } else {
      room.currentPlayerIndex = nextPlayerIndex(room);
    }

    io.to(roomId).emit('card_played', { playerName: currentPlayer.name, card });
    broadcastGameState(roomId);
  });

  // Player passes turn (after drawing, if drawn card cannot be played)
  socket.on('pass_turn', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) return;
    room.currentPlayerIndex = nextPlayerIndex(room);
    broadcastGameState(roomId);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx !== -1) {
      const name = room.players[idx].name;
      room.players.splice(idx, 1);
      console.log(`${name} disconnected`);

      // Reassign leader if leader leaves
      if (room.leaderId === socket.id && room.players.length > 0) {
        room.leaderId = room.players[0].id;
      }

      if (!room.gameStarted) {
        broadcastLobby(roomId);
      } else {
        // Mid-game disconnect — adjust turn index
        if (room.players.length < 2) {
          io.to(roomId).emit('game_over', { winnerId: null, winnerName: room.players[0]?.name, reason: 'disconnect' });
          room.gameStarted = false;
        } else {
          if (room.currentPlayerIndex >= room.players.length) {
            room.currentPlayerIndex = 0;
          }
          io.to(roomId).emit('player_left', { name });
          broadcastGameState(roomId);
        }
      }
    }
  });
});

// ─── Start Server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`UNO server running at http://localhost:${PORT}`);
  console.log(`Share this with others on your WiFi using your local IP:${PORT}`);
});

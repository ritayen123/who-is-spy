const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 60000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/online', (req, res) => res.json({ count: io.sockets.sockets.size }));

// ─── Constants ──────────────────────────────────────────
const MAX_ROOMS = 200;
const JOIN_RATE_LIMIT = 5;
const FORBIDDEN_CHARS = /[<>&"'`]/;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const DESCRIBE_TIME = 60;
const VOTE_TIME = 30;
const REVEAL_TIMEOUT = 60;
const GRACE_PERIOD = 60000; // 60s reconnect window
const HEARTBEAT_INTERVAL = 30000;
const IDLE_TIMEOUT = 120000; // 2min idle kick (lobby only)
const CLEANUP_DELAY = 60000; // 60s before deleting empty room

// ─── Word Bank (server-side only, anti-cheat) ───────────
const WORD_BANK = [
  ['水餃','鍋貼'],['珍珠奶茶','波霸奶茶'],['蝙蝠俠','蜘蛛人'],['iPhone','Samsung'],
  ['火鍋','麻辣燙'],['牛排','豬排'],['麥當勞','肯德基'],['Uber','Lyft'],
  ['咖啡','拿鐵'],['日本','韓國'],['鋼琴','吉他'],['游泳','潛水'],
  ['貓','狗'],['雞蛋','鴨蛋'],['籃球','排球'],['計程車','公車'],
  ['蛋糕','麵包'],['微波爐','烤箱'],['口紅','唇蜜'],['皮鞋','拖鞋'],
  ['沙發','椅子'],['冰箱','冷凍庫'],['Netflix','YouTube'],['Facebook','Instagram'],
  ['醫生','護士'],['老師','教授'],['高鐵','火車'],['地震','颱風'],
  ['聖誕節','跨年'],['海邊','游泳池'],['巧克力','可可'],['滷肉飯','雞肉飯'],
  ['豆漿','牛奶'],['雨傘','雨衣'],['漫畫','動畫'],['戒指','手環'],
  ['行李箱','背包'],['WiFi','藍牙'],['冰淇淋','雪糕'],['眼鏡','墨鏡'],
  ['枕頭','抱枕'],['番茄醬','辣椒醬'],['手錶','時鐘'],['腳踏車','機車'],
];

// ─── Room Management ────────────────────────────────────
const rooms = new Map();

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do { id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(id));
  return id;
}

function createRoom(id, hostId) {
  return {
    id,
    hostId,
    players: [],          // [{ id, name, alive, disconnected, disconnectTimer }]
    gamePhase: 'waiting', // waiting | revealing | describing | voting | result | whiteGuess | ended
    config: { spyCount: 2, whiteCount: 0, wordSource: 'random', civilianWord: '', spyWord: '' },
    roles: {},            // { socketId: 'civilian'|'spy'|'white' }
    words: {},            // { socketId: 'word' }
    civilianWord: '',
    spyWord: '',
    revealed: new Set(),
    round: 1,
    speakerOrder: [],
    speakerIdx: 0,
    votes: {},
    pendingElimination: null,
    usedWordIndices: [],
    timers: {},           // { describe, vote, reveal, cleanup }
    endTimes: {},         // { describe, vote }
  };
}

function getRoom(id) { return rooms.get(id?.toUpperCase()); }

function alivePlayers(room) {
  return room.players.filter(p => p.alive && !p.disconnected);
}

function allPlayers(room) { return room.players; }

function findPlayerBySocket(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function suggestSpies(n) { return n <= 5 ? 1 : n <= 8 ? 2 : 3; }
function maxSpecial(n) { return Math.floor((n - 1) / 2); }

// ─── State Broadcasting ─────────────────────────────────
function emitState(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const alive = alivePlayers(room);
  io.to(roomId).emit('state', {
    roomId: room.id,
    hostId: room.hostId,
    gamePhase: room.gamePhase,
    players: room.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive,
      disconnected: !!p.disconnected,
      revealed: room.revealed.has(p.id),
    })),
    config: room.config,
    round: room.round,
    aliveCount: alive.length,
    revealedCount: room.revealed.size,
    totalPlayers: room.players.length,
    speakerOrder: room.speakerOrder,
    speakerIdx: room.speakerIdx,
    currentSpeakerId: room.speakerOrder[room.speakerIdx] || null,
    voteCount: Object.keys(room.votes).length,
    voteTotal: alive.filter(p => !p.disconnected).length,
    describeEndTime: room.endTimes.describe || null,
    voteEndTime: room.endTimes.vote || null,
  });
}

// ─── Shuffle ─────────────────────────────────────────────
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ─── Timer Helpers ──────────────────────────────────────
function clearRoomTimer(room, key) {
  if (room.timers[key]) { clearTimeout(room.timers[key]); room.timers[key] = null; }
  if (room.endTimes[key]) room.endTimes[key] = null;
}

function clearAllTimers(room) {
  Object.keys(room.timers).forEach(k => clearRoomTimer(room, k));
}

// ─── Game Logic ─────────────────────────────────────────

function pickRandomPair(room) {
  let avail = WORD_BANK.map((_, i) => i).filter(i => !room.usedWordIndices.includes(i));
  if (avail.length === 0) { room.usedWordIndices = []; avail = WORD_BANK.map((_, i) => i); }
  const pick = avail[Math.floor(Math.random() * avail.length)];
  room.usedWordIndices.push(pick);
  return WORD_BANK[pick];
}

function startGame(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const n = room.players.length;
  if (n < MIN_PLAYERS) return;

  const ms = maxSpecial(n);
  let spies = Math.min(room.config.spyCount, ms);
  let whites = Math.min(room.config.whiteCount, ms - spies);
  if (n - spies - whites < 2) { whites = 0; spies = Math.min(spies, ms); }

  // Pick words
  if (room.config.wordSource === 'custom' && room.config.civilianWord && room.config.spyWord) {
    room.civilianWord = room.config.civilianWord;
    room.spyWord = room.config.spyWord;
  } else {
    const pair = pickRandomPair(room);
    if (Math.random() < 0.5) { room.civilianWord = pair[0]; room.spyWord = pair[1]; }
    else { room.civilianWord = pair[1]; room.spyWord = pair[0]; }
  }

  // Assign roles
  const indices = room.players.map((_, i) => i);
  shuffle(indices);
  room.roles = {};
  room.words = {};
  room.players.forEach(p => { p.alive = true; });

  for (let i = 0; i < n; i++) {
    const p = room.players[indices[i]];
    if (i < spies) { room.roles[p.id] = 'spy'; room.words[p.id] = room.spyWord; }
    else if (i < spies + whites) { room.roles[p.id] = 'white'; room.words[p.id] = '???'; }
    else { room.roles[p.id] = 'civilian'; room.words[p.id] = room.civilianWord; }
  }

  room.round = 1;
  room.revealed = new Set();
  room.pendingElimination = null;
  room.votes = {};
  room.gamePhase = 'revealing';

  // Send each player their word (unicast)
  room.players.forEach(p => {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) {
      sock.emit('revealWord', { word: room.words[p.id], role: room.roles[p.id] });
    }
  });

  io.to(roomId).emit('gameStarted', { playerCount: n, spyCount: spies, whiteCount: whites });
  emitState(roomId);

  // Auto-confirm bots
  setTimeout(() => {
    room.players.filter(p => p.isBot).forEach(p => confirmRevealed(roomId, p.id));
  }, 500);

  // Reveal timeout
  room.timers.reveal = setTimeout(() => {
    if (room.gamePhase === 'revealing') {
      // Force all unrevealed to confirmed
      room.players.forEach(p => room.revealed.add(p.id));
      beginDescribePhase(roomId);
    }
  }, REVEAL_TIMEOUT * 1000);
}

function confirmRevealed(roomId, socketId) {
  const room = getRoom(roomId);
  if (!room || room.gamePhase !== 'revealing') return;
  room.revealed.add(socketId);
  emitState(roomId);

  if (room.revealed.size >= room.players.length) {
    clearRoomTimer(room, 'reveal');
    beginDescribePhase(roomId);
  }
}

function beginDescribePhase(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  room.gamePhase = 'describing';

  if (room.round === 1) {
    room.speakerOrder = room.players.filter(p => p.alive).map(p => p.id);
    shuffle(room.speakerOrder);
  } else {
    room.speakerOrder = room.speakerOrder.filter(id => {
      const p = findPlayerBySocket(room, id);
      return p && p.alive;
    });
  }
  room.speakerIdx = 0;
  emitState(roomId);
  startSpeakerTurn(roomId);
}

function startSpeakerTurn(roomId) {
  const room = getRoom(roomId);
  if (!room || room.gamePhase !== 'describing') return;

  // Skip disconnected or bot speakers
  while (room.speakerIdx < room.speakerOrder.length) {
    const sid = room.speakerOrder[room.speakerIdx];
    const p = findPlayerBySocket(room, sid);
    if (p && p.alive && !p.disconnected && !p.isBot) break;
    room.speakerIdx++;
  }

  if (room.speakerIdx >= room.speakerOrder.length) {
    startVotePhase(roomId);
    return;
  }

  const endTime = Date.now() + DESCRIBE_TIME * 1000;
  room.endTimes.describe = endTime;

  const speaker = room.speakerOrder[room.speakerIdx];
  const p = findPlayerBySocket(room, speaker);
  io.to(roomId).emit('speakerTurn', {
    speakerId: speaker,
    speakerName: p?.name || '???',
    endTime,
    round: room.round,
  });
  emitState(roomId);

  clearRoomTimer(room, 'describe');
  room.timers.describe = setTimeout(() => {
    nextSpeaker(roomId);
  }, DESCRIBE_TIME * 1000);
}

function nextSpeaker(roomId) {
  const room = getRoom(roomId);
  if (!room || room.gamePhase !== 'describing') return;
  clearRoomTimer(room, 'describe');
  room.speakerIdx++;
  if (room.speakerIdx >= room.speakerOrder.length) {
    startVotePhase(roomId);
  } else {
    startSpeakerTurn(roomId);
  }
}

function startVotePhase(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  room.gamePhase = 'voting';
  room.votes = {};

  const endTime = Date.now() + VOTE_TIME * 1000;
  room.endTimes.vote = endTime;

  io.to(roomId).emit('votePhase', { endTime });
  emitState(roomId);

  // Auto-vote for bots (random target)
  setTimeout(() => {
    const alive = room.players.filter(p => p.alive && !p.disconnected);
    room.players.filter(p => p.isBot && p.alive).forEach(bot => {
      const targets = alive.filter(t => t.id !== bot.id);
      if (targets.length > 0) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        submitVote(roomId, bot.id, target.id);
      }
    });
  }, 1000);

  clearRoomTimer(room, 'vote');
  room.timers.vote = setTimeout(() => {
    tallyVotes(roomId);
  }, VOTE_TIME * 1000);
}

function submitVote(roomId, voterId, targetId) {
  const room = getRoom(roomId);
  if (!room || room.gamePhase !== 'voting') return;

  const voter = findPlayerBySocket(room, voterId);
  const target = findPlayerBySocket(room, targetId);
  if (!voter || !voter.alive || !target || !target.alive) return;
  if (voterId === targetId) return;
  if (room.votes[voterId]) return; // already voted

  room.votes[voterId] = targetId;

  // Broadcast anonymous progress
  const alive = alivePlayers(room).filter(p => !p.disconnected);
  io.to(roomId).emit('voteProgress', {
    count: Object.keys(room.votes).length,
    total: alive.length,
  });

  // Check if all alive non-disconnected players have voted
  const allVoted = alive.every(p => room.votes[p.id]);
  if (allVoted) {
    clearRoomTimer(room, 'vote');
    tallyVotes(roomId);
  }
}

function tallyVotes(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  clearRoomTimer(room, 'vote');
  room.gamePhase = 'result';

  // Count votes
  const tally = {};
  for (const targetId of Object.values(room.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  const sorted = Object.entries(tally)
    .map(([id, count]) => {
      const p = findPlayerBySocket(room, id);
      return { id, name: p?.name || '???', count };
    })
    .sort((a, b) => b.count - a.count);

  const max = sorted[0]?.count || 0;
  const tops = sorted.filter(s => s.count === max);
  const isTie = tops.length > 1 || max === 0;

  if (isTie) {
    room.pendingElimination = null;
    io.to(roomId).emit('voteResult', { tally: sorted, eliminated: null, isTie: true });
  } else {
    const elimId = tops[0].id;
    room.pendingElimination = elimId;
    const elimPlayer = findPlayerBySocket(room, elimId);
    const role = room.roles[elimId];

    io.to(roomId).emit('voteResult', {
      tally: sorted,
      eliminated: { id: elimId, name: elimPlayer?.name, role },
      isTie: false,
    });
  }

  emitState(roomId);
}

function afterResult(roomId) {
  const room = getRoom(roomId);
  if (!room || room.gamePhase !== 'result') return;

  if (room.pendingElimination) {
    const role = room.roles[room.pendingElimination];
    if (role === 'white') {
      room.gamePhase = 'whiteGuess';
      const wp = findPlayerBySocket(room, room.pendingElimination);
      io.to(roomId).emit('whiteGuessPhase', {
        whiteId: room.pendingElimination,
        whiteName: wp?.name || '???',
      });
      emitState(roomId);
      return;
    }
    // Eliminate the player
    const p = findPlayerBySocket(room, room.pendingElimination);
    if (p) p.alive = false;

    const winner = checkWin(room);
    if (winner) { showGameOver(roomId, winner); return; }
  }

  room.round++;
  beginDescribePhase(roomId);
}

function submitWhiteGuess(roomId, socketId, guess) {
  const room = getRoom(roomId);
  if (!room || room.gamePhase !== 'whiteGuess') return;
  if (socketId !== room.pendingElimination) return;

  const correct = guess.trim().toLowerCase() === room.civilianWord.toLowerCase();

  // Eliminate white
  const p = findPlayerBySocket(room, room.pendingElimination);
  if (p) p.alive = false;

  io.to(roomId).emit('whiteGuessResult', {
    guess: guess.trim(),
    correct,
    civilianWord: room.civilianWord,
  });

  if (correct) {
    showGameOver(roomId, 'white');
  } else {
    const winner = checkWin(room);
    if (winner) { showGameOver(roomId, winner); }
    else { room.round++; beginDescribePhase(roomId); }
  }
}

function checkWin(room) {
  let c = 0, s = 0, w = 0;
  room.players.forEach(p => {
    if (!p.alive) return;
    const role = room.roles[p.id];
    if (role === 'civilian') c++;
    else if (role === 'spy') s++;
    else w++;
  });
  if (s === 0 && w === 0) return 'civilian';
  if (c + s + w <= 3 && s > 0) return 'spy';
  if (s >= c + w) return 'spy';
  return null;
}

function showGameOver(roomId, winner) {
  const room = getRoom(roomId);
  if (!room) return;
  clearAllTimers(room);
  room.gamePhase = 'ended';

  const players = room.players.map(p => ({
    id: p.id,
    name: p.name,
    role: room.roles[p.id],
    word: room.words[p.id],
    alive: p.alive,
  }));

  io.to(roomId).emit('gameOver', { winner, players, civilianWord: room.civilianWord, spyWord: room.spyWord });
  emitState(roomId);
}

function playAgain(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  clearAllTimers(room);
  room.gamePhase = 'waiting';
  room.roles = {};
  room.words = {};
  room.revealed = new Set();
  room.votes = {};
  room.round = 1;
  room.speakerOrder = [];
  room.speakerIdx = 0;
  room.pendingElimination = null;
  room.players.forEach(p => { p.alive = true; });

  // Remove disconnected players
  room.players = room.players.filter(p => !p.disconnected);

  emitState(roomId);
}

// ─── Host Migration ─────────────────────────────────────
function migrateHost(room) {
  const connected = room.players.filter(p => !p.disconnected);
  if (connected.length > 0) {
    room.hostId = connected[0].id;
    io.to(room.id).emit('hostChanged', { hostId: room.hostId, hostName: connected[0].name });
  }
}

// ─── Room Cleanup ───────────────────────────────────────
function scheduleCleanup(room) {
  clearRoomTimer(room, 'cleanup');
  room.timers.cleanup = setTimeout(() => {
    const connected = room.players.filter(p => !p.disconnected);
    if (connected.length === 0) {
      clearAllTimers(room);
      rooms.delete(room.id);
    }
  }, CLEANUP_DELAY);
}

// ─── Socket Handlers ────────────────────────────────────
io.on('connection', (socket) => {
  let joinCount = 0;

  socket.on('createRoom', ({ name }) => {
    if (!name || name.length < 1 || name.length > 8 || FORBIDDEN_CHARS.test(name)) {
      socket.emit('error', { message: '暱稱無效（1-8字，不可含特殊符號）' });
      return;
    }
    if (rooms.size >= MAX_ROOMS) {
      socket.emit('error', { message: '伺服器滿載，請稍後再試' });
      return;
    }
    if (socket.data.roomId) {
      socket.emit('error', { message: '你已在房間中' });
      return;
    }

    const roomId = genRoomId();
    const room = createRoom(roomId, socket.id);
    room.players.push({ id: socket.id, name, alive: true, disconnected: false });
    rooms.set(roomId, room);

    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.join(roomId);

    socket.emit('roomCreated', { roomId, playerId: socket.id });
    emitState(roomId);
  });

  socket.on('joinRoom', ({ name, roomId }) => {
    if (!name || name.length < 1 || name.length > 8 || FORBIDDEN_CHARS.test(name)) {
      socket.emit('error', { message: '暱稱無效（1-8字，不可含特殊符號）' });
      return;
    }
    if (++joinCount > JOIN_RATE_LIMIT) {
      socket.emit('error', { message: '操作太頻繁，請稍後再試' });
      return;
    }
    if (socket.data.roomId) {
      socket.emit('error', { message: '你已在房間中' });
      return;
    }

    const rid = roomId?.toUpperCase();
    const room = getRoom(rid);
    if (!room) {
      socket.emit('error', { message: '找不到此房間' });
      return;
    }
    if (room.gamePhase !== 'waiting') {
      socket.emit('error', { message: '遊戲已開始，無法加入' });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('error', { message: '房間已滿（最多 10 人）' });
      return;
    }
    // Check duplicate name
    if (room.players.some(p => p.name === name && !p.disconnected)) {
      socket.emit('error', { message: '此暱稱已被使用' });
      return;
    }

    room.players.push({ id: socket.id, name, alive: true, disconnected: false });
    socket.data.roomId = rid;
    socket.data.name = name;
    socket.join(rid);

    clearRoomTimer(room, 'cleanup');
    socket.emit('roomJoined', { roomId: rid, playerId: socket.id });
    io.to(rid).emit('playerJoined', { id: socket.id, name });
    emitState(rid);
  });

  socket.on('rejoinRoom', ({ roomId, name }) => {
    const rid = roomId?.toUpperCase();
    const room = getRoom(rid);
    if (!room) {
      socket.emit('error', { message: '房間已不存在' });
      return;
    }
    // Find disconnected player by name
    const player = room.players.find(p => p.name === name && p.disconnected);
    if (!player) {
      socket.emit('error', { message: '找不到你的位置，可能已被移除' });
      return;
    }

    // Restore player
    const oldId = player.id;
    player.id = socket.id;
    player.disconnected = false;
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }

    // Update role/word mappings
    if (room.roles[oldId]) { room.roles[socket.id] = room.roles[oldId]; delete room.roles[oldId]; }
    if (room.words[oldId]) { room.words[socket.id] = room.words[oldId]; delete room.words[oldId]; }
    if (room.revealed.has(oldId)) { room.revealed.delete(oldId); room.revealed.add(socket.id); }
    if (room.votes[oldId]) { room.votes[socket.id] = room.votes[oldId]; delete room.votes[oldId]; }
    // Update vote targets pointing to old id
    for (const [k, v] of Object.entries(room.votes)) {
      if (v === oldId) room.votes[k] = socket.id;
    }
    // Update speaker order
    room.speakerOrder = room.speakerOrder.map(id => id === oldId ? socket.id : id);
    if (room.pendingElimination === oldId) room.pendingElimination = socket.id;
    if (room.hostId === oldId) room.hostId = socket.id;

    socket.data.roomId = rid;
    socket.data.name = name;
    socket.join(rid);

    socket.emit('roomJoined', { roomId: rid, playerId: socket.id, reconnected: true });

    // Send their word if game is active
    if (room.words[socket.id] && room.gamePhase !== 'waiting' && room.gamePhase !== 'ended') {
      socket.emit('revealWord', { word: room.words[socket.id], role: room.roles[socket.id] });
    }

    io.to(rid).emit('playerReconnected', { id: socket.id, name });
    emitState(rid);
  });

  socket.on('updateConfig', (config) => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.gamePhase !== 'waiting') return;

    if (config.spyCount !== undefined) room.config.spyCount = Math.max(1, Math.min(config.spyCount, 5));
    if (config.whiteCount !== undefined) room.config.whiteCount = Math.max(0, Math.min(config.whiteCount, 4));
    // Online mode always uses random words (host is also a player)
    room.config.wordSource = 'random';

    emitState(room.id);
  });

  socket.on('addBots', () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.gamePhase !== 'waiting') return;
    const botNames = ['機器人A', '機器人B', '機器人C', '機器人D', '機器人E'];
    let added = 0;
    while (room.players.length < MIN_PLAYERS && added < botNames.length) {
      const botId = 'bot_' + room.id + '_' + added;
      room.players.push({ id: botId, name: botNames[added], alive: true, disconnected: false, isBot: true });
      added++;
    }
    if (added > 0) emitState(room.id);
  });

  socket.on('startGame', () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.gamePhase !== 'waiting') return;
    if (room.players.length < MIN_PLAYERS) {
      socket.emit('error', { message: `至少需要 ${MIN_PLAYERS} 人才能開始` });
      return;
    }
    startGame(room.id);
  });

  socket.on('confirmRevealed', () => {
    const roomId = socket.data.roomId;
    if (roomId) confirmRevealed(roomId, socket.id);
  });

  socket.on('describeDone', () => {
    const room = getRoom(socket.data.roomId);
    if (!room || room.gamePhase !== 'describing') return;
    const currentSpeaker = room.speakerOrder[room.speakerIdx];
    // Allow speaker or host to advance
    if (socket.id !== currentSpeaker && socket.id !== room.hostId) return;
    nextSpeaker(room.id);
  });

  socket.on('peekWord', (_, cb) => {
    const room = getRoom(socket.data.roomId);
    if (!room || !room.words[socket.id]) return;
    // Return the player's word (private)
    if (typeof cb === 'function') {
      cb({ word: room.words[socket.id], role: room.roles[socket.id] });
    } else {
      socket.emit('peekWordResult', { word: room.words[socket.id], role: room.roles[socket.id] });
    }
  });

  socket.on('submitVote', ({ targetId }) => {
    const roomId = socket.data.roomId;
    if (roomId) submitVote(roomId, socket.id, targetId);
  });

  socket.on('nextRound', () => {
    const room = getRoom(socket.data.roomId);
    if (!room || socket.id !== room.hostId) return;
    if (room.gamePhase === 'result') afterResult(room.id);
  });

  socket.on('submitWhiteGuess', ({ guess }) => {
    const roomId = socket.data.roomId;
    if (roomId) submitWhiteGuess(roomId, socket.id, guess);
  });

  socket.on('playAgain', () => {
    const room = getRoom(socket.data.roomId);
    if (!room || socket.id !== room.hostId) return;
    playAgain(room.id);
  });

  socket.on('leaveRoom', () => {
    handleDisconnect(socket, true);
  });

  socket.on('heartbeat', () => {
    socket.data.lastHeartbeat = Date.now();
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket, false);
  });
});

function handleDisconnect(socket, voluntary) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = getRoom(roomId);
  if (!room) return;

  const player = findPlayerBySocket(room, socket.id);
  if (!player) return;

  socket.data.roomId = null;

  if (voluntary || room.gamePhase === 'waiting') {
    // Permanent leave
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(roomId).emit('playerLeft', { id: socket.id, name: player.name });

    if (room.hostId === socket.id) migrateHost(room);
    if (room.players.filter(p => !p.disconnected).length === 0) {
      scheduleCleanup(room);
    } else {
      // If game is active and too few players, end game
      if (room.gamePhase !== 'waiting' && room.gamePhase !== 'ended') {
        const alive = room.players.filter(p => p.alive);
        if (alive.length < 3) {
          const winner = checkWin(room);
          showGameOver(roomId, winner || 'civilian');
          return;
        }
        // If current speaker left during describe
        if (room.gamePhase === 'describing') {
          const currentSpeaker = room.speakerOrder[room.speakerIdx];
          if (currentSpeaker === socket.id) nextSpeaker(roomId);
        }
      }
      emitState(roomId);
    }
  } else {
    // Disconnect during active game — grace period
    player.disconnected = true;
    io.to(roomId).emit('playerDisconnected', { id: socket.id, name: player.name });

    if (room.hostId === socket.id) migrateHost(room);

    // Grace period timer
    player.disconnectTimer = setTimeout(() => {
      // Permanent removal after grace
      player.alive = false;
      player.disconnected = true;
      io.to(roomId).emit('playerLeft', { id: socket.id, name: player.name, timeout: true });

      if (room.gamePhase === 'describing') {
        const currentSpeaker = room.speakerOrder[room.speakerIdx];
        if (currentSpeaker === socket.id) nextSpeaker(roomId);
      }
      if (room.gamePhase === 'voting') {
        // Check if all remaining have voted
        const alive = alivePlayers(room).filter(p => !p.disconnected);
        const allVoted = alive.every(p => room.votes[p.id]);
        if (allVoted) { clearRoomTimer(room, 'vote'); tallyVotes(roomId); }
      }

      const alive = room.players.filter(p => p.alive);
      if (alive.length < 3 && room.gamePhase !== 'waiting' && room.gamePhase !== 'ended') {
        const winner = checkWin(room);
        showGameOver(roomId, winner || 'civilian');
      } else {
        emitState(roomId);
      }
    }, GRACE_PERIOD);

    // Handle current-speaker disconnect
    if (room.gamePhase === 'describing') {
      const currentSpeaker = room.speakerOrder[room.speakerIdx];
      if (currentSpeaker === socket.id) nextSpeaker(roomId);
    }

    emitState(roomId);
  }
}

// ─── Idle Cleanup ───────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.gamePhase === 'waiting') {
      const connected = room.players.filter(p => !p.disconnected);
      if (connected.length === 0) {
        clearAllTimers(room);
        rooms.delete(id);
      }
    }
  }
}, 60000);

// ─── Start Server ───────────────────────────────────────
const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`誰是臥底 server running on port ${PORT}`);
});

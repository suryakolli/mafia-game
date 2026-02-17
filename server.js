const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);

// CORS configuration for GitHub Pages
// Enhanced Socket.IO config for mobile device stability
const io = socketIO(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://*.github.io" // Allow GitHub Pages
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  // Aggressive timeouts to prevent disconnections on mobile
  pingTimeout: 180000,     // Wait 3 minutes for ping response before disconnecting (increased from 120s)
  pingInterval: 8000,      // Send ping every 8 seconds to keep connection alive (reduced from 15s)
  upgradeTimeout: 30000,   // Time to wait for upgrade
  allowUpgrades: true,
  transports: ['websocket', 'polling'],
  // Additional stability options
  connectTimeout: 45000,   // Connection timeout
  perMessageDeflate: false // Disable compression for better mobile performance
});

app.use(express.static('public'));

let players = [];
let hostId = null;
let gameStarted = false;
let gameState = {
  phase: 'lobby', // lobby, night, day, tentativeVoting, finalVoting, tieRevote, gameOver
  round: 0,
  currentNightAction: null, // 'mafia', 'doctor', 'detective', null
  draftKill: null, // player ID marked for kill
  draftSave: null, // player ID marked for save
  actualKill: null, // final kill after doctor action
  detectiveInvestigation: { target: null, isMafia: null },
  doctorSaveHistory: [], // array of player IDs doctor has saved
  votes: {}, // { voterId: targetId }
  voteType: null, // 'tentative' or 'final'
  timerEndTime: null,
  timerDuration: 0,
  history: [], // array of round events
  tiedCandidates: [], // array of player IDs who are tied (for revote)
  revoteCount: 0, // track number of revotes
  lastDeathInfo: null, // store last death info for reconnecting players
  lastEliminationInfo: null // store last elimination info for reconnecting players
};
let gameSettings = {
  allowSpectatorView: false  // Default: spectator view disabled for security
};
let timerInterval = null;

// Get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

io.on('connection', (socket) => {
  console.log('New player connected:', socket.id);

  // Handle heartbeat to keep connection alive
  socket.on('heartbeat', (data) => {
    // Respond to heartbeat to keep connection active
    socket.emit('heartbeat_ack', { timestamp: Date.now() });
  });

  socket.on('joinGame', (playerName) => {
    // Check if player is reconnecting (same name, game in progress)
    const existingPlayer = players.find(p => p.name === playerName);

    if (existingPlayer && gameStarted) {
      // Player is reconnecting - store old ID for vote update
      const oldPlayerId = existingPlayer.id;
      existingPlayer.id = socket.id;
      existingPlayer.isDisconnected = false;

      // Update votes to use new socket ID
      // 1. Update votes BY this player (voter ID)
      if (gameState.votes[oldPlayerId]) {
        gameState.votes[socket.id] = gameState.votes[oldPlayerId];
        delete gameState.votes[oldPlayerId];
      }

      // 2. Update votes FOR this player (target ID)
      Object.keys(gameState.votes).forEach(voterId => {
        if (gameState.votes[voterId] === oldPlayerId) {
          gameState.votes[voterId] = socket.id;
        }
      });

      // If they were the host, restore host status and resume game
      if (existingPlayer.isHost) {
        hostId = socket.id;

        // Game can resume now that host is back
        io.emit('gameResumed');
        io.emit('notification', {
          message: `${playerName} (HOST) has reconnected! Game resumed.`,
          type: 'success'
        });

        console.log(`Host ${playerName} reconnected. Game resumed.`);
      } else {
        io.emit('notification', {
          message: `${playerName} has reconnected!`,
          type: 'info'
        });

        console.log(`${playerName} reconnected with role: ${existingPlayer.role}`);
      }

      io.emit('updatePlayers', players);
      socket.emit('joinedGame', {
        isHost: existingPlayer.isHost,
        reconnected: true,
        playerName: existingPlayer.name,
        isAlive: existingPlayer.isAlive
      });

      // Send game history so reconnected player knows what happened
      socket.emit('historyUpdate', gameState.history);

      // Send last elimination info if there was one recently
      if (gameState.lastEliminationInfo) {
        socket.emit('voteResult', gameState.lastEliminationInfo);
      }

      // Send current phase with last death info if in day phase
      socket.emit('phaseUpdate', {
        phase: gameState.phase,
        round: gameState.round,
        players: players,
        deathInfo: gameState.phase === 'day' ? gameState.lastDeathInfo : null,
        gameSettings: gameSettings
      });

      // Send their role back to them
      if (existingPlayer.role) {
        const roleData = { role: existingPlayer.role };

        // If player is mafia, send them the list of other mafia members
        if (existingPlayer.role === 'Mafia') {
          const mafiaMembers = players
            .filter(p => p.role === 'Mafia' && p.id !== existingPlayer.id)
            .map(p => p.name);
          roleData.mafiaTeam = mafiaMembers;
        }

        socket.emit('roleAssigned', roleData);
      }

      // If in voting phase, send current votes to ALL players (not just reconnected player)
      // This ensures everyone has synced vote state
      if (gameState.phase === 'tentativeVoting' || gameState.phase === 'finalVoting' || gameState.phase === 'tieRevote') {
        const voteCounts = getVoteCounts();
        const voteDetails = getVoteDetails();

        // Send vote update to everyone to ensure sync
        io.emit('voteUpdate', {
          voterId: null,
          voterName: null,
          targetId: null,
          targetName: null,
          voteCounts,
          voteDetails
        });
      }

      return;
    }

    // Check if game already started and this is a new player
    if (gameStarted && !existingPlayer) {
      socket.emit('gameAlreadyStarted');
      return;
    }

    // Check if player name already exists in lobby
    if (existingPlayer && !gameStarted) {
      socket.emit('error', 'Player name already taken');
      return;
    }

    // Set first player as host
    if (players.length === 0) {
      hostId = socket.id;
    }

    const player = {
      id: socket.id,
      name: playerName,
      role: null,
      isHost: socket.id === hostId,
      isAlive: true,
      isEliminated: false,
      isDisconnected: false,
      hasSeenRole: false,
      isReady: false
    };

    players.push(player);

    io.emit('updatePlayers', players);
    socket.emit('joinedGame', { isHost: socket.id === hostId, reconnected: false });

    console.log(`${playerName} joined. Total players: ${players.length}`);
  });

  socket.on('startGame', () => {
    if (socket.id !== hostId) {
      socket.emit('error', 'Only host can start the game');
      return;
    }

    // Need at least 5 total players (1 host + 4 players)
    if (players.length < 5) {
      socket.emit('error', 'Need at least 5 people total (1 host + 4 players) to start');
      return;
    }

    gameStarted = true;
    gameSettings = {
      allowSpectatorView: false
    };
    assignRoles();

    // Send each player their role
    players.forEach(player => {
      const roleData = { role: player.role };

      // If player is mafia, send them the list of other mafia members
      if (player.role === 'Mafia') {
        const mafiaMembers = players
          .filter(p => p.role === 'Mafia' && p.id !== player.id)
          .map(p => p.name);
        roleData.mafiaTeam = mafiaMembers;
      }

      io.to(player.id).emit('roleAssigned', roleData);
    });

    // Send initial ready status to host (all players should show as waiting)
    updateHostReadyStatus();

    console.log('Game started with roles:', players.map(p => ({ name: p.name, role: p.role })));
  });

  // Night Phase Events
  socket.on('playerViewedRole', () => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    player.hasSeenRole = true;
    console.log(`${player.name} has viewed their role`);

    // Notify host about who has viewed their role
    updateHostReadyStatus();
  });

  socket.on('playerReady', () => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    if (!player.hasSeenRole) {
      socket.emit('error', 'Please reveal your role first before clicking ready');
      return;
    }

    player.isReady = true;
    console.log(`${player.name} is ready`);

    // Notify host about player readiness
    updateHostReadyStatus();

    io.emit('notification', {
      message: `${player.name} is ready`,
      type: 'info'
    });
  });

  socket.on('godStartNight', () => {
    if (socket.id !== hostId) return;

    gameState.round++;
    gameState.phase = 'night';
    gameState.currentNightAction = null;
    gameState.draftKill = null;
    gameState.draftSave = null;
    gameState.actualKill = null;
    gameState.lastDeathInfo = null; // Clear last death info when starting new night
    gameState.lastEliminationInfo = null; // Clear last elimination info when starting new night
    gameState.detectiveInvestigation = {
      target: null,
      targetName: null,
      isMafia: null,
      detectiveName: null,
      foundRole: null
    };

    addToHistory({
      type: 'night',
      description: `Night ${gameState.round} begins`
    });

    // Check role status for host UI
    const doctor = players.find(p => p.role === 'Doctor');
    const detective = players.find(p => p.role === 'Detective');
    const aliveMafia = players.filter(p => p.role === 'Mafia' && p.isAlive).length;

    io.emit('phaseUpdate', {
      phase: 'night',
      round: gameState.round,
      players: players,
      roleStatus: {
        doctorAlive: doctor?.isAlive || false,
        detectiveAlive: detective?.isAlive || false,
        mafiaCount: aliveMafia
      },
      gameSettings: gameSettings
    });

    console.log(`Night ${gameState.round} started`);
  });

  socket.on('godWakeMafia', () => {
    if (socket.id !== hostId) return;
    gameState.currentNightAction = 'mafia';
    const eligiblePlayers = players.filter(p => p.isAlive && p.role !== 'God');
    io.to(hostId).emit('nightActionUpdate', { action: 'mafia', players: eligiblePlayers });
  });

  socket.on('godMarkKill', (playerId) => {
    if (socket.id !== hostId) return;
    gameState.draftKill = playerId;
    const player = players.find(p => p.id === playerId);
    io.to(hostId).emit('killMarked', { playerId, playerName: player?.name });
    console.log(`Mafia marked ${player?.name} for kill`);
  });

  socket.on('godWakeDoctor', () => {
    if (socket.id !== hostId) return;

    // Check if doctor is still alive
    const doctor = players.find(p => p.role === 'Doctor');
    if (!doctor || !doctor.isAlive) {
      io.to(hostId).emit('error', 'Doctor has been eliminated and cannot save anyone');
      return;
    }

    gameState.currentNightAction = 'doctor';
    const availablePlayers = players.filter(p => p.isAlive && p.role !== 'God' && !gameState.doctorSaveHistory.includes(p.id));
    io.to(hostId).emit('nightActionUpdate', {
      action: 'doctor',
      players: availablePlayers,
      savedHistory: gameState.doctorSaveHistory
    });
  });

  socket.on('godMarkSave', (playerId) => {
    if (socket.id !== hostId) return;
    if (gameState.doctorSaveHistory.includes(playerId)) {
      io.to(hostId).emit('error', 'Doctor cannot save this person again');
      return;
    }
    gameState.draftSave = playerId;
    gameState.doctorSaveHistory.push(playerId);
    const player = players.find(p => p.id === playerId);
    io.to(hostId).emit('saveMarked', { playerId, playerName: player?.name });
    console.log(`Doctor marked ${player?.name} for save`);
  });

  socket.on('godWakeDetective', () => {
    if (socket.id !== hostId) return;

    // Check if detective is still alive
    const detective = players.find(p => p.role === 'Detective');
    if (!detective || !detective.isAlive) {
      io.to(hostId).emit('error', 'Detective has been eliminated and cannot investigate anyone');
      return;
    }

    gameState.currentNightAction = 'detective';
    // Detective cannot investigate themselves - exclude detective from eligible players
    const eligiblePlayers = players.filter(p => p.isAlive && p.role !== 'God' && p.role !== 'Detective');
    io.to(hostId).emit('nightActionUpdate', { action: 'detective', players: eligiblePlayers });
  });

  socket.on('godInvestigate', (playerId) => {
    if (socket.id !== hostId) return;
    const player = players.find(p => p.id === playerId);
    if (player) {
      const isMafia = player.role === 'Mafia';
      const detective = players.find(p => p.role === 'Detective' && p.isAlive);

      // Store investigation for later history entry (will be added in processNightActions)
      gameState.detectiveInvestigation = {
        target: playerId,
        targetName: player.name,
        isMafia,
        detectiveName: detective?.name || 'Detective',
        foundRole: isMafia ? 'Mafia' : player.role
      };

      io.to(hostId).emit('investigationResult', {
        playerId,
        playerName: player.name,
        isMafia
      });
      console.log(`Detective investigated ${player.name}: ${isMafia ? 'Mafia' : 'Not Mafia'}`);
    }
  });

  socket.on('updateGameSettings', (settings) => {
    if (socket.id !== hostId) return;

    if (settings.hasOwnProperty('allowSpectatorView')) {
      gameSettings.allowSpectatorView = settings.allowSpectatorView;
    }

    io.emit('gameSettingsUpdate', gameSettings);
    console.log('Game settings updated:', gameSettings);
  });

  socket.on('godStartDay', () => {
    if (socket.id !== hostId) return;

    // Process night actions
    processNightActions();

    gameState.phase = 'day';
    gameState.currentNightAction = null;

    const deathInfo = gameState.actualKill
      ? {
          died: true,
          playerId: gameState.actualKill,
          playerName: players.find(p => p.id === gameState.actualKill)?.name
        }
      : { died: false };

    // Store death info for reconnecting players
    gameState.lastDeathInfo = deathInfo;

    io.emit('phaseUpdate', {
      phase: 'day',
      round: gameState.round,
      players: players,
      deathInfo,
      gameSettings: gameSettings
    });

    // Check win condition after a delay to allow death announcement to be seen
    const winCheck = checkWinCondition();
    if (winCheck.won) {
      // Delay game over by 5 seconds to show death announcement first
      setTimeout(() => {
        endGame(winCheck.winner, winCheck.reason);
      }, 5000);
      return;
    }

    console.log(`Day ${gameState.round} started. Death:`, deathInfo);
  });

  // Voting Events
  socket.on('godStartTentativeVoting', () => {
    if (socket.id !== hostId) return;

    // Clear any existing timer when starting new voting phase
    clearTimer();
    gameState.timerEndTime = null;
    gameState.timerDuration = 0;

    gameState.phase = 'tentativeVoting';
    gameState.voteType = 'tentative';
    gameState.votes = {};

    io.emit('phaseUpdate', {
      phase: 'tentativeVoting',
      round: gameState.round,
      players: players,
      gameSettings: gameSettings
    });

    console.log('Tentative voting started');
  });

  socket.on('godStartFinalVoting', (data) => {
    if (socket.id !== hostId) return;

    // Clear any existing timer when starting new voting phase
    clearTimer();
    gameState.timerEndTime = null;
    gameState.timerDuration = 0;

    gameState.phase = 'finalVoting';
    gameState.voteType = 'final';
    gameState.votes = {};

    io.emit('phaseUpdate', {
      phase: 'finalVoting',
      round: gameState.round,
      players: players,
      gameSettings: gameSettings
    });

    console.log('Final voting started (no timer)');
  });

  socket.on('godStartVotingTimer', (data) => {
    if (socket.id !== hostId) return;

    const duration = data?.duration || 120;

    startTimer(duration, () => {
      // Timer expired - only auto-process if all players have voted
      const alivePlayers = players.filter(p => p.isAlive && !p.isDisconnected && p.role !== 'God');
      const totalVotes = Object.keys(gameState.votes).length;

      if (totalVotes === alivePlayers.length && totalVotes > 0) {
        console.log('Timer expired and all players voted, automatically ending voting');
        processVotingEnd();
      } else {
        console.log(`Timer expired but not all players voted (${totalVotes}/${alivePlayers.length})`);
        io.to(hostId).emit('timerExpiredNotAllVoted', {
          votedCount: totalVotes,
          totalPlayers: alivePlayers.length
        });
      }
    });

    console.log('Voting timer started with', duration, 'seconds');
  });

  socket.on('godExtendTimer', (data) => {
    if (socket.id !== hostId) return;
    const seconds = data?.seconds || 60;
    gameState.timerEndTime += seconds * 1000;
    io.emit('timerExtended', { seconds });
    console.log(`Timer extended by ${seconds} seconds`);
  });

  socket.on('playerVote', (targetId) => {
    const voter = players.find(p => p.id === socket.id);
    if (!voter || !voter.isAlive) {
      socket.emit('error', 'You cannot vote');
      return;
    }

    if (gameState.phase !== 'tentativeVoting' && gameState.phase !== 'finalVoting' && gameState.phase !== 'tieRevote') {
      socket.emit('error', 'Not in voting phase');
      return;
    }

    // Prevent self-voting
    if (targetId === socket.id) {
      socket.emit('error', 'You cannot vote for yourself');
      return;
    }

    // In revote phase, only allow voting for tied candidates
    if (gameState.phase === 'tieRevote' && !gameState.tiedCandidates.includes(targetId)) {
      socket.emit('error', 'You can only vote for tied candidates');
      return;
    }

    gameState.votes[socket.id] = targetId;
    const voteCounts = getVoteCounts();
    const voteDetails = getVoteDetails();

    io.emit('voteUpdate', {
      voterId: socket.id,
      voterName: voter.name,
      targetId,
      targetName: players.find(p => p.id === targetId)?.name,
      voteCounts,
      voteDetails
    });

    console.log(`${voter.name} voted for ${players.find(p => p.id === targetId)?.name}`);

    // Check if all alive players have voted (including disconnected - God will ask them to reconnect)
    const alivePlayers = players.filter(p => p.isAlive && p.role !== 'God');
    const totalVotes = Object.keys(gameState.votes).length;

    if (totalVotes === alivePlayers.length && alivePlayers.length > 0) {
      // All players have voted - notify host
      const phaseMessage =
        gameState.phase === 'tentativeVoting'
          ? 'All players have voted! You can now start Final Voting or continue discussion.'
          : gameState.phase === 'finalVoting'
          ? 'All players have voted! You can end voting now or wait for the timer.'
          : 'All players have voted in the revote! You can end voting now or wait for the timer.';

      io.to(hostId).emit('allPlayersVoted', {
        phase: gameState.phase,
        message: phaseMessage,
        voteCounts
      });

      console.log('All players have voted!');
    }
  });

  socket.on('godEndVoting', () => {
    if (socket.id !== hostId) return;
    processVotingEnd();
  });

  socket.on('transferHost', (newHostId) => {
    if (socket.id !== hostId) {
      socket.emit('error', 'Only host can transfer host status');
      return;
    }

    const newHost = players.find(p => p.id === newHostId);
    if (!newHost) {
      socket.emit('error', 'Invalid player selected');
      return;
    }

    // Update host status
    const oldHost = players.find(p => p.id === hostId);
    if (oldHost) {
      oldHost.isHost = false;
    }

    hostId = newHostId;
    newHost.isHost = true;

    io.emit('hostTransferred', {
      oldHostId: socket.id,
      newHostId: hostId,
      newHostName: newHost.name
    });

    io.emit('updatePlayers', players);

    console.log(`Host transferred from ${oldHost?.name} to ${newHost.name}`);
  });

  socket.on('disconnect', () => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    console.log(`${player.name} disconnected`);

    // If game hasn't started, remove player completely
    if (!gameStarted) {
      const wasHost = socket.id === hostId;
      players = players.filter(p => p.id !== socket.id);

      // Transfer host to next player in lobby
      if (wasHost && players.length > 0) {
        hostId = players[0].id;
        players[0].isHost = true;

        io.emit('hostTransferred', {
          oldHostId: socket.id,
          newHostId: hostId,
          newHostName: players[0].name
        });

        console.log(`Host disconnected from lobby. Control transferred to ${players[0].name}`);
      }

      // Reset game if all players left
      if (players.length === 0) {
        resetGameState();
        hostId = null;
        console.log('All players disconnected. Game reset.');
      }

      io.emit('updatePlayers', players);
      return;
    }

    // Game is in progress - mark as disconnected but keep in game
    player.isDisconnected = true;
    const wasHost = socket.id === hostId;

    if (wasHost) {
      // Host disconnected - DO NOT transfer host, just notify and wait
      io.emit('notification', {
        message: `${player.name} (HOST) disconnected. Game paused. Waiting for host to reconnect...`,
        type: 'warning'
      });

      io.emit('gamePaused', {
        hostName: player.name,
        message: 'Host disconnected. Game is paused until host reconnects.'
      });

      console.log(`Host ${player.name} disconnected. Game paused, waiting for reconnection.`);
    } else {
      // Regular player disconnected
      io.emit('notification', {
        message: `${player.name} disconnected. They can reconnect anytime.`,
        type: 'info'
      });

      console.log(`${player.name} marked as disconnected but kept in game`);
    }

    io.emit('updatePlayers', players);
  });

  socket.on('resetGame', () => {
    if (socket.id !== hostId) {
      socket.emit('error', 'Only host can reset the game');
      return;
    }

    resetGameState();
    io.emit('gameReset');
    io.emit('updatePlayers', players);
    console.log('Game reset by host');
  });
});

function endGame(winner, reason) {
  gameState.phase = 'gameOver';
  clearTimer();

  let historyDesc;
  if (winner === 'draw') {
    historyDesc = `Game is a draw! ${reason || ''}`;
  } else {
    historyDesc = `${winner === 'mafia' ? 'Mafia' : 'Villagers'} win! ${reason || ''}`;
  }

  addToHistory({
    type: 'gameOver',
    description: historyDesc
  });

  io.emit('gameOver', {
    winner,
    reason: reason || null,
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      isAlive: p.isAlive
    })),
    history: gameState.history
  });

  console.log(`Game Over! ${winner === 'draw' ? 'Draw' : winner + ' wins'}! Reason: ${reason}`);
}

function resetGameState() {
  gameStarted = false;
  clearTimer();
  players.forEach(p => {
    p.role = null;
    p.isAlive = true;
    p.isEliminated = false;
    p.isDisconnected = false;
    p.hasSeenRole = false;
    p.isReady = false;
  });
  gameState = {
    phase: 'lobby',
    round: 0,
    currentNightAction: null,
    draftKill: null,
    draftSave: null,
    actualKill: null,
    detectiveInvestigation: { target: null, isMafia: null },
    doctorSaveHistory: [],
    votes: {},
    voteType: null,
    timerEndTime: null,
    timerDuration: 0,
    history: [],
    tiedCandidates: [],
    revoteCount: 0,
    lastDeathInfo: null,
    lastEliminationInfo: null
  };
}

function assignRoles() {
  // Exclude host from role assignment - host is only God
  const nonHostPlayers = players.filter(p => !p.isHost);
  const totalPlayers = nonHostPlayers.length;
  const roles = [];

  // 1 Doctor
  roles.push('Doctor');

  // 1 Detective
  roles.push('Detective');

  // 25% Mafia (at least 1, rounded)
  const mafiaCount = Math.max(1, Math.round((totalPlayers - 2) * 0.25));
  for (let i = 0; i < mafiaCount; i++) {
    roles.push('Mafia');
  }

  // Rest are Villagers
  const villagerCount = totalPlayers - roles.length;
  for (let i = 0; i < villagerCount; i++) {
    roles.push('Villager');
  }

  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  // Assign roles to non-host players only
  nonHostPlayers.forEach((player, index) => {
    player.role = roles[index];
    player.isAlive = true;
    player.isEliminated = false;
  });

  // Host gets 'God' role (not a playing role)
  const host = players.find(p => p.isHost);
  if (host) {
    host.role = 'God';
    host.isAlive = true; // Host is always "alive" but not in game
    host.isEliminated = false;
  }
}

// Game logic functions
function processNightActions() {
  // Add all night actions to history in chronological order

  // 1. Mafia action
  if (gameState.draftKill) {
    const targetPlayer = players.find(p => p.id === gameState.draftKill);
    const mafiaCount = players.filter(p => p.role === 'Mafia' && p.isAlive).length;
    addToHistory({
      type: 'night_action',
      description: `Mafia (${mafiaCount} alive) targeted ${targetPlayer?.name} for elimination`,
      players: [targetPlayer?.name]
    });
  }

  // 2. Doctor action
  if (gameState.draftSave) {
    const savedPlayer = players.find(p => p.id === gameState.draftSave);
    const doctor = players.find(p => p.role === 'Doctor');
    addToHistory({
      type: 'night_action',
      description: `${doctor?.name || 'Doctor'} 🩺 attempted to save ${savedPlayer?.name}`,
      players: [doctor?.name, savedPlayer?.name]
    });
  }

  // 3. Detective action
  if (gameState.detectiveInvestigation && gameState.detectiveInvestigation.target) {
    addToHistory({
      type: 'investigation',
      description: `${gameState.detectiveInvestigation.detectiveName} 🔍 investigated ${gameState.detectiveInvestigation.targetName} and found they are ${gameState.detectiveInvestigation.foundRole}`,
      players: [gameState.detectiveInvestigation.detectiveName, gameState.detectiveInvestigation.targetName]
    });
  }

  // 4. Result of night actions
  if (gameState.draftKill && gameState.draftSave && gameState.draftKill === gameState.draftSave) {
    // Doctor saved the person
    gameState.actualKill = null;
    const savedPlayer = players.find(p => p.id === gameState.draftSave);
    addToHistory({
      type: 'night',
      description: `✅ ${savedPlayer?.name || 'Someone'} was successfully saved! No one died during the night.`,
      players: [savedPlayer?.name]
    });
  } else if (gameState.draftKill) {
    // Kill goes through
    gameState.actualKill = gameState.draftKill;
    const killedPlayer = players.find(p => p.id === gameState.draftKill);
    if (killedPlayer) {
      killedPlayer.isAlive = false;
      killedPlayer.isEliminated = true;
      addToHistory({
        type: 'death',
        description: `💀 ${killedPlayer.name} was killed during the night`,
        players: [killedPlayer.name]
      });
    }
  } else {
    gameState.actualKill = null;
    addToHistory({
      type: 'night',
      description: '✅ No one died during the night'
    });
  }
}

function checkWinCondition() {
  const alivePlayers = players.filter(p => p.isAlive && p.role !== 'God');
  const aliveMafia = alivePlayers.filter(p => p.role === 'Mafia');
  const aliveVillagers = alivePlayers.filter(p => p.role !== 'Mafia' && p.role !== 'God');

  // Draw condition: 1v1 (1 Mafia vs 1 Villager)
  if (aliveMafia.length === 1 && aliveVillagers.length === 1) {
    return {
      won: true,
      winner: 'draw',
      reason: '1 Mafia vs 1 Villager - No majority possible, game is a draw'
    };
  }

  // Mafia wins if mafia count >= villagers count (and not 1v1)
  if (aliveMafia.length >= aliveVillagers.length && aliveMafia.length > 0) {
    return {
      won: true,
      winner: 'mafia',
      reason: `Mafia (${aliveMafia.length}) equals or outnumbers Villagers (${aliveVillagers.length})`
    };
  }

  // Villagers win if all mafia dead
  if (aliveMafia.length === 0) {
    return {
      won: true,
      winner: 'villagers',
      reason: 'All Mafia members have been eliminated'
    };
  }

  return { won: false, winner: null, reason: null };
}

function processVotingEnd() {
  clearTimer();

  const voteCounts = getVoteCounts();
  if (voteCounts.length === 0) {
    io.emit('voteResult', { eliminated: [], reason: 'No votes cast' });
    gameState.phase = 'day';
    gameState.tiedCandidates = [];
    gameState.revoteCount = 0;
    io.emit('phaseUpdate', { phase: 'day', round: gameState.round, players });
    return;
  }

  // Find highest vote count
  const maxVotes = voteCounts[0].count;
  const tied = voteCounts.filter(v => v.count === maxVotes);

  // Check if this is a tie and we should revote
  if (tied.length > 1 && gameState.voteType === 'final' && gameState.revoteCount < 3) {
    // Clear any existing timer when starting new voting phase
    clearTimer();
    gameState.timerEndTime = null;
    gameState.timerDuration = 0;

    // Initiate revote for tied candidates
    gameState.tiedCandidates = tied.map(t => t.playerId);
    gameState.revoteCount++;
    gameState.votes = {};
    gameState.phase = 'tieRevote';

    io.emit('tieRevote', {
      tiedCandidates: tied.map(t => ({ playerId: t.playerId, playerName: t.playerName })),
      revoteCount: gameState.revoteCount,
      voteCounts
    });

    io.emit('phaseUpdate', {
      phase: 'tieRevote',
      round: gameState.round,
      players: players,
      tiedCandidates: gameState.tiedCandidates,
      gameSettings: gameSettings
    });

    console.log('Tie detected, starting revote round', gameState.revoteCount, '(no auto-timer)');
    return;
  } else if (tied.length > 1 && gameState.voteType === 'final' && gameState.revoteCount >= 3) {
    // Max revotes reached, eliminate all tied
    tied.forEach(t => {
      eliminatePlayer(t.playerId, 'tie vote after max revotes');
    });

    const eliminationInfo = {
      eliminated: tied.map(t => ({ playerId: t.playerId, playerName: t.playerName })),
      reason: 'tie_max_revotes',
      voteCounts
    };

    // Store for reconnecting players
    gameState.lastEliminationInfo = eliminationInfo;

    io.emit('voteResult', eliminationInfo);
  } else {
    // Single elimination (or tie in tentative voting)
    const toEliminate = tied[0];
    eliminatePlayer(toEliminate.playerId, tied.length > 1 ? 'tie vote' : 'majority vote');

    const eliminationInfo = {
      eliminated: [{ playerId: toEliminate.playerId, playerName: toEliminate.playerName }],
      reason: tied.length > 1 ? 'tie' : 'majority',
      voteCounts
    };

    // Store for reconnecting players
    gameState.lastEliminationInfo = eliminationInfo;

    io.emit('voteResult', eliminationInfo);
  }

  // Check win condition after a delay to allow elimination announcement to be seen
  const winCheck = checkWinCondition();
  if (winCheck.won) {
    // Delay game over by 5 seconds to show elimination announcement first
    setTimeout(() => {
      endGame(winCheck.winner, winCheck.reason);
    }, 5000);
    return;
  }

  // Reset voting state
  gameState.votes = {};
  gameState.voteType = null;
  gameState.tiedCandidates = [];
  gameState.revoteCount = 0;
  gameState.phase = 'day';

  // Send phase update with votingCompleted flag to show different message
  io.emit('phaseUpdate', {
    phase: 'day',
    round: gameState.round,
    players,
    votingCompleted: true,
    gameSettings: gameSettings
  });
  console.log('Voting ended');
}

function eliminatePlayer(playerId, reason) {
  const player = players.find(p => p.id === playerId);
  if (player) {
    player.isAlive = false;
    player.isEliminated = true;
    addToHistory({
      type: 'elimination',
      description: `${player.name} was eliminated (${reason})`,
      players: [player.name]
    });
  }
}

function getVoteCounts() {
  const counts = {};
  Object.values(gameState.votes).forEach(targetId => {
    counts[targetId] = (counts[targetId] || 0) + 1;
  });

  // Convert to array and sort by count
  return Object.entries(counts)
    .map(([playerId, count]) => {
      const player = players.find(p => p.id === playerId);
      return { playerId, playerName: player?.name, count };
    })
    .sort((a, b) => b.count - a.count);
}

function getVoteDetails() {
  // Returns who voted for whom
  // Format: { targetId: [{ voterId, voterName }, ...] }
  const details = {};

  Object.entries(gameState.votes).forEach(([voterId, targetId]) => {
    if (!details[targetId]) {
      details[targetId] = [];
    }
    const voter = players.find(p => p.id === voterId);
    if (voter) {
      details[targetId].push({
        voterId: voter.id,
        voterName: voter.name
      });
    }
  });

  return details;
}

function updateHostReadyStatus() {
  const playingPlayers = players.filter(p => p.role !== 'God');
  const viewedCount = playingPlayers.filter(p => p.hasSeenRole).length;
  const readyCount = playingPlayers.filter(p => p.isReady).length;
  const totalPlayers = playingPlayers.length;
  const allReady = readyCount === totalPlayers;

  io.to(hostId).emit('playerReadyUpdate', {
    players: playingPlayers.map(p => ({
      id: p.id,
      name: p.name,
      hasSeenRole: p.hasSeenRole,
      isReady: p.isReady
    })),
    viewedCount,
    readyCount,
    totalPlayers,
    allReady
  });
}

function startTimer(duration, onComplete) {
  clearTimer();
  gameState.timerEndTime = Date.now() + duration * 1000;
  gameState.timerDuration = duration;

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, gameState.timerEndTime - Date.now());
    io.emit('timerUpdate', { remaining: Math.floor(remaining / 1000) });

    if (remaining <= 0) {
      clearTimer();
      if (onComplete) onComplete();
    }
  }, 1000);
}

function clearTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function addToHistory(event) {
  gameState.history.push({
    round: gameState.round,
    timestamp: Date.now(),
    type: event.type,
    description: event.description,
    players: event.players || []
  });
  io.emit('historyUpdate', gameState.history);
}

const PORT = process.env.PORT || 3000; // Use environment PORT for cloud platforms
const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=================================');
  console.log('🎭 MAFIA GAME SERVER RUNNING 🎭');
  console.log('=================================');
  console.log(`\nLocal access: http://localhost:${PORT}`);
  console.log(`Network access: http://${localIP}:${PORT}`);
  console.log('\nShare the network URL with your friends!\n');
  console.log('=================================\n');
});

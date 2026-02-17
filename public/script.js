// Configure backend server URL
// For local development: use window.location.origin
// For production: use your Render.com backend URL
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? window.location.origin
    : 'https://mafia-game-x5pu.onrender.com'; // Replace with your actual Render URL

// Detect mobile devices
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

// Mobile gets more frequent heartbeat
const HEARTBEAT_INTERVAL = isMobileDevice() ? 5000 : 10000;

// Socket.IO with aggressive reconnection for mobile devices
const socket = io(BACKEND_URL, {
    reconnection: true,
    reconnectionDelay: 300,           // Faster: 300ms (was 500ms)
    reconnectionDelayMax: 3000,       // Faster: 3s (was 5s)
    reconnectionAttempts: Infinity,   // Never stop trying to reconnect
    timeout: 20000,                   // Connection timeout (20 seconds)
    transports: ['websocket', 'polling'], // Try websocket first, fallback to polling
    upgrade: true,
    rememberUpgrade: true,
    forceNew: false,
    randomizationFactor: 0.5          // Add jitter to prevent thundering herd
});

// Heartbeat mechanism to keep connection alive
let heartbeatInterval = null;

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    // Send heartbeat based on device type (mobile: 5s, desktop: 10s)
    heartbeatInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('heartbeat', {
                playerId: myPlayerId,
                timestamp: Date.now(),
                isMobile: isMobileDevice()
            });
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// Handle page visibility changes (when user switches tabs or apps)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('Page hidden - keeping connection alive');
        // Page is hidden (backgrounded) - keep pinging
        startHeartbeat();
    } else {
        console.log('Page visible - reconnecting if needed');
        // Page is visible again - ensure we're connected
        if (!socket.connected && myPlayerName) {
            console.log('Attempting to reconnect...');
            socket.connect();
        }
    }
});

// Prevent mobile devices from closing connection on sleep
window.addEventListener('beforeunload', (e) => {
    // Only warn if player is in an active game
    if (gameStarted && currentPhase !== 'lobby') {
        e.preventDefault();
        e.returnValue = 'You are in an active game. Are you sure you want to leave?';
        return e.returnValue;
    }
});

// Start heartbeat when page loads
startHeartbeat();

// Initialize Web Worker for mobile devices
let connectionWorker = null;

function initConnectionWorker() {
    if ('Worker' in window && isMobileDevice()) {
        try {
            connectionWorker = new Worker('connection-worker.js');

            connectionWorker.addEventListener('message', (e) => {
                if (e.data.type === 'SEND_HEARTBEAT' && socket.connected) {
                    socket.emit('heartbeat', {
                        playerId: myPlayerId,
                        timestamp: e.data.timestamp,
                        fromWorker: true
                    });
                }
            });

            connectionWorker.postMessage({
                type: 'START_HEARTBEAT',
                data: { interval: HEARTBEAT_INTERVAL }
            });

            console.log('Connection worker initialized');
        } catch (err) {
            console.warn('Worker init failed:', err);
        }
    }
}

// Wake Lock API to prevent mobile devices from sleeping during game
let wakeLock = null;

async function requestWakeLock() {
    if ('wakeLock' in navigator && gameStarted) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock activated - screen will stay on');

            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock released');
            });
        } catch (err) {
            console.log('Wake Lock error:', err);
        }
    }
}

async function releaseWakeLock() {
    if (wakeLock !== null) {
        try {
            await wakeLock.release();
            wakeLock = null;
            console.log('Wake Lock released manually');
        } catch (err) {
            console.log('Wake Lock release error:', err);
        }
    }
}

// Request wake lock when game starts
document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && gameStarted) {
        // Re-request wake lock when page becomes visible
        await requestWakeLock();
    }
});

let isHost = false;
let myRole = null;
let myPlayerId = null;
let myPlayerName = '';
let isAlive = true;
let currentPhase = 'lobby';
let allPlayers = [];
let myMafiaTeam = [];
let currentGameSettings = { allowSpectatorView: false };
let isReconnecting = false; // Track if player is reconnecting

// Role reveal state
let roleRevealed = false;
let hasSeenRole = false;
let playerReady = false;

// DOM Elements
const joinScreen = document.getElementById('joinScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const roleScreen = document.getElementById('roleScreen');
const gameScreen = document.getElementById('gameScreen');
const godScreen = document.getElementById('godScreen');
const preGameWaitingScreen = document.getElementById('preGameWaitingScreen');
const playerNightScreen = document.getElementById('playerNightScreen');
const playerDayScreen = document.getElementById('playerDayScreen');
const votingScreen = document.getElementById('votingScreen');
const spectatorScreen = document.getElementById('spectatorScreen');
const gameOverScreen = document.getElementById('gameOverScreen');

const playerNameInput = document.getElementById('playerName');
const joinBtn = document.getElementById('joinBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const reconnectSection = document.getElementById('reconnectSection');
const reconnectPlayerNameSpan = document.getElementById('reconnectPlayerName');
const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const revealRoleBtn = document.getElementById('revealRoleBtn');

const hostBadge = document.getElementById('hostBadge');
const playersList = document.getElementById('playersList');
const playerCount = document.getElementById('playerCount');
const roleDisplay = document.getElementById('roleDisplay');
const hiddenRole = document.getElementById('hiddenRole');
const notification = document.getElementById('notification');
const btnRevealRole = document.getElementById('btnRevealRole');

// God panel elements
const btnWakeMafia = document.getElementById('btnWakeMafia');
const btnWakeDoctor = document.getElementById('btnWakeDoctor');
const btnWakeDetective = document.getElementById('btnWakeDetective');
const btnStartDay = document.getElementById('btnStartDay');
const btnStartTentativeVoting = document.getElementById('btnStartTentativeVoting');
const btnStartNightFromDay = document.getElementById('btnStartNightFromDay');
const btnStartFinalVoting = document.getElementById('btnStartFinalVoting');
const btnExtendTimer = document.getElementById('btnExtendTimer');
const btnEndVoting = document.getElementById('btnEndVoting');
const btnNewGame = document.getElementById('btnNewGame');
const btnShowMyRole = document.getElementById('btnShowMyRole');
const btnTransferHost = document.getElementById('btnTransferHost');
const btnCancelTransfer = document.getElementById('btnCancelTransfer');
const hostTransferModal = document.getElementById('hostTransferModal');
const btnTransferHostLobby = document.getElementById('btnTransferHostLobby');
const btnCancelTransferLobby = document.getElementById('btnCancelTransferLobby');
const hostTransferModalLobby = document.getElementById('hostTransferModalLobby');

// Event Listeners
joinBtn.addEventListener('click', joinGame);
playerNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinGame();
});

// Reconnect button handler
if (reconnectBtn) {
    reconnectBtn.addEventListener('click', () => {
        const savedName = localStorage.getItem('mafiaGamePlayerName');
        if (savedName) {
            myPlayerName = savedName;
            socket.emit('joinGame', savedName);
        }
    });
}

// Check for saved player name on page load and auto-reconnect if needed
window.addEventListener('load', () => {
    const savedName = localStorage.getItem('mafiaGamePlayerName');
    const autoReconnect = localStorage.getItem('mafiaGameAutoReconnect');

    if (savedName && reconnectPlayerNameSpan) {
        playerNameInput.value = savedName; // Pre-fill the name input
        reconnectPlayerNameSpan.textContent = savedName;
    }

    // Auto-reconnect if flag is set (after page reload from reconnection)
    if (autoReconnect === 'true' && savedName) {
        // Clear the flag
        localStorage.removeItem('mafiaGameAutoReconnect');

        // Auto-join after short delay to ensure socket connection is ready
        setTimeout(() => {
            console.log('Auto-reconnecting as:', savedName);
            myPlayerName = savedName;
            socket.emit('joinGame', savedName);
        }, 500);
    }
});

startBtn.addEventListener('click', () => {
    socket.emit('startGame');
});

resetBtn.addEventListener('click', () => {
    socket.emit('resetGame');
});

// Role reveal button handler
if (revealRoleBtn) {
    revealRoleBtn.addEventListener('click', () => {
        if (myRole) {
            hiddenRole.textContent = `Your role: ${myRole}`;
            hiddenRole.className = `hidden-role role-${myRole.toLowerCase()}`;
            hiddenRole.style.display = 'block';

            setTimeout(() => {
                hiddenRole.style.display = 'none';
            }, 5000);
        }
    });
}

// Main role reveal button (on role screen) handler
if (btnRevealRole) {
    btnRevealRole.addEventListener('click', () => {
        if (!myRole) {
            showNotification('Role not assigned yet');
            return;
        }

        if (!roleRevealed) {
            // Reveal role in the button itself
            const roleClass = `role-${myRole.toLowerCase()}`;
            let buttonHTML = `${getRoleEmoji(myRole)} <strong>${myRole}</strong>`;

            // If mafia, show team members in the roleDisplay area
            if (myRole === 'Mafia' && myMafiaTeam && myMafiaTeam.length > 0) {
                roleDisplay.innerHTML = `<div class="mafia-team-info">Your Mafia Team:<br>${myMafiaTeam.map(name => `🔪 ${name}`).join('<br>')}</div>`;
                roleDisplay.style.display = 'block';
            } else {
                roleDisplay.style.display = 'none';
            }

            buttonHTML += '<br><small style="font-size: 0.8em; opacity: 0.8;">Click again to hide</small>';

            btnRevealRole.innerHTML = buttonHTML;
            btnRevealRole.className = `btn btn-reveal ${roleClass}`;
            roleRevealed = true;

            // First time viewing - notify server and show ready button
            if (!hasSeenRole) {
                hasSeenRole = true;
                socket.emit('playerViewedRole');

                const roleInfo = document.querySelector('.role-info');
                const btnPlayerReady = document.getElementById('btnPlayerReady');

                // Show ready button and instruction
                if (btnPlayerReady) {
                    // Ensure button is in correct initial state before showing
                    btnPlayerReady.innerHTML = "I'm Ready";
                    btnPlayerReady.className = 'btn btn-success btn-large';
                    btnPlayerReady.disabled = false;
                    btnPlayerReady.style.display = 'block';
                }
                if (roleInfo) {
                    roleInfo.innerHTML = 'Reveal your role first, then click "I\'m Ready"';
                    roleInfo.style.color = '#64748b';
                    roleInfo.style.display = 'block';
                }
            }
        } else {
            // Hide role
            roleDisplay.style.display = 'none';
            btnRevealRole.innerHTML = 'Reveal My Role';
            btnRevealRole.className = 'btn btn-reveal';
            roleRevealed = false;
        }
    });
}

// Player ready button handler
const btnPlayerReadyElement = document.getElementById('btnPlayerReady');
if (btnPlayerReadyElement) {
    btnPlayerReadyElement.addEventListener('click', () => {
        // Defensive checks to ensure proper state
        if (!myRole) {
            showNotification('Please wait for role assignment!');
            resetRoleScreenUI(); // Reset UI if in bad state
            return;
        }

        if (!hasSeenRole) {
            showNotification('Please reveal your role first!');
            // Hide the ready button since role hasn't been revealed yet
            btnPlayerReadyElement.style.display = 'none';
            return;
        }

        if (playerReady) {
            showNotification('You are already ready!');
            return;
        }

        // Additional safety check - button should only be visible if role was revealed
        if (!roleRevealed && !hasSeenRole) {
            showNotification('Please reveal your role first!');
            btnPlayerReadyElement.style.display = 'none';
            return;
        }

        playerReady = true;
        socket.emit('playerReady');

        const roleInfo = document.querySelector('.role-info');

        // Update button
        btnPlayerReadyElement.disabled = true;
        btnPlayerReadyElement.innerHTML = '✅ Ready! Waiting for others...';
        btnPlayerReadyElement.className = 'btn btn-secondary btn-large';

        // Update instruction
        if (roleInfo) {
            roleInfo.innerHTML = '✅ Waiting for host to start the game...';
            roleInfo.style.color = '#22c55e';
        }
    });
}

// Functions
function joinGame() {
    const name = playerNameInput.value.trim();
    if (!name) {
        showNotification('Please enter your name');
        return;
    }

    myPlayerName = name;
    // Store name in localStorage for reconnection
    localStorage.setItem('mafiaGamePlayerName', name);
    socket.emit('joinGame', name);
}

function switchScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    screen.classList.add('active');
}

function showNotification(message, type = 'default') {
    notification.textContent = message;
    notification.className = 'notification show';

    // Add type-specific styling
    if (type === 'death') {
        notification.classList.add('notification-death');
    } else if (type === 'safe') {
        notification.classList.add('notification-safe');
    } else if (type === 'error') {
        notification.classList.add('notification-error');
    } else if (type === 'warning') {
        notification.classList.add('notification-warning');
    } else if (type === 'info') {
        notification.classList.add('notification-info');
    } else if (type === 'success') {
        notification.classList.add('notification-success');
    }

    setTimeout(() => {
        notification.classList.remove('show');
    }, 5000);
}

function resetRoleScreenUI() {
    // Reset all role screen UI elements to initial state
    const roleDisplay = document.getElementById('roleDisplay');
    const btnRevealRole = document.getElementById('btnRevealRole');
    const btnPlayerReady = document.getElementById('btnPlayerReady');
    const roleInfo = document.querySelector('.role-info');

    if (roleDisplay) {
        roleDisplay.style.display = 'none';
        roleDisplay.className = 'role-display hidden-role-display';
        roleDisplay.innerHTML = '';
        // Clear any inline styles that might have been added
        roleDisplay.style.cssText = 'display: none;';
    }

    if (btnRevealRole) {
        btnRevealRole.innerHTML = 'Reveal My Role';
        btnRevealRole.className = 'btn btn-reveal';
        btnRevealRole.disabled = false;
        // Clear any inline styles
        btnRevealRole.style.cssText = '';
    }

    if (btnPlayerReady) {
        // Aggressively reset the ready button
        btnPlayerReady.style.cssText = 'display: none !important;';
        btnPlayerReady.disabled = true;
        btnPlayerReady.innerHTML = "I'm Ready";
        btnPlayerReady.className = 'btn btn-success btn-large';
        // Remove any data attributes that might be set
        btnPlayerReady.removeAttribute('data-ready');
        // Force a reflow to ensure DOM updates
        void btnPlayerReady.offsetHeight;
    }

    if (roleInfo) {
        roleInfo.style.display = 'none';
        roleInfo.innerHTML = 'Reveal your role first, then click "I\'m Ready"';
        roleInfo.style.color = '#64748b';
    }

    // Force a small delay to ensure DOM updates are processed
    setTimeout(() => {
        if (btnPlayerReady) {
            btnPlayerReady.style.display = 'none';
            btnPlayerReady.disabled = true;
        }
    }, 0);
}

function showCenterAnnouncement(message, type = 'death') {
    // Create center announcement overlay
    const existingAnnouncement = document.getElementById('centerAnnouncementOverlay');
    if (existingAnnouncement) {
        existingAnnouncement.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = 'centerAnnouncementOverlay';
    overlay.className = 'center-announcement-overlay';

    const content = document.createElement('div');
    content.className = type === 'death' ? 'announcement-death-big center-announcement-content' : 'announcement-safe-big center-announcement-content';
    content.innerHTML = type === 'death' ? `💀 ${message}` : `✅ ${message}`;

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // Auto-hide after 5 seconds
    setTimeout(() => {
        overlay.classList.add('fade-out');
        setTimeout(() => overlay.remove(), 500);
    }, 5000);

    // Click to dismiss
    overlay.addEventListener('click', () => {
        overlay.classList.add('fade-out');
        setTimeout(() => overlay.remove(), 500);
    });
}

function showHostPrompt(message, phase) {
    // Remove existing prompt if any
    const existingPrompt = document.getElementById('hostVotingPrompt');
    if (existingPrompt) {
        existingPrompt.remove();
    }

    // Create prominent prompt banner
    const prompt = document.createElement('div');
    prompt.id = 'hostVotingPrompt';
    prompt.className = 'host-voting-prompt';
    prompt.innerHTML = `
        <div class="host-prompt-content">
            <div class="host-prompt-icon">✅</div>
            <div class="host-prompt-text">
                <strong>All Players Have Voted!</strong>
                <p>${message}</p>
            </div>
            <button class="host-prompt-dismiss" onclick="document.getElementById('hostVotingPrompt').remove()">✕</button>
        </div>
    `;

    // Add to voting controls section if visible
    const votingControls = document.getElementById('votingControls');
    if (votingControls && votingControls.style.display !== 'none') {
        votingControls.insertBefore(prompt, votingControls.firstChild);
    }

    // Auto-hide after 10 seconds
    setTimeout(() => {
        if (prompt.parentElement) {
            prompt.classList.add('fade-out');
            setTimeout(() => prompt.remove(), 500);
        }
    }, 10000);
}

function getRoleEmoji(role) {
    const emojis = {
        'Doctor': '🩺',
        'Detective': '🔍',
        'Mafia': '🔪',
        'Villager': '👥'
    };
    return emojis[role] || '👤';
}

// God Control Event Listeners
if (btnWakeMafia) {
    btnWakeMafia.addEventListener('click', () => {
        socket.emit('godWakeMafia');
    });
}

if (btnWakeDoctor) {
    btnWakeDoctor.addEventListener('click', () => {
        socket.emit('godWakeDoctor');
    });
}

if (btnWakeDetective) {
    btnWakeDetective.addEventListener('click', () => {
        socket.emit('godWakeDetective');
    });
}

if (btnStartDay) {
    btnStartDay.addEventListener('click', () => {
        socket.emit('godStartDay');
    });
}

if (btnStartTentativeVoting) {
    btnStartTentativeVoting.addEventListener('click', () => {
        socket.emit('godStartTentativeVoting');
    });
}

if (btnStartNightFromDay) {
    btnStartNightFromDay.addEventListener('click', () => {
        socket.emit('godStartNight');
    });
}

// Pre-game start night phase button
const btnStartNightPhase = document.getElementById('btnStartNightPhase');
if (btnStartNightPhase) {
    btnStartNightPhase.addEventListener('click', () => {
        socket.emit('godStartNight');
    });
}

// Reset game button (in God panel during game)
const btnResetGame = document.getElementById('btnResetGame');
if (btnResetGame) {
    btnResetGame.addEventListener('click', () => {
        showResetConfirmation();
    });
}

const btnConfirmReset = document.getElementById('btnConfirmReset');
if (btnConfirmReset) {
    btnConfirmReset.addEventListener('click', () => {
        socket.emit('resetGame');
        hideResetConfirmation();
    });
}

const btnCancelReset = document.getElementById('btnCancelReset');
if (btnCancelReset) {
    btnCancelReset.addEventListener('click', () => {
        hideResetConfirmation();
    });
}

if (btnStartFinalVoting) {
    btnStartFinalVoting.addEventListener('click', () => {
        socket.emit('godStartFinalVoting', { duration: 120 });
    });
}

const btnStartFinalVotingDirect = document.getElementById('btnStartFinalVotingDirect');
if (btnStartFinalVotingDirect) {
    btnStartFinalVotingDirect.addEventListener('click', () => {
        socket.emit('godStartFinalVoting', { duration: 120 });
    });
}

const btnStartTimer = document.getElementById('btnStartTimer');
if (btnStartTimer) {
    btnStartTimer.addEventListener('click', () => {
        socket.emit('godStartVotingTimer', { duration: 120 });
        btnStartTimer.style.display = 'none';

        const timerDisplay = document.getElementById('timerDisplay');
        const btnExtendTimer = document.getElementById('btnExtendTimer');
        if (timerDisplay) timerDisplay.style.display = 'block';
        if (btnExtendTimer) btnExtendTimer.style.display = 'inline-block';
    });
}

if (btnExtendTimer) {
    btnExtendTimer.addEventListener('click', () => {
        socket.emit('godExtendTimer', { seconds: 60 });
    });
}

// Lobby settings
const chkAllowSpectatorView = document.getElementById('chkAllowSpectatorView');
if (chkAllowSpectatorView) {
    chkAllowSpectatorView.addEventListener('change', (e) => {
        if (isHost) {
            socket.emit('updateGameSettings', {
                allowSpectatorView: e.target.checked
            });
        }
    });
}

// Game settings modal
const btnGameSettings = document.getElementById('btnGameSettings');
const gameSettingsModal = document.getElementById('gameSettingsModal');

if (btnGameSettings) {
    btnGameSettings.addEventListener('click', () => {
        const chkGame = document.getElementById('chkAllowSpectatorViewGame');
        if (chkGame) chkGame.checked = currentGameSettings.allowSpectatorView;
        if (gameSettingsModal) gameSettingsModal.style.display = 'flex';
    });
}

// Close settings modal when clicking outside
if (gameSettingsModal) {
    gameSettingsModal.addEventListener('click', (e) => {
        if (e.target === gameSettingsModal) {
            gameSettingsModal.style.display = 'none';
        }
    });
}

const btnSaveSettings = document.getElementById('btnSaveSettings');
if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
        const chkGame = document.getElementById('chkAllowSpectatorViewGame');
        socket.emit('updateGameSettings', {
            allowSpectatorView: chkGame.checked
        });
        gameSettingsModal.style.display = 'none';
    });
}

const btnCancelSettings = document.getElementById('btnCancelSettings');
if (btnCancelSettings) {
    btnCancelSettings.addEventListener('click', () => {
        gameSettingsModal.style.display = 'none';
    });
}

if (btnEndVoting) {
    btnEndVoting.addEventListener('click', () => {
        socket.emit('godEndVoting');
    });
}

// Old button (keeping for backward compatibility but will be hidden)
if (btnNewGame) {
    btnNewGame.addEventListener('click', () => {
        socket.emit('resetGame');
    });
}

// New return to lobby button
const btnReturnToLobby = document.getElementById('btnReturnToLobby');
if (btnReturnToLobby) {
    btnReturnToLobby.addEventListener('click', () => {
        socket.emit('resetGame');
    });
}

// Back to lobby from pre-game waiting screen
const btnBackToLobbyFromWaiting = document.getElementById('btnBackToLobbyFromWaiting');
if (btnBackToLobbyFromWaiting) {
    btnBackToLobbyFromWaiting.addEventListener('click', () => {
        if (confirm('Are you sure you want to cancel and return to lobby? All players will need to ready up again.')) {
            socket.emit('resetGame');
        }
    });
}

// Role reveal functionality with manual toggle
let roleRevealStates = {}; // Track reveal state for each button

function setupRoleRevealButton(buttonId, displayId) {
    const button = document.getElementById(buttonId);
    const display = document.getElementById(displayId);

    if (button && display) {
        // Initialize reveal state
        if (roleRevealStates[buttonId] === undefined) {
            roleRevealStates[buttonId] = false;
        }

        // Remove any existing listeners to prevent duplicates
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', () => {
            // Host (God) doesn't need to reveal role
            if (isHost || myRole === 'God') {
                showNotification('You are the host - no role to reveal');
                return;
            }

            if (!myRole) {
                showNotification('Role not assigned yet');
                return;
            }

            // Toggle reveal state
            if (!roleRevealStates[buttonId]) {
                // Show role
                let roleText = `Your role: ${getRoleEmoji(myRole)} ${myRole}`;

                // If mafia, show team members
                if (myRole === 'Mafia' && myMafiaTeam && myMafiaTeam.length > 0) {
                    roleText += `\n\nYour Mafia team:\n${myMafiaTeam.map(name => `🔪 ${name}`).join('\n')}`;
                }

                display.textContent = roleText;
                display.className = 'my-role-display role-reveal-active';
                display.style.display = 'block';
                display.style.whiteSpace = 'pre-line';

                // Update button
                newButton.textContent = '🙈 Hide My Role';
                newButton.classList.add('btn-hide-role');
                roleRevealStates[buttonId] = true;
            } else {
                // Hide role
                display.style.display = 'none';
                display.className = 'my-role-display';
                display.textContent = '';

                // Update button
                newButton.textContent = '👁️ Reveal My Role';
                newButton.classList.remove('btn-hide-role');
                roleRevealStates[buttonId] = false;
            }
        });
    }
}

// Setup role reveal buttons for different screens
setupRoleRevealButton('btnShowMyRoleDay', 'myRoleDisplayDay');
setupRoleRevealButton('btnShowMyRoleVoting', 'myRoleDisplayVoting');

if (btnTransferHost) {
    btnTransferHost.addEventListener('click', () => {
        showHostTransferModal();
    });
}

if (btnCancelTransfer) {
    btnCancelTransfer.addEventListener('click', () => {
        hideHostTransferModal();
    });
}

if (btnTransferHostLobby) {
    btnTransferHostLobby.addEventListener('click', () => {
        showHostTransferModalLobby();
    });
}

if (btnCancelTransferLobby) {
    btnCancelTransferLobby.addEventListener('click', () => {
        hideHostTransferModalLobby();
    });
}

// Socket Events
socket.on('connect', () => {
    myPlayerId = socket.id;
    console.log('Connected with socket ID:', myPlayerId);

    // Initialize connection worker on connect (for mobile)
    initConnectionWorker();
});

socket.on('joinedGame', (data) => {
    isHost = data.isHost;

    // If reconnected, reload page to get fresh state
    if (data.reconnected && data.playerName) {
        myPlayerName = data.playerName;
        isAlive = data.isAlive;

        // Set flag for auto-reconnect after reload
        localStorage.setItem('mafiaGameAutoReconnect', 'true');

        // Show reconnection message and reload
        showNotification('Reconnected! Reloading to sync game state...', 'success');

        // Reload after short delay to show notification
        setTimeout(() => {
            window.location.reload();
        }, 1000);

        return; // Don't continue with normal join flow
    } else {
        isReconnecting = false;
    }

    switchScreen(lobbyScreen);
    updateHostDisplay();

    // Show settings panel for host
    if (isHost) {
        const gameSettingsPanel = document.getElementById('gameSettingsPanel');
        const btnGameSettings = document.getElementById('btnGameSettings');
        if (gameSettingsPanel) gameSettingsPanel.style.display = 'block';
        if (btnGameSettings) btnGameSettings.style.display = 'inline-block';
    }

    // Update player name badge
    updatePlayerNameBadge();
});

socket.on('updatePlayers', (players) => {
    allPlayers = players;
    playersList.innerHTML = '';
    playerCount.textContent = players.length;

    players.forEach(player => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player-item' + (player.isHost ? ' host' : '');
        playerDiv.innerHTML = `
            <span>${player.isHost ? '👑' : '👤'}</span>
            <span>${player.name}</span>
        `;
        playersList.appendChild(playerDiv);
    });

    // Update host display
    updateHostDisplay();
});

socket.on('roleAssigned', (roleData) => {
    // Handle both old string format and new object format for backward compatibility
    if (typeof roleData === 'string') {
        myRole = roleData;
    } else {
        myRole = roleData.role;
        if (roleData.mafiaTeam) {
            myMafiaTeam = roleData.mafiaTeam;
        }
    }

    gameStarted = true;

    // Request wake lock to keep device awake during game
    requestWakeLock();

    // If host (God role), show pre-game waiting screen
    if (myRole === 'God') {
        // Only switch to pre-game screen if in lobby phase
        if (currentPhase === 'lobby') {
            switchScreen(preGameWaitingScreen);
        }
        updatePlayerNameBadge();
        return;
    }

    // If reconnecting and game is already in progress, don't switch to role screen
    // The phaseUpdate event will handle screen switching
    if (currentPhase !== 'lobby' && currentPhase !== '') {
        console.log('Reconnected with role:', myRole, 'Current phase:', currentPhase);
        updatePlayerNameBadge();
        return;
    }

    // Reset all state variables FIRST
    roleRevealed = false;
    hasSeenRole = false;
    playerReady = false;

    // Call the centralized UI reset function
    resetRoleScreenUI();

    // Now switch to role screen
    switchScreen(roleScreen);
    updatePlayerNameBadge();
});

socket.on('phaseUpdate', (data) => {
    const wasReconnecting = isReconnecting; // Store reconnection status before processing
    currentPhase = data.phase;
    allPlayers = data.players;

    if (data.gameSettings) {
        currentGameSettings = data.gameSettings;
    }

    const me = allPlayers.find(p => p.id === myPlayerId);
    if (me) {
        isAlive = me.isAlive;
        myPlayerName = me.name;
        isHost = me.isHost;
    }

    updatePlayerNameBadge();

    if (data.phase === 'night') {
        document.getElementById('roundNumber').textContent = data.round;
        document.getElementById('nightRoundNumber').textContent = data.round;
        document.getElementById('currentPhase').textContent = 'Night Phase';
        document.getElementById('currentPhase').className = 'phase-badge phase-night';

        if (isHost) {
            switchScreen(godScreen);
            showGodControls('night');
            updateGodPlayerGrid(data.players);

            // Update night control buttons based on role status
            if (data.roleStatus) {
                const btnWakeDoctor = document.getElementById('btnWakeDoctor');
                const btnWakeDetective = document.getElementById('btnWakeDetective');
                const btnWakeMafia = document.getElementById('btnWakeMafia');

                if (btnWakeDoctor) {
                    if (!data.roleStatus.doctorAlive) {
                        btnWakeDoctor.disabled = true;
                        btnWakeDoctor.textContent = '🩺 Doctor Eliminated - Cannot Save';
                        btnWakeDoctor.classList.add('btn-disabled-role');
                    } else {
                        btnWakeDoctor.disabled = false;
                        btnWakeDoctor.textContent = 'Wake Doctor';
                        btnWakeDoctor.classList.remove('btn-disabled-role');
                    }
                }

                if (btnWakeDetective) {
                    if (!data.roleStatus.detectiveAlive) {
                        btnWakeDetective.disabled = true;
                        btnWakeDetective.textContent = '🔍 Detective Eliminated - Cannot Investigate';
                        btnWakeDetective.classList.add('btn-disabled-role');
                    } else {
                        btnWakeDetective.disabled = false;
                        btnWakeDetective.textContent = 'Wake Detective';
                        btnWakeDetective.classList.remove('btn-disabled-role');
                    }
                }

                if (btnWakeMafia && data.roleStatus.mafiaCount > 0) {
                    btnWakeMafia.textContent = `Wake Mafia (${data.roleStatus.mafiaCount} alive)`;
                }
            }
        } else {
            switchScreen(playerNightScreen);
        }
    } else if (data.phase === 'day') {
        document.getElementById('dayRoundNumber').textContent = data.round;
        document.getElementById('currentPhase').textContent = 'Day Phase';
        document.getElementById('currentPhase').className = 'phase-badge phase-day';

        if (isHost) {
            switchScreen(godScreen);
            showGodControls('day');
            updateGodPlayerGrid(data.players);

            // Clear night action displays for clean UI
            document.getElementById('mafiaKillSelection').style.display = 'none';
            document.getElementById('doctorSaveSelection').style.display = 'none';
            document.getElementById('detectiveInvestSelection').style.display = 'none';
            document.getElementById('investigationResult').style.display = 'none';

            const deathAnnouncement = document.getElementById('deathAnnouncement');

            // Check if this is after voting completion (takes priority)
            if (data.votingCompleted === true) {
                deathAnnouncement.innerHTML = `<div class="announcement-next-round">🔄 Round ${data.round} completed. Ready to start next round.</div>`;
                deathAnnouncement.style.display = 'block';
                // Don't show center announcement - elimination announcement already shown from voteResult
            } else if (data.deathInfo && data.deathInfo.died) {
                deathAnnouncement.innerHTML = `<div class="announcement-death-big">💀 ${data.deathInfo.playerName} was killed during the night</div>`;
                deathAnnouncement.style.display = 'block';

                // Show center announcement ONLY for reconnecting host (and not if voting just completed)
                if (wasReconnecting) {
                    showCenterAnnouncement(`${data.deathInfo.playerName} was killed during the night`, 'death');
                }
            } else if (data.deathInfo && !data.deathInfo.died) {
                deathAnnouncement.innerHTML = '<div class="announcement-safe-big">✅ No one died during the night</div>';
                deathAnnouncement.style.display = 'block';

                // Show center announcement ONLY for reconnecting host (and not if voting just completed)
                if (wasReconnecting) {
                    showCenterAnnouncement('No one died during the night', 'safe');
                }
            } else {
                deathAnnouncement.style.display = 'none';
            }
        } else if (isAlive) {
            switchScreen(playerDayScreen);

            const playerDeathAnnouncement = document.getElementById('playerDeathAnnouncement');

            // Check if this is after voting completion (takes priority)
            if (data.votingCompleted === true) {
                playerDeathAnnouncement.innerHTML = `<div class="announcement-next-round">🔄 Round ${data.round} completed. Next round starting soon...</div>`;
                playerDeathAnnouncement.style.display = 'block';
                // Don't show center announcement - elimination announcement already shown from voteResult
            } else if (data.deathInfo && data.deathInfo.died) {
                playerDeathAnnouncement.innerHTML = `<div class="announcement-death-big">💀 ${data.deathInfo.playerName} was killed during the night</div>`;
                playerDeathAnnouncement.style.display = 'block';

                // Show center announcement ONLY for reconnecting players (and not if voting just completed)
                if (wasReconnecting) {
                    showCenterAnnouncement(`${data.deathInfo.playerName} was killed during the night`, 'death');
                }
            } else if (data.deathInfo && !data.deathInfo.died) {
                playerDeathAnnouncement.innerHTML = '<div class="announcement-safe-big">✅ No one died during the night</div>';
                playerDeathAnnouncement.style.display = 'block';

                // Show center announcement ONLY for reconnecting players (and not if voting just completed)
                if (wasReconnecting) {
                    showCenterAnnouncement('No one died during the night', 'safe');
                }
            } else {
                playerDeathAnnouncement.style.display = 'none';
            }

            updatePlayerStatusGrid(data.players);
        } else {
            switchScreen(spectatorScreen);
            updateSpectatorView(data);
        }

        // Clear reconnecting flag after processing day phase
        if (wasReconnecting) {
            isReconnecting = false;
        }
    } else if (data.phase === 'tentativeVoting' || data.phase === 'finalVoting' || data.phase === 'tieRevote') {
        const isTentative = data.phase === 'tentativeVoting';
        const isRevote = data.phase === 'tieRevote';
        const isFinalOrRevote = data.phase === 'finalVoting' || isRevote;

        if (isRevote) {
            document.getElementById('votingTitle').textContent = 'Tie Revote';
            document.getElementById('currentPhase').textContent = 'Tie Revote';
        } else {
            document.getElementById('votingTitle').textContent = isTentative ? 'Tentative Voting' : 'Final Voting';
            document.getElementById('currentPhase').textContent = `${isTentative ? 'Tentative' : 'Final'} Voting`;
        }
        document.getElementById('currentPhase').className = 'phase-badge phase-voting';

        // Clear previous voting state when entering new voting phase
        const yourVote = document.getElementById('yourVote');
        if (yourVote) {
            yourVote.textContent = 'Not voted';
        }

        // Clear timer displays from previous voting phase
        const timerDisplay = document.getElementById('timerDisplay');
        const playerTimerDisplay = document.getElementById('playerTimerDisplay');

        if (timerDisplay) {
            timerDisplay.textContent = '';
            timerDisplay.classList.remove('timer-warning');
            timerDisplay.style.display = 'none';
        }
        if (playerTimerDisplay) {
            playerTimerDisplay.textContent = '';
            playerTimerDisplay.classList.remove('timer-warning');
        }

        // Reset vote received display for new voting phase
        const myVotesReceived = document.getElementById('myVotesReceived');
        if (myVotesReceived) {
            myVotesReceived.style.display = 'none';
        }

        if (isHost) {
            switchScreen(godScreen);
            showGodControls('voting');
            updateGodPlayerGrid(data.players);

            // Clear vote results for new voting phase
            const voteResults = document.getElementById('voteResults');
            voteResults.innerHTML = '<h4>Waiting for votes...</h4>';

            // Show/hide buttons based on voting phase
            const btnStartFinalVoting = document.getElementById('btnStartFinalVoting');
            const btnEndVoting = document.getElementById('btnEndVoting');
            const btnStartTimer = document.getElementById('btnStartTimer');
            const timerDisplay = document.getElementById('timerDisplay');
            const btnExtendTimer = document.getElementById('btnExtendTimer');

            if (isFinalOrRevote) {
                // In final voting or revote: hide start final voting, show end voting (initially disabled)
                if (btnStartFinalVoting) btnStartFinalVoting.style.display = 'none';
                if (btnEndVoting) {
                    btnEndVoting.style.display = 'block';
                    btnEndVoting.disabled = true;
                    btnEndVoting.textContent = 'End Voting & Eliminate (Waiting for all votes...)';
                }
                // Show start timer button, hide timer display and extend button initially
                if (btnStartTimer) btnStartTimer.style.display = 'inline-block';
                if (timerDisplay) timerDisplay.style.display = 'none';
                if (btnExtendTimer) btnExtendTimer.style.display = 'none';
            } else {
                // In tentative voting: show start final voting, hide end voting and timer controls
                if (btnStartFinalVoting) btnStartFinalVoting.style.display = 'block';
                if (btnEndVoting) btnEndVoting.style.display = 'none';
                if (btnStartTimer) btnStartTimer.style.display = 'none';
                if (timerDisplay) timerDisplay.style.display = 'none';
                if (btnExtendTimer) btnExtendTimer.style.display = 'none';
            }
        } else if (isAlive) {
            switchScreen(votingScreen);
            if (isRevote && data.tiedCandidates) {
                updateVotingGridRevote(data.players, data.tiedCandidates);
            } else {
                updateVotingGrid(data.players);
            }
        } else {
            switchScreen(spectatorScreen);
            updateSpectatorView(data);
        }
    }
});

socket.on('nightActionUpdate', (data) => {
    if (!isHost) return;

    if (data.action === 'mafia') {
        const selection = document.getElementById('mafiaKillSelection');
        selection.innerHTML = '<p>Select player to kill:</p>';
        data.players.forEach(player => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-sm btn-danger';
            btn.textContent = `${player.name}${player.isDisconnected ? ' ⚠️' : ''}`;
            btn.title = player.isDisconnected ? 'Player is offline but can still be targeted' : '';
            btn.onclick = () => socket.emit('godMarkKill', player.id);
            selection.appendChild(btn);
        });
        selection.style.display = 'block';
    } else if (data.action === 'doctor') {
        const selection = document.getElementById('doctorSaveSelection');
        selection.innerHTML = '<p>Select player to save:</p>';
        data.players.forEach(player => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-sm btn-success';
            btn.textContent = `${player.name}${player.isDisconnected ? ' ⚠️' : ''}`;
            btn.title = player.isDisconnected ? 'Player is offline but can still be targeted' : '';
            btn.onclick = () => socket.emit('godMarkSave', player.id);
            selection.appendChild(btn);
        });
        selection.style.display = 'block';
    } else if (data.action === 'detective') {
        const selection = document.getElementById('detectiveInvestSelection');
        selection.innerHTML = '<p>Select player to investigate:</p>';
        data.players.forEach(player => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-sm btn-primary';
            btn.textContent = `${player.name}${player.isDisconnected ? ' ⚠️' : ''}`;
            btn.title = player.isDisconnected ? 'Player is offline but can still be targeted' : '';
            btn.onclick = () => socket.emit('godInvestigate', player.id);
            selection.appendChild(btn);
        });
        selection.style.display = 'block';
    }
});

socket.on('killMarked', (data) => {
    if (!isHost) return;
    const selection = document.getElementById('mafiaKillSelection');
    selection.innerHTML = `<p class="marked">✓ Marked ${data.playerName} for kill</p>`;
});

socket.on('saveMarked', (data) => {
    if (!isHost) return;
    const selection = document.getElementById('doctorSaveSelection');
    selection.innerHTML = `<p class="marked">✓ Marked ${data.playerName} for save</p>`;
});

socket.on('investigationResult', (data) => {
    if (!isHost) return;
    const result = document.getElementById('investigationResult');
    result.innerHTML = `<p><strong>${data.playerName}</strong> is ${data.isMafia ? '🔪 MAFIA' : '✅ NOT MAFIA'}</p>`;
    result.className = `investigation-result ${data.isMafia ? 'is-mafia' : 'not-mafia'}`;
    result.style.display = 'block';
});

socket.on('timerUpdate', (data) => {
    const minutes = Math.floor(data.remaining / 60);
    const seconds = data.remaining % 60;
    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    const timerDisplay = document.getElementById('timerDisplay');
    const playerTimerDisplay = document.getElementById('playerTimerDisplay');

    if (timerDisplay) {
        timerDisplay.textContent = `Time remaining: ${timeStr}`;
        if (data.remaining < 30) {
            timerDisplay.classList.add('timer-warning');
        }
    }

    if (playerTimerDisplay) {
        playerTimerDisplay.textContent = `Time remaining: ${timeStr}`;
        if (data.remaining < 30) {
            playerTimerDisplay.classList.add('timer-warning');
        }
    }
});

socket.on('voteUpdate', (data) => {
    // Store vote details globally
    currentVoteDetails = data.voteDetails || {};

    if (isHost) {
        const voteResults = document.getElementById('voteResults');

        // Calculate voting progress - include ALL alive players (even disconnected)
        const alivePlayers = allPlayers.filter(p => p.isAlive && p.role !== 'God');
        const totalVoters = alivePlayers.length;
        const votedCount = Object.keys(currentVoteDetails).reduce((sum, targetId) => {
            return sum + (currentVoteDetails[targetId] ? currentVoteDetails[targetId].length : 0);
        }, 0);

        // Show which players haven't voted (including disconnected status)
        const votedPlayerIds = new Set();
        Object.values(currentVoteDetails).forEach(voters => {
            voters.forEach(voter => votedPlayerIds.add(voter.voterId));
        });

        const notVotedPlayers = alivePlayers.filter(p => !votedPlayerIds.has(p.id));
        const notVotedHTML = notVotedPlayers.length > 0
            ? `<div class="not-voted-list">
                <p style="font-weight: bold; margin-bottom: 8px;">Waiting for votes from:</p>
                ${notVotedPlayers.map(p => `
                    <span class="not-voted-player">
                        ${p.name}
                        ${p.isDisconnected ? '<span class="disconnected-badge">⚠️ Offline</span>' : ''}
                    </span>
                `).join('')}
            </div>`
            : '';

        voteResults.innerHTML = `
            <h4>Current Votes:</h4>
            <div class="vote-progress">
                <span class="vote-progress-text">${votedCount} / ${totalVoters} players voted</span>
                <div class="vote-progress-bar">
                    <div class="vote-progress-fill" style="width: ${(votedCount / totalVoters) * 100}%"></div>
                </div>
            </div>
            ${notVotedHTML}
        `;

        data.voteCounts.forEach(v => {
            const div = document.createElement('div');
            div.className = 'vote-count-item';
            div.innerHTML = `<strong>${v.playerName}</strong>: ${v.count} votes`;
            voteResults.appendChild(div);
        });

        // Update end voting button state if in final voting or revote
        const btnEndVoting = document.getElementById('btnEndVoting');
        if (btnEndVoting && (currentPhase === 'finalVoting' || currentPhase === 'tieRevote')) {
            const allVoted = votedCount === totalVoters && totalVoters > 0;
            if (allVoted) {
                btnEndVoting.disabled = false;
                btnEndVoting.textContent = 'End Voting & Eliminate';
                if (!btnEndVoting.classList.contains('btn-ready-pulse')) {
                    btnEndVoting.classList.add('btn-ready-pulse');
                }
            } else {
                btnEndVoting.disabled = true;
                btnEndVoting.textContent = `End Voting & Eliminate (${votedCount}/${totalVoters} voted)`;
                btnEndVoting.classList.remove('btn-ready-pulse');
            }
        }
    }

    // Update vote counts on voting cards for all players
    if (!isHost && isAlive) {
        // Create a map of playerId to vote count
        const voteCountMap = {};
        data.voteCounts.forEach(v => {
            voteCountMap[v.playerId] = v.count;
        });

        // Update all voting cards
        const votingCards = document.querySelectorAll('.voting-card');
        votingCards.forEach(card => {
            const playerId = card.dataset.playerId;
            if (playerId && voteCountMap[playerId]) {
                // Update or add vote count badge
                let badge = card.querySelector('.vote-count-badge');
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'vote-count-badge';
                    card.appendChild(badge);
                }
                badge.textContent = `${voteCountMap[playerId]} votes`;
                badge.style.display = 'block';
            } else {
                // Hide badge if no votes
                const badge = card.querySelector('.vote-count-badge');
                if (badge) {
                    badge.style.display = 'none';
                }
            }
        });

        // Check if I have already voted by looking through all votes in voteDetails
        // Find who I voted for
        let myVotedTarget = null;
        for (const [targetId, voters] of Object.entries(currentVoteDetails)) {
            if (voters.find(v => v.voterId === myPlayerId)) {
                myVotedTarget = targetId;
                break;
            }
        }

        const yourVote = document.getElementById('yourVote');
        if (myVotedTarget) {
            const targetPlayer = allPlayers.find(p => p.id === myVotedTarget);
            if (yourVote && targetPlayer) {
                yourVote.textContent = targetPlayer.name;
            }

            // Highlight the voted card
            votingCards.forEach(card => {
                if (card.dataset.playerId === myVotedTarget) {
                    card.classList.add('selected');
                } else {
                    card.classList.remove('selected');
                }
            });
        } else {
            // Reset vote display when no vote is found
            if (yourVote) {
                yourVote.textContent = 'Not voted';
            }
            votingCards.forEach(card => card.classList.remove('selected'));
        }

        // Show votes received by me
        const myVotesReceived = document.getElementById('myVotesReceived');
        const myVotesCount = document.getElementById('myVotesCount');
        const myVotersList = document.getElementById('myVotersList');

        if (myVotesReceived && myVotesCount && myVotersList) {
            // Get votes I received with enhanced defensive checks
            const myVoters = (currentVoteDetails && currentVoteDetails[myPlayerId])
                ? currentVoteDetails[myPlayerId]
                : [];
            const myVoteCount = myVoters.length;

            if (myVoteCount > 0) {
                myVotesReceived.style.display = 'block';
                myVotesCount.textContent = myVoteCount;

                // Show list of who voted for me
                myVotersList.innerHTML = '';
                myVoters.forEach(voter => {
                    const voterItem = document.createElement('div');
                    voterItem.className = 'my-voter-item';
                    voterItem.innerHTML = `<span class="voter-icon">👤</span> <span class="voter-name">${voter.voterName}</span>`;
                    myVotersList.appendChild(voterItem);
                });
            } else {
                myVotesReceived.style.display = 'none';
            }
        }
    }

    if (data.voterId === myPlayerId && data.targetName) {
        const yourVote = document.getElementById('yourVote');
        if (yourVote) {
            yourVote.textContent = data.targetName;
        }
    }
});

socket.on('voteResult', (data) => {
    let message = '';
    let messageType = 'death';
    if (data.eliminated.length === 0) {
        message = 'No one was eliminated';
        messageType = 'safe';
    } else if (data.eliminated.length === 1) {
        message = `${data.eliminated[0].playerName} was eliminated due to majority voting`;
    } else {
        if (data.reason === 'tie_max_revotes') {
            message = `${data.eliminated.map(e => e.playerName).join(' and ')} were eliminated (tie after max revotes)`;
        } else {
            message = `${data.eliminated.map(e => e.playerName).join(' and ')} were eliminated (tie)`;
        }
    }

    // Show center announcement
    showCenterAnnouncement(message, messageType);
});

socket.on('tieRevote', (data) => {
    const names = data.tiedCandidates.map(c => c.playerName).join(' and ');
    showNotification(`Tie between ${names}! Revote round ${data.revoteCount}`);
});

socket.on('allPlayersVoted', (data) => {
    if (!isHost) return;

    // Enable the end voting button for final voting and revote
    const btnEndVoting = document.getElementById('btnEndVoting');
    if (btnEndVoting && (data.phase === 'finalVoting' || data.phase === 'tieRevote')) {
        btnEndVoting.disabled = false;
        btnEndVoting.textContent = 'End Voting & Eliminate';
        btnEndVoting.classList.add('btn-ready-pulse');
    }

    // Show prominent notification to host
    showHostPrompt(data.message, data.phase);
});

socket.on('timerExpiredNotAllVoted', (data) => {
    if (!isHost) return;

    showNotification(`Timer expired! ${data.votedCount}/${data.totalPlayers} players have voted. Waiting for remaining players...`, 'warning');
});

socket.on('historyUpdate', (history) => {
    const historyLog = document.getElementById('historyLog');
    const spectatorHistory = document.getElementById('spectatorHistory');
    const finalHistory = document.getElementById('finalHistory');

    // Show history in chronological order (oldest first)
    // For collapsed history log, show last 15 items
    const historyForLog = history.slice(-15).map(event => `
        <div class="history-item history-${event.type}">
            <span class="history-round">R${event.round}</span>
            <span class="history-desc">${event.description}</span>
        </div>
    `).join('');

    // For final history (game over screen), show all events
    const historyForFinal = history.map(event => `
        <div class="history-item history-${event.type}">
            <span class="history-round">R${event.round}</span>
            <span class="history-desc">${event.description}</span>
        </div>
    `).join('');

    if (historyLog) historyLog.innerHTML = historyForLog;
    if (spectatorHistory) spectatorHistory.innerHTML = historyForLog;
    if (finalHistory) finalHistory.innerHTML = historyForFinal;
});

socket.on('gameSettingsUpdate', (settings) => {
    currentGameSettings = settings;

    if (currentPhase !== 'lobby' && !isAlive && !isHost) {
        updateSpectatorViewVisibility();
    }

    const chkLobby = document.getElementById('chkAllowSpectatorView');
    const chkGame = document.getElementById('chkAllowSpectatorViewGame');
    if (chkLobby) chkLobby.checked = settings.allowSpectatorView;
    if (chkGame) chkGame.checked = settings.allowSpectatorView;
});

socket.on('gameOver', (data) => {
    // Release wake lock when game is over
    releaseWakeLock();

    switchScreen(gameOverScreen);

    const winnerAnnouncement = document.getElementById('winnerAnnouncement');

    let winHTML;
    if (data.winner === 'draw') {
        winHTML = '<h2 class="winner-draw">🤝 GAME IS A DRAW! 🤝</h2>';
    } else if (data.winner === 'mafia') {
        winHTML = '<h2 class="winner-mafia">🔪 MAFIA WINS! 🔪</h2>';
    } else {
        winHTML = '<h2 class="winner-villagers">✅ VILLAGERS WIN! ✅</h2>';
    }

    // Add reason if provided
    if (data.reason) {
        winHTML += `<p class="win-reason">${data.reason}</p>`;
    }

    winnerAnnouncement.innerHTML = winHTML;

    const finalRoles = document.getElementById('finalRoles');
    finalRoles.innerHTML = '<h3>Final Roles</h3>';
    data.players.forEach(player => {
        const div = document.createElement('div');
        div.className = `final-role-item ${player.isAlive ? 'alive' : 'dead'}`;
        div.innerHTML = `
            <span>${getRoleEmoji(player.role)} ${player.name}</span>
            <span class="role-badge role-${player.role.toLowerCase()}">${player.role}</span>
            <span>${player.isAlive ? '✅ Alive' : '💀 Dead'}</span>
        `;
        finalRoles.appendChild(div);
    });

    // Show appropriate controls based on host status
    const hostNewGameControls = document.getElementById('hostNewGameControls');
    const playerWaitingMsg = document.getElementById('playerWaitingMsg');
    const oldBtnNewGame = document.getElementById('btnNewGame');

    // Hide old button
    if (oldBtnNewGame) {
        oldBtnNewGame.style.display = 'none';
    }

    if (isHost) {
        // Host sees button to return to lobby
        if (hostNewGameControls) hostNewGameControls.style.display = 'block';
        if (playerWaitingMsg) playerWaitingMsg.style.display = 'none';
    } else {
        // Other players see waiting message
        if (hostNewGameControls) hostNewGameControls.style.display = 'none';
        if (playerWaitingMsg) playerWaitingMsg.style.display = 'block';
    }
});

socket.on('hostTransferred', (data) => {
    // Update isHost status
    if (data.newHostId === myPlayerId) {
        isHost = true;
        showNotification(`You are now the host (God)!`);

        // Update host display for all screens
        updateHostDisplay();

        // If in game, switch to god screen
        if (gameStarted && currentPhase !== 'lobby') {
            switchScreen(godScreen);
            if (currentPhase === 'night') {
                showGodControls('night');
            } else if (currentPhase === 'day') {
                showGodControls('day');
            } else if (currentPhase === 'tentativeVoting' || currentPhase === 'finalVoting') {
                showGodControls('voting');
            }
            updateGodPlayerGrid(allPlayers);
        }
    } else if (data.oldHostId === myPlayerId) {
        isHost = false;
        showNotification(`${data.newHostName} is now the host`);

        // Update host display - remove host controls
        updateHostDisplay();

        // If was in god screen, switch to appropriate player screen
        if (currentPhase === 'night') {
            switchScreen(playerNightScreen);
        } else if (currentPhase === 'day') {
            switchScreen(playerDayScreen);
        } else if (currentPhase === 'tentativeVoting' || currentPhase === 'finalVoting') {
            switchScreen(votingScreen);
        }
    } else {
        showNotification(`${data.newHostName} is now the host`);
        updateHostDisplay();
    }
});

socket.on('notification', (data) => {
    showNotification(data.message, data.type);
});

socket.on('gameReset', () => {
    myRole = null;
    isAlive = true;
    gameStarted = false;
    currentPhase = 'lobby';
    myMafiaTeam = [];

    // Release wake lock when game ends
    releaseWakeLock();

    // Reset game settings to default
    currentGameSettings = { allowSpectatorView: false };

    // Reset checkboxes
    const chkLobby = document.getElementById('chkAllowSpectatorView');
    const chkGame = document.getElementById('chkAllowSpectatorViewGame');
    if (chkLobby) chkLobby.checked = false;
    if (chkGame) chkGame.checked = false;

    // Reset role reveal state
    roleRevealed = false;
    hasSeenRole = false;
    playerReady = false;

    // Clear any player readiness display (for host)
    const playerReadinessGrid = document.getElementById('playerReadinessGrid');
    if (playerReadinessGrid) {
        playerReadinessGrid.innerHTML = '';
    }

    // Call the centralized UI reset function
    resetRoleScreenUI();

    switchScreen(lobbyScreen);
    updatePlayerNameBadge(); // Hide badge in lobby
    updateHostDisplay(); // Update settings panel visibility
    showNotification('Returned to lobby. Host can start a new game!');
});

socket.on('gameAlreadyStarted', () => {
    const savedName = localStorage.getItem('mafiaGamePlayerName');

    if (savedName && reconnectSection) {
        // Show reconnect section if we have a saved name
        reconnectSection.style.display = 'block';
        reconnectPlayerNameSpan.textContent = savedName;
        showNotification('Game in progress. Use the reconnect button below.', 'info');
    } else {
        showNotification('Game already in progress. Please wait for next round.', 'warning');
    }
});

socket.on('gamePaused', (data) => {
    // Show pause overlay
    const pauseOverlay = document.createElement('div');
    pauseOverlay.id = 'pauseOverlay';
    pauseOverlay.className = 'pause-overlay';
    pauseOverlay.innerHTML = `
        <div class="pause-content">
            <h2>⏸️ Game Paused</h2>
            <p>${data.message}</p>
            <p class="waiting-text">Waiting for ${data.hostName} to reconnect...</p>
            <div class="loading-spinner"></div>
        </div>
    `;
    document.body.appendChild(pauseOverlay);
});

socket.on('gameResumed', () => {
    // Remove pause overlay
    const pauseOverlay = document.getElementById('pauseOverlay');
    if (pauseOverlay) {
        pauseOverlay.remove();
    }
    showNotification('Host reconnected! Game resumed.');
});

socket.on('playerReadyUpdate', (data) => {
    if (!isHost) return;

    // Update readiness grid
    const grid = document.getElementById('playerReadinessGrid');
    grid.innerHTML = '';

    data.players.forEach(player => {
        let statusClass = 'not-ready';
        let icon = '⏳';
        let statusText = 'Waiting...';

        if (player.isReady) {
            statusClass = 'ready';
            icon = '✅';
            statusText = 'Ready!';
        } else if (player.hasSeenRole) {
            statusClass = 'viewed';
            icon = '👁️';
            statusText = 'Viewed role';
        }

        const card = document.createElement('div');
        card.className = `readiness-card ${statusClass}`;
        card.innerHTML = `
            <span class="readiness-icon">${icon}</span>
            <span class="player-name">${player.name}</span>
            <span class="readiness-status">${statusText}</span>
        `;
        grid.appendChild(card);
    });

    // Update count display
    const readyCountDisplay = document.getElementById('readyCountDisplay');
    if (readyCountDisplay) {
        readyCountDisplay.textContent = `${data.readyCount}/${data.totalPlayers}`;
    }

    // Enable/disable start button based on whether all players are ready
    const btnStartNightPhase = document.getElementById('btnStartNightPhase');
    const startButtonNote = document.getElementById('startButtonNote');

    if (btnStartNightPhase) {
        if (data.allReady) {
            // All players are ready - enable button and animate
            btnStartNightPhase.disabled = false;
            btnStartNightPhase.textContent = '🎮 Everyone Is Ready! Start Night Phase';
            btnStartNightPhase.classList.add('all-ready-pulse');

            if (startButtonNote) {
                startButtonNote.textContent = 'All players are ready! You can start now.';
                startButtonNote.style.color = '#22c55e';
            }
        } else {
            // Not everyone is ready - disable button
            btnStartNightPhase.disabled = true;
            btnStartNightPhase.textContent = 'Start Night Phase';
            btnStartNightPhase.classList.remove('all-ready-pulse');

            if (startButtonNote) {
                startButtonNote.textContent = `Button will enable when all players click "I'm Ready" (${data.readyCount}/${data.totalPlayers} ready)`;
                startButtonNote.style.color = '#64748b';
            }
        }
    }
});

socket.on('error', (message) => {
    showNotification(message);
});

// Enhanced reconnection handling for mobile devices
socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    stopHeartbeat(); // Stop heartbeat when disconnected

    // Don't immediately kick to join screen - show reconnecting message
    if (reason === 'io server disconnect') {
        // Server forcefully disconnected - likely kicked out
        showNotification('Disconnected from server. Please rejoin.', 'error');
        setTimeout(() => switchScreen(joinScreen), 3000);
    } else {
        // Network issue or mobile backgrounding - try to reconnect
        showNotification('Connection lost. Reconnecting...', 'warning');

        // Ensure we try to reconnect
        setTimeout(() => {
            if (!socket.connected) {
                console.log('Manual reconnection attempt...');
                socket.connect();
            }
        }, 1000);
    }
});

socket.on('connect', () => {
    console.log('Connected to server:', socket.id);
    startHeartbeat(); // Start heartbeat when connected

    // If we have player info, this is a reconnection
    if (myPlayerName && gameStarted) {
        console.log('Reconnecting as', myPlayerName);
        showNotification('Connection established!', 'success');
    }
});

socket.on('reconnect_attempt', (attemptNumber) => {
    console.log('Reconnection attempt:', attemptNumber);
    if (attemptNumber % 5 === 1) { // Show notification every 5 attempts
        showNotification(`Reconnecting... (attempt ${attemptNumber})`, 'info');
    }
});

socket.on('reconnect', (attemptNumber) => {
    console.log('Reconnected after', attemptNumber, 'attempts');
    showNotification('Reconnected successfully!', 'success');
    startHeartbeat(); // Ensure heartbeat is running

    // Re-sync with server if we were in a game
    if (myPlayerName && myPlayerId) {
        // Server will automatically handle reconnection via joinedGame event
        console.log('Reconnected as', myPlayerName);
    }
});

socket.on('reconnect_error', (error) => {
    console.log('Reconnection error:', error);
});

socket.on('reconnect_failed', () => {
    console.log('Reconnection failed after all attempts');
    showNotification('Could not reconnect. Please refresh and rejoin.', 'error');
    stopHeartbeat();
    setTimeout(() => switchScreen(joinScreen), 5000);
});

// Handle heartbeat acknowledgment
socket.on('heartbeat_ack', (data) => {
    // Connection is alive and healthy
    console.log('Heartbeat acknowledged');

    // Notify worker of heartbeat acks
    if (connectionWorker) {
        connectionWorker.postMessage({ type: 'HEARTBEAT_ACK' });
    }
});

// Helper Functions
function showGodControls(phase) {
    const nightControls = document.getElementById('nightControls');
    const dayControls = document.getElementById('dayControls');
    const votingControls = document.getElementById('votingControls');

    nightControls.style.display = 'none';
    dayControls.style.display = 'none';
    votingControls.style.display = 'none';

    if (phase === 'night') {
        nightControls.style.display = 'block';
    } else if (phase === 'day') {
        dayControls.style.display = 'block';
    } else if (phase === 'voting') {
        votingControls.style.display = 'block';
    }
}

function updateGodPlayerGrid(players) {
    const grid = document.getElementById('godPlayerGrid');
    grid.innerHTML = '';

    // Only show playing players (exclude God/host)
    const playingPlayers = players.filter(p => p.role !== 'God');

    playingPlayers.forEach(player => {
        const row = document.createElement('div');
        row.className = 'god-player-row';

        const aliveIcon = player.isAlive ? '❤️' : '💀';
        const connectedIcon = player.isDisconnected ? '⚠️' : '🟢';
        const aliveClass = player.isAlive ? 'alive' : 'dead';
        const connectedClass = player.isDisconnected ? 'disconnected' : 'connected';

        row.innerHTML = `
            <span class="player-name-compact">${player.name}</span>
            <span class="player-role-compact role-${player.role.toLowerCase()}">${getRoleEmoji(player.role)} ${player.role}</span>
            <span class="player-alive-icon ${aliveClass}" title="${player.isAlive ? 'Alive' : 'Dead'}">${aliveIcon}</span>
            <span class="player-connection-icon ${connectedClass}" title="${player.isDisconnected ? 'Disconnected' : 'Connected'}">${connectedIcon}</span>
        `;
        grid.appendChild(row);
    });
}

function updatePlayerStatusGrid(players) {
    const grid = document.getElementById('playerStatusGrid');
    grid.innerHTML = '<h3>Player Status</h3>';

    // Only show playing players (exclude God/host)
    const playingPlayers = players.filter(p => p.role !== 'God');

    playingPlayers.forEach(player => {
        const card = document.createElement('div');
        card.className = `player-status-card ${player.isAlive ? 'alive' : 'dead'}`;
        card.innerHTML = `
            <span class="player-name">${player.name}</span>
            <span class="status-icon">${player.isAlive ? '✅' : '💀'}</span>
        `;
        grid.appendChild(card);
    });
}

function updateVotingGrid(players) {
    const grid = document.getElementById('votingGrid');
    grid.innerHTML = '';

    // Show ALL alive players including disconnected (exclude God/host)
    const alivePlayers = players.filter(p => p.isAlive && p.role !== 'God');

    alivePlayers.forEach(player => {
        if (player.id === myPlayerId) return; // Can't vote for yourself

        const card = document.createElement('div');
        card.className = 'voting-card';
        card.dataset.playerId = player.id; // Store player ID for vote count updates
        card.dataset.playerName = player.name;
        card.innerHTML = `
            <div class="voting-player-name">
                ${player.name}
                ${player.isDisconnected ? '<span class="disconnected-badge">⚠️ Offline</span>' : ''}
            </div>
            <button class="view-votes-btn" onclick="event.stopPropagation(); showVoteDetails('${player.id}', '${player.name}')">
                👁️ See Voters
            </button>
        `;
        card.onclick = () => {
            socket.emit('playerVote', player.id);
            // Visual feedback
            document.querySelectorAll('.voting-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
        };
        grid.appendChild(card);
    });
}

function updateVotingGridRevote(players, tiedCandidateIds) {
    const grid = document.getElementById('votingGrid');
    grid.innerHTML = '<div class="revote-notice">⚠️ Vote for one of the tied candidates:</div>';

    // Show tied candidates who are alive (include disconnected, exclude God/host and self)
    const tiedPlayers = players.filter(p => tiedCandidateIds.includes(p.id) && p.isAlive && p.role !== 'God' && p.id !== myPlayerId);

    tiedPlayers.forEach(player => {
        const card = document.createElement('div');
        card.className = 'voting-card voting-card-tied';
        card.dataset.playerId = player.id; // Store player ID for vote count updates
        card.dataset.playerName = player.name;
        card.innerHTML = `
            <div class="voting-player-name">
                ${player.name}
                ${player.isDisconnected ? '<span class="disconnected-badge">⚠️ Offline</span>' : ''}
            </div>
            <div class="tied-badge">TIED</div>
            <button class="view-votes-btn" onclick="event.stopPropagation(); showVoteDetails('${player.id}', '${player.name}')">
                👁️ See Voters
            </button>
        `;
        card.onclick = () => {
            socket.emit('playerVote', player.id);
            // Visual feedback
            document.querySelectorAll('.voting-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
        };
        grid.appendChild(card);
    });
}

function updateSpectatorView(data) {
    document.getElementById('spectatorRole').textContent = `${getRoleEmoji(myRole)} ${myRole}`;
    document.getElementById('spectatorRound').textContent = data.round;

    const grid = document.getElementById('spectatorPlayerGrid');
    grid.innerHTML = '';

    // Only show playing players (exclude God/host)
    const playingPlayers = data.players.filter(p => p.role !== 'God');

    playingPlayers.forEach(player => {
        const card = document.createElement('div');
        card.className = `player-status-card ${player.isAlive ? 'alive' : 'dead'}`;
        card.innerHTML = `
            <span class="player-name">${player.name}</span>
            <span class="status-icon">${player.isAlive ? '✅' : '💀'}</span>
        `;
        grid.appendChild(card);
    });

    updateSpectatorViewVisibility();
}

function updateSpectatorViewVisibility() {
    const fullView = document.getElementById('spectatorFullView');
    const minimalView = document.getElementById('spectatorMinimalView');

    if (currentGameSettings.allowSpectatorView) {
        if (fullView) fullView.style.display = 'block';
        if (minimalView) minimalView.style.display = 'none';
    } else {
        if (fullView) fullView.style.display = 'none';
        if (minimalView) minimalView.style.display = 'block';
    }
}

function showHostTransferModal() {
    const modal = document.getElementById('hostTransferModal');
    const playerList = document.getElementById('hostTransferPlayerList');

    playerList.innerHTML = '';

    // Show all players except current host
    allPlayers.forEach(player => {
        if (player.id !== myPlayerId) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-primary transfer-player-btn';
            btn.textContent = `${player.name} ${player.isAlive ? '✅' : '💀'}`;
            btn.onclick = () => {
                socket.emit('transferHost', player.id);
                hideHostTransferModal();
            };
            playerList.appendChild(btn);
        }
    });

    modal.style.display = 'flex';
}

function hideHostTransferModal() {
    const modal = document.getElementById('hostTransferModal');
    modal.style.display = 'none';
}

function showHostTransferModalLobby() {
    const modal = document.getElementById('hostTransferModalLobby');
    const playerList = document.getElementById('hostTransferPlayerListLobby');

    playerList.innerHTML = '';

    // Show all players except current host
    allPlayers.forEach(player => {
        if (player.id !== myPlayerId) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-primary transfer-player-btn';
            btn.textContent = player.name;
            btn.onclick = () => {
                socket.emit('transferHost', player.id);
                hideHostTransferModalLobby();
            };
            playerList.appendChild(btn);
        }
    });

    modal.style.display = 'flex';
}

function hideHostTransferModalLobby() {
    const modal = document.getElementById('hostTransferModalLobby');
    modal.style.display = 'none';
}

function toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    const header = section.previousElementSibling;
    const icon = header.querySelector('.toggle-icon');

    if (section.classList.contains('collapsed')) {
        section.classList.remove('collapsed');
        icon.textContent = '▼';
    } else {
        section.classList.add('collapsed');
        icon.textContent = '▶';
    }
}

// Make toggleSection available globally
window.toggleSection = toggleSection;

function showVoteDetails(playerId, playerName) {
    const modal = document.getElementById('voteDetailsModal');
    const playerNameDisplay = document.getElementById('voteDetailsPlayerName');
    const voteList = document.getElementById('voteDetailsList');

    playerNameDisplay.textContent = `Votes for ${playerName}`;

    // Get voters for this player
    const voters = currentVoteDetails[playerId] || [];

    if (voters.length === 0) {
        voteList.innerHTML = '<p class="no-votes">No votes yet for this player</p>';
    } else {
        voteList.innerHTML = '';
        voters.forEach(voter => {
            const voterItem = document.createElement('div');
            voterItem.className = 'voter-item';
            voterItem.innerHTML = `
                <span class="voter-icon">👤</span>
                <span class="voter-name">${voter.voterName}</span>
            `;
            voteList.appendChild(voterItem);
        });
    }

    modal.style.display = 'flex';
}

function hideVoteDetails() {
    const modal = document.getElementById('voteDetailsModal');
    modal.style.display = 'none';
}

function showResetConfirmation() {
    const modal = document.getElementById('resetGameModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

function hideResetConfirmation() {
    const modal = document.getElementById('resetGameModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Make functions available globally
window.showVoteDetails = showVoteDetails;
window.hideVoteDetails = hideVoteDetails;
window.showResetConfirmation = showResetConfirmation;
window.hideResetConfirmation = hideResetConfirmation;

// Add close button handler
const btnCloseVoteDetails = document.getElementById('btnCloseVoteDetails');
if (btnCloseVoteDetails) {
    btnCloseVoteDetails.addEventListener('click', hideVoteDetails);
}

// Close modal when clicking outside
const voteDetailsModal = document.getElementById('voteDetailsModal');
if (voteDetailsModal) {
    voteDetailsModal.addEventListener('click', (e) => {
        if (e.target === voteDetailsModal) {
            hideVoteDetails();
        }
    });
}

const resetGameModal = document.getElementById('resetGameModal');
if (resetGameModal) {
    resetGameModal.addEventListener('click', (e) => {
        if (e.target === resetGameModal) {
            hideResetConfirmation();
        }
    });
}

function updatePlayerNameBadge() {
    const badge = document.getElementById('playerNameBadge');
    const nameSpan = document.getElementById('currentPlayerName');

    if (myPlayerName && badge && nameSpan) {
        nameSpan.textContent = myPlayerName;

        // Show badge only during game, not in lobby or join screen
        if (currentPhase !== 'lobby' && gameStarted) {
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

function updateHostDisplay() {
    const hostBadge = document.getElementById('hostBadge');
    const hostInfo = document.getElementById('hostInfo');
    const hostNameDisplay = document.getElementById('hostNameDisplay');
    const startBtn = document.getElementById('startBtn');
    const resetBtn = document.getElementById('resetBtn');
    const btnTransferHostLobby = document.getElementById('btnTransferHostLobby');
    const gameSettingsPanel = document.getElementById('gameSettingsPanel');

    // Find the current host
    const currentHost = allPlayers.find(p => p.isHost);

    if (isHost) {
        // You are the host
        if (hostBadge) hostBadge.style.display = 'inline-block';
        if (hostInfo) hostInfo.style.display = 'none';

        // Show host controls
        if (startBtn) startBtn.style.display = 'block';
        if (resetBtn) resetBtn.style.display = 'block';
        if (btnTransferHostLobby) btnTransferHostLobby.style.display = 'block';

        // Show settings panel in lobby
        if (gameSettingsPanel && currentPhase === 'lobby') {
            gameSettingsPanel.style.display = 'block';
        }
    } else {
        // You are not the host
        if (hostBadge) hostBadge.style.display = 'none';

        // Show host name to other players
        if (currentHost && hostInfo && hostNameDisplay) {
            hostNameDisplay.textContent = currentHost.name;
            hostInfo.style.display = 'block';
        } else if (hostInfo) {
            hostInfo.style.display = 'none';
        }

        // Hide host controls
        if (startBtn) startBtn.style.display = 'none';
        if (resetBtn) resetBtn.style.display = 'none';
        if (btnTransferHostLobby) btnTransferHostLobby.style.display = 'none';
        if (gameSettingsPanel) gameSettingsPanel.style.display = 'none';
    }
}

// Track game started state
let gameStarted = false;

// Store current vote details
let currentVoteDetails = {};

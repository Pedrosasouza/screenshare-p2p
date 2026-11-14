import {
    isDesktopApp,
    forwardPcmBufferToWorklet,
    prepareHelperAudioWorklet,
    checkDiscordStatus,
    fetchWindowList,
    updateAudioAppSelect,
    startDesktopCaptureWith,
    startAppAudioCapture,
    startExcludeDiscordCapture,
    stopAppAudioCapture,
    registerDesktopCaptureListeners
} from './js/modules/desktop-audio.js';
import { sanitizeRoomId, generateRandomRoomId } from './js/modules/room-utils.js';
import {
    SERVER_URL_STORAGE_KEY,
    COLD_START_NOTICE_DELAY_MS,
    SESSION_PASS_STORAGE_KEY,
    resolveSignalingServerUrl,
    saveSessionRoomPassword,
    getSessionRoomPassword,
    clearSessionRoomPassword
} from './js/modules/signaling-url.js';
import {
    THEME_KEY,
    setSignalingStatus,
    getOrCreateToastContainer,
    showToast,
    playPresenceChime,
    initTheme,
    applyTheme,
    toggleTheme
} from './js/modules/ui-feedback.js';
import { prioritizeH264, prioritizePreferredVideoCodecs, optimizeSDP } from './js/modules/sdp.js';
import { getVideoConstraints, getMaxBitrateForPeerCount, collectPeerTelemetry } from './js/modules/qos.js';
import {
    registerFullscreenChangeHandler,
    disposeTileElement,
    toggleTileFullscreen,
    enterPseudoFullscreen,
    showTapToUnmuteBadge
} from './js/modules/tile-dom.js';
import {
    rtcConfig,
    refreshIceServers,
    scheduleIceRefreshTimer,
    stopIceRefreshTimer,
    getActiveIceProvider,
    getIceProviderDisplayLabel
} from './js/modules/ice-config.js';



if (isDesktopApp()) {
    checkDiscordStatus();
    fetchWindowList();
    registerDesktopCaptureListeners((payload) => {
        if (typeof showToast === 'function') {
            const detail = payload && payload.reason ? ` (${payload.reason})` : '';
            showToast(`Captura de áudio do aplicativo interrompida${detail}.`, 'warning', 5000);
        }
    }).catch(() => {});
    window.addEventListener('beforeunload', () => {
        if (window.StreamGridDesktop) {
            window.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
        }
    });
}

const SERVER_URL = resolveSignalingServerUrl();

const socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 30,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 5000,
    timeout: 20000
});

let coldStartTimer = null;
let hasShownColdStartToast = false;

function scheduleColdStartNotice() {
    if ((socket && socket.connected) || coldStartTimer !== null || hasShownColdStartToast) {
        return;
    }
    coldStartTimer = setTimeout(() => {
        coldStartTimer = null;
        if (socket && socket.connected) return;
        if (typeof hasShownConnectErrorToast !== 'undefined' && hasShownConnectErrorToast) return;
        hasShownColdStartToast = true;
        if (typeof setSignalingStatus === 'function') {
            setSignalingStatus('waking');
        }
        if (typeof showToast === 'function') {
            showToast('Acordando servidor de sinalização... isso pode levar alguns segundos.', 'info', 6000);
        }
    }, COLD_START_NOTICE_DELAY_MS);
}

function cancelColdStartNotice() {
    if (coldStartTimer !== null) {
        clearTimeout(coldStartTimer);
        coldStartTimer = null;
    }
}

if (typeof setSignalingStatus === 'function') {
    setSignalingStatus(socket && socket.connected ? 'connected' : 'connecting');
}
scheduleColdStartNotice();

// Map of remote peers: peerId -> { pc, stream, tileEl, iceCandidateQueue, isRemoteDescriptionSet }
const peers = new Map();
const activeRoomPeers = new Set();
const recentlyRemovedPeers = new Map();
let hasRoomMembershipSnapshot = false;

if (typeof refreshIceServers === 'function') {
    refreshIceServers(SERVER_URL, { peers });
}

// Application State
const STORAGE_KEY = 'streamgrid_last_room';
const CLIENT_ID_KEY = 'streamgrid_client_id';
const USERNAME_KEY = 'streamgrid_username';

let currentUserName = '';
try {
    currentUserName = (localStorage.getItem(USERNAME_KEY) || '').trim().slice(0, 24);
} catch (_) {}

let clientId = '';
try {
    clientId = localStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
        clientId = 'c_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
} catch(e) {
    clientId = 'c_' + Math.random().toString(36).substr(2, 9);
}

let roomId = '';
let pendingRoomJoin = null;
let myId = '';
let localStream = null;

// DOM Elements - Room Modal & Views
const roomModal = document.getElementById('roomModal');
const roomErrorBanner = document.getElementById('roomErrorBanner');
const btnCloseRoomModal = document.getElementById('btnCloseRoomModal');
const btnCancelRoomModal = document.getElementById('btnCancelRoomModal');
const roomChoiceCancelContainer = document.getElementById('roomChoiceCancelContainer');

// Subviews
const roomViewChoice = document.getElementById('roomViewChoice');
const roomViewCreate = document.getElementById('roomViewCreate');
const roomViewJoin = document.getElementById('roomViewJoin');

// Choice View Elements
const btnChooseCreate = document.getElementById('btnChooseCreate');
const btnChooseJoin = document.getElementById('btnChooseJoin');

// Create View Elements
const inputCreateUserName = document.getElementById('inputCreateUserName');
const inputCreateRoomId = document.getElementById('inputCreateRoomId');
const inputCreateRoomPassword = document.getElementById('inputCreateRoomPassword');
const btnRandomRoom = document.getElementById('btnRandomRoom');
const btnGenerateRandomQuick = document.getElementById('btnGenerateRandomQuick');
const btnToggleCreatePass = document.getElementById('btnToggleCreatePass');
const createRoomStatusIndicator = document.getElementById('createRoomStatusIndicator');
const btnConfirmCreate = document.getElementById('btnConfirmCreate');
const btnBackFromCreate = document.getElementById('btnBackFromCreate');

// Join View Elements
const inputJoinUserName = document.getElementById('inputJoinUserName');
const inputJoinRoomId = document.getElementById('inputJoinRoomId');
const inputJoinRoomPassword = document.getElementById('inputJoinRoomPassword');
const btnToggleJoinPass = document.getElementById('btnToggleJoinPass');
const joinRoomStatusIndicator = document.getElementById('joinRoomStatusIndicator');
const joinPasswordHint = document.getElementById('joinPasswordHint');
const btnConfirmJoin = document.getElementById('btnConfirmJoin');
const btnBackFromJoin = document.getElementById('btnBackFromJoin');

// Header Info & Actions
const btnChangeRoom = document.getElementById('btnChangeRoom');
const displayRoomId = document.getElementById('displayRoomId');
const memberCountText = document.getElementById('memberCountText');
const btnCopyLink = document.getElementById('btnCopyLink');

let currentRoomPassword = '';

const streamGrid = document.getElementById('streamGrid');
const emptyGridPlaceholder = document.getElementById('emptyGridPlaceholder');
const activeStreamsText = document.getElementById('activeStreamsText');

const btnStartShare = document.getElementById('btnStartShare');
const btnStartShareBig = document.getElementById('btnStartShareBig');
const btnStopShare = document.getElementById('btnStopShare');
const btnQualityToggle = document.getElementById('btnQualityToggle');
const qualityModeLabel = document.getElementById('qualityModeLabel');

// Quality mode: 'motion' = fluid 60fps (gaming), 'detail' = sharp text/UI (Tibia, documents)
let contentHintMode = 'motion';

// ==========================================
// Toast Notification System
// ==========================================

// ==========================================
// Subtle Audio Chime for Presence (Web Audio API)
// ==========================================

const btnThemeToggle = document.getElementById('btnThemeToggle');

// Theme Management (Light / Dark)

if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', toggleTheme);
}
initTheme();

// Error Banner Helpers

function showRoomError(msg) {
    if (!roomErrorBanner) return;
    roomErrorBanner.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> <span></span>';
    const span = roomErrorBanner.querySelector('span');
    if (span) span.textContent = msg || '';
    roomErrorBanner.style.display = 'flex';
    roomErrorBanner.hidden = false;
}

function clearRoomError() {
    if (!roomErrorBanner) return;
    roomErrorBanner.innerHTML = '';
    roomErrorBanner.style.display = 'none';
    roomErrorBanner.hidden = true;
}

// Password Visibility Toggle Helpers
function setupPasswordToggle(btn, input) {
    if (!btn || !input) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.innerHTML = isPassword 
            ? '<i class="fa-solid fa-eye-slash"></i>' 
            : '<i class="fa-solid fa-eye"></i>';
    });
}
setupPasswordToggle(btnToggleCreatePass, inputCreateRoomPassword);
setupPasswordToggle(btnToggleJoinPass, inputJoinRoomPassword);

// Cryptographically Secure Unique Room Generator (e.g. grid-m8kp-7x9v - 850+ billion combinations)

// Subview Switcher
function switchRoomView(viewName) {
    clearRoomError();
    if (roomViewChoice) {
        roomViewChoice.style.display = (viewName === 'choice') ? 'block' : 'none';
        roomViewChoice.hidden = (viewName !== 'choice');
    }
    if (roomViewCreate) {
        roomViewCreate.style.display = (viewName === 'create') ? 'block' : 'none';
        roomViewCreate.hidden = (viewName !== 'create');
    }
    if (roomViewJoin) {
        roomViewJoin.style.display = (viewName === 'join') ? 'block' : 'none';
        roomViewJoin.hidden = (viewName !== 'join');
    }

    if (viewName === 'choice') {
        updateRoomModalCloseButton();
    } else if (viewName === 'create') {
        if (inputCreateUserName && currentUserName) inputCreateUserName.value = currentUserName;
        if (inputCreateRoomId && !inputCreateRoomId.value.trim()) {
            rollRandomCreateRoom();
        } else if (inputCreateRoomId) {
            checkCreateRoomStatus(inputCreateRoomId.value);
        }
        setTimeout(() => {
            if (inputCreateRoomId) {
                inputCreateRoomId.focus();
                inputCreateRoomId.select();
            }
        }, 50);
    } else if (viewName === 'join') {
        if (inputJoinUserName && currentUserName) inputJoinUserName.value = currentUserName;
        if (inputJoinRoomId) checkJoinRoomStatus(inputJoinRoomId.value);
        setTimeout(() => {
            if (inputJoinRoomId) {
                inputJoinRoomId.focus();
                if (inputJoinRoomId.value) inputJoinRoomId.select();
            }
        }, 50);
    }
}

// Real-time Room Existence Checker for Create View
let checkCreateTimeout = null;
function checkCreateRoomStatus(roomIdToCheck) {
    if (!createRoomStatusIndicator) return;
    const cleanId = (roomIdToCheck || '').trim().toLowerCase();
    if (!cleanId || cleanId.length < 3) {
        createRoomStatusIndicator.textContent = '';
        createRoomStatusIndicator.className = 'room-status-indicator';
        return;
    }

    if (socket && socket.connected) {
        socket.emit('check-room', { roomId: cleanId }, (res) => {
            if (!res) return;
            if (res.exists) {
                createRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Sala já existe (${res.memberCount} online)`;
                createRoomStatusIndicator.className = 'room-status-indicator active';
            } else {
                createRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-sparkles"></i> Código disponível!`;
                createRoomStatusIndicator.className = 'room-status-indicator new';
            }
        });
    }
}

// Real-time Room Existence Checker for Join View
let checkJoinTimeout = null;
function checkJoinRoomStatus(roomIdToCheck) {
    if (!joinRoomStatusIndicator) return;
    const cleanId = (roomIdToCheck || '').trim().toLowerCase();
    if (!cleanId || cleanId.length < 3) {
        joinRoomStatusIndicator.textContent = '';
        joinRoomStatusIndicator.className = 'room-status-indicator';
        if (joinPasswordHint) {
            joinPasswordHint.textContent = '';
            joinPasswordHint.className = 'password-hint';
        }
        return;
    }

    if (socket && socket.connected) {
        socket.emit('check-room', { roomId: cleanId }, (res) => {
            if (!res) return;
            if (res.exists) {
                const count = res.memberCount;
                const lockBadge = res.hasPassword ? ' &bull; <i class="fa-solid fa-lock" title="Protegida por senha"></i> Com senha' : '';
                joinRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-circle-check"></i> Sala ativa (${count} ${count === 1 ? 'pessoa' : 'pessoas'})${lockBadge}`;
                joinRoomStatusIndicator.className = 'room-status-indicator active';
                if (joinPasswordHint) {
                    if (res.hasPassword) {
                        joinPasswordHint.innerHTML = '<i class="fa-solid fa-lock"></i> Requer senha';
                        joinPasswordHint.className = 'password-hint required';
                    } else {
                        joinPasswordHint.innerHTML = 'Sem senha (Pública)';
                        joinPasswordHint.className = 'password-hint optional';
                    }
                }
            } else {
                joinRoomStatusIndicator.innerHTML = `<i class="fa-solid fa-circle-info"></i> Sala vazia (será criada ao entrar)`;
                joinRoomStatusIndicator.className = 'room-status-indicator new';
                if (joinPasswordHint) {
                    joinPasswordHint.innerHTML = 'Opcional (Deixe em branco p/ pública)';
                    joinPasswordHint.className = 'password-hint optional';
                }
            }
        });
    }
}

function rollRandomCreateRoom() {
    clearRoomError();
    const uniqueId = generateRandomRoomId();
    if (inputCreateRoomId) {
        inputCreateRoomId.value = uniqueId;
        checkCreateRoomStatus(uniqueId);
    }
}

// Choice View Listeners
if (btnChooseCreate) {
    btnChooseCreate.addEventListener('click', () => switchRoomView('create'));
}
if (btnChooseJoin) {
    btnChooseJoin.addEventListener('click', () => switchRoomView('join'));
}

// Create View Listeners
if (inputCreateUserName) {
    if (currentUserName) inputCreateUserName.value = currentUserName;
    inputCreateUserName.addEventListener('input', (e) => {
        currentUserName = e.target.value.trim().slice(0, 24);
        try { localStorage.setItem(USERNAME_KEY, currentUserName); } catch (_) {}
        if (inputJoinUserName) inputJoinUserName.value = e.target.value;
    });
}
if (btnRandomRoom) {
    btnRandomRoom.addEventListener('click', rollRandomCreateRoom);
}
if (btnGenerateRandomQuick) {
    btnGenerateRandomQuick.addEventListener('click', rollRandomCreateRoom);
}
if (inputCreateRoomId) {
    inputCreateRoomId.addEventListener('input', () => {
        clearRoomError();
        clearTimeout(checkCreateTimeout);
        checkCreateTimeout = setTimeout(() => {
            checkCreateRoomStatus(inputCreateRoomId.value);
        }, 250);
    });
    inputCreateRoomId.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmCreate();
    });
}
if (inputCreateRoomPassword) {
    inputCreateRoomPassword.addEventListener('input', clearRoomError);
    inputCreateRoomPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmCreate();
    });
}
if (btnConfirmCreate) {
    btnConfirmCreate.addEventListener('click', handleConfirmCreate);
}
if (btnBackFromCreate) {
    btnBackFromCreate.addEventListener('click', () => switchRoomView('choice'));
}

// Join View Listeners
if (inputJoinUserName) {
    if (currentUserName) inputJoinUserName.value = currentUserName;
    inputJoinUserName.addEventListener('input', (e) => {
        currentUserName = e.target.value.trim().slice(0, 24);
        try { localStorage.setItem(USERNAME_KEY, currentUserName); } catch (_) {}
        if (inputCreateUserName) inputCreateUserName.value = e.target.value;
    });
}
if (inputJoinRoomId) {
    inputJoinRoomId.addEventListener('input', () => {
        clearRoomError();
        clearTimeout(checkJoinTimeout);
        checkJoinTimeout = setTimeout(() => {
            checkJoinRoomStatus(inputJoinRoomId.value);
        }, 250);
    });
    inputJoinRoomId.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmJoin();
    });
}
if (inputJoinRoomPassword) {
    inputJoinRoomPassword.addEventListener('input', clearRoomError);
    inputJoinRoomPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleConfirmJoin();
    });
}
if (btnConfirmJoin) {
    btnConfirmJoin.addEventListener('click', handleConfirmJoin);
}
if (btnBackFromJoin) {
    btnBackFromJoin.addEventListener('click', () => switchRoomView('choice'));
}

function handleConfirmCreate() {
    clearRoomError();
    const rawName = inputCreateUserName ? inputCreateUserName.value.trim().slice(0, 24) : '';
    if (rawName) {
        currentUserName = rawName;
        try { localStorage.setItem(USERNAME_KEY, currentUserName); } catch (_) {}
    }
    const raw = inputCreateRoomId ? inputCreateRoomId.value : '';
    let newRoomId;
    if (!raw.trim()) {
        newRoomId = generateRandomRoomId();
    } else {
        newRoomId = sanitizeRoomId(raw);
        if (newRoomId.length < 3) {
            showRoomError('Nome de sala inválido. Use pelo menos 3 caracteres alfanuméricos.');
            if (inputCreateRoomId) inputCreateRoomId.focus();
            return;
        }
    }
    if (inputCreateRoomId) inputCreateRoomId.value = newRoomId;
    const pass = (inputCreateRoomPassword ? inputCreateRoomPassword.value.trim() : '');
    joinRoom(newRoomId, pass, currentUserName);
}

function handleConfirmJoin() {
    clearRoomError();
    const rawName = inputJoinUserName ? inputJoinUserName.value.trim().slice(0, 24) : '';
    if (rawName) {
        currentUserName = rawName;
        try { localStorage.setItem(USERNAME_KEY, currentUserName); } catch (_) {}
    }
    const rawRoom = inputJoinRoomId ? inputJoinRoomId.value : '';
    const newRoomId = sanitizeRoomId(rawRoom);
    if (!newRoomId || newRoomId.length < 3) {
        showRoomError('Por favor, informe um código de sala válido (mínimo de 3 caracteres alfanuméricos).');
        if (inputJoinRoomId) inputJoinRoomId.focus();
        return;
    }
    const pass = (inputJoinRoomPassword ? inputJoinRoomPassword.value.trim() : '');
    joinRoom(newRoomId, pass, currentUserName);
}

// Auto populate room code from URL params or localStorage
window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    if (typeof loadSavedClientPreferences === 'function') {
        loadSavedClientPreferences();
    }
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    const rawHash = (window.location.hash || '').replace(/^#/, '');
    const hashParams = new URLSearchParams(rawHash);
    const hashPass = hashParams.get('pass');
    const queryPass = urlParams.get('pass');
    const passParam = hashPass !== null ? hashPass : queryPass;

    if ((hashPass !== null || queryPass !== null) && window.history && window.history.replaceState) {
        try {
            urlParams.delete('pass');
            hashParams.delete('pass');
            const remainingQuery = urlParams.toString();
            const remainingHash = hashParams.toString();
            const cleanUrl = `${window.location.pathname}${remainingQuery ? '?' + remainingQuery : ''}${remainingHash ? '#' + remainingHash : ''}`;
            window.history.replaceState(window.history.state || {}, '', cleanUrl);
        } catch (_) {}
    }

    if (passParam) {
        if (inputCreateRoomPassword) inputCreateRoomPassword.value = passParam;
        if (inputJoinRoomPassword) inputJoinRoomPassword.value = passParam;
    }

    let savedRoom = null;
    try { savedRoom = localStorage.getItem(STORAGE_KEY); } catch(e) {}

    if (roomParam) {
        const clean = sanitizeRoomId(roomParam);
        if (inputJoinRoomId) inputJoinRoomId.value = clean;
        if (clean.length >= 3) {
            const restoredPass = passParam || (typeof getSessionRoomPassword === 'function' ? getSessionRoomPassword(clean) : '');
            joinRoom(clean, restoredPass);
        } else {
            openRoomModal('join');
            showRoomError('Código de sala na URL inválido.');
        }
    } else if (savedRoom) {
        const clean = sanitizeRoomId(savedRoom);
        if (inputJoinRoomId) inputJoinRoomId.value = clean;
        if (clean.length >= 3) {
            const restoredPass = typeof getSessionRoomPassword === 'function' ? getSessionRoomPassword(clean) : '';
            joinRoom(clean, restoredPass);
        } else {
            try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
            openRoomModal('choice');
        }
    } else {
        openRoomModal('choice');
    }
});

function cleanupRoomState(options = {}) {
    const silentShareStop = options && options.silent !== undefined ? Boolean(options.silent) : true;
    console.log('[Room] Cleaning up previous room peer connections and stream tiles...');

    // 1. Stop local screen share if active (silently on room switch to avoid leaking offers/stream-state into new room)
    if (localStream) {
        stopScreenShare({ silent: silentShareStop });
    }

    // 2. Terminate and cleanup all active WebRTC peer connections from old room
    for (const [peerId, peerObj] of peers.entries()) {
        try {
            clearPeerTimers(peerObj);
            if (peerObj.pc) {
                peerObj.pc.close();
            }
            if (peerObj.tileEl) {
                disposeTileElement(peerObj.tileEl);
            }
        } catch (e) {
            console.warn('[Room] Error closing peer:', peerId, e);
        }
    }
    peers.clear();
    if (typeof activeRoomPeers !== 'undefined') activeRoomPeers.clear();
    if (typeof recentlyRemovedPeers !== 'undefined') recentlyRemovedPeers.clear();
    remoteActiveStreams.clear();
    updateEchoWarningVisibility();

    // 3. Remove all remote stream tiles from DOM
    const remoteTiles = streamGrid.querySelectorAll('.stream-tile:not(#localStreamTile)');
    remoteTiles.forEach(tile => tile.remove());

    // 4. Reset participant count and grid state
    updateMemberCount(1);
    updateGridState();
    if (typeof updateBackgroundTracksOptimization === 'function') {
        updateBackgroundTracksOptimization();
    }
}

function joinRoom(targetRoomId, targetPass = '', targetUserName = '') {
    clearRoomError();
    const cleanId = sanitizeRoomId(targetRoomId) || generateRandomRoomId();
    if (cleanId.length < 3) {
        openRoomModal('join');
        showRoomError('O código da sala deve ter pelo menos 3 caracteres alfanuméricos.');
        return;
    }
    const newRoomId = cleanId;
    const pendingPassword = (targetPass || '').trim();
    if (targetUserName) {
        currentUserName = targetUserName.trim().slice(0, 24);
        try { localStorage.setItem(USERNAME_KEY, currentUserName); } catch (_) {}
    }

    pendingRoomJoin = {
        roomId: newRoomId,
        password: pendingPassword,
        userName: currentUserName
    };

    if (socket && socket.connected) {
        socket.emit('join-room', {
            roomId: pendingRoomJoin.roomId,
            clientId,
            password: pendingRoomJoin.password,
            userName: pendingRoomJoin.userName
        });
    } else if (typeof showToast === 'function') {
        showToast('Conectando ao servidor... Você entrará na sala automaticamente.', 'info', 3500);
    }
}

// Room Modal Open / Close Helpers
function openRoomModal(initialView = 'choice') {
    clearRoomError();
    updateRoomModalCloseButton();
    switchRoomView(initialView);
    roomModal.style.removeProperty('display');
    roomModal.style.display = 'flex';
    roomModal.classList.remove('hidden');
    roomModal.hidden = false;
}

function updateRoomModalCloseButton() {
    const canClose = Boolean(roomId);
    if (btnCloseRoomModal) {
        btnCloseRoomModal.style.display = canClose ? 'flex' : 'none';
    }
    if (btnCancelRoomModal) {
        btnCancelRoomModal.style.display = canClose ? 'inline-flex' : 'none';
    }
    if (roomChoiceCancelContainer) {
        roomChoiceCancelContainer.style.display = canClose ? 'block' : 'none';
    }
}

function closeRoomModal() {
    if (!roomId) return; // Cannot close if not connected to any room yet
    clearRoomError();
    roomModal.style.display = 'none';
    roomModal.classList.add('hidden');
    roomModal.hidden = true;
}

if (btnCloseRoomModal) {
    btnCloseRoomModal.addEventListener('click', closeRoomModal);
}
if (btnCancelRoomModal) {
    btnCancelRoomModal.addEventListener('click', closeRoomModal);
}

// Close room modal on backdrop click if already connected to a room
roomModal.addEventListener('click', (e) => {
    if (e.target === roomModal && roomId) {
        closeRoomModal();
    }
});

// Change Room Button Handler
if (btnChangeRoom) {
    btnChangeRoom.addEventListener('click', () => {
        openRoomModal('choice');
    });
}

let wasSocketDisconnected = false;
let hasShownConnectErrorToast = false;

// Socket Lifecycle Events
socket.on('connect', () => {
    myId = socket.id;
    if (typeof cancelColdStartNotice === 'function') {
        cancelColdStartNotice();
    }
    if (typeof setSignalingStatus === 'function') {
        setSignalingStatus('connected');
    }
    if (typeof refreshIceServers === 'function') {
        refreshIceServers(SERVER_URL, { peers });
        if (typeof scheduleIceRefreshTimer === 'function') {
            scheduleIceRefreshTimer(SERVER_URL, { peers });
        }
    }
    console.log('[Socket] Connected to server. Socket ID:', myId);
    if (typeof wasSocketDisconnected !== 'undefined' && wasSocketDisconnected) {
        wasSocketDisconnected = false;
        if (typeof hasShownConnectErrorToast !== 'undefined') {
            hasShownConnectErrorToast = false;
        }
        if (typeof showToast === 'function') {
            showToast('Reconectado ao servidor de sinalização.', 'success', 3000);
        }
    } else if (typeof hasShownConnectErrorToast !== 'undefined' && hasShownConnectErrorToast) {
        hasShownConnectErrorToast = false;
        if (typeof showToast === 'function') {
            showToast('Conectado ao servidor de sinalização.', 'success', 3000);
        }
    }
    if (pendingRoomJoin) {
        console.log('[Socket] Joining pending room on connect:', pendingRoomJoin.roomId);
        socket.emit('join-room', {
            roomId: pendingRoomJoin.roomId,
            clientId,
            password: pendingRoomJoin.password,
            userName: pendingRoomJoin.userName
        });
    } else if (roomId) {
        console.log('[Socket] Joining room on connect:', roomId);
        socket.emit('join-room', { roomId, clientId, password: currentRoomPassword, userName: currentUserName });
    }
});

socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected from server:', reason);
    if (typeof setSignalingStatus === 'function') {
        setSignalingStatus(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    }
    if (reason !== 'io client disconnect') {
        if (typeof wasSocketDisconnected !== 'undefined') {
            wasSocketDisconnected = true;
        }
        if (typeof showToast === 'function') {
            showToast('Conexão com o servidor perdida. Tentando reconectar...', 'warning', 5000);
        }
    }
});

socket.on('connect_error', (err) => {
    if (typeof cancelColdStartNotice === 'function') {
        cancelColdStartNotice();
    }
    if (typeof setSignalingStatus === 'function') {
        setSignalingStatus('offline');
    }
    console.warn('[Socket] Connection error:', err && err.message ? err.message : err);
    if (typeof hasShownConnectErrorToast === 'undefined' || !hasShownConnectErrorToast) {
        if (typeof hasShownConnectErrorToast !== 'undefined') {
            hasShownConnectErrorToast = true;
        }
        if (typeof showToast === 'function') {
            showToast('Não foi possível conectar ao servidor. Tentando novamente...', 'error', 5000);
        }
    }
});

// Authentication and Room Error Handler
socket.on('join-error', ({ error, message }) => {
    console.warn('[Auth] Join error:', error, message);
    const failedRoomId = (pendingRoomJoin && pendingRoomJoin.roomId) || roomId || '';
    pendingRoomJoin = null;

    openRoomModal('join');
    if (error === 'invalid_password') {
        if (typeof clearSessionRoomPassword === 'function') {
            clearSessionRoomPassword();
        }
        if (inputJoinRoomId) inputJoinRoomId.value = failedRoomId;
        showRoomError(message || 'Senha incorreta para esta sala.');
        if (inputJoinRoomPassword) {
            inputJoinRoomPassword.focus();
            inputJoinRoomPassword.select();
        }
    } else if (error === 'invalid_room' || error === 'invalid_password_format') {
        if (typeof clearSessionRoomPassword === 'function') {
            clearSessionRoomPassword();
        }
        if (!roomId || failedRoomId === roomId) {
            roomId = '';
            currentRoomPassword = '';
            try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
            if (window.history && window.history.replaceState) {
                try { window.history.replaceState({}, '', window.location.pathname); } catch(e) {}
            }
            updateRoomModalCloseButton();
        }
        showRoomError(message || 'Código de sala ou formato inválido.');
    } else if (error === 'rate_limited') {
        if (inputJoinRoomId) inputJoinRoomId.value = failedRoomId;
        showRoomError(message || 'Muitas tentativas incorretas. Aguarde antes de tentar novamente.');
    } else {
        showRoomError(message || 'Erro ao entrar na sala.');
    }
});

// Socket Events
socket.on('room-users', async ({ users, userNames, activeStreams, socketId, memberCount, hasPassword }) => {
    myId = socketId;
    if (typeof refreshIceServers === 'function' && typeof SERVER_URL !== 'undefined') {
        await Promise.race([
            refreshIceServers(SERVER_URL, { peers }),
            new Promise((resolve) => setTimeout(resolve, 1200))
        ]);
        if (typeof scheduleIceRefreshTimer === 'function') {
            scheduleIceRefreshTimer(SERVER_URL, { peers });
        }
    }
    if (pendingRoomJoin) {
        const target = pendingRoomJoin;
        pendingRoomJoin = null;

        if (roomId && roomId !== target.roomId) {
            cleanupRoomState();
        }

        roomId = target.roomId;
        currentRoomPassword = target.password;

        if (currentRoomPassword) {
            if (typeof saveSessionRoomPassword === 'function') {
                saveSessionRoomPassword(roomId, currentRoomPassword);
            }
        } else if (typeof clearSessionRoomPassword === 'function') {
            clearSessionRoomPassword();
        }

        try { localStorage.setItem(STORAGE_KEY, roomId); } catch(e) {}
        if (window.location.protocol.startsWith('http') && window.history.pushState) {
            try {
                const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
                window.history.pushState({ path: newUrl }, '', newUrl);
            } catch(e) {}
        }

        closeRoomModal();
        updateRoomModalCloseButton();
    }

    console.log('[Socket] Joined room. My ID:', myId, 'Other users:', users, 'Active streams:', activeStreams);
    remoteActiveStreams.clear();
    if (Array.isArray(activeStreams)) {
        activeStreams.forEach(id => { if (id !== myId) remoteActiveStreams.add(id); });
    }
    updateEchoWarningVisibility();

    const activeUserSet = new Set((Array.isArray(users) ? users : []).filter(id => id && id !== myId));
    if (typeof hasRoomMembershipSnapshot !== 'undefined') hasRoomMembershipSnapshot = true;
    if (typeof activeRoomPeers !== 'undefined') {
        activeRoomPeers.clear();
        activeUserSet.forEach((id) => activeRoomPeers.add(id));
    }
    if (typeof recentlyRemovedPeers !== 'undefined') {
        activeUserSet.forEach((id) => recentlyRemovedPeers.delete(id));
    }

    // Reconcile stale peers that left while disconnected (even without pendingRoomJoin)
    for (const existingPeerId of Array.from(peers.keys())) {
        if (!activeUserSet.has(existingPeerId)) {
            removePeerConnection(existingPeerId);
        }
    }

    // Sync member count immediately for the joiner
    updateMemberCount(memberCount || (activeUserSet.size + 1));

    displayRoomId.textContent = roomId;
    if (hasPassword) {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-lock';
        icon.style.fontSize = '0.75rem';
        icon.style.marginLeft = '4px';
        icon.title = 'Sala protegida por senha';
        displayRoomId.appendChild(icon);
    }

    // Initialize peer connections for existing users
    activeUserSet.forEach(peerId => {
        getOrCreatePeerConnection(peerId);
        if (userNames && userNames[peerId]) {
            updatePeerUserName(peerId, userNames[peerId]);
        }
    });

    // If I am currently sharing screen, send offer with my tracks to all peers
    if (localStream) {
        for (const [peerId, peerObj] of peers.entries()) {
            addLocalTracksToPC(peerObj.pc);
            sendOffer(peerId);
        }
        updateSendersForActivePeers();
    }
});

socket.on('user-joined', async ({ socketId, userName, memberCount }) => {
    if (!socketId || (myId && socketId === myId)) return;
    console.log('[Socket] User joined:', socketId, userName);
    const displayName = userName || 'Um participante';
    showToast(`${displayName} entrou na sala.`, 'info');
    playPresenceChime('join');
    updateMemberCount(memberCount);
    if (typeof activeRoomPeers !== 'undefined') activeRoomPeers.add(socketId);
    if (typeof recentlyRemovedPeers !== 'undefined') recentlyRemovedPeers.delete(socketId);
    const pc = getOrCreatePeerConnection(socketId);
    const peerObj = peers.get(socketId);
    if (userName) updatePeerUserName(socketId, userName);

    // Sincronização Automática (Late-Joiner Sync):
    // Se eu já estiver compartilhando a tela, envio oferta com minha transmissão ao novo usuário!
    if (localStream) {
        addLocalTracksToPC(pc);
        sendOffer(socketId);
        updateSendersForActivePeers();

        // Pulso inicial de Keyframe: assegura envio de IDR frame assim que o recém-chegado negociar
        if (peerObj) {
            if (peerObj._keyframePulseTimeout) clearTimeout(peerObj._keyframePulseTimeout);
            peerObj._keyframePulseTimeout = setTimeout(() => {
                peerObj._keyframePulseTimeout = null;
                if (!isPeerConnectionActive(socketId, peerObj, pc) || !localStream) return;
                const vTrack = localStream.getVideoTracks()[0];
                if (!vTrack) return;
                const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (vSender) {
                    try { Promise.resolve(vSender.replaceTrack(vTrack)).catch(() => {}); } catch (e) {}
                }
            }, 400);
        }
    }
});

socket.on('user-left', ({ socketId, memberCount }) => {
    remoteActiveStreams.delete(socketId);
    updateEchoWarningVisibility();
    console.log('[Socket] User left:', socketId);
    const peerObj = peers.get(socketId);
    const displayName = (peerObj && peerObj.userName) || 'Um participante';
    showToast(`${displayName} saiu da sala.`, 'info');
    playPresenceChime('leave');
    if (typeof activeRoomPeers !== 'undefined') activeRoomPeers.delete(socketId);
    if (typeof recentlyRemovedPeers !== 'undefined' && socketId) {
        recentlyRemovedPeers.set(socketId, Date.now());
    }
    removePeerConnection(socketId);
    updateMemberCount(memberCount);
    if (localStream) {
        updateSendersForActivePeers();
    }
});

socket.on('room-status', ({ memberCount }) => {
    updateMemberCount(memberCount);
});

function updateMemberCount(count) {
    memberCountText.textContent = `${count} ${count === 1 ? 'Participante' : 'Participantes'}`;
}

function isPeerConnectionActive(peerId, peerObj, pc) {
    return Boolean(
        peerId &&
        peerObj &&
        pc &&
        peers.get(peerId) === peerObj &&
        pc.signalingState !== 'closed' &&
        pc.connectionState !== 'closed'
    );
}

// Perfect Negotiation Offer Dispatcher (Avoids Glare / Dual-Offer collisions)
async function sendOffer(peerId) {
    const peerObj = peers.get(peerId);
    if (!peerObj || !peerObj.pc) return;
    const pc = peerObj.pc;

    if (!isPeerConnectionActive(peerId, peerObj, pc)) return;

    // Guard: Queue pendingOffer instead of silently dropping renegotiations during glare/unstable states
    if (peerObj.makingOffer || pc.signalingState !== 'stable') {
        peerObj.pendingOffer = true;
        console.warn(`[WebRTC] Enfileirando oferta pendente para ${peerId} (makingOffer: ${peerObj.makingOffer}, signalingState: ${pc.signalingState})`);
        return;
    }

    try {
        peerObj.makingOffer = true;
        peerObj.pendingOffer = false;
        let offer = await pc.createOffer();
        if (!isPeerConnectionActive(peerId, peerObj, pc) || pc.signalingState !== 'stable') {
            peerObj.pendingOffer = true;
            return;
        }
        offer = new RTCSessionDescription({
            type: offer.type,
            sdp: optimizeSDP(offer.sdp)
        });
        await pc.setLocalDescription(offer);
        if (!isPeerConnectionActive(peerId, peerObj, pc)) return;
        socket.emit('signal', { targetId: peerId, signal: pc.localDescription });
    } catch (err) {
        console.error('[WebRTC] Error sending offer to peer:', peerId, err);
    } finally {
        peerObj.makingOffer = false;
        if (peerObj.pendingOffer && isPeerConnectionActive(peerId, peerObj, pc) && pc.signalingState === 'stable') {
            peerObj.pendingOffer = false;
            Promise.resolve().then(() => sendOffer(peerId));
        }
    }
}

// Targeted WebRTC Signal Receiver with Perfect Negotiation & Candidate Queueing
socket.on('signal', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { senderId, signal } = payload;
    if (!senderId || typeof senderId !== 'string') return;
    if (!signal || typeof signal !== 'object') return;
    if (myId && senderId === myId) return;

    if (typeof recentlyRemovedPeers !== 'undefined' && recentlyRemovedPeers.has(senderId)) {
        return;
    }
    if (
        typeof hasRoomMembershipSnapshot !== 'undefined' &&
        hasRoomMembershipSnapshot &&
        !peers.has(senderId) &&
        typeof activeRoomPeers !== 'undefined' &&
        !activeRoomPeers.has(senderId)
    ) {
        return;
    }

    if (signal.type === 'request-keyframe' && !peers.has(senderId)) {
        return;
    }

    const pc = getOrCreatePeerConnection(senderId);
    const peerObj = peers.get(senderId);
    if (!isPeerConnectionActive(senderId, peerObj, pc)) return;

    const runSignalTask = async () => {
        if (!isPeerConnectionActive(senderId, peerObj, pc)) return;

        if (signal.type === 'offer') {
            // Check for offer collision (glare)
            const offerCollision = Boolean(peerObj.makingOffer || pc.signalingState !== 'stable');
            peerObj.ignoreOffer = !peerObj.isPolite && offerCollision;

            if (peerObj.ignoreOffer) {
                console.warn('[WebRTC] Glare collision: Impolite peer ignoring offer from:', senderId);
                return;
            }

            if (offerCollision) {
                console.log('[WebRTC] Glare collision: Polite peer rolling back for:', senderId);
                peerObj.iceCandidateQueue = [];
                try {
                    await pc.setLocalDescription({ type: 'rollback' });
                } catch (e) {
                    console.warn('[WebRTC] Rollback error:', e);
                }
                if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
            }

            const prevRemoteSet = Boolean(
                peerObj.isRemoteDescriptionSet &&
                pc.remoteDescription &&
                pc.remoteDescription.type
            );
            peerObj.isRemoteDescriptionSet = false;
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
            } catch (err) {
                peerObj.isRemoteDescriptionSet = Boolean(
                    prevRemoteSet && pc.remoteDescription && pc.remoteDescription.type
                );
                throw err;
            }
            if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
            peerObj.isRemoteDescriptionSet = true;

            // Flush buffered candidates
            while (peerObj.iceCandidateQueue.length > 0) {
                if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                const cand = peerObj.iceCandidateQueue.shift();
                try { await pc.addIceCandidate(cand); } catch(e) {}
            }
            if (!isPeerConnectionActive(senderId, peerObj, pc)) return;

            // If I am broadcasting, ensure my tracks are attached to this peer connection
            if (localStream && typeof addLocalTracksToPC === 'function') {
                addLocalTracksToPC(pc);
            }

            let answer = await pc.createAnswer();
            if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
            answer = new RTCSessionDescription({
                type: answer.type,
                sdp: optimizeSDP(answer.sdp)
            });
            await pc.setLocalDescription(answer);
            if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
            socket.emit('signal', { targetId: senderId, signal: pc.localDescription });

            if (peerObj.pendingOffer && pc.signalingState === 'stable' && typeof sendOffer === 'function') {
                peerObj.pendingOffer = false;
                Promise.resolve().then(() => sendOffer(senderId));
            }

        } else if (signal.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                peerObj.ignoreOffer = false;
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                peerObj.isRemoteDescriptionSet = true;
                // Flush buffered candidates
                while (peerObj.iceCandidateQueue.length > 0) {
                    if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                    const cand = peerObj.iceCandidateQueue.shift();
                    try { await pc.addIceCandidate(cand); } catch(e) {}
                }
                if (peerObj.pendingOffer && pc.signalingState === 'stable' && typeof sendOffer === 'function') {
                    peerObj.pendingOffer = false;
                    Promise.resolve().then(() => sendOffer(senderId));
                }
            }
        } else if (signal.candidate) {
            if (peerObj.ignoreOffer) return;
            const candidate = new RTCIceCandidate(signal.candidate);
            if (pc.remoteDescription && pc.remoteDescription.type && peerObj.isRemoteDescriptionSet) {
                try {
                    await pc.addIceCandidate(candidate);
                } catch (err) {
                    console.warn('[WebRTC] Candidate error:', err);
                }
            } else {
                // Buffer candidate until remote description is processed
                peerObj.iceCandidateQueue.push(candidate);
            }
        } else if (signal.type === 'request-keyframe') {
            if (localStream) {
                const videoTrack = localStream.getVideoTracks()[0];
                const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (videoSender && videoTrack) {
                    console.log(`[WebRTC] Peer ${senderId} solicitou keyframe (tela preta). Forçando IDR frame via replaceTrack...`);
                    try { Promise.resolve(videoSender.replaceTrack(videoTrack)).catch(() => {}); } catch (e) {}
                }
            }
        }
    };

    const prevChain = peerObj._signalChain || Promise.resolve();
    peerObj._signalChain = prevChain
        .then(runSignalTask)
        .catch((err) => {
            console.error('[WebRTC] Signal handling error:', err);
        });
});

// Track active remote screen streams for anti-echo detection
const remoteActiveStreams = new Set();

// Broadcast Stream State Changes
socket.on('stream-state', ({ senderId, state }) => {
    if (state === 'started') {
        remoteActiveStreams.add(senderId);
        if (typeof ensureRemoteStreamTile === 'function') {
            ensureRemoteStreamTile(senderId);
        }
    } else {
        remoteActiveStreams.delete(senderId);
        removeStreamTile(senderId);
    }
    updateEchoWarningVisibility();
});

// Diagnóstico e Feedback Visual de Falha de Conexão P2P
function setPeerConnectionStatus(peerId, status, message) {
    const peerObj = peers.get(peerId);
    if (!peerObj || !peerObj.tileEl) return;
    let warningEl = peerObj.tileEl.querySelector('.peer-connection-warning');
    if (status === 'failed') {
        if (!warningEl) {
            warningEl = document.createElement('div');
            warningEl.className = 'peer-connection-warning';
            warningEl.style.position = 'absolute';
            warningEl.style.top = '10px';
            warningEl.style.left = '10px';
            warningEl.style.right = '10px';
            warningEl.style.zIndex = '5';
            warningEl.style.background = 'rgba(239, 68, 68, 0.9)';
            warningEl.style.color = '#fff';
            warningEl.style.padding = '6px 10px';
            warningEl.style.borderRadius = '6px';
            warningEl.style.fontSize = '0.75rem';
            warningEl.style.display = 'flex';
            warningEl.style.alignItems = 'center';
            warningEl.style.gap = '6px';
            const warnIcon = document.createElement('i');
            warnIcon.className = 'fa-solid fa-triangle-exclamation';
            const warnText = document.createElement('span');
            warnText.textContent = message || 'Falha de conexão direta P2P.';
            warningEl.appendChild(warnIcon);
            warningEl.appendChild(warnText);
            peerObj.tileEl.appendChild(warningEl);
        }
    } else if (warningEl) {
        warningEl.remove();
    }
}

async function logPeerConnectionTelemetry(peerId, pc) {
    if (!pc || typeof pc.getStats !== 'function') return;
    try {
        const stats = await pc.getStats();
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                const localCand = stats.get(report.localCandidateId);
                const remoteCand = stats.get(report.remoteCandidateId);
                const localType = localCand ? localCand.candidateType : 'unknown';
                const remoteType = remoteCand ? remoteCand.candidateType : 'unknown';
                console.log(`[WebRTC QoS] Conexão P2P com ${peerId} estabelecida: local=${localType}, remoto=${remoteType}`);
            }
        });
    } catch (_) {}
}

// Otimização de GPU/CPU: pausa decodificação de faixas de vídeo quando janela estiver oculta/minimizada
function updateBackgroundTracksOptimization() {
    const isHidden = typeof document !== 'undefined' && Boolean(document.hidden);
    const activeFsTile = typeof document !== 'undefined'
        ? (document.querySelector('.stream-tile.pseudo-fullscreen') || (document.fullscreenElement && document.fullscreenElement.classList.contains('stream-tile') ? document.fullscreenElement : null))
        : null;
    const activeFsPeerId = activeFsTile ? activeFsTile.dataset.peerId : null;

    for (const [peerId, peerObj] of peers.entries()) {
        if (peerObj.stream) {
            peerObj.stream.getVideoTracks().forEach(track => {
                if (isHidden) {
                    track.enabled = false;
                } else if (activeFsPeerId && peerId !== activeFsPeerId && activeFsPeerId !== 'local') {
                    track.enabled = false;
                } else {
                    track.enabled = true;
                }
            });
        }
    }
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', updateBackgroundTracksOptimization);
    document.addEventListener('fullscreenchange', updateBackgroundTracksOptimization);
}
if (typeof registerFullscreenChangeHandler === 'function') {
    registerFullscreenChangeHandler(updateBackgroundTracksOptimization);
}

// PeerConnection Factory
function getOrCreatePeerConnection(peerId) {
    if (peers.has(peerId)) {
        return peers.get(peerId).pc;
    }

    console.log('[WebRTC] Initializing PeerConnection for:', peerId);
    const pc = new RTCPeerConnection(rtcConfig);

    // Polite Peer Pattern: Deterministic tie-breaker to resolve double-offer glare
    const isPolite = Boolean(myId && peerId && myId < peerId);

    const peerObj = {
        pc,
        stream: new MediaStream(),
        userName: '',
        tileEl: null,
        iceCandidateQueue: [],
        isRemoteDescriptionSet: false,
        isPolite,
        makingOffer: false,
        pendingOffer: false,
        ignoreOffer: false,
        _iceRestartAttempts: 0,
        _signalChain: Promise.resolve()
    };
    peers.set(peerId, peerObj);

    const scheduleIceRestart = () => {
        if (peerObj._iceRestartTimeout || (peerObj._iceRestartAttempts || 0) >= 3) return;
        const delayMs = 2000 * Math.pow(2, peerObj._iceRestartAttempts || 0);
        peerObj._iceRestartTimeout = setTimeout(() => {
            peerObj._iceRestartTimeout = null;
            if (!isPeerConnectionActive(peerId, peerObj, pc)) return;
            const iceFailed = pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected';
            const connFailed = pc.connectionState === 'failed' || pc.connectionState === 'disconnected';
            if (iceFailed || connFailed) {
                peerObj._iceRestartAttempts = (peerObj._iceRestartAttempts || 0) + 1;
                console.log(`[WebRTC] Triggering ICE restart #${peerObj._iceRestartAttempts} for: ${peerId}`);
                if (typeof pc.restartIce === 'function') pc.restartIce();
                sendOffer(peerId);
            }
        }, delayMs);
    };

    // ICE Candidate Handler
    pc.onicecandidate = (event) => {
        if (event.candidate && peers.get(peerId) === peerObj && pc.signalingState !== 'closed' && pc.connectionState !== 'closed') {
            socket.emit('signal', {
                targetId: peerId,
                signal: { candidate: event.candidate }
            });
        }
    };

    // Remote Track Received -> Render & Paint Tile in Grid
    pc.ontrack = (event) => {
        console.log('[WebRTC] Received track from:', peerId, event.track.kind, event.track.id);

        // Remove old track of the same kind from peerObj.stream (without calling .stop() on remote tracks)
        peerObj.stream.getTracks().filter(t => t.kind === event.track.kind).forEach(oldTrack => {
            if (oldTrack.id !== event.track.id) {
                try { peerObj.stream.removeTrack(oldTrack); } catch (e) {}
            }
        });

        if (!peerObj.stream.getTracks().some(t => t.id === event.track.id)) {
            peerObj.stream.addTrack(event.track);
        }

        // Only create visual tile in grid if we actually have a video track (prevents audio-only black screens)
        const hasVideo = peerObj.stream.getVideoTracks().length > 0;
        if (!peerObj.tileEl && hasVideo) {
            const label = peerObj.userName || `Participante ${peerId.substr(0, 5)}`;
            peerObj.tileEl = createStreamTile(peerId, peerObj.stream, label, false);
            streamGrid.appendChild(peerObj.tileEl);
        }

        if (peerObj.tileEl) {
            const videoEl = typeof peerObj.tileEl.querySelector === 'function'
                ? peerObj.tileEl.querySelector('video')
                : null;
            if (videoEl) {
                if (videoEl.srcObject !== peerObj.stream) {
                    videoEl.srcObject = peerObj.stream;
                }
                startTilePlayback(peerObj.tileEl, videoEl);
            }
        }

        event.track.onunmute = () => {
            console.log('[WebRTC] Track unmuted from:', peerId, event.track.kind);
            if (peerObj.tileEl) {
                const videoEl = peerObj.tileEl.querySelector('video');
                if (videoEl) {
                    if (videoEl.srcObject !== peerObj.stream) {
                        videoEl.srcObject = peerObj.stream;
                    }
                    if (videoEl.paused) {
                        videoEl.play().catch(() => {});
                    }
                }
            }
        };

        event.track.onended = () => {
            console.log('[WebRTC] Remote track ended:', peerId, event.track.kind);
            if (event.track.kind === 'video') {
                if (peerObj._keyframeCheckInterval) {
                    clearInterval(peerObj._keyframeCheckInterval);
                    peerObj._keyframeCheckInterval = null;
                }
                removeStreamTile(peerId);
            }
        };

        // Auto-recuperação de tela preta para Late-Joiners:
        // Se a trilha de vídeo foi conectada mas o decodificador está em 0 pixels (esperando Frame-I),
        // solicita ativamente um Keyframe ao transmissor via sinalização.
        if (event.track.kind === 'video') {
            if (peerObj._keyframeCheckInterval) clearInterval(peerObj._keyframeCheckInterval);
            let checkAttempts = 0;
            peerObj._keyframeCheckInterval = setInterval(() => {
                if (!isPeerConnectionActive(peerId, peerObj, pc)) {
                    clearInterval(peerObj._keyframeCheckInterval);
                    peerObj._keyframeCheckInterval = null;
                    return;
                }
                checkAttempts++;
                const v = peerObj.tileEl ? peerObj.tileEl.querySelector('video') : null;
                if (!v || v.videoWidth > 0 || checkAttempts > 5) {
                    clearInterval(peerObj._keyframeCheckInterval);
                    peerObj._keyframeCheckInterval = null;
                    return;
                }
                console.log(`[WebRTC] Vídeo anexado mas 0 frames decodificados (videoWidth: 0). Solicitando keyframe para ${peerId}...`);
                socket.emit('signal', {
                    targetId: peerId,
                    signal: { type: 'request-keyframe' }
                });
            }, 1200);
        }

        updateGridState();
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] ICE state (${peerId}):`, pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            scheduleIceRestart();
            if (pc.iceConnectionState === 'failed') {
                setPeerConnectionStatus(peerId, 'failed', 'Falha de conexão P2P: Firewall ou rede restrita bloqueando tráfego.');
            }
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            peerObj._iceRestartAttempts = 0;
            if (peerObj._iceRestartTimeout) {
                clearTimeout(peerObj._iceRestartTimeout);
                peerObj._iceRestartTimeout = null;
            }
            setPeerConnectionStatus(peerId, 'ok');
            logPeerConnectionTelemetry(peerId, pc);
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
            scheduleIceRestart();
            setPeerConnectionStatus(peerId, 'failed', 'Falha de transporte P2P (DTLS/ICE).');
        } else if (pc.connectionState === 'connected') {
            peerObj._iceRestartAttempts = 0;
            if (peerObj._iceRestartTimeout) {
                clearTimeout(peerObj._iceRestartTimeout);
                peerObj._iceRestartTimeout = null;
            }
            setPeerConnectionStatus(peerId, 'ok');
        }
    };

    return pc;
}

function updatePeerUserName(peerId, userName) {
    if (!userName) return;
    const cleanName = userName.trim().slice(0, 24);
    const peerObj = peers.get(peerId);
    if (!peerObj) return;
    peerObj.userName = cleanName;
    if (peerObj.tileEl) {
        const nameEl = peerObj.tileEl.querySelector('.user-name');
        if (nameEl) nameEl.textContent = cleanName;
    }
}

// Prioritize Universal H.264 Codec (Constrained Baseline 42e01f first for 100% Mobile & PC compatibility)

// Prioritize low-CPU real-time codecs (VP8 -> VP9) ahead of H.264 to avoid software OpenH264 CPU bottlenecks
// in WebView2, while keeping H.264 (Constrained Baseline 42e01f first) as universal fallback.

// SDP Optimization Helper (Unlocks Smooth 1080p60 Bitrate & Stereo Audio without Freezes)

function clearPeerTimers(peerObj) {
    if (!peerObj) return;
    if (peerObj._keyframeCheckInterval) {
        clearInterval(peerObj._keyframeCheckInterval);
        peerObj._keyframeCheckInterval = null;
    }
    if (peerObj._iceRestartTimeout) {
        clearTimeout(peerObj._iceRestartTimeout);
        peerObj._iceRestartTimeout = null;
    }
    if (peerObj._keyframePulseTimeout) {
        clearTimeout(peerObj._keyframePulseTimeout);
        peerObj._keyframePulseTimeout = null;
    }
}

function removePeerConnection(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        clearPeerTimers(peerObj);
        if (peerObj.stream) {
            peerObj.stream.getTracks().forEach(track => track.stop());
        }
        if (peerObj.pc) peerObj.pc.close();
        if (peerObj.tileEl) {
            disposeTileElement(peerObj.tileEl);
        }
        peers.delete(peerId);
        updateGridState();
        if (typeof updateBackgroundTracksOptimization === 'function') {
            updateBackgroundTracksOptimization();
        }
    }
}

function ensureRemoteStreamTile(peerId) {
    const peerObj = peers.get(peerId);
    if (!peerObj) return;
    if (!peerObj.stream) {
        peerObj.stream = new MediaStream();
    }
    if (peerObj.pc && typeof peerObj.pc.getReceivers === 'function') {
        peerObj.pc.getReceivers().forEach((receiver) => {
            const track = receiver && receiver.track;
            if (!track || track.readyState === 'ended') return;
            peerObj.stream.getTracks().filter(t => t.kind === track.kind && t.id !== track.id).forEach(oldTrack => {
                try { peerObj.stream.removeTrack(oldTrack); } catch (e) {}
            });
            if (!peerObj.stream.getTracks().some(t => t.id === track.id)) {
                peerObj.stream.addTrack(track);
            }
        });
    }
    const hasVideo = peerObj.stream.getVideoTracks().length > 0;
    if (!peerObj.tileEl && hasVideo) {
        const label = peerObj.userName || `Participante ${peerId.substr(0, 5)}`;
        peerObj.tileEl = createStreamTile(peerId, peerObj.stream, label, false);
        streamGrid.appendChild(peerObj.tileEl);
    }
    if (peerObj.tileEl) {
        const videoEl = typeof peerObj.tileEl.querySelector === 'function'
            ? peerObj.tileEl.querySelector('video')
            : null;
        if (videoEl) {
            if (videoEl.srcObject !== peerObj.stream) {
                videoEl.srcObject = peerObj.stream;
            }
            startTilePlayback(peerObj.tileEl, videoEl);
        }
    }
    updateGridState();
}

function removeStreamTile(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        if (peerObj._keyframeCheckInterval) {
            clearInterval(peerObj._keyframeCheckInterval);
            peerObj._keyframeCheckInterval = null;
        }
        if (peerObj.tileEl) {
            disposeTileElement(peerObj.tileEl);
            peerObj.tileEl = null;
        }
        // Keep remote receiver tracks alive so subsequent replaceTrack renegotiations work
        peerObj.stream = new MediaStream();
        updateGridState();
        if (typeof updateBackgroundTracksOptimization === 'function') {
            updateBackgroundTracksOptimization();
        }
    }
}

function addLocalTracksToPC(pc) {
    if (!pc || !localStream) return;
    const senders = pc.getSenders();
    const transceivers = typeof pc.getTransceivers === 'function' ? pc.getTransceivers() : null;
    localStream.getTracks().forEach(track => {
        // Reutiliza sender existente (ativo ou silenciado com track null) sem misturar audio/video
        let existingSender = null;
        let matchedTransceiver = null;
        if (transceivers) {
            matchedTransceiver = transceivers.find(t => {
                const s = t && t.sender;
                if (!s) return false;
                if (s.track) return s.track.id === track.id || s.track.kind === track.kind;
                const receiverKind = t.receiver && t.receiver.track && t.receiver.track.kind;
                return (s._kind && s._kind === track.kind) || (receiverKind === track.kind);
            }) || null;
            if (matchedTransceiver) {
                existingSender = matchedTransceiver.sender;
                if (matchedTransceiver.direction === 'recvonly') {
                    matchedTransceiver.direction = 'sendrecv';
                } else if (matchedTransceiver.direction === 'inactive') {
                    matchedTransceiver.direction = 'sendonly';
                }
            }
        }
        if (!existingSender) {
            existingSender = senders.find(s =>
                (s.track && (s.track.id === track.id || s.track.kind === track.kind)) ||
                (!s.track && (s._kind === track.kind || (!transceivers && s._kind === undefined && s.dtlsTransport)))
            );
        }
        if (existingSender) {
            existingSender._kind = track.kind;
            if (existingSender.track !== track) {
                try { Promise.resolve(existingSender.replaceTrack(track)).catch(() => {}); } catch (e) {}
            }
            configureSenderParams(existingSender, track.kind);
        } else {
            const sender = pc.addTrack(track, localStream);
            sender._kind = track.kind;
            configureSenderParams(sender, track.kind);
        }
    });
}

const VIDEO_RES_KEY = 'streamgrid_video_resolution';
const VIDEO_FPS_KEY = 'streamgrid_video_fps';
const AUDIO_SOURCE_KEY = 'streamgrid_audio_source';
const CONTENT_HINT_KEY = 'streamgrid_content_hint';
let selectedVideoResolution = '1080p';
let selectedVideoFps = 60;
let selectedAudioSource = null;

function loadSavedClientPreferences() {
    if (typeof localStorage !== 'undefined') {
        try {
            if (typeof VIDEO_RES_KEY !== 'undefined') {
                const savedRes = localStorage.getItem(VIDEO_RES_KEY);
                if (savedRes === '720p' || savedRes === '1080p') selectedVideoResolution = savedRes;
            }
            if (typeof VIDEO_FPS_KEY !== 'undefined') {
                const savedFps = Number(localStorage.getItem(VIDEO_FPS_KEY));
                if (savedFps === 30 || savedFps === 60) selectedVideoFps = savedFps;
            }
            if (typeof AUDIO_SOURCE_KEY !== 'undefined') {
                const savedAudio = localStorage.getItem(AUDIO_SOURCE_KEY);
                if (savedAudio === 'exclude_discord' || savedAudio === 'app' || savedAudio === 'system' || savedAudio === 'none') {
                    selectedAudioSource = savedAudio;
                }
            }
            if (typeof CONTENT_HINT_KEY !== 'undefined' && typeof contentHintMode !== 'undefined') {
                const savedHint = localStorage.getItem(CONTENT_HINT_KEY);
                if (savedHint === 'motion' || savedHint === 'detail') {
                    contentHintMode = savedHint;
                }
            }
        } catch (_) {}
    }
    if (typeof applyQualityModeUI === 'function') {
        applyQualityModeUI();
    }
}

loadSavedClientPreferences();

function configureSenderParams(sender, kind) {
    if (!sender || typeof sender.getParameters !== 'function') return;
    if (kind === 'video') {
        try {
            const params = sender.getParameters();
            const isDetailMode = typeof contentHintMode !== 'undefined' && contentHintMode === 'detail';
            // In Fluido ('motion') mode, preserve framerate over resolution so temporary congestion downscales instead of halving FPS
            params.degradationPreference = isDetailMode ? 'maintain-resolution' : 'maintain-framerate';
            const baseFps = Number(selectedVideoFps) === 30 ? 30 : 60;
            if (params.encodings && params.encodings[0]) {
                params.encodings[0].maxBitrate = getMaxBitrateForPeerCount(typeof peers !== 'undefined' ? peers.size : 1, selectedVideoResolution, selectedVideoFps);
                params.encodings[0].maxFramerate = isDetailMode ? Math.min(30, baseFps) : baseFps;
            }
            sender.setParameters(params).catch(() => {});
        } catch (e) {}
    } else if (kind === 'audio') {
        try {
            const params = sender.getParameters();
            if (params.encodings && params.encodings[0]) {
                params.encodings[0].maxBitrate = 128000;
            }
            sender.setParameters(params).catch(() => {});
        } catch (e) {}
    }
}

// Dynamically rebalances bitrate across all active peer senders whenever participants join or leave
function updateSendersForActivePeers() {
    if (!localStream) return;
    for (const [peerId, peerObj] of peers.entries()) {
        if (peerObj && peerObj.pc) {
            const sender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                configureSenderParams(sender, 'video');
            }
        }
    }
}

// ========== Adaptive Bitrate Quality Monitor (getStats) ==========
let qualityMonitorInterval = null;
let isQualityMonitorRunning = false;

/**
 * Extracts active candidate-pair, real FPS/resolution/bitrate deltas, codec/encoder,
 * and quality limitation metrics from a WebRTC RTCStatsReport without requiring stats.get().
 */

/**
 * Evaluates a single peer's RTCStatsReport to adapt outbound encoding parameters
 * and update the inbound video tile QoS badge.
 */
async function evaluatePeerQoS(peerId, peerObj) {
    if (!peerObj || !peerObj.pc || peerObj.pc.connectionState === 'closed') return;
    const stats = await peerObj.pc.getStats();
    const telemetry = collectPeerTelemetry(stats, peerObj._qosRateState);
    peerObj._qosRateState = telemetry.nextState;

    const availableBitrate = telemetry.availableOutgoingBitrate;
    const rtt = telemetry.currentRoundTripTime || 0;
    const qualityLimitation = telemetry.outbound ? telemetry.outbound.qualityLimitationReason : 'none';
    const outboundFps = telemetry.outbound ? telemetry.outbound.fps : 0;
    const inboundFps = telemetry.inbound ? telemetry.inbound.fps : 0;
    const inboundPacketsLost = telemetry.inbound ? telemetry.inbound.packetsLost : 0;
    const inboundPacketsReceived = telemetry.inbound ? telemetry.inbound.packetsReceived : 0;

    // --- 1. OUTBOUND ADAPTATION (When we are streaming to this peer) ---
    if (localStream && availableBitrate !== null) {
        const videoSender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
            const params = videoSender.getParameters();
            if (params.encodings && params.encodings[0]) {
                const peerCap = getMaxBitrateForPeerCount(
                typeof peers !== 'undefined' ? peers.size : 1,
                typeof selectedVideoResolution !== 'undefined' ? selectedVideoResolution : '1080p',
                typeof selectedVideoFps !== 'undefined' ? selectedVideoFps : 60
            );
                const current = params.encodings[0].maxBitrate || peerCap;
                let targetBitrate;

                if (availableBitrate < 600000) {
                    targetBitrate = 350000; // Emergency ultra-low floor (prevents black screen freezes)
                } else if (availableBitrate < 1200000) {
                    targetBitrate = Math.max(350000, Math.floor(availableBitrate * 0.70));
                } else if (availableBitrate < 2500000) {
                    targetBitrate = Math.floor(availableBitrate * 0.75);
                } else if (availableBitrate < 5000000) {
                    targetBitrate = Math.min(peerCap, Math.floor(availableBitrate * 0.80));
                } else {
                    targetBitrate = peerCap; // Cap dinâmico por contagem de espectadores
                }

                // Auto-throttle framerate under critical bottleneck, and restore using profile-scaled recovery threshold
                let fpsChanged = false;
                const targetFps = Number(selectedVideoFps) === 30 ? 30 : 60;
                const recoverThreshold = Math.min(2200000, Math.round(peerCap * 0.75));
                if (availableBitrate < 1000000 || qualityLimitation === 'cpu') {
                    const throttledFps = Math.min(30, targetFps);
                    if (params.encodings[0].maxFramerate !== throttledFps) {
                        params.encodings[0].maxFramerate = throttledFps;
                        fpsChanged = true;
                        console.log(`[QoS] ${peerId.slice(0,6)}: Throttled to ${throttledFps} FPS due to ${qualityLimitation === 'cpu' ? 'CPU' : 'network'}`);
                    }
                } else if (availableBitrate >= recoverThreshold && contentHintMode === 'motion') {
                    if (params.encodings[0].maxFramerate !== targetFps) {
                        params.encodings[0].maxFramerate = targetFps;
                        fpsChanged = true;
                    }
                }

                // Smooth ramp with convergence snap (avoids dead-zone around medium gaps)
                const boundedTarget = Math.max(350000, Math.min(peerCap, targetBitrate));
                let nextBitrate = current;
                if (Math.abs(boundedTarget - current) <= 100000) {
                    nextBitrate = boundedTarget;
                } else {
                    const smoothed = Math.floor(current + (boundedTarget - current) * 0.3);
                    const clamped = Math.max(350000, Math.min(peerCap, smoothed));
                    if (Math.abs(clamped - current) >= 25000) {
                        nextBitrate = clamped;
                    }
                }
                const bitrateChanged = nextBitrate !== current;

                if (bitrateChanged || fpsChanged) {
                    if (bitrateChanged) {
                        params.encodings[0].maxBitrate = nextBitrate;
                    }
                    videoSender.setParameters(params).catch(() => {});
                    console.log(
                        `[QoS] Outbound ${peerId.slice(0,6)}: ` +
                        `bitrate ${(current/1e6).toFixed(1)}→${(params.encodings[0].maxBitrate/1e6).toFixed(1)} Mbps | ` +
                        `maxFps: ${params.encodings[0].maxFramerate} | fps: ${outboundFps} | limit: ${qualityLimitation} | rtt: ${(rtt*1000).toFixed(0)}ms`
                    );
                }
            }
        }
    }

    // --- 2. INBOUND QUALITY BADGE (When we are watching this peer) ---
    if (peerObj.tileEl) {
        const badge = peerObj.tileEl.querySelector('.tile-quality-badge');
        if (badge) {
            let lossRatio = 0;
            if (!peerObj._lastStats) {
                peerObj._lastStats = { lost: inboundPacketsLost, received: inboundPacketsReceived };
            } else {
                const dLost = inboundPacketsLost - peerObj._lastStats.lost;
                const dRecv = inboundPacketsReceived - peerObj._lastStats.received;
                const dTotal = dLost + dRecv;
                if (dTotal > 0) {
                    lossRatio = Math.max(0, dLost / dTotal);
                }
                peerObj._lastStats = { lost: inboundPacketsLost, received: inboundPacketsReceived };
            }

            const fps = Math.round(inboundFps || 0);
            let qosClass = 'good';
            let qosText = `${fps > 0 ? fps + ' FPS' : 'Bom'}`;

            if (lossRatio > 0.08 || (fps > 0 && fps < 15)) {
                qosClass = 'poor';
                qosText = `Instável • ${fps} FPS`;
            } else if (lossRatio > 0.03 || (fps > 0 && fps < 22)) {
                qosClass = 'medium';
                qosText = `Oscilando • ${fps} FPS`;
            } else {
                qosClass = 'good';
                qosText = fps >= 55 ? '60 FPS Estável' : (fps > 0 ? `${fps} FPS` : 'Estável');
            }

            const dot = badge.querySelector('.qos-dot');
            const label = badge.querySelector('.qos-label');
            if (dot) dot.className = `qos-dot ${qosClass}`;
            if (label) label.textContent = qosText;

            if (qosClass === 'poor' || qosClass === 'medium') {
                badge.classList.add('visible');
            } else {
                badge.classList.remove('visible');
            }
        }
    }
}

function startQualityMonitor() {
    if (qualityMonitorInterval) return;
    console.log('[QoS] ▶ Quality monitor started');

    qualityMonitorInterval = setInterval(async () => {
        if (isQualityMonitorRunning) return;
        if (!localStream && peers.size === 0) {
            stopQualityMonitor();
            return;
        }

        isQualityMonitorRunning = true;
        try {
            for (const [peerId, peerObj] of peers.entries()) {
                try {
                    await evaluatePeerQoS(peerId, peerObj);
                } catch (e) { /* peer disconnected mid-stats */ }
            }
        } finally {
            isQualityMonitorRunning = false;
        }
    }, 3500);
}

function stopQualityMonitor() {
    if (qualityMonitorInterval) {
        clearInterval(qualityMonitorInterval);
        qualityMonitorInterval = null;
        console.log('[QoS] ■ Quality monitor stopped');
    }
    isQualityMonitorRunning = false;
}

// ========== Quality Mode Toggle (Fluido vs Nítido) ==========
function applyQualityModeUI() {
    const isMotion = contentHintMode !== 'detail';
    if (typeof qualityModeLabel !== 'undefined' && qualityModeLabel) {
        qualityModeLabel.textContent = isMotion ? 'Fluido' : 'Nítido';
    }
    if (typeof btnQualityToggle !== 'undefined' && btnQualityToggle) {
        btnQualityToggle.title = isMotion
            ? 'Modo Fluido: prioriza 60fps (ideal para jogos de ação)'
            : 'Modo Nítido: prioriza nitidez de texto/UI (ideal para Tibia, documentos)';
    }
}

btnQualityToggle.addEventListener('click', toggleQualityMode);

function toggleQualityMode() {
    contentHintMode = contentHintMode === 'motion' ? 'detail' : 'motion';
    const isMotion = contentHintMode === 'motion';
    try {
        if (typeof localStorage !== 'undefined' && typeof CONTENT_HINT_KEY !== 'undefined') {
            localStorage.setItem(CONTENT_HINT_KEY, contentHintMode);
        }
    } catch (_) {}

    if (typeof applyQualityModeUI === 'function') {
        applyQualityModeUI();
    } else {
        qualityModeLabel.textContent = isMotion ? 'Fluido' : 'Nítido';
        btnQualityToggle.title = isMotion
            ? 'Modo Fluido: prioriza 60fps (ideal para jogos de ação)'
            : 'Modo Nítido: prioriza nitidez de texto/UI (ideal para Tibia, documentos)';
    }

    // Apply contentHint to local video track
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack && 'contentHint' in videoTrack) {
            videoTrack.contentHint = contentHintMode;
            console.log(`[Quality] contentHint → "${contentHintMode}"`);
        }
    }

    // Update degradationPreference on all senders
    const baseFps = Number(selectedVideoFps) === 30 ? 30 : 60;
    for (const [, peerObj] of peers.entries()) {
        if (!peerObj.pc) continue;
        const videoSender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
            try {
                const params = videoSender.getParameters();
                // 'detail' mode: never sacrifice resolution → maintain-resolution + cap framerate at 30
                // 'motion' mode: preserve framerate ('maintain-framerate') and respect user's selected framerate (30 or 60)
                params.degradationPreference = isMotion ? 'maintain-framerate' : 'maintain-resolution';
                if (params.encodings && params.encodings[0]) {
                    params.encodings[0].maxFramerate = isMotion ? baseFps : Math.min(30, baseFps);
                }
                videoSender.setParameters(params).catch(() => {});
            } catch (e) {}
        }
    }
}

// Screen Share Configuration Modal & Triggers
const shareConfigModal = document.getElementById('shareConfigModal');
const btnCloseShareConfig = document.getElementById('btnCloseShareConfig');
const btnConfirmStartShare = document.getElementById('btnConfirmStartShare');
const btnRefreshAudioApps = document.getElementById('btnRefreshAudioApps');
const selectAudioApp = document.getElementById('selectAudioApp');
const audioSourceExcludeDiscord = document.getElementById('audioSourceExcludeDiscord');
const audioSourceApp = document.getElementById('audioSourceApp');
const audioSourceSystem = document.getElementById('audioSourceSystem');
const audioSourceNone = document.getElementById('audioSourceNone');
const appSelectorContainer = document.getElementById('appSelectorContainer');

if (btnCloseShareConfig) {
    btnCloseShareConfig.addEventListener('click', closeShareConfigModal);
}

if (btnRefreshAudioApps) {
    btnRefreshAudioApps.addEventListener('click', () => {
        fetchWindowList();
    });
}

// Toggle app selector visibility based on radio choice
[audioSourceExcludeDiscord, audioSourceApp, audioSourceSystem, audioSourceNone].forEach(radio => {
    if (radio) {
        radio.addEventListener('change', () => {
            if (radio.checked && radio.value) {
                if (typeof selectedAudioSource !== 'undefined') {
                    selectedAudioSource = radio.value;
                }
                try {
                    if (typeof localStorage !== 'undefined' && typeof AUDIO_SOURCE_KEY !== 'undefined') {
                        localStorage.setItem(AUDIO_SOURCE_KEY, radio.value);
                    }
                } catch (_) {}
            }
            if (appSelectorContainer) {
                appSelectorContainer.style.display = (audioSourceApp && audioSourceApp.checked) ? 'flex' : 'none';
            }
            const audioRadios = (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function')
                ? document.querySelectorAll('input[name="audioSourceType"]')
                : [audioSourceExcludeDiscord, audioSourceApp, audioSourceSystem, audioSourceNone];
            audioRadios.forEach((r) => {
                const card = r && typeof r.closest === 'function' ? r.closest('.audio-option-card') : null;
                if (!card) return;
                if (card.classList && typeof card.classList.toggle === 'function') {
                    card.classList.toggle('is-selected', Boolean(r.checked));
                }
                if (card.style) {
                    card.style.border = '';
                }
            });
        });
    }
});

function updateEchoWarningVisibility() {
    const warningEl = document.getElementById('dualStreamEchoWarning');
    if (!warningEl) return;
    const hasOtherStream = remoteActiveStreams.size > 0;
    warningEl.style.display = hasOtherStream ? 'block' : 'none';
}

function openShareConfigModal() {
    updateEchoWarningVisibility();

    const isDesktop = isDesktopApp();

    // Se estiver no navegador web (sem app desktop), adapta o modal amigavelmente
    const desktopOnlyCard1 = audioSourceExcludeDiscord?.closest('.audio-option-card');
    const desktopOnlyCard2 = audioSourceApp?.closest('.audio-option-card');
    const preferredAudioSource = (typeof selectedAudioSource !== 'undefined' &&
        (selectedAudioSource === 'exclude_discord' || selectedAudioSource === 'app' || selectedAudioSource === 'system' || selectedAudioSource === 'none'))
        ? selectedAudioSource
        : null;

    if (!isDesktop) {
        if (desktopOnlyCard1) desktopOnlyCard1.style.display = 'none';
        if (desktopOnlyCard2) desktopOnlyCard2.style.display = 'none';
        if (audioSourceExcludeDiscord) audioSourceExcludeDiscord.checked = false;
        if (audioSourceApp) audioSourceApp.checked = false;
        const webSource = preferredAudioSource === 'none' && typeof audioSourceNone !== 'undefined' && audioSourceNone
            ? 'none'
            : 'system';
        if (typeof audioSourceNone !== 'undefined' && audioSourceNone) {
            audioSourceNone.checked = webSource === 'none';
        }
        if (audioSourceSystem) {
            audioSourceSystem.checked = webSource === 'system';
        }
        if (appSelectorContainer) {
            appSelectorContainer.style.display = 'none';
        }
    } else {
        if (desktopOnlyCard1) desktopOnlyCard1.style.display = 'flex';
        if (desktopOnlyCard2) desktopOnlyCard2.style.display = 'flex';
        const desktopRadioMap = {
            exclude_discord: typeof audioSourceExcludeDiscord !== 'undefined' ? audioSourceExcludeDiscord : null,
            app: typeof audioSourceApp !== 'undefined' ? audioSourceApp : null,
            system: typeof audioSourceSystem !== 'undefined' ? audioSourceSystem : null,
            none: typeof audioSourceNone !== 'undefined' ? audioSourceNone : null
        };
        const targetRadio = preferredAudioSource ? desktopRadioMap[preferredAudioSource] : null;
        if (targetRadio) {
            Object.values(desktopRadioMap).forEach((r) => {
                if (r) r.checked = r === targetRadio;
            });
        }
        if (appSelectorContainer) {
            const checkedAudioRadio = document.querySelector('input[name="audioSourceType"]:checked');
            const isAppMode = checkedAudioRadio
                ? checkedAudioRadio.value === 'app'
                : Boolean(audioSourceApp && audioSourceApp.checked);
            appSelectorContainer.style.display = isAppMode ? 'flex' : 'none';
        }
        checkDiscordStatus();
        fetchWindowList();
    }

    const audioRadios = (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function')
        ? document.querySelectorAll('input[name="audioSourceType"]')
        : [
            typeof audioSourceExcludeDiscord !== 'undefined' ? audioSourceExcludeDiscord : null,
            typeof audioSourceApp !== 'undefined' ? audioSourceApp : null,
            typeof audioSourceSystem !== 'undefined' ? audioSourceSystem : null,
            typeof audioSourceNone !== 'undefined' ? audioSourceNone : null
        ];
    audioRadios.forEach((radio) => {
        const card = radio && typeof radio.closest === 'function' ? radio.closest('.audio-option-card') : null;
        if (!card) return;
        if (card.classList && typeof card.classList.toggle === 'function') {
            card.classList.toggle('is-selected', Boolean(radio.checked));
        }
        if (!radio.checked && card.style && card.style.border) {
            card.style.border = '';
        }
    });

    const resRadio = document.querySelector(`input[name="videoResolution"][value="${selectedVideoResolution}"]`);
    if (resRadio) resRadio.checked = true;
    const fpsRadio = document.querySelector(`input[name="videoFps"][value="${selectedVideoFps}"]`);
    if (fpsRadio) fpsRadio.checked = true;

    if (shareConfigModal) {
        shareConfigModal.removeAttribute('hidden');
        shareConfigModal.style.display = 'flex';
    }
}

function closeShareConfigModal() {
    if (shareConfigModal) {
        shareConfigModal.setAttribute('hidden', '');
        shareConfigModal.style.display = 'none';
    }
}

if (shareConfigModal) {
    shareConfigModal.addEventListener('click', (e) => {
        if (e.target === shareConfigModal) {
            closeShareConfigModal();
        }
    });
}

// Toolbar Utilities: Picture-in-Picture & Stats Modals
const btnTogglePip = document.getElementById('btnTogglePip');
const btnToggleStats = document.getElementById('btnToggleStats');
const statsModal = document.getElementById('statsModal');
const btnCloseStatsModal = document.getElementById('btnCloseStatsModal');

let statsUpdateInterval = null;
let isStatsUpdateRunning = false;
let statsUpdateGeneration = 0;

async function updateStatsDisplay() {
    if (isStatsUpdateRunning) return;
    const runId = ++statsUpdateGeneration;
    isStatsUpdateRunning = true;

    try {
        const elConnectionState = document.getElementById('statsConnectionState');
        const elRtt = document.getElementById('statsRtt');
        const elPacketLoss = document.getElementById('statsPacketLoss');
        const elLocalStream = document.getElementById('statsLocalStream');
        const elContentHint = document.getElementById('statsContentHint');
        const elVideoTelemetry = document.getElementById('statsVideoTelemetry');
        const elCodecEncoder = document.getElementById('statsCodecEncoder');
        const elQualityLimitation = document.getElementById('statsQualityLimitation');
        const elIceRoute = document.getElementById('statsIceRoute');

        const peerCount = peers ? peers.size : 0;
        if (elConnectionState) {
            if (peerCount === 0) {
                elConnectionState.textContent = 'Aguardando participantes...';
            } else {
                let connectedCount = 0;
                peers.forEach(p => {
                    if (p.pc && (p.pc.connectionState === 'connected' || p.pc.iceConnectionState === 'connected')) {
                        connectedCount++;
                    }
                });
                elConnectionState.textContent = connectedCount > 0
                    ? `Conectado (${connectedCount}/${peerCount} pares)`
                    : `Negociando (${peerCount} pares)`;
            }
        }

        if (elLocalStream) {
            if (localStream && localStream.active) {
                const vTrack = typeof localStream.getVideoTracks === 'function' ? localStream.getVideoTracks()[0] : null;
                const vSettings = vTrack && typeof vTrack.getSettings === 'function' ? vTrack.getSettings() : null;
                if (vSettings && vSettings.width && vSettings.height) {
                    const capFps = vSettings.frameRate ? Math.round(vSettings.frameRate) : selectedVideoFps;
                    elLocalStream.textContent = `Ativa (${vSettings.height}p @ ${capFps} FPS captura)`;
                } else {
                    elLocalStream.textContent = `Ativa (${selectedVideoResolution} @ ${selectedVideoFps} FPS)`;
                }
            } else {
                elLocalStream.textContent = 'Inativa';
            }
        }

        if (elContentHint) {
            elContentHint.textContent = contentHintMode === 'motion'
                ? `Fluido (Priorizar ${selectedVideoFps} FPS)`
                : 'Detalhado (Nitidez / Texto)';
        }

        let minRtt = null;
        let totalLost = 0;
        let totalReceived = 0;
        let primaryOutbound = null;
        let primaryInbound = null;
        let primaryBweKbps = null;
        const iceRoutes = [];

        if (peers && peers.size > 0) {
            for (const [, peerObj] of peers.entries()) {
                if (!peerObj.pc || peerObj.pc.connectionState === 'closed') continue;
                try {
                    const stats = await peerObj.pc.getStats();
                    if (statsUpdateGeneration !== runId) return;
                    const telemetry = collectPeerTelemetry(stats, peerObj._modalStatsState);
                    peerObj._modalStatsState = telemetry.nextState;

                    if (telemetry.currentRoundTripTime != null) {
                        const rttMs = Math.round(telemetry.currentRoundTripTime * 1000);
                        if (minRtt === null || rttMs < minRtt) minRtt = rttMs;
                    }
                    if (telemetry.availableOutgoingBitrate != null && primaryBweKbps === null) {
                        primaryBweKbps = Math.round(telemetry.availableOutgoingBitrate / 1000);
                    }
                    if (telemetry.iceRoute && !iceRoutes.includes(telemetry.iceRoute)) {
                        iceRoutes.push(telemetry.iceRoute);
                    }
                    if (telemetry.outbound && !primaryOutbound) {
                        primaryOutbound = telemetry.outbound;
                    }
                    if (telemetry.inbound) {
                        totalLost += telemetry.inbound.packetsLost;
                        totalReceived += telemetry.inbound.packetsReceived;
                        if (!primaryInbound) primaryInbound = telemetry.inbound;
                    }
                } catch (_) {}
            }
        }

        if (statsUpdateGeneration !== runId) return;

        if (elRtt) {
            elRtt.textContent = minRtt !== null ? `${minRtt} ms` : '-- ms';
        }

        if (elPacketLoss) {
            if (totalReceived + totalLost > 0) {
                const lossPct = ((totalLost / (totalReceived + totalLost)) * 100).toFixed(1);
                elPacketLoss.textContent = `${lossPct}%`;
            } else {
                elPacketLoss.textContent = '0%';
            }
        }

        if (elVideoTelemetry) {
            const activeVideo = primaryOutbound || primaryInbound;
            if (activeVideo) {
                const prefix = primaryOutbound ? 'TX' : 'RX';
                const resText = activeVideo.width && activeVideo.height
                    ? `${activeVideo.width}x${activeVideo.height}`
                    : selectedVideoResolution;
                const rateText = activeVideo.kbps != null
                    ? `${activeVideo.kbps} kbps`
                    : (primaryOutbound && primaryBweKbps != null ? `BWE ${primaryBweKbps} kbps` : '-- kbps');
                elVideoTelemetry.textContent = `${prefix} ${resText} @ ${activeVideo.fps} FPS (${rateText})`;
            } else {
                elVideoTelemetry.textContent = '--';
            }
        }

        if (elCodecEncoder) {
            const codecInfo = primaryOutbound || primaryInbound;
            if (codecInfo && (codecInfo.codec || codecInfo.encoder || codecInfo.decoder)) {
                const impl = codecInfo.encoder || codecInfo.decoder || 'padrão';
                elCodecEncoder.textContent = `${codecInfo.codec || 'Video'} (${impl})`;
            } else {
                elCodecEncoder.textContent = '--';
            }
        }

        if (elQualityLimitation) {
            const reason = primaryOutbound ? primaryOutbound.qualityLimitationReason : 'none';
            const reasonLabels = {
                none: 'Nenhuma (none)',
                cpu: 'CPU sobrecarregada (cpu)',
                bandwidth: 'Banda / Rede (bandwidth)',
                other: 'Outro recurso (other)'
            };
            elQualityLimitation.textContent = reasonLabels[reason] || reason;
        }

        if (elIceRoute) {
            elIceRoute.textContent = iceRoutes.length > 0 ? iceRoutes.join(', ') : '--';
        }

        const elIceProvider = document.getElementById('statsIceProvider');
        if (elIceProvider && typeof getActiveIceProvider === 'function' && typeof getIceProviderDisplayLabel === 'function') {
            elIceProvider.textContent = getIceProviderDisplayLabel(getActiveIceProvider());
        }

        const elServerUrl = document.getElementById('statsServerUrl');
        const btnResetServer = document.getElementById('btnResetServerUrl');
        let hasSavedServerOverride = false;
        try {
            if (typeof localStorage !== 'undefined' && typeof SERVER_URL_STORAGE_KEY !== 'undefined') {
                hasSavedServerOverride = Boolean(localStorage.getItem(SERVER_URL_STORAGE_KEY));
            }
        } catch (_) {}
        if (elServerUrl) {
            const activeServer = typeof SERVER_URL !== 'undefined' ? SERVER_URL : '';
            elServerUrl.textContent = activeServer
                ? (hasSavedServerOverride ? `${activeServer} (override local)` : activeServer)
                : '--';
        }
        if (btnResetServer) {
            btnResetServer.hidden = !hasSavedServerOverride;
        }
    } finally {
        if (statsUpdateGeneration === runId) {
            isStatsUpdateRunning = false;
        }
    }
}

function openStatsModal() {
    if (statsModal) {
        statsModal.removeAttribute('hidden');
        statsModal.style.display = 'flex';
        updateStatsDisplay();
        if (statsUpdateInterval) clearInterval(statsUpdateInterval);
        statsUpdateInterval = setInterval(updateStatsDisplay, 1000);
    }
}

function closeStatsModal() {
    if (statsModal) {
        statsModal.setAttribute('hidden', '');
        statsModal.style.display = 'none';
        if (statsUpdateInterval) {
            clearInterval(statsUpdateInterval);
            statsUpdateInterval = null;
        }
        statsUpdateGeneration += 1;
        isStatsUpdateRunning = false;
    }
}

async function togglePictureInPicture() {
    if (typeof document === 'undefined' || !document.pictureInPictureEnabled) {
        showToast('Janela Flutuante (Picture-in-Picture) não é suportada neste navegador.', 'warning');
        return;
    }

    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            return;
        }

        const remoteVideo = streamGrid ? streamGrid.querySelector('.stream-tile:not(#localStreamTile) video') : null;
        const localVideo = streamGrid ? streamGrid.querySelector('#localStreamTile video') : null;
        const targetVideo = remoteVideo || localVideo || (streamGrid ? streamGrid.querySelector('video') : null);

        if (!targetVideo) {
            showToast('Nenhuma transmissão ativa para abrir em janela flutuante.', 'info');
            return;
        }

        await targetVideo.requestPictureInPicture();
    } catch (err) {
        console.error('[PiP] Falha ao alternar Picture-in-Picture:', err);
        showToast('Não foi possível ativar a janela flutuante: ' + (err.message || 'Erro desconhecido'), 'error');
    }
}

if (btnTogglePip) {
    btnTogglePip.addEventListener('click', togglePictureInPicture);
}

function resetSavedSignalingServerUrl() {
    let hadOverride = false;
    try {
        if (typeof localStorage !== 'undefined' && typeof SERVER_URL_STORAGE_KEY !== 'undefined') {
            hadOverride = Boolean(localStorage.getItem(SERVER_URL_STORAGE_KEY));
            localStorage.removeItem(SERVER_URL_STORAGE_KEY);
        }
    } catch (_) {}

    if (hadOverride) {
        if (typeof showToast === 'function') {
            showToast('Servidor salvo removido. Recarregando para a instância padrão...', 'info', 2500);
        }
        if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
            window.location.reload();
        }
    } else if (typeof showToast === 'function') {
        showToast('Já está usando o servidor padrão.', 'info', 2500);
    }
}

const btnResetServerUrl = document.getElementById('btnResetServerUrl');
if (btnResetServerUrl) {
    btnResetServerUrl.addEventListener('click', resetSavedSignalingServerUrl);
}

if (btnToggleStats) {
    btnToggleStats.addEventListener('click', openStatsModal);
}

if (btnCloseStatsModal) {
    btnCloseStatsModal.addEventListener('click', closeStatsModal);
}

if (statsModal) {
    statsModal.addEventListener('click', (e) => {
        if (e.target === statsModal) {
            closeStatsModal();
        }
    });
}

btnStartShare.addEventListener('click', openShareConfigModal);
btnStartShareBig.addEventListener('click', openShareConfigModal);

if (btnConfirmStartShare) {
    btnConfirmStartShare.addEventListener('click', async () => {
        closeShareConfigModal();
        const mode = document.querySelector('input[name="audioSourceType"]:checked')?.value || 'exclude_discord';
        if (typeof selectedAudioSource !== 'undefined') {
            selectedAudioSource = mode;
        }
        try {
            if (typeof AUDIO_SOURCE_KEY !== 'undefined') {
                localStorage.setItem(AUDIO_SOURCE_KEY, mode);
            }
        } catch (_) {}
        const targetPid = selectAudioApp ? selectAudioApp.value : null;

        const resChoice = document.querySelector('input[name="videoResolution"]:checked')?.value;
        if (resChoice === '720p' || resChoice === '1080p') {
            selectedVideoResolution = resChoice;
            try { localStorage.setItem(VIDEO_RES_KEY, selectedVideoResolution); } catch (_) {}
        }
        const fpsChoice = Number(document.querySelector('input[name="videoFps"]:checked')?.value);
        if (fpsChoice === 30 || fpsChoice === 60) {
            selectedVideoFps = fpsChoice;
            try { localStorage.setItem(VIDEO_FPS_KEY, String(selectedVideoFps)); } catch (_) {}
        }

        await startScreenShare(mode, targetPid, selectedVideoResolution, selectedVideoFps);
    });
}

async function startScreenShare(audioMode = 'exclude_discord', targetPid = null, resolution = selectedVideoResolution, fps = selectedVideoFps) {
    if (startScreenShare._isStarting) return;
    startScreenShare._isStarting = true;

    if (localStream) {
        stopScreenShare();
    }

    let screenStream = null;
    let audioTrack = null;
    let cableStream = null;
    let captureSucceeded = false;

    try {
        let idealFps = Number(fps) || 60;
        let idealWidth = resolution === '720p' ? 1280 : 1920;
        let idealHeight = resolution === '720p' ? 720 : 1080;

        // Auto-detect mobile or constrained cellular network
        if (navigator.connection) {
            const conn = navigator.connection;
            if (conn.saveData || conn.effectiveType === '2g' || conn.effectiveType === '3g') {
                console.log(`[Capture] ⚠️ Low-bandwidth detected (${conn.effectiveType}), defaulting to 720p30 profile`);
                idealWidth = 1280;
                idealHeight = 720;
                idealFps = 30;
            }
        }

        const videoConstraints = getVideoConstraints(idealWidth === 1280 ? '720p' : '1080p', idealFps);

        if (audioMode === 'exclude_discord') {
            // Mode 1: Full PC Audio with Discord call filtered out (WASAPI Exclusion Loopback)
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: videoConstraints,
                    audio: false
                });
            } catch (err) {
                if (err.name === 'NotAllowedError') return;
                throw err;
            }

            try {
                audioTrack = await startExcludeDiscordCapture();
                console.log('[Audio] ✅ Capturando áudio de todo o sistema excluindo o Discord (WASAPI Exclusion Loopback)');
            } catch (appErr) {
                console.warn('[Audio] Falha ao capturar no modo excluir Discord:', appErr.message);
                showToast('Aviso de Áudio: ' + appErr.message + ' (Continuando transmissão apenas com vídeo)', 'warning');
            }
        } else if (audioMode === 'app' && targetPid) {
            // Mode 2: Isolated Application Audio Capture (WASAPI Process Loopback)
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: videoConstraints,
                    audio: false
                });
            } catch (err) {
                if (err.name === 'NotAllowedError') return;
                throw err;
            }

            try {
                audioTrack = await startAppAudioCapture(targetPid);
                console.log('[Audio] ✅ Capturing isolated application audio via WASAPI Loopback for PID:', targetPid);
            } catch (appErr) {
                console.warn('[Audio] Failed to capture app audio:', appErr.message);
                showToast('Aviso de Áudio: ' + appErr.message + ' (Continuando transmissão apenas com vídeo)', 'warning');
            }
        } else if (audioMode === 'system') {
            // Mode 2: System / VB-Cable Audio
            let cableOutputId = null;
            try {
                let devices = await navigator.mediaDevices.enumerateDevices();
                const hasEmptyLabels = devices.some(d => d.deviceId && d.label === '');
                if (hasEmptyLabels) {
                    try {
                        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        tempStream.getTracks().forEach(t => t.stop());
                        devices = await navigator.mediaDevices.enumerateDevices();
                    } catch (permErr) {}
                }

                const cableOutput = devices.find(d => {
                    if (d.kind !== 'audioinput') return false;
                    const label = d.label.toLowerCase();
                    return label.includes('cable output') ||
                           (label.includes('vb-audio') && label.includes('cable')) ||
                           (label.includes('virtual cable') && !label.includes('16ch'));
                });

                if (cableOutput) {
                    cableOutputId = cableOutput.deviceId;
                }
            } catch (e) {}

            if (cableOutputId) {
                try {
                    screenStream = await navigator.mediaDevices.getDisplayMedia({
                        video: videoConstraints,
                        audio: false
                    });
                } catch (err) {
                    if (err.name === 'NotAllowedError') return;
                    throw err;
                }

                try {
                    cableStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: { exact: cableOutputId },
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                            channelCount: 2,
                            sampleRate: 48000
                        }
                    });
                    const cableAudioTracks = cableStream.getAudioTracks();
                    audioTrack = cableAudioTracks[0] || null;
                    cableStream.getTracks().forEach(t => {
                        if (t !== audioTrack) {
                            try { t.stop(); } catch (_) {}
                        }
                    });
                    console.log('[Audio] ✅ Capturing isolated audio from VB-Cable');
                } catch (audioErr) {
                    if (cableStream) {
                        cableStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
                        cableStream = null;
                    }
                    console.warn('[Audio] VB-Cable capture failed:', audioErr.message);
                }
            } else {
                try {
                    screenStream = await navigator.mediaDevices.getDisplayMedia({
                        video: videoConstraints,
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false
                        }
                    });
                } catch (err) {
                    if (err.name === 'NotAllowedError') return;
                    throw err;
                }

                if (screenStream.getAudioTracks().length > 0) {
                    audioTrack = screenStream.getAudioTracks()[0];
                    console.log('[Audio] ✅ System audio captured directly via getDisplayMedia');
                }
            }
        } else if (audioMode === 'app') {
            showToast('Nenhum aplicativo selecionado para áudio isolado. Continuando apenas com vídeo.', 'warning');
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: videoConstraints,
                    audio: false
                });
            } catch (err) {
                if (err.name === 'NotAllowedError') return;
                throw err;
            }
        } else {
            // Mode 3: Video Only (Muted)
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: videoConstraints,
                    audio: false
                });
            } catch (err) {
                if (err.name === 'NotAllowedError') return;
                throw err;
            }
        }

        // --- Step 4: Build final stream ---
        const videoTrack = screenStream && screenStream.getVideoTracks()[0];
        if (!videoTrack) {
            throw new Error('Nenhuma trilha de vídeo foi capturada.');
        }
        if ('contentHint' in videoTrack) {
            videoTrack.contentHint = contentHintMode;
            console.log(`[WebRTC] videoTrack contentHint set to "${contentHintMode}"`);
        }

        const effectiveAudioTrack = audioTrack || (typeof screenStream.getAudioTracks === 'function' ? screenStream.getAudioTracks()[0] : null);
        if (effectiveAudioTrack && 'contentHint' in effectiveAudioTrack) {
            effectiveAudioTrack.contentHint = 'music';
        }

        if (audioTrack && !screenStream.getAudioTracks().includes(audioTrack)) {
            // Merge video from screen + audio from CABLE
            localStream = new MediaStream([videoTrack, audioTrack]);
        } else {
            localStream = screenStream;
        }

        // --- Step 5: Add Local Tile preview in Grid ---
        const localLabel = currentUserName ? `${currentUserName} (Você)` : 'Você (Sua Tela)';
        const localTile = createStreamTile('local', localStream, localLabel, true);
        localTile.id = 'localStreamTile';
        streamGrid.appendChild(localTile);
        if (typeof startTilePlayback === 'function') {
            startTilePlayback(localTile);
        }

        btnStartShare.hidden = true;
        btnStopShare.hidden = false;
        btnQualityToggle.hidden = false;
        updateGridState();

        // Detect user clicking native "Stop sharing" bar
        localStream.getVideoTracks()[0].onended = () => {
            stopScreenShare();
        };

        // --- Step 6: Send stream to all peers ---
        for (const [peerId, peerObj] of peers.entries()) {
            addLocalTracksToPC(peerObj.pc);
            sendOffer(peerId);
        }

        socket.emit('stream-state', { roomId, state: 'started' });
        startQualityMonitor();
        captureSucceeded = true;

        // Log audio status
        const finalAudioTracks = localStream.getAudioTracks();
        console.log(`[Capture] ✅ Sharing started | Video: yes | Audio: ${finalAudioTracks.length > 0 ? 'yes (' + finalAudioTracks[0].label + ')' : 'no'}`);

    } catch (err) {
        if (!captureSucceeded) {
            if (localStream) {
                try {
                    localStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
                } catch (_) {}
                localStream = null;
            }
            if (screenStream) {
                try {
                    screenStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
                } catch (_) {}
            }
            if (cableStream) {
                try {
                    cableStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
                } catch (_) {}
            }
            if (audioTrack) {
                try { audioTrack.stop(); } catch (_) {}
            }
            if (audioMode === 'exclude_discord' || audioMode === 'app') {
                try { stopAppAudioCapture(); } catch (_) {}
            }
        }
        console.error('[Capture] Error getting display media:', err);
        if (err.name !== 'NotAllowedError') {
            showToast('Não foi possível iniciar o compartilhamento: ' + err.message, 'error');
        }
    } finally {
        startScreenShare._isStarting = false;
    }
}

// Stop Screen Share
btnStopShare.addEventListener('click', stopScreenShare);

function stopScreenShare(options = {}) {
    const silent = Boolean(options && options.silent === true);
    stopQualityMonitor();
    stopAppAudioCapture();

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (!silent) {
        // Clean up transceivers/senders across all active peer connections
        for (const [peerId, peerObj] of peers.entries()) {
            if (peerObj && peerObj.pc) {
                const transceivers = typeof peerObj.pc.getTransceivers === 'function' ? peerObj.pc.getTransceivers() : null;
                if (transceivers) {
                    transceivers.forEach(t => {
                        if (t && t.sender && t.sender.track) {
                            t.sender._kind = t.sender.track.kind;
                            if (t.direction === 'sendrecv') t.direction = 'recvonly';
                            else if (t.direction === 'sendonly') t.direction = 'inactive';
                        }
                    });
                }
                peerObj.pc.getSenders().forEach(sender => {
                    try {
                        if (sender.track && !sender._kind) {
                            sender._kind = sender.track.kind;
                        }
                        Promise.resolve(sender.replaceTrack(null)).catch(() => {});
                    } catch (e) {}
                });
                // Renegotiate so peers drop the remote tile cleanly
                sendOffer(peerId);
            }
        }
    }

    const localTile = document.getElementById('localStreamTile');
    if (localTile) {
        const localVideo = typeof localTile.querySelector === 'function' ? localTile.querySelector('video') : null;
        if (localVideo) localVideo.srcObject = null;
        localTile.remove();
    }

    btnStartShare.hidden = false;
    btnStopShare.hidden = true;
    btnQualityToggle.hidden = true;
    updateGridState();

    if (!silent) {
        socket.emit('stream-state', { roomId, state: 'stopped' });
    }
}

function startTilePlayback(tile, videoEl) {
    const video = videoEl || (tile && typeof tile.querySelector === 'function' ? tile.querySelector('video') : null);
    if (!video || typeof video.play !== 'function') return;

    const playPromise = video.play();
    if (playPromise !== undefined) {
        Promise.resolve(playPromise).catch((e) => {
            if (!video.muted) {
                console.warn('[Playback] Autoplay blocked, forcing muted play for mobile:', e);
                video.muted = true;
                video.setAttribute('muted', '');
                if (typeof tile._syncAudioUi === 'function') {
                    tile._syncAudioUi();
                }
                Promise.resolve(video.play()).catch((err) => console.error('[Playback] Video play failed completely:', err));
                showTapToUnmuteBadge(tile, video);
            }
        });
    }
}

// Create UI Stream Tile for Video Grid
function createStreamTile(id, stream, labelText, isMuted) {
    const tile = document.createElement('div');
    tile.className = 'stream-tile';
    tile.dataset.peerId = id;

    const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
    // Mobile browsers (Android Chrome & iOS Safari) strictly block unmuted video autoplay.
    // Starting with muted=true guarantees immediate hardware decoding and renders frames without black screen.
    const startMuted = isMuted || isMobile;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    if (startMuted) {
        video.muted = true;
        video.defaultMuted = true;
        video.setAttribute('muted', '');
    } else {
        video.muted = false;
    }
    video.srcObject = stream;

    // Tile Header Badge (Live + Name)
    const headerBadge = document.createElement('div');
    headerBadge.className = 'tile-header-badge';
    const liveDot = document.createElement('span');
    liveDot.className = 'live-dot';
    const userNameSpan = document.createElement('span');
    userNameSpan.className = 'user-name';
    userNameSpan.textContent = labelText;
    headerBadge.appendChild(liveDot);
    headerBadge.appendChild(userNameSpan);

    // Tile Controls Overlay (Mute + Volume + Fullscreen)
    const controlsOverlay = document.createElement('div');
    controlsOverlay.className = 'tile-controls-overlay';

    if (!isMuted) {
        let lastNonZeroVolume = 1;

        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = 'btn-icon btn-mute-toggle';
        muteBtn.title = 'Silenciar / Ativar Som';
        if (typeof muteBtn.setAttribute === 'function') {
            muteBtn.setAttribute('aria-label', 'Silenciar / Ativar Som');
        }
        muteBtn.style.width = '32px';
        muteBtn.style.height = '32px';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.05';
        if (typeof slider.setAttribute === 'function') {
            slider.setAttribute('aria-label', 'Volume');
        }

        const syncAudioUi = () => {
            const isCurrentlyMuted = Boolean(video.muted || video.volume === 0);
            slider.value = isCurrentlyMuted ? '0' : String(video.volume > 0 ? video.volume : lastNonZeroVolume);
            muteBtn.innerHTML = isCurrentlyMuted ? '<i class="fa-solid fa-volume-xmark"></i>' : '<i class="fa-solid fa-volume-high"></i>';
        };
        tile._syncAudioUi = syncAudioUi;
        syncAudioUi();

        slider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            video.volume = val;
            if (val > 0) {
                lastNonZeroVolume = val;
                video.muted = false;
                video.removeAttribute('muted');
                if (typeof tile._cleanupTapUnmute === 'function') {
                    tile._cleanupTapUnmute();
                } else {
                    const badge = tile.querySelector('.tap-unmute-badge');
                    if (badge) badge.remove();
                }
            } else {
                video.muted = true;
            }
            muteBtn.innerHTML = (val === 0 || video.muted) ? '<i class="fa-solid fa-volume-xmark"></i>' : '<i class="fa-solid fa-volume-high"></i>';
        });

        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!video.muted && video.volume > 0) {
                lastNonZeroVolume = video.volume > 0 ? video.volume : (parseFloat(slider.value) > 0 ? parseFloat(slider.value) : lastNonZeroVolume);
                video.muted = true;
                slider.value = '0';
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
            } else {
                video.muted = false;
                video.removeAttribute('muted');
                const prevVal = parseFloat(slider.value);
                const targetVol = prevVal > 0 ? prevVal : (lastNonZeroVolume > 0 ? lastNonZeroVolume : 1);
                video.volume = targetVol;
                slider.value = targetVol.toString();
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
                if (typeof tile._cleanupTapUnmute === 'function') {
                    tile._cleanupTapUnmute();
                } else {
                    const badge = tile.querySelector('.tap-unmute-badge');
                    if (badge) badge.remove();
                }
            }
        });

        controlsOverlay.appendChild(muteBtn);
        controlsOverlay.appendChild(slider);
    }

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'btn-icon';
    fsBtn.style.width = '32px';
    fsBtn.style.height = '32px';
    fsBtn.title = 'Tela Cheia';
    if (typeof fsBtn.setAttribute === 'function') {
        fsBtn.setAttribute('aria-label', 'Tela Cheia');
    }
    fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTileFullscreen(tile, video);
    });
    controlsOverlay.appendChild(fsBtn);

    // Double tap/click to fullscreen
    tile.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        toggleTileFullscreen(tile, video);
    });

    tile.appendChild(video);
    tile.appendChild(headerBadge);
    tile.appendChild(controlsOverlay);

    // Quality signal badge (remote tiles only)
    if (!isMuted) {
        const qosBadge = document.createElement('div');
        qosBadge.className = 'tile-quality-badge';
        qosBadge.innerHTML = '<span class="qos-dot good"></span><span class="qos-label">Bom</span>';
        tile.appendChild(qosBadge);

        if (isMobile) {
            showTapToUnmuteBadge(tile, video);
        }
    }

    return tile;
}

// Universal Fullscreen Handler for Mobile & Desktop

// Show Tap-to-Unmute for mobile browsers that block autoplay with sound

// Update Grid Layout State
function updateGridState() {
    const tiles = streamGrid.querySelectorAll('.stream-tile');
    const count = tiles.length;

    emptyGridPlaceholder.hidden = (count > 0);
    activeStreamsText.textContent = `${count} ${count === 1 ? 'Transmissão Ativa' : 'Transmissões Ativas'}`;
    streamGrid.dataset.count = count;

    if (count > 0 || localStream) {
        startQualityMonitor();
    } else {
        stopQualityMonitor();
    }
}

// Copy Invite Link
const defaultCopyLinkHtml = btnCopyLink ? btnCopyLink.innerHTML : '';
let copyLinkResetTimer = null;

if (btnCopyLink) {
    btnCopyLink.addEventListener('click', () => {
        if (!roomId) {
            showToast('Entre ou crie uma sala antes de copiar o link de convite.', 'warning');
            return;
        }
        let inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
        if (currentRoomPassword) {
            inviteUrl += `#pass=${encodeURIComponent(currentRoomPassword)}`;
        }
        navigator.clipboard.writeText(inviteUrl).then(() => {
            if (copyLinkResetTimer) {
                clearTimeout(copyLinkResetTimer);
                copyLinkResetTimer = null;
            }
            btnCopyLink.innerHTML = '<i class="fa-solid fa-check"></i> <span class="btn-text">Link Copiado!</span>';
            copyLinkResetTimer = setTimeout(() => {
                btnCopyLink.innerHTML = defaultCopyLinkHtml;
                copyLinkResetTimer = null;
            }, 2000);
        }).catch(() => {
            // Fallback se a API de clipboard do navegador falhar
            showToast('Não foi possível copiar automaticamente. Acesse: ' + inviteUrl, 'warning', 6000);
        });
    });
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (shareConfigModal && !shareConfigModal.hidden && shareConfigModal.style.display !== 'none') {
            closeShareConfigModal();
            return;
        }
        if (statsModal && !statsModal.hidden && statsModal.style.display !== 'none') {
            closeStatsModal();
            return;
        }
        if (!roomModal.hidden && roomModal.style.display !== 'none') {
            if (roomViewChoice && roomViewChoice.style.display === 'none') {
                switchRoomView('choice');
            } else if (roomId) {
                closeRoomModal();
            }
        }
    }
});

function teardownClientSession() {
    try {
        if (typeof stopIceRefreshTimer === 'function') stopIceRefreshTimer();
        stopQualityMonitor();
        if (statsUpdateInterval) {
            clearInterval(statsUpdateInterval);
            statsUpdateInterval = null;
        }
        cleanupRoomState({ silent: true });
        if (socket && socket.connected) {
            socket.disconnect();
        }
    } catch (_) {}
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', teardownClientSession);
}


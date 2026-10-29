// ==========================================
// Rust Audio Helper (WASAPI Application Loopback)
// ==========================================
const HELPER_AUTH_TOKEN_KEY = 'streamgrid_helper_auth_token';
let helperAuthToken = null;
try {
    helperAuthToken = sessionStorage.getItem(HELPER_AUTH_TOKEN_KEY);
} catch (_) {}

if (!helperAuthToken) {
    helperAuthToken = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'sg_tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    try {
        sessionStorage.setItem(HELPER_AUTH_TOKEN_KEY, helperAuthToken);
    } catch (_) {}
}
let helperWs = null;
let helperConnected = false;
let helperConnectAttempts = 0;
let availableWindows = [];
let helperAudioContext = null;
let activeAudioWorkletNode = null;
let helperAudioDestination = null;

async function spawnAudioHelperIfNeutralino() {
    if (typeof Neutralino !== 'undefined' && Neutralino.os) {
        try {
            const appPath = (typeof NL_PATH !== 'undefined' && NL_PATH) ? NL_PATH : '.';
            const parentPid = (typeof NL_PID !== 'undefined' && NL_PID) ? NL_PID : 0;
            console.log('[AudioHelper] Spawning helper process (parent PID:', parentPid, ')...');
            await Neutralino.os.spawnProcess(`"${appPath}/bin/streamgrid-audio-helper.exe" --port 45454 --parent-pid ${parentPid} --token "${helperAuthToken}"`);
        } catch(err) {
            console.log('[AudioHelper] Spawn attempt note:', err.message || err);
        }
    }
}

function connectAudioHelper() {
    if (helperWs && (helperWs.readyState === WebSocket.OPEN || helperWs.readyState === WebSocket.CONNECTING)) {
        return;
    }
    try {
        helperWs = new WebSocket('ws://127.0.0.1:45454');
        helperWs.binaryType = 'arraybuffer';

        helperWs.onopen = () => {
            console.log('[AudioHelper] 🔌 Conexão estabelecida com Helper WASAPI. Autenticando...');
            helperConnected = false;
            // Envia o token de autenticação imediatamente
            helperWs.send(JSON.stringify({ type: 'auth', token: helperAuthToken }));
        };

        helperWs.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                if (activeAudioWorkletNode) {
                    const float32Data = new Float32Array(event.data);
                    activeAudioWorkletNode.port.postMessage(float32Data);
                }
                return;
            }

            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'auth_ok') {
                    console.log('[AudioHelper] 🛡️ Autenticação aceita pelo Helper!');
                    helperConnected = true;
                    helperConnectAttempts = 0; // Conectado com sucesso, reseta contador
                    checkDiscordStatus();
                    fetchWindowList();
                    if (!window._helperPingInterval) {
                        window._helperPingInterval = setInterval(() => {
                            if (helperWs && helperWs.readyState === WebSocket.OPEN) {
                                helperWs.send(JSON.stringify({ type: String.fromCharCode(112,105,110,103) }));
                            }
                        }, 1500);
                    }
                } else if (msg.type === 'auth_failed') {
                    console.error('[AudioHelper] ❌ Falha na autenticação do Helper:', msg.error);
                    helperConnected = false;
                    try { sessionStorage.removeItem(HELPER_AUTH_TOKEN_KEY); } catch (_) {}
                    helperAuthToken = null;
                    helperConnectAttempts = 10; // Força recuo para permitir encerramento do watchdog (2,5s)
                    try { helperWs.close(); } catch(e) {}
                    setTimeout(() => {
                        helperAuthToken = (typeof crypto !== 'undefined' && crypto.randomUUID)
                            ? crypto.randomUUID()
                            : 'sg_tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
                        try { sessionStorage.setItem(HELPER_AUTH_TOKEN_KEY, helperAuthToken); } catch (_) {}
                        spawnAudioHelperIfNeutralino();
                    }, 3500);
                } else if (msg.type === 'windows_list') {
                    availableWindows = msg.windows || [];
                    updateAudioAppSelect(availableWindows);
                } else if (msg.type === 'discord_status') {
                    const badge = document.getElementById('discordStatusBadge');
                    if (badge) {
                        if (msg.detected) {
                            badge.style.color = '#3ba55d';
                            badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Discord detectado (PID ${msg.pid}) — Chamadas serão excluídas do stream`;
                        } else {
                            badge.style.color = '#faa81a';
                            badge.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Discord Desktop não detectado (inicie-o para isolar a chamada)`;
                        }
                    }
                } else if (msg.type === 'capture_started') {
                    const modeDesc = msg.mode === 'exclude' ? 'Exclusão do Discord' : 'Aplicativo Isolado';
                    console.log(`[AudioHelper] ✅ Captura iniciada no modo [${modeDesc}] para PID ${msg.pid} (${msg.sample_rate}Hz, ${msg.channels} canais)`);
                } else if (msg.type === 'error') {
                    console.error('[AudioHelper] Erro relatado pelo helper:', msg.message);
                    showToast('Aviso de Áudio: ' + msg.message, 'warning');
                }
            } catch(e) {}
        };

        helperWs.onclose = () => {
            helperConnected = false;
            // Retry rápido nos primeiros 2s (250ms) para conexão instantânea ao abrir o app
            const retryDelay = helperConnectAttempts < 6 ? 250 : 3000;
            helperConnectAttempts++;
            setTimeout(connectAudioHelper, retryDelay);
        };
        helperWs.onerror = () => {
            helperConnected = false;
        };
    } catch(e) {
        console.warn('[AudioHelper] Erro ao conectar ao WebSocket do helper:', e);
    }
}

function checkDiscordStatus() {
    if (helperWs && helperWs.readyState === WebSocket.OPEN) {
        helperWs.send(JSON.stringify({ type: 'get_discord_status' }));
    }
}

function fetchWindowList() {
    if (helperWs && helperWs.readyState === WebSocket.OPEN) {
        helperWs.send(JSON.stringify({ type: 'list_windows' }));
    }
}

function updateAudioAppSelect(windows) {
    const select = document.getElementById('selectAudioApp');
    if (!select) return;

    select.innerHTML = '';
    if (!windows || windows.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Nenhuma janela compatível encontrada';
        select.appendChild(opt);
        return;
    }

    windows.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.pid;
        const exeInfo = w.exe ? ` [${w.exe}]` : '';
        const titleTrimmed = w.title.length > 40 ? w.title.substring(0, 37) + '...' : w.title;
        opt.textContent = `${titleTrimmed}${exeInfo}`;
        select.appendChild(opt);
    });
}

async function startAppAudioCapture(pid) {
    if (!helperConnected || !helperWs) {
        throw new Error('Helper de áudio não conectado. Inicie o streamgrid-audio-helper.exe.');
    }

    if (!helperAudioContext || helperAudioContext.state === 'closed') {
        helperAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    } else if (helperAudioContext.state === 'suspended') {
        await helperAudioContext.resume();
    }

    try {
        await helperAudioContext.audioWorklet.addModule('js/audio-worklet-processor.js');
    } catch(e) {
        console.log('[AudioWorklet] Módulo já carregado ou pronto');
    }

    if (activeAudioWorkletNode) {
        try { activeAudioWorkletNode.disconnect(); } catch(e) {}
    }

    activeAudioWorkletNode = new AudioWorkletNode(helperAudioContext, 'pcm-ring-buffer-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
    });
    helperAudioDestination = helperAudioContext.createMediaStreamDestination();
    activeAudioWorkletNode.connect(helperAudioDestination);

    helperWs.send(JSON.stringify({ type: 'start_capture', pid: Number(pid) }));
    return helperAudioDestination.stream.getAudioTracks()[0];
}

async function startExcludeDiscordCapture() {
    if (!helperConnected || !helperWs) {
        throw new Error('Helper de áudio não conectado. Inicie o streamgrid-audio-helper.exe.');
    }

    if (!helperAudioContext || helperAudioContext.state === 'closed') {
        helperAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    } else if (helperAudioContext.state === 'suspended') {
        await helperAudioContext.resume();
    }

    try {
        await helperAudioContext.audioWorklet.addModule('js/audio-worklet-processor.js');
    } catch(e) {
        console.log('[AudioWorklet] Módulo já carregado ou pronto');
    }

    if (activeAudioWorkletNode) {
        try { activeAudioWorkletNode.disconnect(); } catch(e) {}
    }

    activeAudioWorkletNode = new AudioWorkletNode(helperAudioContext, 'pcm-ring-buffer-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
    });
    helperAudioDestination = helperAudioContext.createMediaStreamDestination();
    activeAudioWorkletNode.connect(helperAudioDestination);

    helperWs.send(JSON.stringify({ type: 'start_exclude_discord' }));
    return helperAudioDestination.stream.getAudioTracks()[0];
}

function stopAppAudioCapture() {
    if (helperWs && helperWs.readyState === WebSocket.OPEN) {
        helperWs.send(JSON.stringify({ type: 'stop_capture' }));
    }
    if (activeAudioWorkletNode) {
        try {
            activeAudioWorkletNode.port.postMessage({ type: 'flush' });
            activeAudioWorkletNode.disconnect();
        } catch(e) {}
        activeAudioWorkletNode = null;
    }
    if (helperAudioContext && helperAudioContext.state !== 'closed') {
        helperAudioContext.suspend().catch(() => {});
    }
}

if (typeof Neutralino !== 'undefined') {
    try {
        Neutralino.init();

        // Encerramento limpo de todos os subprocessos ao fechar a janela
        if (Neutralino.events && Neutralino.events.on) {
            Neutralino.events.on('windowClose', async () => {
                console.log('[Neutralino] Janela fechada. Encerrando processos...');
                try {
                    if (helperWs && helperWs.readyState === WebSocket.OPEN) {
                        helperWs.send(JSON.stringify({ type: 'shutdown' }));
                        helperWs.close();
                    }
                } catch(e) {}
                // Garantia final: encerra o app Neutralino
                try {
                    await new Promise(r => setTimeout(r, 80));
                await Neutralino.app.exit();
                } catch(e) {}
            });
        }

        spawnAudioHelperIfNeutralino();
        // Pequena pausa de 120ms para o processo do helper subir a porta antes da primeira conexão
        setTimeout(connectAudioHelper, 120);
    } catch(e) {
        connectAudioHelper();
    }
} else {
    connectAudioHelper();
}

const SERVER_URL = (window.location.protocol.startsWith('http') && !window.location.hostname.includes('localhost') && window.location.hostname !== '127.0.0.1')
    ? window.location.origin
    : 'https://screenshare-p2p.onrender.com';

const socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// STUN + TURN servers for high NAT/CGNAT penetration (essential for Brazilian fiber ISPs)
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        // Free TURN relay (Metered.ca Open Relay) — fallback when STUN fails behind symmetric NAT/CGNAT
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 4
};

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
let myId = '';
let localStream = null;

// Map of remote peers: peerId -> { pc, stream, tileEl, iceCandidateQueue, isRemoteDescriptionSet }
const peers = new Map();

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
function getOrCreateToastContainer() {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    return container;
}

function showToast(message, type = 'info', durationMs = 4000) {
    if (!message) return;
    const container = getOrCreateToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconClass = 'fa-solid fa-circle-info';
    if (type === 'error') iconClass = 'fa-solid fa-circle-xmark';
    else if (type === 'warning') iconClass = 'fa-solid fa-triangle-exclamation';
    else if (type === 'success') iconClass = 'fa-solid fa-circle-check';

    const iconEl = document.createElement('i');
    iconEl.className = `${iconClass} toast-icon`;

    const messageEl = document.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.type = 'button';
    closeBtn.title = 'Fechar notificação';
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';

    let timeoutId = null;
    const dismiss = () => {
        if (timeoutId) clearTimeout(timeoutId);
        toast.classList.add('hiding');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 250);
    };

    closeBtn.addEventListener('click', dismiss);
    if (durationMs > 0) {
        timeoutId = setTimeout(dismiss, durationMs);
    }

    toast.appendChild(iconEl);
    toast.appendChild(messageEl);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
}

// ==========================================
// Subtle Audio Chime for Presence (Web Audio API)
// ==========================================
function playPresenceChime(type = 'join') {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!window._presenceAudioCtx) {
            window._presenceAudioCtx = new AudioCtx();
        }
        const ctx = window._presenceAudioCtx;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        if (type === 'join') {
            // Dois tons ascendentes suaves (440Hz -> 587.33Hz)
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(587.33, now + 0.12);
        } else {
            // Dois tons descendentes suaves (587.33Hz -> 392Hz)
            osc.frequency.setValueAtTime(587.33, now);
            osc.frequency.exponentialRampToValueAtTime(392, now + 0.12);
        }

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(0.05, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.23);
    } catch (_) {}
}

const btnThemeToggle = document.getElementById('btnThemeToggle');
const THEME_KEY = 'streamgrid_theme';

// Theme Management (Light / Dark)
function initTheme() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem(THEME_KEY); } catch(e) {}
    
    if (!savedTheme) {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        savedTheme = prefersDark ? 'dark' : 'light';
    }
    applyTheme(savedTheme);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) {}
    
    if (btnThemeToggle) {
        if (theme === 'dark') {
            btnThemeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
            btnThemeToggle.title = 'Mudar para Tema Claro';
        } else {
            btnThemeToggle.innerHTML = '<i class="fa-solid fa-moon"></i>';
            btnThemeToggle.title = 'Mudar para Tema Escuro';
        }
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
}

if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', toggleTheme);
}
initTheme();

// Error Banner Helpers
function sanitizeRoomId(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .trim()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-+/g, '-')
        .slice(0, 64);
}

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
function generateRandomRoomId() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    const array = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(array);
    } else {
        for (let i = 0; i < 8; i++) array[i] = Math.floor(Math.random() * 256);
    }
    for (let i = 0; i < 8; i++) {
        code += chars[array[i] % chars.length];
    }
    return `grid-${code.slice(0, 4)}-${code.slice(4)}`;
}

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
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    const passParam = urlParams.get('pass');
    
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
            joinRoom(clean, passParam || '');
        } else {
            openRoomModal('join');
            showRoomError('Código de sala na URL inválido.');
        }
    } else if (savedRoom) {
        const clean = sanitizeRoomId(savedRoom);
        if (inputJoinRoomId) inputJoinRoomId.value = clean;
        if (clean.length >= 3) {
            joinRoom(clean);
        } else {
            try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
            openRoomModal('choice');
        }
    } else {
        openRoomModal('choice');
    }
});

function cleanupRoomState() {
    console.log('[Room] Cleaning up previous room peer connections and stream tiles...');
    
    // 1. Stop local screen share if active
    if (localStream) {
        stopScreenShare();
    }

    // 2. Terminate and cleanup all active WebRTC peer connections from old room
    for (const [peerId, peerObj] of peers.entries()) {
        try {
            if (peerObj.stream) {
                peerObj.stream.getTracks().forEach(track => track.stop());
            }
            if (peerObj.pc) {
                peerObj.pc.close();
            }
            if (peerObj.tileEl) {
                peerObj.tileEl.remove();
            }
        } catch (e) {
            console.warn('[Room] Error closing peer:', peerId, e);
        }
    }
    peers.clear();

    // 3. Remove all remote stream tiles from DOM
    const remoteTiles = streamGrid.querySelectorAll('.stream-tile:not(#localStreamTile)');
    remoteTiles.forEach(tile => tile.remove());

    // 4. Reset participant count and grid state
    updateMemberCount(1);
    updateGridState();
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
    currentRoomPassword = (targetPass || '').trim();
    if (targetUserName) {
        currentUserName = targetUserName.trim().slice(0, 24);
        try { localStorage.setItem(USERNAME_KEY, currentUserName); } catch (_) {}
    }

    // If switching rooms, close all previous connections cleanly
    if (roomId && roomId !== newRoomId) {
        cleanupRoomState();
    }

    roomId = newRoomId;

    // Persist room in localStorage
    try { localStorage.setItem(STORAGE_KEY, roomId); } catch(e) {}

    // Update browser URL query parameter if running on Web
    if (window.location.protocol.startsWith('http') && window.history.pushState) {
        try {
            const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
            window.history.pushState({ path: newUrl }, '', newUrl);
        } catch(e) {}
    }

    displayRoomId.textContent = roomId;
    roomModal.style.display = 'none';
    roomModal.classList.add('hidden');
    roomModal.hidden = true;
    updateRoomModalCloseButton();

    if (socket) {
        socket.emit('join-room', { roomId, clientId, password: currentRoomPassword, userName: currentUserName });
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

// Socket Lifecycle Events
socket.on('connect', () => {
    myId = socket.id;
    console.log('[Socket] Connected to server. Socket ID:', myId);
    if (roomId) {
        console.log('[Socket] Joining room on connect:', roomId);
        socket.emit('join-room', { roomId, clientId, password: currentRoomPassword, userName: currentUserName });
    }
});

socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected from server:', reason);
});

// Authentication and Room Error Handler
socket.on('join-error', ({ error, message }) => {
    console.warn('[Auth] Join error:', error, message);
    openRoomModal('join');
    if (error === 'invalid_password') {
        if (inputJoinRoomId) inputJoinRoomId.value = roomId || '';
        showRoomError(message || 'Senha incorreta para esta sala.');
        if (inputJoinRoomPassword) {
            inputJoinRoomPassword.focus();
            inputJoinRoomPassword.select();
        }
    } else if (error === 'invalid_room' || error === 'invalid_password_format') {
        roomId = '';
        try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
        if (window.history && window.history.replaceState) {
            try { window.history.replaceState({}, '', window.location.pathname); } catch(e) {}
        }
        showRoomError(message || 'Código de sala ou formato inválido.');
    } else if (error === 'rate_limited') {
        showRoomError(message || 'Muitas tentativas incorretas. Aguarde antes de tentar novamente.');
    } else {
        showRoomError(message || 'Erro ao entrar na sala.');
    }
});

// Socket Events
socket.on('room-users', async ({ users, userNames, activeStreams, socketId, memberCount, hasPassword }) => {
    myId = socketId;
    console.log('[Socket] Joined room. My ID:', myId, 'Other users:', users, 'Active streams:', activeStreams);
    remoteActiveStreams.clear();
    if (Array.isArray(activeStreams)) {
        activeStreams.forEach(id => { if (id !== myId) remoteActiveStreams.add(id); });
    }
    updateEchoWarningVisibility();

    // Sync member count immediately for the joiner
    updateMemberCount(memberCount || (users.length + 1));

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
    users.forEach(peerId => {
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
    }
});

socket.on('user-joined', async ({ socketId, userName, memberCount }) => {
    console.log('[Socket] User joined:', socketId, userName);
    const pc = getOrCreatePeerConnection(socketId);
    if (userName) updatePeerUserName(socketId, userName);
    const displayName = userName || 'Um participante';
    showToast(`${displayName} entrou na sala.`, 'info');
    playPresenceChime('join');
    updateMemberCount(memberCount);

    // Sincronização Automática (Late-Joiner Sync):
    // Se eu já estiver compartilhando a tela, envio oferta com minha transmissão ao novo usuário!
    if (localStream) {
        addLocalTracksToPC(pc);
        sendOffer(socketId);
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
    removePeerConnection(socketId);
    updateMemberCount(memberCount);
});

socket.on('room-status', ({ memberCount }) => {
    updateMemberCount(memberCount);
});

function updateMemberCount(count) {
    memberCountText.textContent = `${count} ${count === 1 ? 'Participante' : 'Participantes'}`;
}

// Perfect Negotiation Offer Dispatcher (Avoids Glare / Dual-Offer collisions)
async function sendOffer(peerId) {
    const peerObj = peers.get(peerId);
    if (!peerObj || !peerObj.pc) return;
    const pc = peerObj.pc;

    // Guard: Prevent concurrent offer collisions (glare) and offers during unstable signaling states
    if (peerObj.makingOffer || pc.signalingState !== 'stable') {
        console.warn(`[WebRTC] Skipping offer dispatch to ${peerId} (makingOffer: ${peerObj.makingOffer}, signalingState: ${pc.signalingState})`);
        return;
    }

    try {
        peerObj.makingOffer = true;
        let offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        offer = new RTCSessionDescription({
            type: offer.type,
            sdp: optimizeSDP(offer.sdp)
        });
        await pc.setLocalDescription(offer);
        socket.emit('signal', { targetId: peerId, signal: pc.localDescription });
    } catch (err) {
        console.error('[WebRTC] Error sending offer to peer:', peerId, err);
    } finally {
        peerObj.makingOffer = false;
    }
}

// Targeted WebRTC Signal Receiver with Perfect Negotiation & Candidate Queueing
socket.on('signal', async ({ senderId, signal }) => {
    const pc = getOrCreatePeerConnection(senderId);
    const peerObj = peers.get(senderId);
    if (!peerObj) return;

    try {
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
                try {
                    await pc.setLocalDescription({ type: 'rollback' });
                } catch (e) {
                    console.warn('[WebRTC] Rollback error:', e);
                }
            }

            peerObj.isRemoteDescriptionSet = false;
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            peerObj.isRemoteDescriptionSet = true;

            // Flush buffered candidates
            while (peerObj.iceCandidateQueue.length > 0) {
                const cand = peerObj.iceCandidateQueue.shift();
                try { await pc.addIceCandidate(cand); } catch(e) {}
            }

            // If I am broadcasting, ensure my tracks are attached to this peer connection
            if (localStream) {
                addLocalTracksToPC(pc);
            }

            let answer = await pc.createAnswer();
            answer = new RTCSessionDescription({
                type: answer.type,
                sdp: optimizeSDP(answer.sdp)
            });
            await pc.setLocalDescription(answer);
            socket.emit('signal', { targetId: senderId, signal: pc.localDescription });

        } else if (signal.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                peerObj.isRemoteDescriptionSet = true;
                // Flush buffered candidates
                while (peerObj.iceCandidateQueue.length > 0) {
                    const cand = peerObj.iceCandidateQueue.shift();
                    try { await pc.addIceCandidate(cand); } catch(e) {}
                }
            }
        } else if (signal.candidate) {
            const candidate = new RTCIceCandidate(signal.candidate);
            if (pc.remoteDescription && pc.remoteDescription.type && peerObj && peerObj.isRemoteDescriptionSet) {
                try {
                    await pc.addIceCandidate(candidate);
                } catch (err) {
                    console.warn('[WebRTC] Candidate error:', err);
                }
            } else if (peerObj) {
                // Buffer candidate until remote description is processed
                peerObj.iceCandidateQueue.push(candidate);
            }
        }
    } catch (err) {
        console.error('[WebRTC] Signal handling error:', err);
    }
});

// Track active remote screen streams for anti-echo detection
const remoteActiveStreams = new Set();

// Broadcast Stream State Changes
socket.on('stream-state', ({ senderId, state }) => {
    if (state === 'started') {
        remoteActiveStreams.add(senderId);
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
            warningEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>${message || 'Falha de conexão direta P2P.'}</span>`;
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
        ignoreOffer: false
    };
    peers.set(peerId, peerObj);

    // ICE Candidate Handler
    pc.onicecandidate = (event) => {
        if (event.candidate) {
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
            const videoEl = peerObj.tileEl.querySelector('video');
            if (videoEl) {
                if (videoEl.srcObject !== peerObj.stream) {
                    videoEl.srcObject = peerObj.stream;
                }
                const playPromise = videoEl.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => {
                        console.warn('[Playback] Autoplay blocked, forcing muted play for mobile:', e);
                        videoEl.muted = true;
                        videoEl.setAttribute('muted', '');
                        videoEl.play().catch(err => console.error('[Playback] Video play failed completely:', err));
                        showTapToUnmuteBadge(peerObj.tileEl, videoEl);
                    });
                }
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
                removeStreamTile(peerId);
            }
        };

        updateGridState();
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] ICE state (${peerId}):`, pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            if (peerObj._iceRestartTimeout) clearTimeout(peerObj._iceRestartTimeout);
            peerObj._iceRestartTimeout = setTimeout(() => {
                if ((pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') && localStream) {
                    console.log(`[WebRTC] Triggering active ICE restart for: ${peerId}`);
                    if (pc.restartIce) pc.restartIce();
                    sendOffer(peerId);
                }
            }, 2000);
            if (pc.iceConnectionState === 'failed') {
                setPeerConnectionStatus(peerId, 'failed', 'Falha de conexão P2P: Firewall ou rede restrita bloqueando tráfego.');
            }
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            if (peerObj._iceRestartTimeout) {
                clearTimeout(peerObj._iceRestartTimeout);
                peerObj._iceRestartTimeout = null;
            }
            setPeerConnectionStatus(peerId, 'ok');
            logPeerConnectionTelemetry(peerId, pc);
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
function prioritizeH264(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    const lines = sdp.split('\r\n');
    const mVideoIndex = lines.findIndex(l => l.startsWith('m=video'));
    if (mVideoIndex === -1) return sdp;

    // Map payload -> profile-level-id from a=fmtp lines
    const payloadProfiles = new Map();
    for (const line of lines) {
        if (line.startsWith('a=fmtp:')) {
            const match = line.match(/^a=fmtp:(\d+)\s+.*profile-level-id=([0-9a-fA-F]+)/i);
            if (match) {
                payloadProfiles.set(match[1], match[2].toLowerCase());
            }
        }
    }

    const h264Payloads = [];
    for (const line of lines) {
        if (line.startsWith('a=rtpmap:') && line.toLowerCase().includes('h264/90000')) {
            const parts = line.split(' ')[0].split(':');
            if (parts[1]) {
                h264Payloads.push(parts[1]);
            }
        }
    }

    if (h264Payloads.length === 0) return sdp;

    // Prioritize 42e01f (Constrained Baseline) first so Android & iOS mobile devices can decode in hardware
    h264Payloads.sort((a, b) => {
        const profA = payloadProfiles.get(a) || '';
        const profB = payloadProfiles.get(b) || '';
        const isBaselineA = profA.includes('42e0');
        const isBaselineB = profB.includes('42e0');
        if (isBaselineA && !isBaselineB) return -1;
        if (!isBaselineA && isBaselineB) return 1;
        return 0;
    });

    const mVideoParts = lines[mVideoIndex].split(' ');
    const header = mVideoParts.slice(0, 3);
    const currentPayloads = mVideoParts.slice(3);

    const reordered = [
        ...h264Payloads.filter(pt => currentPayloads.includes(pt)),
        ...currentPayloads.filter(pt => !h264Payloads.includes(pt))
    ];

    lines[mVideoIndex] = [...header, ...reordered].join(' ');
    return lines.join('\r\n');
}

// SDP Optimization Helper (Unlocks Smooth 1080p60 Bitrate & Stereo Audio without Freezes)
function optimizeSDP(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    sdp = prioritizeH264(sdp);
    const lines = sdp.split('\r\n');

    // 1. Mapear payloads para Opus e Codecs de Vídeo via linhas a=rtpmap
    const opusPayloads = new Set();
    const videoPayloads = new Set();
    const existingFmtpPayloads = new Set();

    for (const line of lines) {
        if (line.startsWith('a=rtpmap:')) {
            const match = line.match(/^a=rtpmap:(\d+)\s+([^\/]+)/i);
            if (match) {
                const pt = match[1];
                const codec = match[2].toLowerCase();
                if (codec === 'opus') {
                    opusPayloads.add(pt);
                } else if (codec === 'h264' || codec === 'vp8' || codec === 'vp9') {
                    videoPayloads.add(pt);
                }
            }
        } else if (line.startsWith('a=fmtp:')) {
            const match = line.match(/^a=fmtp:(\d+)/i);
            if (match) {
                existingFmtpPayloads.add(match[1]);
            }
        }
    }

    const newLines = [];
    let inVideoSection = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        if (line.startsWith('m=video')) {
            inVideoSection = true;
            newLines.push(line);
            newLines.push('b=AS:6000');
            newLines.push('b=TIAS:6000000');
            continue;
        } else if (line.startsWith('m=')) {
            inVideoSection = false;
        }

        // Evitar linhas duplicadas de banda na seção de vídeo
        if (inVideoSection && (line.startsWith('b=AS:') || line.startsWith('b=TIAS:'))) {
            continue;
        }

        // Atualizar linhas a=fmtp existentes
        if (line.startsWith('a=fmtp:')) {
            const match = line.match(/^a=fmtp:(\d+)/i);
            if (match) {
                const pt = match[1];
                if (opusPayloads.has(pt)) {
                    if (!line.includes('stereo=1')) {
                        line += ';stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
                    }
                } else if (videoPayloads.has(pt)) {
                    if (!line.includes('x-google-max-bitrate')) {
                        line += ';x-google-min-bitrate=1800;x-google-start-bitrate=3500;x-google-max-bitrate=6000';
                    }
                }
            }
            newLines.push(line);
            continue;
        }

        newLines.push(line);

        // Se o rtpmap não tinha a=fmtp associado originalmente, injetar logo após a=rtpmap
        if (line.startsWith('a=rtpmap:')) {
            const match = line.match(/^a=rtpmap:(\d+)/i);
            if (match) {
                const pt = match[1];
                if (!existingFmtpPayloads.has(pt)) {
                    if (opusPayloads.has(pt)) {
                        newLines.push(`a=fmtp:${pt} stereo=1;sprop-stereo=1;maxaveragebitrate=128000`);
                        existingFmtpPayloads.add(pt);
                    } else if (videoPayloads.has(pt)) {
                        newLines.push(`a=fmtp:${pt} x-google-min-bitrate=1800;x-google-start-bitrate=3500;x-google-max-bitrate=6000`);
                        existingFmtpPayloads.add(pt);
                    }
                }
            }
        }
    }

    return newLines.join('\r\n');
}

function removePeerConnection(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        if (peerObj.stream) {
            peerObj.stream.getTracks().forEach(track => track.stop());
        }
        if (peerObj.pc) peerObj.pc.close();
        if (peerObj.tileEl) {
            const videoEl = peerObj.tileEl.querySelector('video');
            if (videoEl) videoEl.srcObject = null;
            peerObj.tileEl.remove();
        }
        peers.delete(peerId);
        updateGridState();
    }
}

function removeStreamTile(peerId) {
    if (peers.has(peerId)) {
        const peerObj = peers.get(peerId);
        if (peerObj.tileEl) {
            const videoEl = peerObj.tileEl.querySelector('video');
            if (videoEl) videoEl.srcObject = null;
            peerObj.tileEl.remove();
            peerObj.tileEl = null;
        }
        if (peerObj.stream) {
            peerObj.stream.getTracks().forEach(t => t.stop());
        }
        peerObj.stream = new MediaStream();
        updateGridState();
    }
}

function addLocalTracksToPC(pc) {
    if (!pc || !localStream) return;
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
        const existingSender = senders.find(s => s.track && (s.track.id === track.id || s.track.kind === track.kind));
        if (existingSender) {
            if (existingSender.track !== track) {
                try { existingSender.replaceTrack(track); } catch (e) {}
            }
            configureSenderParams(existingSender, track.kind);
        } else {
            const sender = pc.addTrack(track, localStream);
            configureSenderParams(sender, track.kind);
        }
    });
}

const VIDEO_RES_KEY = 'streamgrid_video_resolution';
const VIDEO_FPS_KEY = 'streamgrid_video_fps';
let selectedVideoResolution = '1080p';
let selectedVideoFps = 60;
try {
    const savedRes = localStorage.getItem(VIDEO_RES_KEY);
    if (savedRes === '720p' || savedRes === '1080p') selectedVideoResolution = savedRes;
    const savedFps = Number(localStorage.getItem(VIDEO_FPS_KEY));
    if (savedFps === 30 || savedFps === 60) selectedVideoFps = savedFps;
} catch (_) {}

function getVideoConstraints(resolution = '1080p', fps = 60) {
    const is720p = resolution === '720p';
    const targetFps = Number(fps) === 30 ? 30 : 60;
    const targetWidth = is720p ? 1280 : 1920;
    const targetHeight = is720p ? 720 : 1080;

    return {
        width: { ideal: targetWidth, max: targetWidth },
        height: { ideal: targetHeight, max: targetHeight },
        frameRate: { ideal: targetFps, max: targetFps }
    };
}

function getMaxBitrateForPeerCount(count = (typeof peers !== 'undefined' ? peers.size : 1), resolution = selectedVideoResolution, fps = selectedVideoFps) {
    const is720p = resolution === '720p';
    const is30fps = Number(fps) === 30;

    let baseBitrate;
    if (is720p) {
        baseBitrate = is30fps ? 1800000 : 2800000;
    } else {
        baseBitrate = is30fps ? 4000000 : 6000000;
    }

    const peerCount = typeof count === 'number' ? count : 1;
    if (peerCount <= 1) return baseBitrate;
    if (peerCount === 2) return Math.round(baseBitrate * 0.75);
    return Math.round(baseBitrate * 0.58);
}

function configureSenderParams(sender, kind) {
    if (kind === 'video' && sender && typeof sender.getParameters === 'function') {
        try {
            const params = sender.getParameters();
            params.degradationPreference = 'maintain-resolution';
            if (params.encodings && params.encodings[0]) {
                params.encodings[0].maxBitrate = getMaxBitrateForPeerCount(typeof peers !== 'undefined' ? peers.size : 1, selectedVideoResolution, selectedVideoFps);
                params.encodings[0].maxFramerate = Number(selectedVideoFps);
            }
            sender.setParameters(params).catch(() => {});
        } catch (e) {}
    }
}

// ========== Adaptive Bitrate Quality Monitor (getStats) ==========
let qualityMonitorInterval = null;

function startQualityMonitor() {
    if (qualityMonitorInterval) return;
    console.log('[QoS] ▶ Quality monitor started');

    qualityMonitorInterval = setInterval(async () => {
        // Stop if no local stream and no active peers
        if (!localStream && peers.size === 0) {
            stopQualityMonitor();
            return;
        }

        for (const [peerId, peerObj] of peers.entries()) {
            if (!peerObj.pc || peerObj.pc.connectionState === 'closed') continue;
            try {
                const stats = await peerObj.pc.getStats();
                let availableBitrate = null;
                let qualityLimitation = 'none';
                let outboundFps = 0;
                let inboundFps = 0;
                let inboundPacketsLost = 0;
                let inboundPacketsReceived = 0;
                let rtt = 0;

                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        if (report.availableOutgoingBitrate != null) {
                            availableBitrate = report.availableOutgoingBitrate;
                        }
                        if (report.currentRoundTripTime != null) {
                            rtt = report.currentRoundTripTime;
                        }
                    }
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        outboundFps = report.framesPerSecond || 0;
                        qualityLimitation = report.qualityLimitationReason || 'none';
                    }
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        inboundFps = report.framesPerSecond || 0;
                        inboundPacketsLost = report.packetsLost || 0;
                        inboundPacketsReceived = report.packetsReceived || 0;
                    }
                });

                // --- 1. OUTBOUND ADAPTATION (When we are streaming to this peer) ---
                if (localStream && availableBitrate !== null) {
                    const videoSender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (videoSender) {
                        const params = videoSender.getParameters();
                        if (params.encodings && params.encodings[0]) {
                            const current = params.encodings[0].maxBitrate || 6000000;
                            let targetBitrate;

                            const peerCap = getMaxBitrateForPeerCount();
                            if (availableBitrate < 1200000) {
                                targetBitrate = 800000; // Emergency floor
                            } else if (availableBitrate < 2500000) {
                                targetBitrate = Math.floor(availableBitrate * 0.65);
                            } else if (availableBitrate < 5000000) {
                                targetBitrate = Math.min(peerCap, Math.floor(availableBitrate * 0.75));
                            } else {
                                targetBitrate = peerCap; // Cap dinâmico por contagem de espectadores
                            }

                            // Auto-throttle framerate to 30fps under critical bottleneck to prevent freezes
                            if (availableBitrate < 1400000 || qualityLimitation === 'cpu') {
                                if (params.encodings[0].maxFramerate !== 30) {
                                    params.encodings[0].maxFramerate = 30;
                                    console.log(`[QoS] ${peerId.slice(0,6)}: Throttled to 30 FPS due to ${qualityLimitation === 'cpu' ? 'CPU' : 'network'}`);
                                }
                            } else if (availableBitrate >= 3500000 && contentHintMode === 'motion') {
                                if (params.encodings[0].maxFramerate !== 60) {
                                    params.encodings[0].maxFramerate = 60;
                                }
                            }

                            // Smooth ramp
                            const smoothed = Math.floor(current + (targetBitrate - current) * 0.3);
                            const clamped = Math.max(800000, Math.min(6000000, smoothed));

                            if (Math.abs(clamped - current) > 100000) {
                                params.encodings[0].maxBitrate = clamped;
                                videoSender.setParameters(params).catch(() => {});
                                console.log(
                                    `[QoS] Outbound ${peerId.slice(0,6)}: ` +
                                    `bitrate ${(current/1e6).toFixed(1)}→${(clamped/1e6).toFixed(1)} Mbps | ` +
                                    `fps: ${outboundFps} | rtt: ${(rtt*1000).toFixed(0)}ms`
                                );
                            }
                        }
                    }
                }

                // --- 2. INBOUND QUALITY BADGE (When we are watching this peer) ---
                if (peerObj.tileEl) {
                    const badge = peerObj.tileEl.querySelector('.tile-quality-badge');
                    if (badge) {
                        // Calculate packet loss delta
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

                        if (lossRatio > 0.08 || (fps > 0 && fps < 18)) {
                            qosClass = 'poor';
                            qosText = `Instável • ${fps} FPS`;
                        } else if (lossRatio > 0.03 || (fps > 0 && fps < 30)) {
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

                        // Make visible permanently if network is degraded to alert user
                        if (qosClass === 'poor' || qosClass === 'medium') {
                            badge.classList.add('visible');
                        } else {
                            badge.classList.remove('visible');
                        }
                    }
                }
            } catch (e) { /* peer disconnected mid-stats */ }
        }
    }, 3500);
}

function stopQualityMonitor() {
    if (qualityMonitorInterval) {
        clearInterval(qualityMonitorInterval);
        qualityMonitorInterval = null;
        console.log('[QoS] ■ Quality monitor stopped');
    }
}

// ========== Quality Mode Toggle (Fluido vs Nítido) ==========
btnQualityToggle.addEventListener('click', toggleQualityMode);

function toggleQualityMode() {
    contentHintMode = contentHintMode === 'motion' ? 'detail' : 'motion';
    const isMotion = contentHintMode === 'motion';

    // Update button label
    qualityModeLabel.textContent = isMotion ? 'Fluido' : 'Nítido';
    btnQualityToggle.title = isMotion
        ? 'Modo Fluido: prioriza 60fps (ideal para jogos de ação)'
        : 'Modo Nítido: prioriza nitidez de texto/UI (ideal para Tibia, documentos)';

    // Apply contentHint to local video track
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack && 'contentHint' in videoTrack) {
            videoTrack.contentHint = contentHintMode;
            console.log(`[Quality] contentHint → "${contentHintMode}"`);
        }
    }

    // Update degradationPreference on all senders
    for (const [, peerObj] of peers.entries()) {
        if (!peerObj.pc) continue;
        const videoSender = peerObj.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
            try {
                const params = videoSender.getParameters();
                // 'detail' mode: never sacrifice resolution → maintain-resolution + cap framerate at 30
                // 'motion' mode: keep resolution but allow full 60fps
                params.degradationPreference = 'maintain-resolution';
                if (params.encodings && params.encodings[0]) {
                    params.encodings[0].maxFramerate = isMotion ? 60 : 30;
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
            if (appSelectorContainer) {
                appSelectorContainer.style.display = (audioSourceApp && audioSourceApp.checked) ? 'flex' : 'none';
            }
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

    const isDesktop = (typeof window !== 'undefined' && Boolean(window.NL_PORT));

    // Se estiver no navegador web (sem app desktop), adapta o modal amigavelmente
    const desktopOnlyCard1 = audioSourceExcludeDiscord?.closest('.audio-option-card');
    const desktopOnlyCard2 = audioSourceApp?.closest('.audio-option-card');

    if (!isDesktop) {
        if (desktopOnlyCard1) desktopOnlyCard1.style.display = 'none';
        if (desktopOnlyCard2) desktopOnlyCard2.style.display = 'none';
        if (audioSourceSystem) {
            audioSourceSystem.checked = true;
            audioSourceSystem.closest('.audio-option-card').style.border = '1px solid var(--primary)';
        }
    } else {
        if (desktopOnlyCard1) desktopOnlyCard1.style.display = 'flex';
        if (desktopOnlyCard2) desktopOnlyCard2.style.display = 'flex';
        checkDiscordStatus();
        fetchWindowList();
    }

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

btnStartShare.addEventListener('click', openShareConfigModal);
btnStartShareBig.addEventListener('click', openShareConfigModal);

if (btnConfirmStartShare) {
    btnConfirmStartShare.addEventListener('click', async () => {
        closeShareConfigModal();
        const mode = document.querySelector('input[name="audioSourceType"]:checked')?.value || 'exclude_discord';
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

        let screenStream = null;
        let audioTrack = null;

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
                    const audioStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: { exact: cableOutputId },
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                            channelCount: 2,
                            sampleRate: 48000
                        }
                    });
                    audioTrack = audioStream.getAudioTracks()[0];
                    console.log('[Audio] ✅ Capturing isolated audio from VB-Cable');
                } catch (audioErr) {
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
        const videoTrack = screenStream.getVideoTracks()[0];
        if (videoTrack && 'contentHint' in videoTrack) {
            videoTrack.contentHint = contentHintMode;
            console.log(`[WebRTC] videoTrack contentHint set to "${contentHintMode}"`);
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

        // Log audio status
        const finalAudioTracks = localStream.getAudioTracks();
        console.log(`[Capture] ✅ Sharing started | Video: yes | Audio: ${finalAudioTracks.length > 0 ? 'yes (' + finalAudioTracks[0].label + ')' : 'no'}`);

    } catch (err) {
        console.error('[Capture] Error getting display media:', err);
        if (err.name !== 'NotAllowedError') {
            showToast('Não foi possível iniciar o compartilhamento: ' + err.message, 'error');
        }
    }
}


// Stop Screen Share
btnStopShare.addEventListener('click', stopScreenShare);

function stopScreenShare() {
    stopQualityMonitor();
    stopAppAudioCapture();

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Clean up transceivers/senders across all active peer connections
    for (const [peerId, peerObj] of peers.entries()) {
        if (peerObj && peerObj.pc) {
            peerObj.pc.getSenders().forEach(sender => {
                try {
                    peerObj.pc.removeTrack(sender);
                } catch (e) {}
            });
            // Renegotiate so peers drop the remote tile cleanly
            sendOffer(peerId);
        }
    }

    const localTile = document.getElementById('localStreamTile');
    if (localTile) localTile.remove();

    btnStartShare.hidden = false;
    btnStopShare.hidden = true;
    btnQualityToggle.hidden = true;
    updateGridState();

    socket.emit('stream-state', { roomId, state: 'stopped' });
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
        const muteBtn = document.createElement('button');
        muteBtn.className = 'btn-icon';
        muteBtn.style.width = '32px';
        muteBtn.style.height = '32px';
        muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.05';
        slider.value = '1';

        slider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            video.volume = val;
            if (val > 0) {
                video.muted = false;
                video.removeAttribute('muted');
                const badge = tile.querySelector('.tap-unmute-badge');
                if (badge) badge.remove();
            } else {
                video.muted = true;
            }
            muteBtn.innerHTML = (val === 0 || video.muted) ? '<i class="fa-solid fa-volume-xmark"></i>' : '<i class="fa-solid fa-volume-high"></i>';
        });

        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!video.muted && video.volume > 0) {
                video.muted = true;
                slider.value = '0';
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
            } else {
                video.muted = false;
                video.removeAttribute('muted');
                const prevVal = parseFloat(slider.value);
                const targetVol = prevVal > 0 ? prevVal : 1;
                video.volume = targetVol;
                slider.value = targetVol.toString();
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
                const badge = tile.querySelector('.tap-unmute-badge');
                if (badge) badge.remove();
            }
        });

        controlsOverlay.appendChild(muteBtn);
        controlsOverlay.appendChild(slider);
    }

    const fsBtn = document.createElement('button');
    fsBtn.className = 'btn-icon';
    fsBtn.style.width = '32px';
    fsBtn.style.height = '32px';
    fsBtn.title = 'Tela Cheia';
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
function toggleTileFullscreen(tile, video) {
    if (!tile) return;

    // 1. If currently in pseudo-fullscreen, exit it
    if (tile.classList.contains('pseudo-fullscreen')) {
        tile.classList.remove('pseudo-fullscreen');
        const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
        if (exitBtn) exitBtn.remove();
        updateBackgroundTracksOptimization();
        return;
    }

    // 2. If native document fullscreen is active, exit it
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
        return;
    }

    // 3. iOS Safari native video player fullscreen
    if (video && typeof video.webkitEnterFullscreen === 'function') {
        try {
            video.webkitEnterFullscreen();
            return;
        } catch (e) {
            console.warn('[FS] iOS webkitEnterFullscreen error, using pseudo:', e);
        }
    }

    // 4. Standard Element Fullscreen (Android Chrome, PC)
    const req = tile.requestFullscreen || tile.webkitRequestFullscreen || tile.mozRequestFullScreen || tile.msRequestFullscreen;
    if (req) {
        req.call(tile).catch(err => {
            console.warn('[FS] Native requestFullscreen rejected, falling back to pseudo:', err);
            enterPseudoFullscreen(tile);
        });
    } else {
        // 5. Fallback: Pseudo-fullscreen
        enterPseudoFullscreen(tile);
    }
}

function enterPseudoFullscreen(tile) {
    tile.classList.add('pseudo-fullscreen');
    updateBackgroundTracksOptimization();
    if (!tile.querySelector('.btn-exit-pseudo-fs')) {
        const exitBtn = document.createElement('button');
        exitBtn.className = 'btn-exit-pseudo-fs';
        exitBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        exitBtn.title = 'Sair da Tela Cheia';
        exitBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            tile.classList.remove('pseudo-fullscreen');
            exitBtn.remove();
            updateBackgroundTracksOptimization();
        });
        tile.appendChild(exitBtn);
    }
}

// Show Tap-to-Unmute for mobile browsers that block autoplay with sound
function showTapToUnmuteBadge(tile, video) {
    if (!tile || tile.querySelector('.tap-unmute-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'tap-unmute-badge';
    badge.innerHTML = '<i class="fa-solid fa-volume-xmark"></i> Toque para ativar o som';
    badge.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(15, 18, 26, 0.9);
        color: #fff;
        padding: 10px 18px;
        border-radius: 24px;
        font-size: 0.85rem;
        font-weight: 600;
        border: 1px solid var(--border);
        box-shadow: 0 4px 18px rgba(0,0,0,0.5);
        cursor: pointer;
        z-index: 15;
    `;
    const unmute = (e) => {
        e.stopPropagation();
        video.muted = false;
        video.play().catch(() => {});
        badge.remove();
        const muteBtn = tile.querySelector('.tile-controls-overlay .btn-icon');
        if (muteBtn) muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
    };
    badge.addEventListener('click', unmute);
    tile.addEventListener('click', unmute, { once: true });
    tile.appendChild(badge);
}

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
btnCopyLink.addEventListener('click', () => {
    let inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
    if (currentRoomPassword) {
        inviteUrl += `&pass=${encodeURIComponent(currentRoomPassword)}`;
    }
    navigator.clipboard.writeText(inviteUrl).then(() => {
        const origText = btnCopyLink.innerHTML;
        btnCopyLink.innerHTML = '<i class="fa-solid fa-check"></i> Link Copiado!';
        setTimeout(() => {
            btnCopyLink.innerHTML = origText;
        }, 2000);
    }).catch(() => {
        // Fallback se a API de clipboard do navegador falhar
        showToast('Não foi possível copiar automaticamente. Acesse: ' + inviteUrl, 'warning', 6000);
    });
});



window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (shareConfigModal && !shareConfigModal.hidden && shareConfigModal.style.display !== 'none') {
            closeShareConfigModal();
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




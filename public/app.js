import {
    isDesktopApp,
    checkDiscordStatus,
    fetchWindowList,
    startExcludeDiscordCapture,
    startAppAudioCapture,
    stopAppAudioCapture,
    registerDesktopCaptureListeners
} from './js/modules/desktop-audio.js';
import { sanitizeRoomId, generateRandomRoomId } from './js/modules/room-utils.js';
import {
    COLD_START_NOTICE_DELAY_MS,
    resolveSignalingServerUrl,
    saveSessionRoomPassword,
    getSessionRoomPassword,
    clearSessionRoomPassword
} from './js/modules/signaling-url.js';
import {
    setSignalingStatus,
    showToast,
    playPresenceChime,
    initTheme,
    toggleTheme
} from './js/modules/ui-feedback.js';
import {
    rtcConfig,
    refreshIceServers,
    scheduleIceRefreshTimer,
    stopIceRefreshTimer
} from './js/modules/ice-config.js';
import { registerFullscreenChangeHandler } from './js/modules/tile-dom.js';
import {
    getOrCreateClientId,
    loadSavedUserName,
    saveUserName,
    loadSavedClientPreferences
} from './js/modules/preferences.js';
import { createStreamGridController } from './js/modules/stream-grid.js';
import { createQosMonitor } from './js/modules/qos-monitor.js';
import { createShareConfigModalController } from './js/modules/share-config-modal.js';
import { createStatsModalController } from './js/modules/stats-modal.js';
import { createScreenShareController } from './js/modules/screen-share.js';
import { createWebRtcMesh } from './js/modules/webrtc-mesh.js';
import { createRoomModalController } from './js/modules/room-modal.js';

function collectDomReferences(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return {};
    const ids = [
        'roomModal', 'roomErrorBanner', 'btnCloseRoomModal', 'btnCancelRoomModal',
        'roomChoiceCancelContainer', 'roomViewChoice', 'roomViewCreate', 'roomViewJoin',
        'btnChooseCreate', 'btnChooseJoin', 'inputCreateUserName', 'inputCreateRoomId',
        'inputCreateRoomPassword', 'btnRandomRoom', 'btnGenerateRandomQuick',
        'btnToggleCreatePass', 'createRoomStatusIndicator', 'btnConfirmCreate', 'btnBackFromCreate',
        'inputJoinUserName', 'inputJoinRoomId', 'inputJoinRoomPassword', 'btnToggleJoinPass',
        'joinRoomStatusIndicator', 'joinPasswordHint', 'btnConfirmJoin', 'btnBackFromJoin',
        'btnChangeRoom', 'displayRoomId', 'memberCountText', 'btnCopyLink',
        'streamGrid', 'emptyGridPlaceholder', 'activeStreamsText',
        'btnStartShare', 'btnStartShareBig', 'btnStopShare', 'btnQualityToggle', 'qualityModeLabel',
        'btnThemeToggle',
        'shareConfigModal', 'btnCloseShareConfig', 'btnConfirmStartShare', 'btnRefreshAudioApps',
        'selectAudioApp', 'audioSourceExcludeDiscord', 'audioSourceApp', 'audioSourceSystem',
        'audioSourceNone', 'appSelectorContainer',
        'btnTogglePip', 'btnToggleStats', 'statsModal', 'btnCloseStatsModal', 'btnResetServerUrl'
    ];
    const dom = {};
    for (const id of ids) {
        dom[id] = doc.getElementById(id);
    }
    return dom;
}

export function initApp({
    windowObj = (typeof window !== 'undefined' ? window : null),
    documentObj = (typeof document !== 'undefined' ? document : null),
    navigatorObj = (typeof navigator !== 'undefined' ? navigator : null),
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    ioFactory = (typeof io === 'function' ? io : null),
    serverUrl: explicitServerUrl
} = {}) {
    const dom = collectDomReferences(documentObj);
    const serverUrl = explicitServerUrl || resolveSignalingServerUrl();
    const state = {
        clientId: getOrCreateClientId(storage),
        currentUserName: loadSavedUserName(storage),
        roomId: '',
        pendingRoomJoin: null,
        myId: '',
        localStream: null,
        currentRoomPassword: '',
        contentHintMode: 'motion',
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        selectedAudioSource: null
    };

    const socket = typeof ioFactory === 'function'
        ? ioFactory(serverUrl, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 30,
            reconnectionDelay: 1500,
            reconnectionDelayMax: 5000,
            timeout: 20000
        })
        : null;

    let coldStartTimer = null;
    let hasShownColdStartToast = false;
    let wasSocketDisconnected = false;
    let hasShownConnectErrorToast = false;

    function scheduleColdStartNotice() {
        if ((socket && socket.connected) || coldStartTimer !== null || hasShownColdStartToast) {
            return;
        }
        coldStartTimer = setTimeout(() => {
            coldStartTimer = null;
            if (socket && socket.connected) return;
            if (hasShownConnectErrorToast) return;
            hasShownColdStartToast = true;
            setSignalingStatus('waking');
            showToast('Acordando servidor de sinalização... isso pode levar alguns segundos.', 'info', 6000);
        }, COLD_START_NOTICE_DELAY_MS);
    }

    function cancelColdStartNotice() {
        if (coldStartTimer !== null) {
            clearTimeout(coldStartTimer);
            coldStartTimer = null;
        }
    }

    let webrtc;
    let grid;
    let qosMonitor;
    let screenShare;
    let roomModalCtrl;
    let shareConfigCtrl;
    let statsModalCtrl;

    qosMonitor = createQosMonitor({
        state,
        dom,
        getPeers: () => webrtc.peers,
        storage
    });

    grid = createStreamGridController({
        state,
        dom,
        getPeers: () => webrtc.peers,
        getRemoteActiveStreams: () => webrtc.remoteActiveStreams,
        getQualityMonitor: () => qosMonitor,
        isDesktopApp: () => isDesktopApp(windowObj),
        getServerUrl: () => serverUrl,
        showToast,
        documentObj,
        windowObj,
        navigatorObj
    });

    webrtc = createWebRtcMesh({
        state,
        dom,
        getSocket: () => socket,
        getQosMonitor: () => qosMonitor,
        getGrid: () => grid,
        getScreenShare: () => screenShare,
        getRoomModal: () => roomModalCtrl,
        getServerUrl: () => serverUrl,
        rtcConfig,
        refreshIceServers,
        scheduleIceRefreshTimer,
        registerFullscreenChangeHandler,
        saveSessionRoomPassword,
        clearSessionRoomPassword,
        showToast,
        playPresenceChime,
        documentObj,
        windowObj,
        storage
    });

    screenShare = createScreenShareController({
        state,
        dom,
        getSocket: () => socket,
        getPeers: () => webrtc.peers,
        getWebRtc: () => webrtc,
        getGrid: () => grid,
        getQosMonitor: () => qosMonitor,
        startExcludeDiscordCapture,
        startAppAudioCapture,
        stopAppAudioCapture,
        showToast,
        documentObj,
        navigatorObj
    });

    roomModalCtrl = createRoomModalController({
        state,
        dom,
        getSocket: () => socket,
        onCleanupRoomState: (opts) => webrtc.cleanupRoomState(opts),
        getMembership: () => webrtc.membership,
        showToast,
        getSessionRoomPassword,
        clearSessionRoomPassword,
        onThemeInit: () => initTheme({ windowObj, documentObj, storage }),
        onLoadPreferences: () => loadSavedClientPreferences({
            state,
            storage,
            onApplied: () => qosMonitor.applyQualityModeUI()
        }),
        saveUserName,
        sanitizeRoomId,
        generateRandomRoomId,
        storage,
        windowObj
    });

    shareConfigCtrl = createShareConfigModalController({
        state,
        dom,
        isDesktopApp: () => isDesktopApp(windowObj),
        checkDiscordStatus,
        fetchWindowList,
        updateEchoWarningVisibility: () => grid.updateEchoWarningVisibility(),
        onStartScreenShare: (...args) => screenShare.startScreenShare(...args),
        documentObj,
        storage
    });

    statsModalCtrl = createStatsModalController({
        state,
        dom,
        getPeers: () => webrtc.peers,
        getServerUrl: () => serverUrl,
        showToast,
        documentObj,
        windowObj,
        storage
    });

    // Initial UI & Preferences
    if (dom.btnThemeToggle) {
        dom.btnThemeToggle.addEventListener('click', () => toggleTheme({ documentObj, storage }));
    }
    initTheme({ windowObj, documentObj, storage });
    loadSavedClientPreferences({
        state,
        storage,
        onApplied: () => qosMonitor.applyQualityModeUI()
    });

    setSignalingStatus(socket && socket.connected ? 'connected' : 'connecting');
    scheduleColdStartNotice();
    refreshIceServers(serverUrl, { peers: webrtc.peers });

    // Bind DOM events
    roomModalCtrl.bindEvents();
    shareConfigCtrl.bindEvents();
    statsModalCtrl.bindEvents();
    qosMonitor.bindEvents();
    screenShare.bindEvents();
    grid.bindCopyInviteLink();
    webrtc.bindLifecycleListeners();

    if (isDesktopApp(windowObj)) {
        checkDiscordStatus();
        fetchWindowList();
        registerDesktopCaptureListeners((payload) => screenShare.handleDesktopCaptureStopped(payload)).catch(() => {});
        if (windowObj) {
            windowObj.addEventListener('beforeunload', () => {
                if (windowObj.StreamGridDesktop) {
                    windowObj.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
                }
            });
        }
    }

    // Bind Socket.IO events
    if (socket) {
        socket.on('connect', () => {
            state.myId = socket.id;
            cancelColdStartNotice();
            setSignalingStatus('connected');
            Promise.resolve(refreshIceServers(serverUrl, { peers: webrtc.peers }))
                .catch(() => {})
                .finally(() => {
                    scheduleIceRefreshTimer(serverUrl, { peers: webrtc.peers });
                });
            console.log('[Socket] Connected to server. Socket ID:', state.myId);
            if (wasSocketDisconnected) {
                wasSocketDisconnected = false;
                hasShownConnectErrorToast = false;
                showToast('Reconectado ao servidor de sinalização.', 'success', 3000);
            } else if (hasShownConnectErrorToast) {
                hasShownConnectErrorToast = false;
                showToast('Conectado ao servidor de sinalização.', 'success', 3000);
            }
            if (state.pendingRoomJoin) {
                console.log('[Socket] Joining pending room on connect:', state.pendingRoomJoin.roomId);
                state.pendingRoomJoin.inFlight = true;
                socket.emit('join-room', {
                    roomId: state.pendingRoomJoin.roomId,
                    clientId: state.clientId,
                    password: state.pendingRoomJoin.password,
                    userName: state.pendingRoomJoin.userName
                });
            } else if (state.roomId) {
                console.log('[Socket] Joining room on connect:', state.roomId);
                socket.emit('join-room', {
                    roomId: state.roomId,
                    clientId: state.clientId,
                    password: state.currentRoomPassword,
                    userName: state.currentUserName
                });
            }
        });

        socket.on('disconnect', (reason) => {
            console.warn('[Socket] Disconnected from server:', reason);
            webrtc.membership.isRoomMembershipConfirmed = false;
            setSignalingStatus(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
            if (reason !== 'io client disconnect') {
                wasSocketDisconnected = true;
                showToast('Conexão com o servidor perdida. Tentando reconectar...', 'warning', 5000);
            }
        });

        socket.on('connect_error', (err) => {
            cancelColdStartNotice();
            setSignalingStatus('offline');
            console.warn('[Socket] Connection error:', err && err.message ? err.message : err);
            if (!hasShownConnectErrorToast) {
                hasShownConnectErrorToast = true;
                showToast('Não foi possível conectar ao servidor. Tentando novamente...', 'error', 5000);
            }
        });

        socket.on('join-error', (payload) => roomModalCtrl.handleJoinError(payload));
        socket.on('room-users', (payload) => webrtc.handleRoomUsers(payload));
        socket.on('user-joined', (payload) => webrtc.handleUserJoined(payload));
        socket.on('user-left', (payload) => webrtc.handleUserLeft(payload));
        socket.on('room-status', ({ memberCount }) => grid.updateMemberCount(memberCount));
        socket.on('signal', (payload) => webrtc.handleSignal(payload));
        socket.on('stream-state', (payload) => webrtc.handleStreamState(payload));
    }

    function teardownClientSession() {
        try {
            cancelColdStartNotice();
            stopIceRefreshTimer();
            qosMonitor.stopQualityMonitor();
            statsModalCtrl.stop();
            webrtc.cleanupRoomState({ silent: true });
            if (socket && socket.connected) {
                socket.disconnect();
            }
        } catch (_) {}
    }

    if (windowObj && typeof windowObj.addEventListener === 'function') {
        if (documentObj && documentObj.readyState === 'complete') {
            roomModalCtrl.applyInitialUrlAndRestore();
        } else {
            windowObj.addEventListener('DOMContentLoaded', () => roomModalCtrl.applyInitialUrlAndRestore());
        }

        windowObj.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (shareConfigCtrl.isShareConfigModalOpen()) {
                    shareConfigCtrl.closeShareConfigModal();
                    return;
                }
                if (statsModalCtrl.isStatsModalOpen()) {
                    statsModalCtrl.closeStatsModal();
                    return;
                }
                if (roomModalCtrl.isRoomModalOpen()) {
                    if (dom.roomViewChoice && dom.roomViewChoice.style.display === 'none') {
                        roomModalCtrl.switchRoomView('choice');
                    } else if (state.roomId) {
                        roomModalCtrl.closeRoomModal();
                    }
                }
            }
        });

        windowObj.addEventListener('pagehide', teardownClientSession);
    }

    return {
        state,
        dom,
        socket,
        webrtc,
        grid,
        qosMonitor,
        screenShare,
        roomModalCtrl,
        shareConfigCtrl,
        statsModalCtrl,
        teardownClientSession
    };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof io === 'function' && !window.__STREAMGRID_SKIP_AUTO_INIT__) {
    initApp();
}

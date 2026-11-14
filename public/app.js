import {
    isDesktopApp,
    configureDesktopAudioRuntime,
    checkDiscordStatus,
    fetchWindowList,
    startExcludeDiscordCapture,
    startExcludeAppCapture,
    startAppAudioCapture,
    stopAppAudioCapture,
    registerDesktopCaptureListeners
} from './js/modules/desktop-audio.js';
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
    loadSavedClientPreferences
} from './js/modules/preferences.js';
import { createStreamGridController } from './js/modules/stream-grid.js';
import { createQosMonitor } from './js/modules/qos-monitor.js';
import { createShareConfigModalController } from './js/modules/share-config-modal.js';
import { createStatsModalController } from './js/modules/stats-modal.js';
import { createScreenShareController } from './js/modules/screen-share.js';
import { createWebRtcMesh } from './js/modules/webrtc-mesh.js';
import { createRoomModalController } from './js/modules/room-modal.js';
import { trapModalTabKey } from './js/modules/modal-a11y.js';

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
        'audioSourceNone', 'appSelectorContainer', 'appExcludeOptionContainer', 'chkExcludeSelectedApp',
        'vbCableOptionContainer', 'chkUseVbCable',
        'btnTogglePip', 'btnToggleStats', 'statsModal', 'btnCloseStatsModal',
        'btnResetServerUrl', 'inputCustomServerUrl', 'btnSaveServerUrl'
    ];
    const dom = {};
    for (const id of ids) {
        dom[id] = doc.getElementById(id);
    }
    return dom;
}

/**
 * @typedef {import('./js/modules/types.js').AnyWindow} AnyWindow
 * @typedef {import('./js/modules/types.js').AnyDocument} AnyDocument
 */

/**
 * @param {{
 *   windowObj?: AnyWindow | null,
 *   documentObj?: AnyDocument | null,
 *   navigatorObj?: Navigator | null,
 *   storage?: Storage | null,
 *   sessionStorageObj?: Storage | null,
 *   ioFactory?: ((url: string, opts?: any) => any) | null,
 *   serverUrl?: string
 * }} [options]
 */
export function initApp({
    windowObj = (typeof window !== 'undefined' ? /** @type {AnyWindow} */ (window) : null),
    documentObj = (typeof document !== 'undefined' ? /** @type {AnyDocument} */ (document) : null),
    navigatorObj = (typeof navigator !== 'undefined' ? navigator : null),
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    sessionStorageObj = (typeof sessionStorage !== 'undefined' ? sessionStorage : null),
    ioFactory = (typeof (/** @type {any} */ (globalThis)).io === 'function' ? (/** @type {any} */ (globalThis)).io : null),
    serverUrl: explicitServerUrl
} = {}) {
    configureDesktopAudioRuntime({ windowObj, documentObj });
    const dom = collectDomReferences(documentObj);
    const serverUrl = explicitServerUrl || resolveSignalingServerUrl({
        windowObj,
        storage,
        isDesktop: isDesktopApp(windowObj)
    });
    const boundShowToast = (msg, type, durationMs) => showToast(msg, type, durationMs, documentObj);
    const boundSetSignalingStatus = (status, customLabel) => setSignalingStatus(status, { customLabel, documentObj });
    const boundPlayPresenceChime = (type) => playPresenceChime(type, windowObj);
    const boundSaveSessionRoomPassword = (roomId, password) => saveSessionRoomPassword(roomId, password, sessionStorageObj);
    const boundGetSessionRoomPassword = (roomId) => getSessionRoomPassword(roomId, sessionStorageObj);
    const boundClearSessionRoomPassword = () => clearSessionRoomPassword(sessionStorageObj);
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
        selectedAudioSource: null,
        useVbCableAudio: false,
        excludeSelectedApp: false
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
            boundSetSignalingStatus('waking');
            boundShowToast('Acordando servidor de sinalização... isso pode levar alguns segundos.', 'info', 6000);
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
        showToast: boundShowToast,
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
        saveSessionRoomPassword: boundSaveSessionRoomPassword,
        clearSessionRoomPassword: boundClearSessionRoomPassword,
        showToast: boundShowToast,
        playPresenceChime: boundPlayPresenceChime,
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
        startExcludeDiscordCapture: () => startExcludeDiscordCapture(windowObj),
        startExcludeAppCapture: (pid) => startExcludeAppCapture(pid, windowObj),
        startAppAudioCapture: (pid) => startAppAudioCapture(pid, windowObj),
        stopAppAudioCapture: () => stopAppAudioCapture(windowObj),
        showToast: boundShowToast,
        documentObj,
        navigatorObj
    });

    roomModalCtrl = createRoomModalController({
        state,
        dom,
        getSocket: () => socket,
        onCleanupRoomState: (opts) => webrtc.cleanupRoomState(opts),
        getMembership: () => webrtc.membership,
        showToast: boundShowToast,
        getSessionRoomPassword: boundGetSessionRoomPassword,
        clearSessionRoomPassword: boundClearSessionRoomPassword,
        onThemeInit: () => initTheme({ windowObj, documentObj, storage }),
        onLoadPreferences: () => loadSavedClientPreferences({
            state,
            storage,
            onApplied: () => qosMonitor.applyQualityModeUI()
        }),
        documentObj,
        storage,
        windowObj
    });

    shareConfigCtrl = createShareConfigModalController({
        state,
        dom,
        isDesktopApp: () => isDesktopApp(windowObj),
        checkDiscordStatus: () => checkDiscordStatus(windowObj, documentObj),
        fetchWindowList: () => fetchWindowList(windowObj, documentObj),
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
        showToast: boundShowToast,
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

    boundSetSignalingStatus(socket && socket.connected ? 'connected' : 'connecting');
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

    let isTornDown = false;
    let unlistenDesktopCapture = null;
    let onBeforeUnload = null;
    let onDomContentLoaded = null;
    let onKeyDown = null;
    let onPageHide = null;

    if (isDesktopApp(windowObj)) {
        checkDiscordStatus(windowObj, documentObj);
        fetchWindowList(windowObj, documentObj);
        Promise.resolve(
            registerDesktopCaptureListeners(
                (payload) => screenShare.handleDesktopCaptureStopped(payload),
                windowObj,
                (payload) => screenShare.handleDesktopCaptureRebound(payload)
            )
        ).then((unlisten) => {
            if (isTornDown) {
                if (typeof unlisten === 'function') unlisten();
            } else {
                unlistenDesktopCapture = typeof unlisten === 'function' ? unlisten : null;
            }
        }).catch(() => {});
        if (windowObj && typeof windowObj.addEventListener === 'function') {
            onBeforeUnload = () => {
                if (windowObj.StreamGridDesktop && typeof windowObj.StreamGridDesktop.stopAppAudioCapture === 'function') {
                    windowObj.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
                }
            };
            windowObj.addEventListener('beforeunload', onBeforeUnload);
        }
    }

    // Bind Socket.IO events
    if (socket) {
        socket.on('connect', () => {
            if (isTornDown) return;
            state.myId = socket.id;
            cancelColdStartNotice();
            boundSetSignalingStatus('connected');
            Promise.resolve(refreshIceServers(serverUrl, { peers: webrtc.peers }))
                .catch(() => {})
                .finally(() => {
                    if (!isTornDown) {
                        scheduleIceRefreshTimer(serverUrl, { peers: webrtc.peers });
                    }
                });
            console.log('[Socket] Connected to server. Socket ID:', state.myId);
            if (wasSocketDisconnected) {
                wasSocketDisconnected = false;
                hasShownConnectErrorToast = false;
                boundShowToast('Reconectado ao servidor de sinalização.', 'success', 3000);
            } else if (hasShownConnectErrorToast) {
                hasShownConnectErrorToast = false;
                boundShowToast('Conectado ao servidor de sinalização.', 'success', 3000);
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
            boundSetSignalingStatus(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
            if (reason !== 'io client disconnect') {
                wasSocketDisconnected = true;
                boundShowToast('Conexão com o servidor perdida. Tentando reconectar...', 'warning', 5000);
            }
        });

        socket.on('connect_error', (err) => {
            cancelColdStartNotice();
            boundSetSignalingStatus('offline');
            console.warn('[Socket] Connection error:', err && err.message ? err.message : err);
            if (!hasShownConnectErrorToast) {
                hasShownConnectErrorToast = true;
                boundShowToast('Não foi possível conectar ao servidor. Tentando novamente...', 'error', 5000);
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
        isTornDown = true;
        try {
            cancelColdStartNotice();
            stopIceRefreshTimer();
            qosMonitor.stopQualityMonitor();
            statsModalCtrl.stop();
            roomModalCtrl.cleanup();
            grid.cleanup();
            webrtc.unbindLifecycleListeners();
            webrtc.cleanupRoomState({ silent: true });
            if (typeof unlistenDesktopCapture === 'function') {
                unlistenDesktopCapture();
                unlistenDesktopCapture = null;
            }
            if (isDesktopApp(windowObj)) {
                stopAppAudioCapture();
                if (windowObj && windowObj.StreamGridDesktop && typeof windowObj.StreamGridDesktop.stopAppAudioCapture === 'function') {
                    windowObj.StreamGridDesktop.stopAppAudioCapture().catch(() => {});
                }
            }
            if (socket && typeof socket.disconnect === 'function') {
                socket.disconnect();
            }
            if (windowObj && typeof windowObj.removeEventListener === 'function') {
                if (onDomContentLoaded) windowObj.removeEventListener('DOMContentLoaded', onDomContentLoaded);
                if (onKeyDown) windowObj.removeEventListener('keydown', onKeyDown);
                if (onPageHide) windowObj.removeEventListener('pagehide', onPageHide);
                if (onBeforeUnload) windowObj.removeEventListener('beforeunload', onBeforeUnload);
            }
        } catch (_) {}
    }

    if (windowObj && typeof windowObj.addEventListener === 'function') {
        if (documentObj && documentObj.readyState === 'complete') {
            roomModalCtrl.applyInitialUrlAndRestore();
        } else {
            onDomContentLoaded = () => roomModalCtrl.applyInitialUrlAndRestore();
            windowObj.addEventListener('DOMContentLoaded', onDomContentLoaded);
        }

        onKeyDown = (e) => {
            if (e.key === 'Tab') {
                let activeModalEl = null;
                if (shareConfigCtrl.isShareConfigModalOpen()) {
                    activeModalEl = dom.shareConfigModal;
                } else if (statsModalCtrl.isStatsModalOpen()) {
                    activeModalEl = dom.statsModal;
                } else if (roomModalCtrl.isRoomModalOpen()) {
                    activeModalEl = dom.roomModal;
                }
                if (activeModalEl) {
                    trapModalTabKey(activeModalEl, e, documentObj);
                }
                return;
            }
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
                    return;
                }
                if (grid && typeof grid.isSpotlightActive === 'function' && grid.isSpotlightActive()) {
                    grid.clearSpotlight();
                }
            }
        };
        windowObj.addEventListener('keydown', onKeyDown);

        onPageHide = teardownClientSession;
        windowObj.addEventListener('pagehide', onPageHide);
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

const globalWindow = typeof window !== 'undefined' ? /** @type {AnyWindow} */ (window) : null;
if (globalWindow && typeof document !== 'undefined' && typeof (/** @type {any} */ (globalThis)).io === 'function' && !globalWindow.__STREAMGRID_SKIP_AUTO_INIT__) {
    initApp();
}

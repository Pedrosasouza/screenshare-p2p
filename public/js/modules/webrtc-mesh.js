import { optimizeSDP } from './sdp.js';
import {
    rtcConfig as defaultRtcConfig,
    refreshIceServers as defaultRefreshIceServers,
    scheduleIceRefreshTimer as defaultScheduleIceRefreshTimer
} from './ice-config.js';
import { disposeTileElement, registerFullscreenChangeHandler as defaultRegisterFsHandler } from './tile-dom.js';
import { saveSessionRoomPassword as defaultSavePass, clearSessionRoomPassword as defaultClearPass } from './signaling-url.js';
import { STORAGE_KEY } from './preferences.js';

export function clearPeerTimers(peerObj) {
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

/**
 * @typedef {import('./types.js').AppState} AppState
 * @typedef {import('./types.js').DomRefs} DomRefs
 * @typedef {import('./types.js').ShowToastFn} ShowToastFn
 * @typedef {import('./types.js').PlayPresenceChimeFn} PlayPresenceChimeFn
 * @typedef {import('./types.js').AnyWindow} AnyWindow
 * @typedef {import('./types.js').AnyDocument} AnyDocument
 */

/**
 * @param {{
 *   state: AppState,
 *   dom?: DomRefs,
 *   getSocket?: () => any,
 *   getQosMonitor?: () => any,
 *   getGrid?: () => any,
 *   getScreenShare?: () => any,
 *   getRoomModal?: () => any,
 *   getServerUrl?: () => string,
 *   rtcConfig?: any,
 *   refreshIceServers?: typeof defaultRefreshIceServers,
 *   scheduleIceRefreshTimer?: typeof defaultScheduleIceRefreshTimer,
 *   registerFullscreenChangeHandler?: typeof defaultRegisterFsHandler,
 *   saveSessionRoomPassword?: (roomId: string, password: string, sessionStore?: Storage | null) => void,
 *   clearSessionRoomPassword?: (sessionStore?: Storage | null) => void,
 *   showToast?: ShowToastFn,
 *   playPresenceChime?: PlayPresenceChimeFn,
 *   RTCPeerConnectionCtor?: any,
 *   RTCSessionDescriptionCtor?: any,
 *   RTCIceCandidateCtor?: any,
 *   MediaStreamCtor?: any,
 *   documentObj?: AnyDocument | null,
 *   windowObj?: AnyWindow | null,
 *   storage?: Storage | null
 * }} options
 */
export function createWebRtcMesh({
    state,
    dom = /** @type {DomRefs} */ ({}),
    getSocket = () => null,
    getQosMonitor = () => null,
    getGrid = () => null,
    getScreenShare = () => null,
    getRoomModal = () => null,
    getServerUrl = () => '',
    rtcConfig = defaultRtcConfig,
    refreshIceServers = defaultRefreshIceServers,
    scheduleIceRefreshTimer = defaultScheduleIceRefreshTimer,
    registerFullscreenChangeHandler = defaultRegisterFsHandler,
    saveSessionRoomPassword = /** @type {(roomId: string, password: string, sessionStore?: Storage | null) => void} */ (defaultSavePass),
    clearSessionRoomPassword = defaultClearPass,
    showToast = /** @type {ShowToastFn} */ (() => {}),
    playPresenceChime = /** @type {PlayPresenceChimeFn} */ (() => {}),
    RTCPeerConnectionCtor = (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null),
    RTCSessionDescriptionCtor = (typeof RTCSessionDescription !== 'undefined' ? RTCSessionDescription : null),
    RTCIceCandidateCtor = (typeof RTCIceCandidate !== 'undefined' ? RTCIceCandidate : null),
    MediaStreamCtor = (typeof MediaStream !== 'undefined' ? MediaStream : null),
    documentObj = (typeof document !== 'undefined' ? /** @type {AnyDocument} */ (document) : null),
    windowObj = (typeof window !== 'undefined' ? /** @type {AnyWindow} */ (window) : null),
    storage = (typeof localStorage !== 'undefined' ? localStorage : null)
} = /** @type {any} */ ({})) {
    const peers = new Map();
    const activeRoomPeers = new Set();
    const recentlyRemovedPeers = new Map();
    const remoteActiveStreams = new Set();
    const membership = {
        hasRoomMembershipSnapshot: false,
        lastJoinedSocketId: '',
        roomUsersGeneration: 0,
        isRoomMembershipConfirmed: false
    };

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

    function pruneRecentlyRemovedPeers(now = Date.now()) {
        for (const [id, ts] of recentlyRemovedPeers.entries()) {
            if (now - ts > 30000) {
                recentlyRemovedPeers.delete(id);
            }
        }
    }

    function setPeerConnectionStatus(peerId, status, message) {
        const peerObj = peers.get(peerId);
        if (!peerObj) return;
        peerObj._connectionStatus = status === 'failed' ? { status, message } : null;
        if (!peerObj.tileEl) return;
        let warningEl = peerObj.tileEl.querySelector('.peer-connection-warning');
        if (status === 'failed') {
            if (!warningEl && documentObj) {
                warningEl = documentObj.createElement('div');
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
                const warnIcon = documentObj.createElement('i');
                warnIcon.className = 'fa-solid fa-triangle-exclamation';
                const warnText = documentObj.createElement('span');
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
            stats.forEach((report) => {
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

    function updateBackgroundTracksOptimization() {
        const doc = documentObj;
        const isHidden = Boolean(doc && doc.hidden);
        const pipEl = doc ? (doc.pictureInPictureElement || null) : null;
        const activeFsEl = doc
            ? (doc.fullscreenElement || (/** @type {any} */ (doc)).webkitFullscreenElement || null)
            : null;
        const activeFsTile = doc
            ? (doc.querySelector('.stream-tile.pseudo-fullscreen') ||
                (activeFsEl && activeFsEl.classList.contains('stream-tile') ? activeFsEl : null))
            : null;
        const activeFsPeerId = activeFsTile ? activeFsTile.dataset.peerId : null;

        for (const [peerId, peerObj] of peers.entries()) {
            if (peerObj.stream) {
                const tileVideo = peerObj.tileEl && typeof peerObj.tileEl.querySelector === 'function'
                    ? peerObj.tileEl.querySelector('video')
                    : null;
                const isPipActive = Boolean(
                    pipEl &&
                    peerObj.tileEl &&
                    ((typeof peerObj.tileEl.contains === 'function' && peerObj.tileEl.contains(pipEl)) || tileVideo === pipEl)
                );

                peerObj.stream.getVideoTracks().forEach((track) => {
                    if (isHidden) {
                        track.enabled = isPipActive;
                    } else if (activeFsPeerId && peerId !== activeFsPeerId && activeFsPeerId !== 'local') {
                        track.enabled = isPipActive;
                    } else {
                        track.enabled = true;
                    }
                });
            }
        }
    }

    function addLocalTracksToPC(pc) {
        if (!pc || !state.localStream) return Promise.resolve([]);
        const qm = getQosMonitor();
        const senders = pc.getSenders();
        const transceivers = typeof pc.getTransceivers === 'function' ? pc.getTransceivers() : null;
        const replacePromises = [];
        state.localStream.getTracks().forEach((track) => {
            let existingSender = null;
            const matchedTransceiver = transceivers
                ? (transceivers.find((t) => {
                    const s = t && t.sender;
                    if (!s) return false;
                    if (s.track) return s.track.id === track.id || s.track.kind === track.kind;
                    const receiverKind = t.receiver && t.receiver.track && t.receiver.track.kind;
                    return (s._kind && s._kind === track.kind) || (receiverKind === track.kind);
                }) || null)
                : null;
            if (matchedTransceiver) {
                existingSender = matchedTransceiver.sender;
                if (matchedTransceiver.direction === 'recvonly') {
                    matchedTransceiver.direction = 'sendrecv';
                } else if (matchedTransceiver.direction === 'inactive') {
                    matchedTransceiver.direction = 'sendonly';
                }
            }
            if (!existingSender) {
                existingSender = senders.find((s) =>
                    (s.track && (s.track.id === track.id || s.track.kind === track.kind)) ||
                    (!s.track && (s._kind === track.kind || (!transceivers && s._kind === undefined && s.dtlsTransport)))
                );
            }
            if (existingSender) {
                existingSender._kind = track.kind;
                if (existingSender.track !== track) {
                    try {
                        replacePromises.push(Promise.resolve(existingSender.replaceTrack(track)).catch(() => {}));
                    } catch (_) {}
                }
                if (qm) qm.configureSenderParams(existingSender, track.kind);
            } else {
                const sender = pc.addTrack(track, state.localStream);
                sender._kind = track.kind;
                if (qm) qm.configureSenderParams(sender, track.kind);
            }
        });
        return Promise.allSettled(replacePromises);
    }

    async function sendOffer(peerId) {
        const peerObj = peers.get(peerId);
        if (!peerObj || !peerObj.pc) return;
        const pc = peerObj.pc;

        if (!isPeerConnectionActive(peerId, peerObj, pc)) return;

        if (peerObj.makingOffer || pc.signalingState !== 'stable') {
            peerObj.pendingOffer = true;
            console.warn(`[WebRTC] Enfileirando oferta pendente para ${peerId} (makingOffer: ${peerObj.makingOffer}, signalingState: ${pc.signalingState})`);
            return;
        }

        const socket = getSocket();
        try {
            peerObj.makingOffer = true;
            peerObj.pendingOffer = false;
            let offer = await pc.createOffer();
            if (!isPeerConnectionActive(peerId, peerObj, pc) || pc.signalingState !== 'stable') {
                peerObj.pendingOffer = true;
                return;
            }
            offer = new RTCSessionDescriptionCtor({
                type: offer.type,
                sdp: optimizeSDP(offer.sdp)
            });
            await pc.setLocalDescription(offer);
            if (!isPeerConnectionActive(peerId, peerObj, pc)) return;
            if (socket) socket.emit('signal', { targetId: peerId, signal: pc.localDescription });
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

    function getOrCreatePeerConnection(peerId) {
        if (peers.has(peerId)) {
            return peers.get(peerId).pc;
        }

        console.log('[WebRTC] Initializing PeerConnection for:', peerId);
        const pc = new RTCPeerConnectionCtor(rtcConfig);
        const isPolite = Boolean(state.myId && peerId && state.myId < peerId);

        const peerObj = {
            pc,
            stream: MediaStreamCtor ? new MediaStreamCtor() : null,
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
                    if ((pc.iceConnectionState === 'failed' || pc.connectionState === 'failed') &&
                        (peerObj._iceRestartAttempts || 0) < 3) {
                        scheduleIceRestart();
                    }
                }
            }, delayMs);
        };

        pc.onicecandidate = (event) => {
            const socket = getSocket();
            if (event.candidate && peers.get(peerId) === peerObj && pc.signalingState !== 'closed' && pc.connectionState !== 'closed') {
                if (socket) {
                    socket.emit('signal', {
                        targetId: peerId,
                        signal: { candidate: event.candidate }
                    });
                }
            }
        };

        pc.ontrack = (event) => {
            console.log('[WebRTC] Received track from:', peerId, event.track.kind, event.track.id);
            const grid = getGrid();

            peerObj.stream.getTracks().filter((t) => t.kind === event.track.kind).forEach((oldTrack) => {
                if (oldTrack.id !== event.track.id) {
                    try { peerObj.stream.removeTrack(oldTrack); } catch (_) {}
                }
            });

            if (!peerObj.stream.getTracks().some((t) => t.id === event.track.id)) {
                peerObj.stream.addTrack(event.track);
            }

            const hasVideo = peerObj.stream.getVideoTracks().length > 0;
            if (!peerObj.tileEl && hasVideo && grid) {
                const label = peerObj.userName || `Participante ${peerId.substr(0, 5)}`;
                peerObj.tileEl = grid.createStreamTile(peerId, peerObj.stream, label, false);
                if (dom.streamGrid) dom.streamGrid.appendChild(peerObj.tileEl);
                if (peerObj._connectionStatus) {
                    setPeerConnectionStatus(peerId, peerObj._connectionStatus.status, peerObj._connectionStatus.message);
                }
            }

            if (peerObj.tileEl) {
                const videoEl = typeof peerObj.tileEl.querySelector === 'function'
                    ? peerObj.tileEl.querySelector('video')
                    : null;
                if (videoEl) {
                    if (videoEl.srcObject !== peerObj.stream) {
                        videoEl.srcObject = peerObj.stream;
                    }
                    if (grid) grid.startTilePlayback(peerObj.tileEl, videoEl);
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
                    const socket = getSocket();
                    if (socket) {
                        socket.emit('signal', {
                            targetId: peerId,
                            signal: { type: 'request-keyframe' }
                        });
                    }
                }, 1200);
            }

            if (grid) grid.updateGridState();
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

    function removePeerConnection(peerId) {
        if (peers.has(peerId)) {
            const peerObj = peers.get(peerId);
            clearPeerTimers(peerObj);
            if (peerObj.stream) {
                peerObj.stream.getTracks().forEach((track) => track.stop());
            }
            if (peerObj.pc) peerObj.pc.close();
            if (peerObj.tileEl) {
                disposeTileElement(peerObj.tileEl, documentObj);
            }
            peers.delete(peerId);
            const grid = getGrid();
            if (grid) grid.updateGridState();
            updateBackgroundTracksOptimization();
        }
    }

    function ensureRemoteStreamTile(peerId) {
        const peerObj = peers.get(peerId);
        if (!peerObj) return;
        const grid = getGrid();
        if (!peerObj.stream && MediaStreamCtor) {
            peerObj.stream = new MediaStreamCtor();
        }
        if (peerObj.pc && typeof peerObj.pc.getReceivers === 'function') {
            peerObj.pc.getReceivers().forEach((receiver) => {
                const track = receiver && receiver.track;
                if (!track || track.readyState === 'ended') return;
                peerObj.stream.getTracks().filter((t) => t.kind === track.kind && t.id !== track.id).forEach((oldTrack) => {
                    try { peerObj.stream.removeTrack(oldTrack); } catch (_) {}
                });
                if (!peerObj.stream.getTracks().some((t) => t.id === track.id)) {
                    peerObj.stream.addTrack(track);
                }
            });
        }
        const hasVideo = peerObj.stream.getVideoTracks().length > 0;
        if (!peerObj.tileEl && hasVideo && grid) {
            const label = peerObj.userName || `Participante ${peerId.substr(0, 5)}`;
            peerObj.tileEl = grid.createStreamTile(peerId, peerObj.stream, label, false);
            if (dom.streamGrid) dom.streamGrid.appendChild(peerObj.tileEl);
            if (peerObj._connectionStatus) {
                setPeerConnectionStatus(peerId, peerObj._connectionStatus.status, peerObj._connectionStatus.message);
            }
        }
        if (peerObj.tileEl) {
            const videoEl = typeof peerObj.tileEl.querySelector === 'function'
                ? peerObj.tileEl.querySelector('video')
                : null;
            if (videoEl) {
                if (videoEl.srcObject !== peerObj.stream) {
                    videoEl.srcObject = peerObj.stream;
                }
                if (grid) grid.startTilePlayback(peerObj.tileEl, videoEl);
            }
        }
        if (grid) grid.updateGridState();
    }

    function removeStreamTile(peerId) {
        if (peers.has(peerId)) {
            const peerObj = peers.get(peerId);
            if (peerObj._keyframeCheckInterval) {
                clearInterval(peerObj._keyframeCheckInterval);
                peerObj._keyframeCheckInterval = null;
            }
            if (peerObj.tileEl) {
                disposeTileElement(peerObj.tileEl, documentObj);
                peerObj.tileEl = null;
            }
            if (MediaStreamCtor) {
                peerObj.stream = new MediaStreamCtor();
            }
            const grid = getGrid();
            if (grid) grid.updateGridState();
            updateBackgroundTracksOptimization();
        }
    }

    function cleanupRoomState(options = {}) {
        const silentShareStop = options && options.silent !== undefined ? Boolean(options.silent) : true;
        console.log('[Room] Cleaning up previous room peer connections and stream tiles...');
        membership.roomUsersGeneration += 1;

        const screenShare = getScreenShare();
        if (screenShare) {
            screenShare.invalidateGeneration();
            if (state.localStream) {
                screenShare.stopScreenShare({ silent: silentShareStop });
            }
        }

        for (const [peerId, peerObj] of peers.entries()) {
            try {
                clearPeerTimers(peerObj);
                if (peerObj.stream) {
                    peerObj.stream.getTracks().forEach((track) => track.stop());
                }
                if (peerObj.pc) peerObj.pc.close();
                if (peerObj.tileEl) disposeTileElement(peerObj.tileEl, documentObj);
            } catch (e) {
                console.warn('[Room] Error closing peer:', peerId, e);
            }
        }
        peers.clear();
        activeRoomPeers.clear();
        recentlyRemovedPeers.clear();
        membership.lastJoinedSocketId = '';
        membership.isRoomMembershipConfirmed = false;
        remoteActiveStreams.clear();

        const grid = getGrid();
        if (grid) grid.updateEchoWarningVisibility();

        if (dom.streamGrid && typeof dom.streamGrid.querySelectorAll === 'function') {
            const remoteTiles = dom.streamGrid.querySelectorAll('.stream-tile:not(#localStreamTile)');
            remoteTiles.forEach((tile) => disposeTileElement(tile, documentObj));
        }

        if (grid) {
            grid.updateMemberCount(1);
            grid.updateGridState();
        }
        updateBackgroundTracksOptimization();
    }

    function handleSignal(payload) {
        if (!payload || typeof payload !== 'object') return;
        const { senderId, signal } = payload;
        if (!senderId || typeof senderId !== 'string') return;
        if (!signal || typeof signal !== 'object') return;
        if (state.myId && senderId === state.myId) return;

        if (recentlyRemovedPeers.has(senderId)) return;
        if (membership.hasRoomMembershipSnapshot && !peers.has(senderId) && !activeRoomPeers.has(senderId)) {
            return;
        }
        if (signal.type === 'request-keyframe' && !peers.has(senderId)) {
            return;
        }

        const pc = getOrCreatePeerConnection(senderId);
        const peerObj = peers.get(senderId);
        if (!isPeerConnectionActive(senderId, peerObj, pc)) return;

        const socket = getSocket();

        const runSignalTask = async () => {
            if (!isPeerConnectionActive(senderId, peerObj, pc)) return;

            if (signal.type === 'offer') {
                if (socket && socket._pendingIceRefreshPromise) {
                    try {
                        await socket._pendingIceRefreshPromise;
                    } catch (_) {}
                    if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                    if (typeof pc.setConfiguration === 'function' && rtcConfig) {
                        try { pc.setConfiguration(rtcConfig); } catch (_) {}
                    }
                }

                const offerCollision = Boolean(peerObj.makingOffer || pc.signalingState !== 'stable');
                peerObj.ignoreOffer = !peerObj.isPolite && offerCollision;

                if (peerObj.ignoreOffer) {
                    console.warn('[WebRTC] Glare collision: Impolite peer ignoring offer from:', senderId);
                    return;
                }

                let hadLocalOfferRollback = false;
                if (offerCollision) {
                    hadLocalOfferRollback = pc.signalingState === 'have-local-offer';
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
                    await pc.setRemoteDescription(new RTCSessionDescriptionCtor(signal));
                } catch (err) {
                    peerObj.isRemoteDescriptionSet = Boolean(
                        prevRemoteSet && pc.remoteDescription && pc.remoteDescription.type
                    );
                    throw err;
                }
                if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                peerObj.isRemoteDescriptionSet = true;

                while (peerObj.iceCandidateQueue.length > 0) {
                    if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                    const cand = peerObj.iceCandidateQueue.shift();
                    try { await pc.addIceCandidate(cand); } catch (_) {}
                }
                if (!isPeerConnectionActive(senderId, peerObj, pc)) return;

                if (state.localStream) {
                    await addLocalTracksToPC(pc);
                    if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                }

                let answer = await pc.createAnswer();
                if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                answer = new RTCSessionDescriptionCtor({
                    type: answer.type,
                    sdp: optimizeSDP(answer.sdp)
                });
                await pc.setLocalDescription(answer);
                if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                if (socket) socket.emit('signal', { targetId: senderId, signal: pc.localDescription });

                if (hadLocalOfferRollback) {
                    peerObj.pendingOffer = true;
                }

                if (peerObj.pendingOffer && pc.signalingState === 'stable') {
                    peerObj.pendingOffer = false;
                    Promise.resolve().then(() => sendOffer(senderId));
                }
            } else if (signal.type === 'answer') {
                if (pc.signalingState === 'have-local-offer') {
                    peerObj.ignoreOffer = false;
                    await pc.setRemoteDescription(new RTCSessionDescriptionCtor(signal));
                    if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                    peerObj.isRemoteDescriptionSet = true;
                    while (peerObj.iceCandidateQueue.length > 0) {
                        if (!isPeerConnectionActive(senderId, peerObj, pc)) return;
                        const cand = peerObj.iceCandidateQueue.shift();
                        try { await pc.addIceCandidate(cand); } catch (_) {}
                    }
                    if (peerObj.pendingOffer && pc.signalingState === 'stable') {
                        peerObj.pendingOffer = false;
                        Promise.resolve().then(() => sendOffer(senderId));
                    }
                }
            } else if (signal.candidate) {
                if (peerObj.ignoreOffer) return;
                const candidate = new RTCIceCandidateCtor(signal.candidate);
                if (pc.remoteDescription && pc.remoteDescription.type && peerObj.isRemoteDescriptionSet) {
                    try {
                        await pc.addIceCandidate(candidate);
                    } catch (err) {
                        console.warn('[WebRTC] Candidate error:', err);
                    }
                } else {
                    peerObj.iceCandidateQueue.push(candidate);
                }
            } else if (signal.type === 'request-keyframe') {
                if (state.localStream) {
                    const videoTrack = state.localStream.getVideoTracks()[0];
                    const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
                    if (videoSender && videoTrack) {
                        console.log(`[WebRTC] Peer ${senderId} solicitou keyframe (tela preta). Forçando IDR frame via replaceTrack...`);
                        try { Promise.resolve(videoSender.replaceTrack(videoTrack)).catch(() => {}); } catch (_) {}
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
    }

    async function handleRoomUsers({ users, userNames, activeStreams, socketId, memberCount, hasPassword }) {
        const prevJoinedSocketId = membership.lastJoinedSocketId;
        const joinGen = ++membership.roomUsersGeneration;
        const roomModalCtrl = getRoomModal();
        const grid = getGrid();
        const qm = getQosMonitor();
        const socket = getSocket();

        if (state.pendingRoomJoin) {
            const target = state.pendingRoomJoin;
            state.pendingRoomJoin = null;

            if (state.roomId && state.roomId !== target.roomId) {
                cleanupRoomState();
            }

            state.roomId = target.roomId;
            state.currentRoomPassword = target.password;

            if (state.currentRoomPassword) {
                saveSessionRoomPassword(state.roomId, state.currentRoomPassword);
            } else {
                clearSessionRoomPassword();
            }

            if (storage) {
                try { storage.setItem(STORAGE_KEY, state.roomId); } catch (_) {}
            }
            if (windowObj && windowObj.location && windowObj.location.protocol && windowObj.location.protocol.startsWith('http') && windowObj.history && windowObj.history.pushState) {
                try {
                    const newUrl = `${windowObj.location.pathname}?room=${encodeURIComponent(state.roomId)}`;
                    windowObj.history.pushState({ path: newUrl }, '', newUrl);
                } catch (_) {}
            }

            if (roomModalCtrl) {
                roomModalCtrl.closeRoomModal();
                roomModalCtrl.updateRoomModalCloseButton();
            }
        }

        state.myId = socketId;
        membership.lastJoinedSocketId = socketId || '';
        membership.isRoomMembershipConfirmed = true;

        console.log('[Socket] Joined room. My ID:', state.myId, 'Other users:', users, 'Active streams:', activeStreams);
        remoteActiveStreams.clear();
        if (Array.isArray(activeStreams)) {
            activeStreams.forEach((id) => { if (id !== state.myId) remoteActiveStreams.add(id); });
        }
        if (grid) grid.updateEchoWarningVisibility();

        const activeUserSet = new Set((Array.isArray(users) ? users : []).filter((id) => id && id !== state.myId));
        membership.hasRoomMembershipSnapshot = true;
        activeRoomPeers.clear();
        activeUserSet.forEach((id) => activeRoomPeers.add(id));
        activeUserSet.forEach((id) => recentlyRemovedPeers.delete(id));

        const socketChangedOnReconnect = Boolean(prevJoinedSocketId && socketId && prevJoinedSocketId !== socketId);
        for (const existingPeerId of Array.from(peers.keys())) {
            if (socketChangedOnReconnect || !activeUserSet.has(existingPeerId)) {
                removePeerConnection(existingPeerId);
            }
        }

        if (grid) grid.updateMemberCount(memberCount || (activeUserSet.size + 1));

        if (dom.displayRoomId) {
            dom.displayRoomId.textContent = state.roomId;
            if (hasPassword && documentObj) {
                const icon = documentObj.createElement('i');
                icon.className = 'fa-solid fa-lock';
                icon.style.fontSize = '0.75rem';
                icon.style.marginLeft = '4px';
                icon.title = 'Sala protegida por senha';
                dom.displayRoomId.appendChild(icon);
            }
        }

        const offeredDuringAwait = new Set();
        const serverUrl = getServerUrl();
        if (typeof refreshIceServers === 'function' && serverUrl) {
            if (socket) {
                socket._roomUsersAwaitGen = joinGen;
                socket._roomUsersOfferedPeers = offeredDuringAwait;
            }
            const iceRefreshRace = Promise.race([
                refreshIceServers(serverUrl, { peers }),
                new Promise((resolve) => setTimeout(resolve, 1200))
            ]);
            if (socket) {
                socket._pendingIceRefreshPromise = iceRefreshRace;
            }
            try {
                await iceRefreshRace;
            } finally {
                if (socket && socket._pendingIceRefreshPromise === iceRefreshRace) {
                    socket._pendingIceRefreshPromise = null;
                }
                if (socket && socket._roomUsersAwaitGen === joinGen) {
                    socket._roomUsersAwaitGen = 0;
                    socket._roomUsersOfferedPeers = null;
                }
            }
            if (membership.roomUsersGeneration !== joinGen) {
                return;
            }
            if (typeof scheduleIceRefreshTimer === 'function') {
                scheduleIceRefreshTimer(serverUrl, { peers });
            }
        }

        activeRoomPeers.forEach((peerId) => {
            if (!peerId || peerId === state.myId) return;
            getOrCreatePeerConnection(peerId);
            if (userNames && userNames[peerId] && grid) {
                grid.updatePeerUserName(peerId, userNames[peerId]);
            }
        });

        if (state.localStream) {
            const trackPromises = [];
            for (const [peerId, peerObj] of peers.entries()) {
                if (offeredDuringAwait.has(peerId)) continue;
                trackPromises.push(
                    Promise.resolve(addLocalTracksToPC(peerObj.pc)).then(() => {
                        if (!isPeerConnectionActive(peerId, peerObj, peerObj.pc)) return;
                        return sendOffer(peerId);
                    })
                );
            }
            await Promise.allSettled(trackPromises);
            if (qm) qm.updateSendersForActivePeers();
            if (state.roomId && socket && typeof socket.emit === 'function') {
                socket.emit('stream-state', { roomId: state.roomId, state: 'started' });
            }
        }
    }

    async function handleUserJoined({ socketId, userName, memberCount }) {
        if (!socketId || (state.myId && socketId === state.myId)) return;
        console.log('[Socket] User joined:', socketId, userName);
        const grid = getGrid();
        const qm = getQosMonitor();
        const socket = getSocket();

        const displayName = userName || 'Um participante';
        showToast(`${displayName} entrou na sala.`, 'info');
        playPresenceChime('join');
        if (grid) grid.updateMemberCount(memberCount);
        activeRoomPeers.add(socketId);
        recentlyRemovedPeers.delete(socketId);

        const pc = getOrCreatePeerConnection(socketId);
        const peerObj = peers.get(socketId);
        if (userName && grid) grid.updatePeerUserName(socketId, userName);

        if (state.localStream) {
            await addLocalTracksToPC(pc);
            if (!isPeerConnectionActive(socketId, peerObj, pc)) return;
            sendOffer(socketId);
            if (socket && socket._roomUsersOfferedPeers) {
                socket._roomUsersOfferedPeers.add(socketId);
            }
            if (qm) qm.updateSendersForActivePeers();

            if (peerObj) {
                if (peerObj._keyframePulseTimeout) clearTimeout(peerObj._keyframePulseTimeout);
                peerObj._keyframePulseTimeout = setTimeout(() => {
                    peerObj._keyframePulseTimeout = null;
                    if (!isPeerConnectionActive(socketId, peerObj, pc) || !state.localStream) return;
                    const vTrack = state.localStream.getVideoTracks()[0];
                    if (!vTrack) return;
                    const vSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
                    if (vSender) {
                        try { Promise.resolve(vSender.replaceTrack(vTrack)).catch(() => {}); } catch (_) {}
                    }
                }, 400);
            }
        }
    }

    function handleUserLeft({ socketId, memberCount }) {
        remoteActiveStreams.delete(socketId);
        const grid = getGrid();
        const qm = getQosMonitor();
        if (grid) grid.updateEchoWarningVisibility();
        console.log('[Socket] User left:', socketId);
        const peerObj = peers.get(socketId);
        const displayName = (peerObj && peerObj.userName) || 'Um participante';
        showToast(`${displayName} saiu da sala.`, 'info');
        playPresenceChime('leave');
        activeRoomPeers.delete(socketId);
        if (socketId) {
            pruneRecentlyRemovedPeers();
            recentlyRemovedPeers.set(socketId, Date.now());
        }
        removePeerConnection(socketId);
        if (grid) grid.updateMemberCount(memberCount);
        if (state.localStream && qm) {
            qm.updateSendersForActivePeers();
        }
    }

    function handleStreamState({ senderId, state: streamState }) {
        if (streamState === 'started') {
            remoteActiveStreams.add(senderId);
            ensureRemoteStreamTile(senderId);
        } else {
            remoteActiveStreams.delete(senderId);
            removeStreamTile(senderId);
        }
        const grid = getGrid();
        if (grid) grid.updateEchoWarningVisibility();
    }

    function bindLifecycleListeners() {
        if (documentObj && typeof documentObj.addEventListener === 'function') {
            documentObj.addEventListener('visibilitychange', updateBackgroundTracksOptimization);
            documentObj.addEventListener('fullscreenchange', updateBackgroundTracksOptimization);
            documentObj.addEventListener('webkitfullscreenchange', updateBackgroundTracksOptimization);
            documentObj.addEventListener('enterpictureinpicture', updateBackgroundTracksOptimization);
            documentObj.addEventListener('leavepictureinpicture', updateBackgroundTracksOptimization);
        }
        if (typeof registerFullscreenChangeHandler === 'function') {
            registerFullscreenChangeHandler(updateBackgroundTracksOptimization);
        }
    }

    function unbindLifecycleListeners() {
        if (documentObj && typeof documentObj.removeEventListener === 'function') {
            documentObj.removeEventListener('visibilitychange', updateBackgroundTracksOptimization);
            documentObj.removeEventListener('fullscreenchange', updateBackgroundTracksOptimization);
            documentObj.removeEventListener('webkitfullscreenchange', updateBackgroundTracksOptimization);
            documentObj.removeEventListener('enterpictureinpicture', updateBackgroundTracksOptimization);
            documentObj.removeEventListener('leavepictureinpicture', updateBackgroundTracksOptimization);
        }
        if (typeof registerFullscreenChangeHandler === 'function') {
            registerFullscreenChangeHandler(null);
        }
    }

    return {
        peers,
        activeRoomPeers,
        recentlyRemovedPeers,
        remoteActiveStreams,
        membership,
        isPeerConnectionActive,
        setPeerConnectionStatus,
        logPeerConnectionTelemetry,
        updateBackgroundTracksOptimization,
        getOrCreatePeerConnection,
        addLocalTracksToPC,
        sendOffer,
        removePeerConnection,
        ensureRemoteStreamTile,
        removeStreamTile,
        cleanupRoomState,
        handleSignal,
        handleRoomUsers,
        handleUserJoined,
        handleUserLeft,
        handleStreamState,
        bindLifecycleListeners,
        unbindLifecycleListeners
    };
}

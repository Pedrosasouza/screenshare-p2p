import { getVideoConstraints } from './qos.js';

const SYSTEM_AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
};

/**
 * @typedef {import('./types.js').AppState} AppState
 * @typedef {import('./types.js').DomRefs} DomRefs
 * @typedef {import('./types.js').ShowToastFn} ShowToastFn
 * @typedef {import('./types.js').AnyDocument} AnyDocument
 */

/**
 * @param {{
 *   state: AppState,
 *   dom?: DomRefs,
 *   getSocket?: () => any,
 *   getPeers?: () => Map<string, any>,
 *   getWebRtc?: () => any,
 *   getGrid?: () => any,
 *   getQosMonitor?: () => any,
 *   startExcludeDiscordCapture?: () => Promise<any>,
 *   startExcludeAppCapture?: ((pid: any) => Promise<any>) | null,
 *   startAppAudioCapture?: (pid: any, opts?: any) => Promise<any>,
 *   stopAppAudioCapture?: () => void,
 *   showToast?: ShowToastFn,
 *   documentObj?: AnyDocument | null,
 *   navigatorObj?: (Navigator & Record<string, any>) | null,
 *   MediaStreamCtor?: typeof MediaStream | null
 * }} options
 */
export function createScreenShareController({
    state,
    dom = /** @type {DomRefs} */ ({}),
    getSocket = () => null,
    getPeers = () => new Map(),
    getWebRtc = () => null,
    getGrid = () => null,
    getQosMonitor = () => null,
    startExcludeDiscordCapture = async () => null,
    startExcludeAppCapture = null,
    startAppAudioCapture = async () => null,
    stopAppAudioCapture = () => {},
    showToast = /** @type {ShowToastFn} */ (() => {}),
    documentObj = (typeof document !== 'undefined' ? /** @type {AnyDocument} */ (document) : null),
    navigatorObj = (typeof navigator !== 'undefined' ? /** @type {Navigator & Record<string, any>} */ (navigator) : null),
    MediaStreamCtor = (typeof MediaStream !== 'undefined' ? MediaStream : null)
} = /** @type {any} */ ({})) {
    const shareMeta = /** @type {{ _generation?: number, _isStarting?: boolean, _attemptToken?: number }} */ (/** @type {unknown} */ (startScreenShare));

    async function stopScreenShare(options = {}) {
        const silent = Boolean(options && options.silent === true);
        shareMeta._generation = (shareMeta._generation || 0) + 1;

        const qm = getQosMonitor();
        if (qm) qm.stopQualityMonitor();
        stopAppAudioCapture();

        if (state.localStream) {
            state.localStream.getTracks().forEach((track) => track.stop());
            state.localStream = null;
        }

        const peers = getPeers();
        const webrtc = getWebRtc();
        const renegotiationPromises = [];
        if (!silent) {
            for (const [peerId, peerObj] of peers.entries()) {
                const pc = peerObj && peerObj.pc;
                if (!pc || pc.connectionState === 'closed' || pc.signalingState === 'closed') continue;

                const transceivers = typeof pc.getTransceivers === 'function' ? pc.getTransceivers() : null;
                if (transceivers) {
                    transceivers.forEach((t) => {
                        if (t && t.sender && t.sender.track) {
                            t.sender._kind = t.sender.track.kind;
                            if (t.direction === 'sendrecv') t.direction = 'recvonly';
                            else if (t.direction === 'sendonly') t.direction = 'inactive';
                        }
                    });
                }

                const replacePromises = [];
                const senders = typeof pc.getSenders === 'function' ? pc.getSenders() : [];
                senders.forEach((sender) => {
                    try {
                        if (sender.track && !sender._kind) {
                            sender._kind = sender.track.kind;
                        }
                        replacePromises.push(Promise.resolve(sender.replaceTrack(null)).catch(() => {}));
                    } catch (_) {}
                });

                renegotiationPromises.push(
                    Promise.allSettled(replacePromises).then(() => {
                        const current = peers.get(peerId);
                        if (!current || current.pc !== pc) return;
                        if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return;
                        if (webrtc && typeof webrtc.sendOffer === 'function') {
                            return webrtc.sendOffer(peerId);
                        }
                    })
                );
            }
        }

        const localTile = documentObj && typeof documentObj.getElementById === 'function'
            ? documentObj.getElementById('localStreamTile')
            : null;
        if (localTile) {
            const localVideo = typeof localTile.querySelector === 'function' ? localTile.querySelector('video') : null;
            if (localVideo) localVideo.srcObject = null;
            localTile.remove();
        }

        if (dom.btnStartShare) dom.btnStartShare.hidden = false;
        if (dom.btnStopShare) dom.btnStopShare.hidden = true;
        if (dom.btnQualityToggle) dom.btnQualityToggle.hidden = true;

        const grid = getGrid();
        if (grid) grid.updateGridState();

        const socket = getSocket();
        if (!silent && socket && typeof socket.emit === 'function') {
            socket.emit('stream-state', { roomId: state.roomId, state: 'stopped' });
        }

        return Promise.allSettled(renegotiationPromises);
    }

    async function captureDisplayMedia(constraints) {
        try {
            return await navigatorObj.mediaDevices.getDisplayMedia(constraints);
        } catch (err) {
            if (err && err.name === 'NotAllowedError') return null;
            throw err;
        }
    }

    async function startScreenShare(
        audioMode = 'exclude_discord',
        targetPid = null,
        resolution = state.selectedVideoResolution,
        fps = state.selectedVideoFps,
        options = {}
    ) {
        if (shareMeta._isStarting) return;
        shareMeta._isStarting = true;
        const attemptToken = (shareMeta._attemptToken || 0) + 1;
        shareMeta._attemptToken = attemptToken;

        let screenStream = null;
        let audioTrack = null;
        let captureSucceeded = false;
        let startedDesktopAudioThisAttempt = false;
        let shareGen = null;

        try {
            const preStopGen = shareMeta._generation || 0;
            const hadLocalStream = Boolean(state.localStream);
            if (hadLocalStream) {
                await stopScreenShare();
                if ((shareMeta._generation || 0) > preStopGen + 1) {
                    return;
                }
            } else if ((shareMeta._generation || 0) !== preStopGen) {
                return;
            }

            shareGen = (shareMeta._generation || 0) + 1;
            shareMeta._generation = shareGen;
            const isShareCancelled = () => (shareMeta._generation || 0) !== shareGen;

            let idealFps = Number(fps) || 60;
            let idealWidth = resolution === '720p' ? 1280 : 1920;

            if (navigatorObj && navigatorObj.connection) {
                const conn = navigatorObj.connection;
                if (conn.saveData || conn.effectiveType === '2g' || conn.effectiveType === '3g') {
                    console.log(`[Capture] ⚠️ Low-bandwidth detected (${conn.effectiveType}), defaulting to 720p30 profile`);
                    idealWidth = 1280;
                    idealFps = 30;
                }
            }

            const videoConstraints = getVideoConstraints(idealWidth === 1280 ? '720p' : '1080p', idealFps);
            const shouldExcludeSelectedApp = audioMode === 'exclude_app' || (
                audioMode === 'app' && Boolean(
                    options && options.excludeApp !== undefined ? options.excludeApp : state.excludeSelectedApp
                )
            );

            async function captureWithExcludeFallback(captureFn, targetLabel) {
                let excludeSucceeded = false;
                try {
                    startedDesktopAudioThisAttempt = true;
                    audioTrack = await captureFn();
                    if (audioTrack) {
                        excludeSucceeded = true;
                        console.log(`[Audio] ✅ Capturando áudio no modo exclusão (${targetLabel})`);
                    } else {
                        startedDesktopAudioThisAttempt = false;
                        try {
                            await stopAppAudioCapture();
                        } catch (_) {}
                        showToast(`Aviso de Áudio: Não foi possível isolar ${targetLabel} — alternando para áudio completo do sistema.`, 'warning');
                    }
                } catch (appErr) {
                    console.warn(`[Audio] Falha ao capturar no modo excluir ${targetLabel}:`, appErr.message);
                    showToast('Aviso de Áudio: ' + appErr.message + ' — alternando para áudio completo do sistema.', 'warning');
                    startedDesktopAudioThisAttempt = false;
                    try {
                        await stopAppAudioCapture();
                    } catch (_) {}
                }

                if (isShareCancelled()) return null;

                if (excludeSucceeded) {
                    return captureDisplayMedia({
                        video: videoConstraints,
                        audio: false
                    });
                }

                const fallbackStream = await captureDisplayMedia({
                    video: videoConstraints,
                    audio: SYSTEM_AUDIO_CONSTRAINTS
                });
                if (fallbackStream && typeof fallbackStream.getAudioTracks === 'function') {
                    audioTrack = fallbackStream.getAudioTracks()[0] || null;
                }
                return fallbackStream;
            }

            if (audioMode === 'exclude_discord') {
                screenStream = await captureWithExcludeFallback(
                    () => startExcludeDiscordCapture(),
                    'o Discord'
                );
                if (!screenStream || isShareCancelled()) return;
            } else if (shouldExcludeSelectedApp && targetPid) {
                const excludeAppFn = typeof startExcludeAppCapture === 'function'
                    ? () => startExcludeAppCapture(targetPid)
                    : () => startAppAudioCapture(targetPid, { exclude: true });
                screenStream = await captureWithExcludeFallback(
                    excludeAppFn,
                    'o aplicativo selecionado'
                );
                if (!screenStream || isShareCancelled()) return;
            } else if (audioMode === 'app' && targetPid) {
                screenStream = await captureDisplayMedia({
                    video: videoConstraints,
                    audio: false
                });
                if (!screenStream || isShareCancelled()) return;

                try {
                    startedDesktopAudioThisAttempt = true;
                    audioTrack = await startAppAudioCapture(targetPid);
                    console.log('[Audio] ✅ Capturing isolated application audio via WASAPI Loopback for PID:', targetPid);
                } catch (appErr) {
                    console.warn('[Audio] Failed to capture app audio:', appErr.message);
                    showToast('Aviso de Áudio: ' + appErr.message + ' (Continuando transmissão apenas com vídeo)', 'warning');
                }
                if (isShareCancelled()) return;
            } else if (audioMode === 'system') {
                screenStream = await captureDisplayMedia({
                    video: videoConstraints,
                    audio: SYSTEM_AUDIO_CONSTRAINTS
                });
                if (!screenStream || isShareCancelled()) return;

                if (screenStream.getAudioTracks().length > 0) {
                    audioTrack = screenStream.getAudioTracks()[0];
                    console.log('[Audio] ✅ System audio captured directly via getDisplayMedia');
                }
            } else if (audioMode === 'app' || audioMode === 'exclude_app') {
                showToast('Nenhum aplicativo selecionado para áudio isolado. Continuando apenas com vídeo.', 'warning');
                screenStream = await captureDisplayMedia({
                    video: videoConstraints,
                    audio: false
                });
                if (!screenStream || isShareCancelled()) return;
            } else {
                screenStream = await captureDisplayMedia({
                    video: videoConstraints,
                    audio: false
                });
                if (!screenStream || isShareCancelled()) return;
            }

            if (isShareCancelled()) return;

            const videoTrack = screenStream && screenStream.getVideoTracks()[0];
            if (!videoTrack) {
                throw new Error('Nenhuma trilha de vídeo foi capturada.');
            }
            if ('contentHint' in videoTrack) {
                videoTrack.contentHint = state.contentHintMode;
                console.log(`[WebRTC] videoTrack contentHint set to "${state.contentHintMode}"`);
            }

            const effectiveAudioTrack = audioTrack || (typeof screenStream.getAudioTracks === 'function' ? screenStream.getAudioTracks()[0] : null);
            if (effectiveAudioTrack && 'contentHint' in effectiveAudioTrack) {
                effectiveAudioTrack.contentHint = 'music';
            }

            if (audioTrack && !screenStream.getAudioTracks().includes(audioTrack)) {
                state.localStream = new MediaStreamCtor([videoTrack, audioTrack]);
            } else {
                state.localStream = screenStream;
            }

            const grid = getGrid();
            if (grid) {
                const localLabel = state.currentUserName ? `${state.currentUserName} (Você)` : 'Você (Sua Tela)';
                const localTile = grid.createStreamTile('local', state.localStream, localLabel, true);
                localTile.id = 'localStreamTile';
                if (dom.streamGrid) dom.streamGrid.appendChild(localTile);
                grid.startTilePlayback(localTile);
            }

            if (dom.btnStartShare) dom.btnStartShare.hidden = true;
            if (dom.btnStopShare) dom.btnStopShare.hidden = false;
            if (dom.btnQualityToggle) dom.btnQualityToggle.hidden = false;
            if (grid) grid.updateGridState();

            state.localStream.getVideoTracks()[0].onended = () => {
                stopScreenShare();
            };

            const peers = getPeers();
            const webrtc = getWebRtc();
            const trackSetupPromises = [];
            for (const [peerId, peerObj] of peers.entries()) {
                if (webrtc) {
                    trackSetupPromises.push(
                        Promise.resolve(webrtc.addLocalTracksToPC(peerObj.pc, peerObj)).then(() => {
                            const current = peers.get(peerId);
                            if (!current || current.pc !== peerObj.pc) return;
                            return webrtc.sendOffer(peerId);
                        })
                    );
                }
            }
            await Promise.allSettled(trackSetupPromises);

            const socket = getSocket();
            if (socket && typeof socket.emit === 'function') {
                socket.emit('stream-state', { roomId: state.roomId, state: 'started' });
            }
            const qm = getQosMonitor();
            if (qm) qm.startQualityMonitor();
            captureSucceeded = true;

            const finalAudioTracks = state.localStream.getAudioTracks();
            console.log(`[Capture] ✅ Sharing started | Video: yes | Audio: ${finalAudioTracks.length > 0 ? 'yes (' + finalAudioTracks[0].label + ')' : 'no'}`);
        } catch (err) {
            console.error('[Capture] Error getting display media:', err);
            if (err.name !== 'NotAllowedError') {
                showToast('Não foi possível iniciar o compartilhamento: ' + err.message, 'error');
            }
        } finally {
            if (!captureSucceeded) {
                if (state.localStream && (shareGen === null || (shareMeta._generation || 0) === shareGen)) {
                    try {
                        state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                    } catch (_) {}
                    state.localStream = null;
                }
                if (screenStream) {
                    try {
                        screenStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                    } catch (_) {}
                }
                if (audioTrack) {
                    try { audioTrack.stop(); } catch (_) {}
                }
                if ((audioMode === 'exclude_discord' || audioMode === 'exclude_app' || audioMode === 'app') &&
                    startedDesktopAudioThisAttempt &&
                    shareMeta._attemptToken === attemptToken) {
                    try { stopAppAudioCapture(); } catch (_) {}
                }
            }
            shareMeta._isStarting = false;
        }
    }

    async function handleDesktopCaptureStopped(payload) {
        const detail = payload && payload.reason ? ` (${payload.reason})` : '';
        showToast(`Captura de áudio do aplicativo interrompida${detail}.`, 'warning', 5000);

        if (!state.localStream || typeof state.localStream.getAudioTracks !== 'function') {
            return;
        }

        const deadAudioTracks = state.localStream.getAudioTracks().filter((track) => {
            const trackMeta = /** @type {MediaStreamTrack & { _isDesktopWasapiTrack?: boolean }} */ (track);
            return Boolean(trackMeta && trackMeta._isDesktopWasapiTrack);
        });
        if (deadAudioTracks.length === 0) {
            return;
        }

        const deadTrackSet = new Set(deadAudioTracks);
        deadAudioTracks.forEach((track) => {
            try { track.stop(); } catch (_) {}
            try {
                if (typeof state.localStream.removeTrack === 'function') {
                    state.localStream.removeTrack(track);
                }
            } catch (_) {}
        });

        const peers = getPeers();
        const webrtc = getWebRtc();
        if (!peers || typeof peers.entries !== 'function') {
            return;
        }

        const renegotiationPromises = [];
        for (const [peerId, peerObj] of peers.entries()) {
            const pc = peerObj && peerObj.pc;
            if (!pc || pc.connectionState === 'closed' || pc.signalingState === 'closed') continue;

            const transceivers = typeof pc.getTransceivers === 'function' ? pc.getTransceivers() : null;
            if (transceivers) {
                transceivers.forEach((t) => {
                    if (t && t.sender && t.sender.track && deadTrackSet.has(t.sender.track)) {
                        t.sender._kind = t.sender.track.kind;
                        if (t.direction === 'sendrecv') t.direction = 'recvonly';
                        else if (t.direction === 'sendonly') t.direction = 'inactive';
                    }
                });
            }

            const replacePromises = [];
            const senders = typeof pc.getSenders === 'function' ? pc.getSenders() : [];
            senders.forEach((sender) => {
                if (sender && sender.track && deadTrackSet.has(sender.track)) {
                    try {
                        if (!sender._kind) {
                            sender._kind = sender.track.kind;
                        }
                        replacePromises.push(Promise.resolve(sender.replaceTrack(null)).catch(() => {}));
                    } catch (_) {}
                }
            });

            if (replacePromises.length > 0 && webrtc && typeof webrtc.sendOffer === 'function') {
                renegotiationPromises.push(
                    Promise.allSettled(replacePromises).then(() => {
                        const current = peers.get(peerId);
                        if (!current || current.pc !== pc) return;
                        if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return;
                        return webrtc.sendOffer(peerId);
                    })
                );
            }
        }

        await Promise.allSettled(renegotiationPromises);
    }

    function handleDesktopCaptureRebound(payload) {
        const message = payload && payload.reason
            ? payload.reason
            : 'Alvo de exclusão de áudio atualizado; mantendo captura do sistema.';
        showToast(message, 'info', 4500);
    }

    function invalidateGeneration() {
        shareMeta._generation = (shareMeta._generation || 0) + 1;
    }

    function bindEvents() {
        if (dom.btnStopShare) {
            dom.btnStopShare.addEventListener('click', stopScreenShare);
        }
    }

    return {
        startScreenShare,
        stopScreenShare,
        handleDesktopCaptureStopped,
        handleDesktopCaptureRebound,
        invalidateGeneration,
        bindEvents
    };
}

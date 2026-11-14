import { getVideoConstraints } from './qos.js';

export function createScreenShareController({
    state,
    dom = {},
    getSocket = () => null,
    getPeers = () => new Map(),
    getWebRtc = () => null,
    getGrid = () => null,
    getQosMonitor = () => null,
    startExcludeDiscordCapture = async () => null,
    startAppAudioCapture = async () => null,
    stopAppAudioCapture = () => {},
    showToast = () => {},
    documentObj = (typeof document !== 'undefined' ? document : null),
    navigatorObj = (typeof navigator !== 'undefined' ? navigator : null),
    MediaStreamCtor = (typeof MediaStream !== 'undefined' ? MediaStream : null)
} = {}) {
    async function stopScreenShare(options = {}) {
        const silent = Boolean(options && options.silent === true);
        startScreenShare._generation = (startScreenShare._generation || 0) + 1;

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

    async function startScreenShare(
        audioMode = 'exclude_discord',
        targetPid = null,
        resolution = state.selectedVideoResolution,
        fps = state.selectedVideoFps
    ) {
        if (startScreenShare._isStarting) return;
        startScreenShare._isStarting = true;
        const attemptToken = (startScreenShare._attemptToken || 0) + 1;
        startScreenShare._attemptToken = attemptToken;

        let screenStream = null;
        let audioTrack = null;
        let cableStream = null;
        let captureSucceeded = false;
        let startedDesktopAudioThisAttempt = false;
        let shareGen = null;

        try {
            const preStopGen = startScreenShare._generation || 0;
            const hadLocalStream = Boolean(state.localStream);
            if (hadLocalStream) {
                await stopScreenShare();
                if ((startScreenShare._generation || 0) > preStopGen + 1) {
                    return;
                }
            } else if ((startScreenShare._generation || 0) !== preStopGen) {
                return;
            }

            shareGen = (startScreenShare._generation || 0) + 1;
            startScreenShare._generation = shareGen;
            const isShareCancelled = () => (startScreenShare._generation || 0) !== shareGen;

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

            if (audioMode === 'exclude_discord') {
                try {
                    screenStream = await navigatorObj.mediaDevices.getDisplayMedia({
                        video: videoConstraints,
                        audio: false
                    });
                } catch (err) {
                    if (err.name === 'NotAllowedError') return;
                    throw err;
                }
                if (isShareCancelled()) return;

                try {
                    startedDesktopAudioThisAttempt = true;
                    audioTrack = await startExcludeDiscordCapture();
                    console.log('[Audio] ✅ Capturando áudio de todo o sistema excluindo o Discord (WASAPI Exclusion Loopback)');
                } catch (appErr) {
                    console.warn('[Audio] Falha ao capturar no modo excluir Discord:', appErr.message);
                    showToast('Aviso de Áudio: ' + appErr.message + ' — alternando para áudio completo do sistema.', 'warning');
                    startedDesktopAudioThisAttempt = false;
                    try {
                        await stopAppAudioCapture();
                    } catch (_) {}
                    try {
                        const fallbackStream = await navigatorObj.mediaDevices.getDisplayMedia({
                            video: videoConstraints,
                            audio: {
                                echoCancellation: false,
                                noiseSuppression: false,
                                autoGainControl: false
                            }
                        });
                        if (isShareCancelled()) {
                            fallbackStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                            return;
                        }
                        if (fallbackStream && fallbackStream.getVideoTracks().length > 0) {
                            if (screenStream) {
                                screenStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                            }
                            screenStream = fallbackStream;
                            audioTrack = fallbackStream.getAudioTracks()[0] || null;
                        } else if (fallbackStream) {
                            fallbackStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                        }
                    } catch (_) {
                        // Fallback recusado ou indisponível: segue apenas com vídeo já capturado
                    }
                }
                if (isShareCancelled()) return;
            } else if (audioMode === 'app' && targetPid) {
                try {
                    screenStream = await navigatorObj.mediaDevices.getDisplayMedia({
                        video: videoConstraints,
                        audio: false
                    });
                } catch (err) {
                    if (err.name === 'NotAllowedError') return;
                    throw err;
                }
                if (isShareCancelled()) return;

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
                let cableOutputId = null;
                try {
                    let devices = await navigatorObj.mediaDevices.enumerateDevices();
                    if (isShareCancelled()) return;
                    const hasEmptyLabels = devices.some((d) => d.deviceId && d.label === '');
                    if (hasEmptyLabels) {
                        let canProbeMicLabels = false;
                        if (navigatorObj.permissions && typeof navigatorObj.permissions.query === 'function') {
                            try {
                                const micPerm = await navigatorObj.permissions.query({ name: 'microphone' });
                                canProbeMicLabels = Boolean(micPerm && micPerm.state === 'granted');
                            } catch (_) {}
                            if (isShareCancelled()) return;
                        }
                        if (canProbeMicLabels) {
                            try {
                                const tempStream = await navigatorObj.mediaDevices.getUserMedia({ audio: true });
                                tempStream.getTracks().forEach((t) => t.stop());
                                devices = await navigatorObj.mediaDevices.enumerateDevices();
                            } catch (_) {}
                            if (isShareCancelled()) return;
                        }
                    }

                    const cableOutput = devices.find((d) => {
                        if (d.kind !== 'audioinput') return false;
                        const label = d.label.toLowerCase();
                        return label.includes('cable output') ||
                            (label.includes('vb-audio') && label.includes('cable')) ||
                            (label.includes('virtual cable') && !label.includes('16ch'));
                    });

                    if (cableOutput) {
                        cableOutputId = cableOutput.deviceId;
                    }
                } catch (_) {}

                if (cableOutputId) {
                    try {
                        screenStream = await navigatorObj.mediaDevices.getDisplayMedia({
                            video: videoConstraints,
                            audio: false
                        });
                    } catch (err) {
                        if (err.name === 'NotAllowedError') return;
                        throw err;
                    }
                    if (isShareCancelled()) return;

                    try {
                        cableStream = await navigatorObj.mediaDevices.getUserMedia({
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
                        cableStream.getTracks().forEach((t) => {
                            if (t !== audioTrack) {
                                try { t.stop(); } catch (_) {}
                            }
                        });
                        console.log('[Audio] ✅ Capturing isolated audio from VB-Cable');
                    } catch (audioErr) {
                        if (cableStream) {
                            cableStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                            cableStream = null;
                        }
                        console.warn('[Audio] VB-Cable capture failed:', audioErr.message);
                        showToast('Aviso de Áudio: Falha ao capturar pelo VB-Cable (transmitindo apenas vídeo).', 'warning', 5000);
                    }
                    if (isShareCancelled()) return;
                } else {
                    try {
                        screenStream = await navigatorObj.mediaDevices.getDisplayMedia({
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
                    if (isShareCancelled()) return;

                    if (screenStream.getAudioTracks().length > 0) {
                        audioTrack = screenStream.getAudioTracks()[0];
                        console.log('[Audio] ✅ System audio captured directly via getDisplayMedia');
                    }
                }
            } else if (audioMode === 'app') {
                showToast('Nenhum aplicativo selecionado para áudio isolado. Continuando apenas com vídeo.', 'warning');
                try {
                    screenStream = await navigatorObj.mediaDevices.getDisplayMedia({
                        video: videoConstraints,
                        audio: false
                    });
                } catch (err) {
                    if (err.name === 'NotAllowedError') return;
                    throw err;
                }
                if (isShareCancelled()) return;
            } else {
                try {
                    screenStream = await navigatorObj.mediaDevices.getDisplayMedia({
                        video: videoConstraints,
                        audio: false
                    });
                } catch (err) {
                    if (err.name === 'NotAllowedError') return;
                    throw err;
                }
                if (isShareCancelled()) return;
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
                        Promise.resolve(webrtc.addLocalTracksToPC(peerObj.pc)).then(() => {
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
                if (state.localStream && (shareGen === null || (startScreenShare._generation || 0) === shareGen)) {
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
                if (cableStream) {
                    try {
                        cableStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                    } catch (_) {}
                }
                if (audioTrack) {
                    try { audioTrack.stop(); } catch (_) {}
                }
                if ((audioMode === 'exclude_discord' || audioMode === 'app') &&
                    startedDesktopAudioThisAttempt &&
                    startScreenShare._attemptToken === attemptToken) {
                    try { stopAppAudioCapture(); } catch (_) {}
                }
            }
            startScreenShare._isStarting = false;
        }
    }

    async function handleDesktopCaptureStopped(payload) {
        const detail = payload && payload.reason ? ` (${payload.reason})` : '';
        showToast(`Captura de áudio do aplicativo interrompida${detail}.`, 'warning', 5000);

        if (!state.localStream || typeof state.localStream.getAudioTracks !== 'function') {
            return;
        }

        const deadAudioTracks = state.localStream.getAudioTracks().filter((track) => track && track._isDesktopWasapiTrack);
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

    function invalidateGeneration() {
        startScreenShare._generation = (startScreenShare._generation || 0) + 1;
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
        invalidateGeneration,
        bindEvents
    };
}

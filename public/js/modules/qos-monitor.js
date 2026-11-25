import {
    collectPeerTelemetry,
    getViewerOptimizationModeMeta,
    normalizeStreamMaxQuality,
    resolveEffectiveEncodingProfile
} from './qos.js';

const MIN_VIDEO_BITRATE = 350000;

/**
 * Clamp a bitrate between the minimum floor and the absolute peerCap ceiling.
 * peerCap always wins when peerCap < minBitrate (e.g., many peers at 720p30).
 */
export function clampBitrate(value, peerCap, minBitrate = MIN_VIDEO_BITRATE) {
    return Math.min(peerCap, Math.max(minBitrate, value));
}

/**
 * @param {{
 *   state?: import('./types.js').AppState,
 *   dom?: import('./types.js').DomRefs,
 *   getPeers?: () => Map<string, any>,
 *   storage?: Storage | null
 * }} [options]
 */
export function createQosMonitor({
    state = /** @type {import('./types.js').AppState} */ ({}),
    getPeers = () => new Map()
} = {}) {
    let qualityMonitorInterval = null;
    let isQualityMonitorRunning = false;

    function getBroadcasterMaxQuality() {
        return normalizeStreamMaxQuality(
            state.activeStreamMaxQuality,
            state.selectedVideoResolution || '1080p',
            state.selectedVideoFps || 60
        );
    }

    function resolveSenderVideoTrack(baseVideoTrack, peerObj = null) {
        if (!baseVideoTrack) return null;
        const viewerMode = peerObj && peerObj.viewerOptimizationMode ? peerObj.viewerOptimizationMode : 'balanced';
        const modeMeta = getViewerOptimizationModeMeta(viewerMode);
        if (!modeMeta.contentHint) {
            if ('contentHint' in baseVideoTrack && baseVideoTrack.contentHint !== '') {
                try { baseVideoTrack.contentHint = ''; } catch (_) {}
            }
            return baseVideoTrack;
        }
        const trackAny = /** @type {any} */ (baseVideoTrack);
        if (typeof trackAny.clone === 'function') {
            if (!(trackAny._modeClones instanceof Map)) {
                trackAny._modeClones = new Map();
            }
            const existing = trackAny._modeClones.get(modeMeta.id);
            if (existing && existing.readyState !== 'ended') {
                return existing;
            }
            const cloned = trackAny.clone();
            if (cloned && 'contentHint' in cloned) {
                try { cloned.contentHint = modeMeta.contentHint; } catch (_) {}
            }
            trackAny._modeClones.set(modeMeta.id, cloned);
            return cloned;
        }
        const peers = getPeers();
        if ((!peers || peers.size <= 1) && 'contentHint' in baseVideoTrack) {
            try { baseVideoTrack.contentHint = modeMeta.contentHint; } catch (_) {}
        }
        return baseVideoTrack;
    }

    function disposeVideoTrackClones(stream = state.localStream) {
        if (!stream || typeof stream.getVideoTracks !== 'function') return;
        stream.getVideoTracks().forEach((track) => {
            const trackAny = /** @type {any} */ (track);
            if (trackAny && trackAny._modeClones instanceof Map) {
                for (const cloned of trackAny._modeClones.values()) {
                    try {
                        if (cloned && typeof cloned.stop === 'function') cloned.stop();
                    } catch (_) {}
                }
                trackAny._modeClones.clear();
            }
        });
    }

    function configureSenderParams(sender, kind, peerObj = null) {
        if (!sender || typeof sender.getParameters !== 'function') return;
        const peers = getPeers();
        if (kind === 'video') {
            try {
                const params = sender.getParameters();
                const peerCount = peers && peers.size > 0 ? peers.size : 1;
                const viewerPreset = peerObj && peerObj.viewerQualityPreset ? peerObj.viewerQualityPreset : 'auto';
                const viewerMode = peerObj && peerObj.viewerOptimizationMode ? peerObj.viewerOptimizationMode : 'balanced';
                const profile = resolveEffectiveEncodingProfile(
                    getBroadcasterMaxQuality(),
                    viewerPreset,
                    peerCount,
                    viewerMode
                );
                params.degradationPreference = profile.degradationPreference;
                if (params.encodings && params.encodings[0]) {
                    params.encodings[0].maxBitrate = profile.maxBitrate;
                    params.encodings[0].maxFramerate = profile.maxFramerate;
                    params.encodings[0].scaleResolutionDownBy = profile.scaleResolutionDownBy;
                }
                sender.setParameters(params).catch(() => {});
            } catch (_) {}
        } else if (kind === 'audio') {
            try {
                const params = sender.getParameters();
                if (params.encodings && params.encodings[0]) {
                    params.encodings[0].maxBitrate = 128000;
                }
                sender.setParameters(params).catch(() => {});
            } catch (_) {}
        }
    }

    function applyPeerViewerQuality(peerId, peerObj = null) {
        if (!state.localStream) return false;
        const peers = getPeers();
        const targetPeer = peerObj || (peers && typeof peers.get === 'function' ? peers.get(peerId) : null);
        if (!targetPeer || !targetPeer.pc) return false;
        const sender = targetPeer.pc.getSenders().find((s) => (s.track && s.track.kind === 'video') || s._kind === 'video');
        if (!sender) return false;
        if (typeof state.localStream.getVideoTracks === 'function') {
            const baseVideoTrack = state.localStream.getVideoTracks()[0] || null;
            if (baseVideoTrack) {
                const desiredTrack = resolveSenderVideoTrack(baseVideoTrack, targetPeer);
                if (desiredTrack && sender.track !== desiredTrack && typeof sender.replaceTrack === 'function') {
                    try {
                        Promise.resolve(sender.replaceTrack(desiredTrack)).catch(() => {});
                    } catch (_) {}
                }
            }
        }
        configureSenderParams(sender, 'video', targetPeer);
        return true;
    }

    function updateSendersForActivePeers() {
        if (!state.localStream) return;
        const peers = getPeers();
        for (const [, peerObj] of peers.entries()) {
            if (peerObj && peerObj.pc) {
                const sender = peerObj.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
                if (sender) {
                    configureSenderParams(sender, 'video', peerObj);
                }
            }
        }
    }

    async function evaluatePeerQoS(peerId, peerObj) {
        if (!peerObj || !peerObj.pc || peerObj.pc.connectionState === 'closed') return;
        let stats;
        try {
            stats = await peerObj.pc.getStats();
        } catch (_) {
            return;
        }

        const telemetry = collectPeerTelemetry(stats, peerObj._qosTelemetryState);
        peerObj._qosTelemetryState = telemetry.nextState;

        const rtt = telemetry.currentRoundTripTime || 0;
        const availableBitrate = telemetry.availableOutgoingBitrate;
        const outboundFps = telemetry.outbound ? telemetry.outbound.fps : 0;
        const qualityLimitation = telemetry.outbound ? telemetry.outbound.qualityLimitationReason : 'none';
        const inboundFps = telemetry.inbound ? telemetry.inbound.fps : 0;
        const inboundPacketsLost = telemetry.inbound ? telemetry.inbound.packetsLost : 0;
        const inboundPacketsReceived = telemetry.inbound ? telemetry.inbound.packetsReceived : 0;
        const peers = getPeers();

        if (state.localStream && availableBitrate !== null) {
            const videoSender = peerObj.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (videoSender) {
                const params = videoSender.getParameters();
                if (params.encodings && params.encodings[0]) {
                    const peerCount = peers && peers.size > 0 ? peers.size : 1;
                    const viewerPreset = peerObj.viewerQualityPreset || 'auto';
                    const viewerMode = peerObj.viewerOptimizationMode || 'balanced';
                    const profile = resolveEffectiveEncodingProfile(
                        getBroadcasterMaxQuality(),
                        viewerPreset,
                        peerCount,
                        viewerMode
                    );
                    const peerCap = profile.maxBitrate;
                    const targetFps = profile.maxFramerate;
                    const current = params.encodings[0].maxBitrate || peerCap;
                    let targetBitrate;

                    if (availableBitrate < 600000) {
                        targetBitrate = 350000;
                    } else if (availableBitrate < 1200000) {
                        targetBitrate = Math.max(350000, Math.floor(availableBitrate * 0.70));
                    } else if (availableBitrate < 2500000) {
                        targetBitrate = Math.floor(availableBitrate * 0.75);
                    } else if (availableBitrate < 5000000) {
                        targetBitrate = Math.min(peerCap, Math.floor(availableBitrate * 0.80));
                    } else {
                        targetBitrate = peerCap;
                    }

                    let fpsChanged = false;
                    const recoverThreshold = Math.min(2200000, Math.round(peerCap * 0.75));
                    if (availableBitrate < 1000000 || qualityLimitation === 'cpu') {
                        const throttledFps = Math.min(30, targetFps);
                        if (params.encodings[0].maxFramerate !== throttledFps) {
                            params.encodings[0].maxFramerate = throttledFps;
                            fpsChanged = true;
                            console.log(`[QoS] ${peerId.slice(0, 6)}: Throttled to ${throttledFps} FPS due to ${qualityLimitation === 'cpu' ? 'CPU' : 'network'}`);
                        }
                    } else if (availableBitrate >= recoverThreshold || (params.encodings[0].maxFramerate && params.encodings[0].maxFramerate > targetFps)) {
                        if (params.encodings[0].maxFramerate !== targetFps) {
                            params.encodings[0].maxFramerate = targetFps;
                            fpsChanged = true;
                        }
                    }

                    let scaleChanged = false;
                    if (
                        params.encodings[0].scaleResolutionDownBy !== undefined &&
                        params.encodings[0].scaleResolutionDownBy !== profile.scaleResolutionDownBy
                    ) {
                        params.encodings[0].scaleResolutionDownBy = profile.scaleResolutionDownBy;
                        scaleChanged = true;
                    } else if (params.encodings[0].scaleResolutionDownBy === undefined && profile.scaleResolutionDownBy > 1) {
                        params.encodings[0].scaleResolutionDownBy = profile.scaleResolutionDownBy;
                        scaleChanged = true;
                    }

                    let degChanged = false;
                    if (params.degradationPreference && params.degradationPreference !== profile.degradationPreference) {
                        params.degradationPreference = profile.degradationPreference;
                        degChanged = true;
                    }

                    const boundedTarget = clampBitrate(targetBitrate, peerCap);
                    let nextBitrate = current;
                    if (Math.abs(boundedTarget - current) <= 100000) {
                        nextBitrate = boundedTarget;
                    } else {
                        const smoothed = Math.floor(current + (boundedTarget - current) * 0.3);
                        const clamped = clampBitrate(smoothed, peerCap);
                        if (Math.abs(clamped - current) >= 25000) {
                            nextBitrate = clamped;
                        }
                    }
                    const bitrateChanged = nextBitrate !== current;

                    if (bitrateChanged || fpsChanged || scaleChanged || degChanged) {
                        if (bitrateChanged) {
                            params.encodings[0].maxBitrate = nextBitrate;
                        }
                        videoSender.setParameters(params).catch(() => {});
                        console.log(
                            `[QoS] Outbound ${peerId.slice(0, 6)}: ` +
                            `bitrate ${(current / 1e6).toFixed(1)}→${(params.encodings[0].maxBitrate / 1e6).toFixed(1)} Mbps | ` +
                            `maxFps: ${params.encodings[0].maxFramerate} | scale: ${profile.scaleResolutionDownBy}x | fps: ${outboundFps} | limit: ${qualityLimitation} | rtt: ${(rtt * 1000).toFixed(0)}ms`
                        );
                    }
                }
            }
        }

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
                let qosClass;
                let qosText;

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
            const peers = getPeers();
            if (!state.localStream && peers.size === 0) {
                stopQualityMonitor();
                return;
            }

            isQualityMonitorRunning = true;
            try {
                for (const [peerId, peerObj] of peers.entries()) {
                    try {
                        await evaluatePeerQoS(peerId, peerObj);
                    } catch (_) {}
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

    function bindEvents() {}

    return {
        resolveSenderVideoTrack,
        disposeVideoTrackClones,
        configureSenderParams,
        applyPeerViewerQuality,
        updateSendersForActivePeers,
        evaluatePeerQoS,
        startQualityMonitor,
        stopQualityMonitor,
        bindEvents
    };
}

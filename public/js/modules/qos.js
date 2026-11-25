export const VIEWER_OPTIMIZATION_MODES = [
    {
        id: 'balanced',
        label: 'Equilibrado',
        shortLabel: 'Equilibrado',
        degradationPreference: 'balanced',
        contentHint: ''
    },
    {
        id: 'motion',
        label: 'Fluido',
        shortLabel: 'Fluido',
        degradationPreference: 'maintain-framerate',
        contentHint: 'motion'
    },
    {
        id: 'detail',
        label: 'Nítido',
        shortLabel: 'Nítido',
        degradationPreference: 'maintain-resolution',
        contentHint: 'detail'
    }
];

const MODE_MAP = new Map(VIEWER_OPTIMIZATION_MODES.map((m) => [m.id, m]));

export function isValidViewerOptimizationMode(mode) {
    return typeof mode === 'string' && MODE_MAP.has(mode);
}

export function getViewerOptimizationModeMeta(mode) {
    return (typeof mode === 'string' && MODE_MAP.get(mode)) || MODE_MAP.get('balanced');
}

export const VIEWER_QUALITY_PRESETS = [
    { id: 'auto', label: 'Automático', shortLabel: 'Auto', resolution: null, height: null, fps: null },
    { id: '1080p60', label: '1080p 60 FPS', shortLabel: '1080p60', resolution: '1080p', height: 1080, fps: 60 },
    { id: '1080p30', label: '1080p 30 FPS', shortLabel: '1080p30', resolution: '1080p', height: 1080, fps: 30 },
    { id: '720p60', label: '720p 60 FPS', shortLabel: '720p60', resolution: '720p', height: 720, fps: 60 },
    { id: '720p30', label: '720p 30 FPS', shortLabel: '720p30', resolution: '720p', height: 720, fps: 30 },
    { id: '480p30', label: '480p 30 FPS', shortLabel: '480p30', resolution: '480p', height: 480, fps: 30 }
];

const PRESET_MAP = new Map(VIEWER_QUALITY_PRESETS.map((p) => [p.id, p]));

export function isValidViewerQualityPreset(preset) {
    return typeof preset === 'string' && PRESET_MAP.has(preset);
}

export function getViewerPresetMeta(preset) {
    return (typeof preset === 'string' && PRESET_MAP.get(preset)) || PRESET_MAP.get('auto');
}

export function normalizeStreamMaxQuality(raw, fallbackResolution = '1080p', fallbackFps = 60) {
    const fbRes = fallbackResolution === '720p' ? '720p' : '1080p';
    const fbFps = Number(fallbackFps) === 30 ? 30 : 60;
    if (!raw || typeof raw !== 'object') {
        return {
            resolution: fbRes,
            height: fbRes === '720p' ? 720 : 1080,
            fps: fbFps
        };
    }
    const resolution = raw.resolution === '720p'
        ? '720p'
        : (raw.resolution === '1080p' ? '1080p' : fbRes);
    const numFps = Number(raw.fps);
    const fps = numFps === 30 ? 30 : (numFps === 60 ? 60 : fbFps);
    return {
        resolution,
        height: resolution === '720p' ? 720 : 1080,
        fps
    };
}

export function isPresetWithinMaxQuality(presetId, maxQuality) {
    if (!presetId || presetId === 'auto') return true;
    const preset = PRESET_MAP.get(presetId);
    if (!preset) return false;
    const max = normalizeStreamMaxQuality(maxQuality);
    return preset.height <= max.height && preset.fps <= max.fps;
}

export function getAvailableViewerPresets(maxQuality) {
    const max = normalizeStreamMaxQuality(maxQuality);
    return VIEWER_QUALITY_PRESETS.filter((preset) => (
        preset.id === 'auto' || (preset.height <= max.height && preset.fps <= max.fps)
    ));
}

export function getVideoConstraints(resolution = '1080p', fps = 60) {
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

export function getMaxBitrateForPeerCount(count = 1, resolution = '1080p', fps = 60) {
    const is480p = resolution === '480p';
    const is720p = resolution === '720p';
    const is30fps = Number(fps) === 30;

    let baseBitrate;
    if (is480p) {
        baseBitrate = is30fps ? 900000 : 1300000;
    } else if (is720p) {
        baseBitrate = is30fps ? 1800000 : 2800000;
    } else {
        baseBitrate = is30fps ? 4000000 : 6000000;
    }

    const peerCount = typeof count === 'number' ? count : 1;
    if (peerCount <= 1) return baseBitrate;
    if (peerCount === 2) return Math.min(2500000, Math.round(baseBitrate * 0.45));
    if (peerCount === 3) return Math.min(1800000, Math.round(baseBitrate * 0.30));
    return Math.min(1200000, Math.round(baseBitrate / peerCount));
}

export function resolveEffectiveEncodingProfile(
    maxQuality,
    viewerPreset = 'auto',
    peerCount = 1,
    viewerMode = 'balanced'
) {
    const max = normalizeStreamMaxQuality(maxQuality);
    const preset = isValidViewerQualityPreset(viewerPreset) ? PRESET_MAP.get(viewerPreset) : PRESET_MAP.get('auto');
    const modeMeta = getViewerOptimizationModeMeta(viewerMode);

    let targetHeight = max.height;
    let targetFps = max.fps;

    if (preset && preset.id !== 'auto') {
        targetHeight = Math.min(max.height, preset.height);
        targetFps = Math.min(max.fps, preset.fps);
    } else if (modeMeta.id === 'detail') {
        targetFps = Math.min(30, max.fps);
    }

    const targetResolution = targetHeight <= 480 ? '480p' : (targetHeight <= 720 ? '720p' : '1080p');
    const scaleResolutionDownBy = Math.max(1, Number((max.height / targetHeight).toFixed(4)));
    const maxBitrate = getMaxBitrateForPeerCount(peerCount, targetResolution, targetFps);

    return {
        preset: preset ? preset.id : 'auto',
        mode: modeMeta.id,
        degradationPreference: modeMeta.degradationPreference,
        contentHint: modeMeta.contentHint,
        resolution: targetResolution,
        height: targetHeight,
        maxFramerate: targetFps,
        scaleResolutionDownBy,
        maxBitrate
    };
}

export function collectPeerTelemetry(stats, prevState) {
    const reportsById = new Map();
    let nominatedPair = null;
    let fallbackPair = null;
    let outboundVideo = null;
    let inboundVideo = null;

    if (stats && typeof stats.forEach === 'function') {
        stats.forEach(report => {
            if (!report) return;
            if (report.id) reportsById.set(report.id, report);

            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                if (report.nominated) {
                    nominatedPair = report;
                } else if (!fallbackPair) {
                    fallbackPair = report;
                }
            } else if (report.type === 'outbound-rtp' && report.kind === 'video') {
                if (!outboundVideo || (report.bytesSent || 0) > (outboundVideo.bytesSent || 0)) {
                    outboundVideo = report;
                }
            } else if (report.type === 'inbound-rtp' && report.kind === 'video') {
                if (!inboundVideo || (report.bytesReceived || 0) > (inboundVideo.bytesReceived || 0)) {
                    inboundVideo = report;
                }
            }
        });
    }

    const activePair = nominatedPair || fallbackPair;
    const availableOutgoingBitrate = activePair && activePair.availableOutgoingBitrate != null
        ? activePair.availableOutgoingBitrate
        : null;
    const currentRoundTripTime = activePair && activePair.currentRoundTripTime != null
        ? activePair.currentRoundTripTime
        : null;

    let iceRoute = null;
    if (activePair) {
        const localCand = activePair.localCandidateId ? reportsById.get(activePair.localCandidateId) : null;
        const remoteCand = activePair.remoteCandidateId ? reportsById.get(activePair.remoteCandidateId) : null;
        const localType = localCand && localCand.candidateType ? localCand.candidateType : 'desconhecido';
        const remoteType = remoteCand && remoteCand.candidateType ? remoteCand.candidateType : 'desconhecido';
        iceRoute = `${localType} → ${remoteType}`;
    }

    const nowTs = (outboundVideo && outboundVideo.timestamp)
        || (inboundVideo && inboundVideo.timestamp)
        || Date.now();
    const dtSec = prevState && prevState.timestamp && nowTs > prevState.timestamp
        ? (nowTs - prevState.timestamp) / 1000
        : 0;

    let outboundKbps = null;
    if (outboundVideo && prevState && typeof prevState.outboundBytes === 'number' && dtSec > 0.1 && (outboundVideo.bytesSent || 0) >= prevState.outboundBytes) {
        outboundKbps = Math.round(((outboundVideo.bytesSent - prevState.outboundBytes) * 8) / dtSec / 1000);
    }

    let inboundKbps = null;
    if (inboundVideo && prevState && typeof prevState.inboundBytes === 'number' && dtSec > 0.1 && (inboundVideo.bytesReceived || 0) >= prevState.inboundBytes) {
        inboundKbps = Math.round(((inboundVideo.bytesReceived - prevState.inboundBytes) * 8) / dtSec / 1000);
    }

    const resolveCodec = (rtpReport) => {
        if (!rtpReport || !rtpReport.codecId) return null;
        const codec = reportsById.get(rtpReport.codecId);
        if (!codec || !codec.mimeType) return null;
        return codec.mimeType.replace(/^video\//i, '').toUpperCase();
    };

    const nextState = {
        timestamp: nowTs,
        outboundBytes: outboundVideo && outboundVideo.bytesSent != null ? outboundVideo.bytesSent : null,
        inboundBytes: inboundVideo && inboundVideo.bytesReceived != null ? inboundVideo.bytesReceived : null
    };

    return {
        availableOutgoingBitrate,
        currentRoundTripTime,
        iceRoute,
        outbound: outboundVideo ? {
            fps: Math.round(outboundVideo.framesPerSecond || 0),
            width: outboundVideo.frameWidth || 0,
            height: outboundVideo.frameHeight || 0,
            kbps: outboundKbps,
            qualityLimitationReason: outboundVideo.qualityLimitationReason || 'none',
            encoder: outboundVideo.encoderImplementation || null,
            codec: resolveCodec(outboundVideo)
        } : null,
        inbound: inboundVideo ? {
            fps: Math.round(inboundVideo.framesPerSecond || 0),
            width: inboundVideo.frameWidth || 0,
            height: inboundVideo.frameHeight || 0,
            kbps: inboundKbps,
            packetsLost: inboundVideo.packetsLost || 0,
            packetsReceived: inboundVideo.packetsReceived || 0,
            decoder: inboundVideo.decoderImplementation || null,
            codec: resolveCodec(inboundVideo)
        } : null,
        nextState
    };
}

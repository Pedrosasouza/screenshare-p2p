export function createDefaultRtcConfig() {
    const fallbackServers = [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
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
    ];
    return {
        iceServers: fallbackServers,
        iceCandidatePoolSize: 4
    };
}

let activeIceProvider = 'fallback';
let iceServersExpiresAt = 0;
let iceServersFetchPromise = null;
let iceRefreshTimerId = null;
let iceRefreshTimerGeneration = 0;
let consecutiveIceRefreshFailures = 0;
export const rtcConfig = createDefaultRtcConfig();

export function stopIceRefreshTimer() {
    iceRefreshTimerGeneration += 1;
    if (iceRefreshTimerId !== null) {
        clearTimeout(iceRefreshTimerId);
        iceRefreshTimerId = null;
    }
}

export function scheduleIceRefreshTimer(serverUrl = '', options = {}) {
    stopIceRefreshTimer();
    const timerGen = iceRefreshTimerGeneration;
    const now = Date.now();
    let delayMs;
    if (iceServersExpiresAt > now) {
        delayMs = Math.max(15000, iceServersExpiresAt - now);
    } else if (consecutiveIceRefreshFailures > 0) {
        delayMs = Math.min(240000, 15000 * (2 ** Math.min(consecutiveIceRefreshFailures - 1, 4)));
    } else {
        delayMs = 240000;
    }
    iceRefreshTimerId = setTimeout(async () => {
        iceRefreshTimerId = null;
        if (timerGen !== iceRefreshTimerGeneration) return;
        await refreshIceServers(serverUrl, { ...options, force: true });
        if (timerGen !== iceRefreshTimerGeneration) return;
        scheduleIceRefreshTimer(serverUrl, options);
    }, delayMs);
    if (iceRefreshTimerId && typeof iceRefreshTimerId.unref === 'function') {
        iceRefreshTimerId.unref();
    }
}

export function getActiveIceProvider() {
    return activeIceProvider;
}

export function getIceProviderDisplayLabel(provider) {
    if (provider === 'cloudflare') return 'Cloudflare TURN';
    if (provider === 'coturn') return 'TURN Próprio (HMAC)';
    return 'Fallback (STUN/OpenRelay)';
}

export async function refreshIceServers(serverUrl = '', options = {}) {
    const force = Boolean(options && options.force);
    const now = Date.now();
    if (!force && iceServersExpiresAt > now && Array.isArray(rtcConfig.iceServers) && rtcConfig.iceServers.length > 0) {
        return { provider: activeIceProvider, iceServers: rtcConfig.iceServers, cached: true };
    }
    if (!force && iceServersFetchPromise) {
        return iceServersFetchPromise;
    }

    const run = (async () => {
        if (typeof fetch !== 'function') {
            return { provider: activeIceProvider, iceServers: rtcConfig.iceServers };
        }
        const base = typeof serverUrl === 'string' ? serverUrl.trim().replace(/\/+$/, '') : '';
        const endpoint = base ? `${base}/ice-servers` : '/ice-servers';
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), 3500) : null;
        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                cache: 'no-store',
                signal: controller ? controller.signal : undefined
            });
            if (!response || !response.ok) {
                throw new Error(`HTTP ${response ? response.status : 'unknown'}`);
            }
            const data = await response.json();
            if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
                rtcConfig.iceServers = data.iceServers;
                activeIceProvider = typeof data.provider === 'string' ? data.provider : 'fallback';
                if (typeof consecutiveIceRefreshFailures !== 'undefined') {
                    consecutiveIceRefreshFailures = 0;
                }
                const ttlSec = Number(data.ttlSeconds) > 0 ? Number(data.ttlSeconds) : 300;
                const refreshMarginSec = Math.min(300, Math.max(30, Math.floor(ttlSec * 0.15)));
                iceServersExpiresAt = Date.now() + Math.max(15, ttlSec - refreshMarginSec) * 1000;

                const peerMap = (options && options.peers) || (typeof peers !== 'undefined' ? peers : null);
                if (peerMap && typeof peerMap.values === 'function') {
                    for (const peerObj of peerMap.values()) {
                        const pc = peerObj && peerObj.pc;
                        if (pc && pc.connectionState !== 'closed' && typeof pc.setConfiguration === 'function') {
                            try {
                                pc.setConfiguration(rtcConfig);
                            } catch (_) {}
                        }
                    }
                }
            } else if (typeof consecutiveIceRefreshFailures !== 'undefined') {
                consecutiveIceRefreshFailures += 1;
            }
            return { provider: activeIceProvider, iceServers: rtcConfig.iceServers };
        } catch (err) {
            if (typeof consecutiveIceRefreshFailures !== 'undefined') {
                consecutiveIceRefreshFailures += 1;
            }
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[ICE] Falha ao obter /ice-servers; mantendo configuração atual:', err.message || err);
            }
            return { provider: activeIceProvider, iceServers: rtcConfig.iceServers, error: err };
        } finally {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
        }
    })();

    if (!force) {
        iceServersFetchPromise = run;
    }
    try {
        return await run;
    } finally {
        if (iceServersFetchPromise === run) {
            iceServersFetchPromise = null;
        }
    }
}

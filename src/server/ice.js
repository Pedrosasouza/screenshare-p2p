const { createHmac } = require('crypto');

const FALLBACK_ICE_SERVERS = [
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

function cloneFallbackIceServers() {
    return FALLBACK_ICE_SERVERS.map((entry) => ({ ...entry }));
}

function parseTurnUrls(rawUrls) {
    if (typeof rawUrls !== 'string') return [];
    return rawUrls
        .split(',')
        .map((u) => u.trim())
        .filter((u) => /^(?:turns?|stuns?):[^\s]+$/i.test(u));
}

function createIceServersResolver({ env = process.env, fetchImpl = global.fetch, nowFn = Date.now } = {}) {
    let cachedPayload = null;
    let cacheExpiresAt = 0;
    let hardExpiresAt = 0;
    let inFlightPromise = null;

    return async function resolveIceServers() {
        const cfTokenId = typeof env.CF_TURN_TOKEN_ID === 'string' ? env.CF_TURN_TOKEN_ID.trim() : '';
        const cfApiToken = typeof env.CF_TURN_API_TOKEN === 'string' ? env.CF_TURN_API_TOKEN.trim() : '';

        if (cfTokenId && cfApiToken) {
            const now = nowFn();
            if (cachedPayload && now < cacheExpiresAt) {
                const remainingTtl = Math.max(1, Math.floor((hardExpiresAt - now) / 1000));
                return { ...cachedPayload, ttlSeconds: remainingTtl };
            }
            if (inFlightPromise) {
                return inFlightPromise;
            }

            const rawTtl = Number(env.CF_TURN_TTL_SECONDS);
            const ttlSeconds = Number.isFinite(rawTtl) && rawTtl >= 60 ? Math.min(86400, Math.floor(rawTtl)) : 14400;

            inFlightPromise = (async () => {
                try {
                    if (typeof fetchImpl !== 'function') {
                        throw new Error('fetch indisponível');
                    }
                    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfTokenId)}/credentials/generate-ice-servers`;
                    const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
                        ? AbortSignal.timeout(4000)
                        : undefined;
                    const response = await fetchImpl(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${cfApiToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ ttl: ttlSeconds }),
                        signal
                    });
                    if (!response || !response.ok) {
                        throw new Error(`Cloudflare TURN HTTP ${response ? response.status : 'unknown'}`);
                    }
                    const json = await response.json();
                    const iceServers = Array.isArray(json && json.iceServers)
                        ? json.iceServers
                        : (json && json.result && Array.isArray(json.result.iceServers) ? json.result.iceServers : null);
                    if (!iceServers || iceServers.length === 0) {
                        throw new Error('Resposta Cloudflare TURN sem iceServers válidos');
                    }

                    const payload = {
                        provider: 'cloudflare',
                        ttlSeconds,
                        iceServers
                    };
                    const refreshMarginSec = Math.min(300, Math.max(60, Math.floor(ttlSeconds * 0.15)));
                    const fetchedNow = nowFn();
                    cachedPayload = payload;
                    hardExpiresAt = fetchedNow + ttlSeconds * 1000;
                    cacheExpiresAt = fetchedNow + Math.max(30, ttlSeconds - refreshMarginSec) * 1000;
                    return payload;
                } catch (err) {
                    const failNow = nowFn();
                    if (cachedPayload && failNow < hardExpiresAt) {
                        cacheExpiresAt = Math.min(hardExpiresAt, failNow + 30000);
                        const remainingTtl = Math.max(1, Math.floor((hardExpiresAt - failNow) / 1000));
                        console.warn('[ICE] Refresh Cloudflare falhou; mantendo cache ainda válido:', err && err.message ? err.message : err);
                        return { ...cachedPayload, ttlSeconds: remainingTtl };
                    }
                    cachedPayload = null;
                    cacheExpiresAt = 0;
                    hardExpiresAt = 0;
                    console.warn('[ICE] Falha ao consultar Cloudflare TURN, usando fallback:', err && err.message ? err.message : err);
                    return {
                        provider: 'fallback',
                        ttlSeconds: 60,
                        degraded: true,
                        iceServers: cloneFallbackIceServers()
                    };
                } finally {
                    inFlightPromise = null;
                }
            })();

            return inFlightPromise;
        }

        const turnUrls = parseTurnUrls(env.TURN_URLS);
        const turnSecret = typeof env.TURN_SECRET === 'string' ? env.TURN_SECRET.trim() : '';
        if (turnUrls.length > 0 && turnSecret) {
            const rawTtl = Number(env.TURN_TTL_SECONDS);
            const ttlSeconds = Number.isFinite(rawTtl) && rawTtl >= 60 ? Math.min(86400, Math.floor(rawTtl)) : 14400;
            const expiryEpoch = Math.floor(nowFn() / 1000) + ttlSeconds;
            const username = `${expiryEpoch}:streamgrid`;
            const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
            return {
                provider: 'coturn',
                ttlSeconds,
                iceServers: [
                    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
                    { urls: turnUrls, username, credential }
                ]
            };
        }

        return {
            provider: 'fallback',
            ttlSeconds: 300,
            iceServers: cloneFallbackIceServers()
        };
    };
}

module.exports = {
    FALLBACK_ICE_SERVERS,
    cloneFallbackIceServers,
    parseTurnUrls,
    createIceServersResolver
};

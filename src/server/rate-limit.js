const ICE_RATE_LIMIT_WINDOW_MS = 600000;
const ICE_RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_ICE_RATE_ENTRIES = 10000;
const MAX_LOGIN_ATTEMPTS_ENTRIES = 10000;
const LOGIN_ATTEMPT_TTL_MS = 600000;

function getHttpClientIp(req, env = process.env) {
    const trustProxy = env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1';
    if (trustProxy && req && req.headers) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim()) {
            const parts = forwarded.split(',');
            const safeIp = parts[parts.length - 1].trim().replace(/^::ffff:/, '');
            if (safeIp) return safeIp;
        }
    }
    const rawAddress = (req && req.socket && req.socket.remoteAddress) || (req && req.ip) || 'unknown';
    return String(rawAddress).trim().replace(/^::ffff:/, '') || 'unknown';
}

function getClientIdentifier(socket, env = process.env) {
    const trustProxy = env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1';

    if (trustProxy) {
        const forwarded = socket.handshake.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim()) {
            const parts = forwarded.split(',');
            const safeIp = parts[parts.length - 1].trim().replace(/^::ffff:/, '');
            if (safeIp) return safeIp;
        }
    }

    const rawAddress = socket.handshake.address;
    if (typeof rawAddress === 'string' && rawAddress.trim()) {
        return rawAddress.trim().replace(/^::ffff:/, '');
    }

    return socket.id;
}

function createHttpIceRateLimiter() {
    const iceRateLimitMap = new Map();

    function checkHttpIceRateLimit(clientIp, now = Date.now()) {
        const existing = iceRateLimitMap.get(clientIp);
        if (!existing || now - existing.windowStart >= ICE_RATE_LIMIT_WINDOW_MS) {
            if (!existing && iceRateLimitMap.size >= MAX_ICE_RATE_ENTRIES) {
                for (const [k, v] of iceRateLimitMap.entries()) {
                    if (now - v.windowStart >= ICE_RATE_LIMIT_WINDOW_MS) {
                        iceRateLimitMap.delete(k);
                    }
                }
                while (iceRateLimitMap.size >= MAX_ICE_RATE_ENTRIES) {
                    const oldest = iceRateLimitMap.keys().next().value;
                    if (oldest === undefined) break;
                    iceRateLimitMap.delete(oldest);
                }
            }
            iceRateLimitMap.set(clientIp, { count: 1, windowStart: now });
            return true;
        }
        if (existing.count >= ICE_RATE_LIMIT_MAX_REQUESTS) {
            return false;
        }
        existing.count += 1;
        return true;
    }

    function purgeExpired(now = Date.now()) {
        for (const [ip, tracker] of iceRateLimitMap.entries()) {
            if (!tracker || now - tracker.windowStart >= ICE_RATE_LIMIT_WINDOW_MS) {
                iceRateLimitMap.delete(ip);
            }
        }
    }

    return {
        iceRateLimitMap,
        checkHttpIceRateLimit,
        purgeExpired
    };
}

function createAttemptTracker() {
    const loginAttempts = new Map();
    const pendingAttemptLocks = new Map();

    function withAttemptLock(key, fn) {
        const prev = pendingAttemptLocks.get(key) || Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        const tail = run.finally(() => {
            if (pendingAttemptLocks.get(key) === tail) {
                pendingAttemptLocks.delete(key);
            }
        });
        pendingAttemptLocks.set(key, tail);
        return run;
    }

    function getAttemptKey(clientKey, roomId) {
        return `${clientKey}:${roomId}`;
    }

    function isAttemptExpired(data, now = Date.now()) {
        if (!data) return true;
        const lockExpiry = typeof data.lockedUntil === 'number' ? data.lockedUntil : 0;
        const lastAttempt = typeof data.lastAttempt === 'number' ? data.lastAttempt : 0;
        return now >= lockExpiry && (now - lastAttempt > LOGIN_ATTEMPT_TTL_MS);
    }

    function setLoginAttempt(key, data, now = Date.now(), maxEntries = MAX_LOGIN_ATTEMPTS_ENTRIES) {
        if (!loginAttempts.has(key) && loginAttempts.size >= maxEntries) {
            for (const [existingKey, existingData] of loginAttempts.entries()) {
                if (isAttemptExpired(existingData, now)) {
                    loginAttempts.delete(existingKey);
                }
            }
            if (loginAttempts.size >= maxEntries) {
                for (const [existingKey, existingData] of loginAttempts.entries()) {
                    if (!existingData || typeof existingData.lockedUntil !== 'number' || existingData.lockedUntil <= now) {
                        loginAttempts.delete(existingKey);
                        if (loginAttempts.size < maxEntries) break;
                    }
                }
            }
            while (loginAttempts.size >= maxEntries) {
                const oldestKey = loginAttempts.keys().next().value;
                if (oldestKey === undefined) break;
                loginAttempts.delete(oldestKey);
            }
        }
        loginAttempts.set(key, data);
    }

    function purgeExpired(now = Date.now()) {
        for (const [key, data] of loginAttempts.entries()) {
            if (isAttemptExpired(data, now)) {
                loginAttempts.delete(key);
            }
        }
    }

    return {
        loginAttempts,
        withAttemptLock,
        getAttemptKey,
        isAttemptExpired,
        setLoginAttempt,
        purgeExpired
    };
}

function checkRateLimit(socket, eventName, windowMs = 1000) {
    const now = Date.now();
    if (!socket._rateLimit) {
        socket._rateLimit = new Map();
    }
    let tracker = socket._rateLimit.get(eventName);
    if (!tracker || now > tracker.resetAt) {
        tracker = { count: 0, resetAt: now + windowMs };
        socket._rateLimit.set(eventName, tracker);
    }
    tracker.count += 1;
    const maxEvents = eventName === 'signal'
        ? 250
        : (eventName === 'join-room' || eventName === 'check-room' ? 10 : 50);
    return tracker.count <= maxEvents;
}

function safeHandler(socket, eventName, handler) {
    return async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        const payload = args[0];

        if (!checkRateLimit(socket, eventName)) {
            if (eventName === 'join-room') {
                socket.emit('join-error', {
                    error: 'rate_limited',
                    message: 'Muitas solicitações de entrada em sequência. Aguarde um momento.'
                });
            }
            if (typeof ack === 'function') {
                try { ack({ error: 'rate_limited' }); } catch (_) {}
            }
            return;
        }

        try {
            await Promise.resolve(handler(payload, ack));
        } catch (err) {
            if (!socket._errorLogCount) socket._errorLogCount = 0;
            if (socket._errorLogCount < 5) {
                console.warn(`[Security/Error] Exception in "${eventName}" from ${socket.id}:`, err.message);
                socket._errorLogCount++;
            }
            if (typeof ack === 'function') {
                try { ack({ error: 'server_error' }); } catch (_) {}
            }
            socket.emit('server-error', {
                event: eventName,
                message: 'Invalid payload or server error.'
            });
        }
    };
}

module.exports = {
    ICE_RATE_LIMIT_WINDOW_MS,
    ICE_RATE_LIMIT_MAX_REQUESTS,
    MAX_ICE_RATE_ENTRIES,
    MAX_LOGIN_ATTEMPTS_ENTRIES,
    LOGIN_ATTEMPT_TTL_MS,
    getHttpClientIp,
    getClientIdentifier,
    createHttpIceRateLimiter,
    createAttemptTracker,
    checkRateLimit,
    safeHandler
};

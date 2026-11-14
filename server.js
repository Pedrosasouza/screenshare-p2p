const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const { scrypt, randomBytes, timingSafeEqual, createHmac } = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(scrypt);

// Cryptographic Password Hashing & Safe Verification (scrypt + random 16-byte salt)
async function hashPassword(password) {
    if (typeof password !== 'string' || !password) {
        return { hash: null, salt: null };
    }
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 32);
    return { hash, salt };
}

async function verifyPassword(password, storedHash, storedSalt) {
    if (typeof password !== 'string' || !password || !Buffer.isBuffer(storedHash) || !Buffer.isBuffer(storedSalt)) {
        return false;
    }
    try {
        const derivedKey = await scryptAsync(password, storedSalt, storedHash.length);
        return timingSafeEqual(derivedKey, storedHash);
    } catch (_) {
        return false;
    }
}

function getCorsOrigin() {
    const raw = process.env.ALLOWED_ORIGINS;
    if (typeof raw !== 'string' || !raw.trim()) {
        return '*';
    }
    const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length === 0) return '*';
    return (origin, callback) => {
        if (!origin || allowed.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin not allowed by CORS'));
    };
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    next();
});
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: getCorsOrigin(),
        methods: ["GET", "POST"]
    },
    pingInterval: 5000,
    pingTimeout: 7000,
    maxHttpBufferSize: 1e5 // 100 KB max payload size
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Dynamic ICE / TURN Credential Resolver (Cloudflare Realtime TURN -> Coturn HMAC -> Fallback)
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

const defaultIceServersResolver = createIceServersResolver();
const iceRateLimitMap = new Map();
const ICE_RATE_LIMIT_WINDOW_MS = 600000;
const ICE_RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_ICE_RATE_ENTRIES = 10000;

function getHttpClientIp(req) {
    const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
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

function setIceEndpointCorsHeaders(req, res) {
    const rawAllowed = process.env.ALLOWED_ORIGINS;
    const reqOrigin = req && req.headers ? req.headers.origin : '';
    if (typeof rawAllowed !== 'string' || !rawAllowed.trim()) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return true;
    }
    const allowed = rawAllowed.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return true;
    }
    if (!reqOrigin || allowed.includes(reqOrigin)) {
        if (reqOrigin) {
            res.setHeader('Access-Control-Allow-Origin', reqOrigin);
            res.setHeader('Vary', 'Origin');
        }
        return true;
    }
    return false;
}

// Healthcheck endpoint for hosting platforms (e.g. Render)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        rooms: rooms.size,
        uptime: Math.floor(process.uptime())
    });
});

// Dynamic ICE / TURN endpoint (returns ephemeral credentials without exposing backend secrets)
app.options('/ice-servers', (req, res) => {
    if (!setIceEndpointCorsHeaders(req, res)) {
        return res.status(403).end();
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
});

app.get('/ice-servers', async (req, res, next) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        if (!setIceEndpointCorsHeaders(req, res)) {
            return res.status(403).json({ error: 'origin_not_allowed' });
        }
        const clientIp = getHttpClientIp(req);
        if (!checkHttpIceRateLimit(clientIp)) {
            return res.status(429).json({
                error: 'rate_limited',
                message: 'Muitas solicitações de servidores ICE. Tente novamente em alguns minutos.'
            });
        }
        const payload = await defaultIceServersResolver();
        return res.json(payload);
    } catch (err) {
        return next(err);
    }
});

// Silence automatic browser /favicon.ico requests when no .ico file is present
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Return explicit 404 for missing static assets instead of serving index.html
app.use((req, res, next) => {
    if (/\.[a-z0-9]{1,8}$/i.test(req.path)) {
        return res.status(404).end();
    }
    return next();
});

// Fallback route to ensure index.html is always served
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
    console.error('[HTTP Error]', err && err.message ? err.message : err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// Store active rooms and members
const rooms = new Map();
const MAX_ROOMS = 2000;
const MAX_MEMBERS_PER_ROOM = 32;

// Anti-Brute Force Protection for Password-Protected Rooms
// Key: `${clientKey}:${roomId}` -> { count: number, lockedUntil: number, lastAttempt: number }
const loginAttempts = new Map();
const pendingAttemptLocks = new Map();
const MAX_LOGIN_ATTEMPTS_ENTRIES = 10000;
const LOGIN_ATTEMPT_TTL_MS = 600000;

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
        // 1. Purge expired entries first
        for (const [existingKey, existingData] of loginAttempts.entries()) {
            if (isAttemptExpired(existingData, now)) {
                loginAttempts.delete(existingKey);
            }
        }
        // 2. Purge unlocked entries next so active brute-force locks are never displaced by unlocked floods
        if (loginAttempts.size >= maxEntries) {
            for (const [existingKey, existingData] of loginAttempts.entries()) {
                if (!existingData || typeof existingData.lockedUntil !== 'number' || existingData.lockedUntil <= now) {
                    loginAttempts.delete(existingKey);
                    if (loginAttempts.size < maxEntries) break;
                }
            }
        }
        // 3. Fallback FIFO eviction only if every remaining entry is actively locked
        while (loginAttempts.size >= maxEntries) {
            const oldestKey = loginAttempts.keys().next().value;
            if (oldestKey === undefined) break;
            loginAttempts.delete(oldestKey);
        }
    }
    loginAttempts.set(key, data);
}

// Validation and sanitization helpers
const ROOM_ID_REGEX = /^[a-z0-9_-]{3,64}$/;

function isPlainObject(obj) {
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

function sanitizeControlChars(str) {
    return String(str).replace(/[\x00-\x1f\x7f]/g, '');
}

function isValidSignal(signal) {
    if (!isPlainObject(signal)) return false;
    const isSdp = typeof signal.type === 'string' &&
        (signal.type === 'offer' || signal.type === 'answer') &&
        typeof signal.sdp === 'string' &&
        signal.sdp.length > 0 &&
        signal.sdp.length <= 65536;
    const icePayload = isPlainObject(signal.candidate) ? signal.candidate : signal;
    const hasIceField = icePayload.candidate !== undefined || icePayload.sdpMid !== undefined || icePayload.sdpMLineIndex !== undefined;
    const candidateOk = icePayload.candidate === undefined || (typeof icePayload.candidate === 'string' && icePayload.candidate.length <= 8192);
    const sdpMidOk = icePayload.sdpMid === undefined || icePayload.sdpMid === null || (typeof icePayload.sdpMid === 'string' && icePayload.sdpMid.length <= 64);
    const sdpMLineOk = icePayload.sdpMLineIndex === undefined || icePayload.sdpMLineIndex === null || (Number.isInteger(icePayload.sdpMLineIndex) && icePayload.sdpMLineIndex >= 0);
    const isIce = hasIceField && candidateOk && sdpMidOk && sdpMLineOk && Boolean(icePayload.candidate || icePayload.sdpMid !== undefined || icePayload.sdpMLineIndex !== undefined);
    const isKeyframeReq = signal.type === 'request-keyframe';
    return isSdp || isIce || isKeyframeReq;
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
    // Permite maior vazão para rajadas de candidatos ICE no WebRTC Mesh (até 250/s)
    // e restringe eventos custosos (join-room/check-room) contra flood de scrypt.
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

function getClientIdentifier(socket) {
    const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';

    if (trustProxy) {
        const forwarded = socket.handshake.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim()) {
            const parts = forwarded.split(',');
            // Extrai o IP anexado pelo proxy confiável de borda (mais à direita)
            const safeIp = parts[parts.length - 1].trim().replace(/^::ffff:/, '');
            if (safeIp) return safeIp;
        }
    }

    // Padrão seguro: utiliza o endereço da conexão física do socket
    const rawAddress = socket.handshake.address;
    if (typeof rawAddress === 'string' && rawAddress.trim()) {
        return rawAddress.trim().replace(/^::ffff:/, '');
    }

    return socket.id;
}

// Limpeza periódica da memória a cada 10 minutos
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of loginAttempts.entries()) {
        if (isAttemptExpired(data, now)) {
            loginAttempts.delete(key);
        }
    }
    for (const [ip, tracker] of iceRateLimitMap.entries()) {
        if (!tracker || now - tracker.windowStart >= ICE_RATE_LIMIT_WINDOW_MS) {
            iceRateLimitMap.delete(ip);
        }
    }
    for (const [roomId, room] of rooms.entries()) {
        if (!room || !room.members || room.members.size === 0) {
            rooms.delete(roomId);
        }
    }
}, 600000).unref();

io.on('connection', (socket) => {
    console.log(`[+] Client connected: ${socket.id}`);

    socket.on('join-room', safeHandler(socket, 'join-room', async (data) => {
        if (!isPlainObject(data)) return;

        const rawRoomId = typeof data.roomId === 'string' ? data.roomId.trim().toLowerCase() : '';
        if (!ROOM_ID_REGEX.test(rawRoomId)) {
            socket.emit('join-error', {
                error: 'invalid_room',
                message: 'Nome de sala inválido. Use de 3 a 64 caracteres alfanuméricos, hífen ou underline.'
            });
            return;
        }
        const cleanRoomId = rawRoomId;

        // Password format validation: reject if provided and not string
        if (data.password !== undefined && data.password !== null && typeof data.password !== 'string') {
            socket.emit('join-error', {
                error: 'invalid_password_format',
                message: 'Formato de senha inválido.'
            });
            return;
        }

        if (typeof data.password === 'string' && (data.password.length > 100 || (data.password.length > 0 && data.password.trim().length === 0))) {
            socket.emit('join-error', {
                error: 'invalid_password_format',
                message: data.password.length > 100
                    ? 'A senha excede o limite de 100 caracteres.'
                    : 'A senha não pode conter apenas espaços.'
            });
            return;
        }

        const cleanPassword = typeof data.password === 'string' ? data.password.trim() : '';
        const rawClientId = typeof data.clientId === 'string' ? sanitizeControlChars(data.clientId).trim().slice(0, 100) : null;
        const cleanUserName = typeof data.userName === 'string' ? sanitizeControlChars(data.userName).trim().slice(0, 32) : '';

        let room = rooms.get(cleanRoomId);
        const clientKey = getClientIdentifier(socket);
        const attemptKey = getAttemptKey(clientKey, cleanRoomId);

        let isNewRoom = false;
        if (!room) {
            if (rooms.size >= MAX_ROOMS) {
                socket.emit('join-error', {
                    error: 'server_busy',
                    message: 'Limite máximo de salas ativas atingido. Tente novamente em instantes.'
                });
                return;
            }
            const { hash, salt } = await hashPassword(cleanPassword);
            if (!socket.connected) {
                return;
            }
            room = rooms.get(cleanRoomId);
            if (!room) {
                if (rooms.size >= MAX_ROOMS) {
                    socket.emit('join-error', {
                        error: 'server_busy',
                        message: 'Limite máximo de salas ativas atingido. Tente novamente em instantes.'
                    });
                    return;
                }
                room = {
                    passwordHash: hash,
                    passwordSalt: salt,
                    members: new Map(), // socketId -> clientId | null
                    userNames: new Map(), // socketId -> userName
                    activeStreams: new Set()
                };
                rooms.set(cleanRoomId, room);
                loginAttempts.delete(attemptKey);
                isNewRoom = true;
            }
        }

        if (!isNewRoom && room.passwordHash) {
            const verified = await withAttemptLock(attemptKey, async () => {
                const now = Date.now();
                const attemptData = loginAttempts.get(attemptKey) || { count: 0, lockedUntil: 0, lastAttempt: now };

                // Verifica se o IP/Cliente está temporariamente bloqueado por força bruta nesta sala
                if (attemptData.lockedUntil > now) {
                    const waitSeconds = Math.ceil((attemptData.lockedUntil - now) / 1000);
                    console.warn(`[Security] Bloqueio anti-força bruta ativo para ${clientKey} na sala "${cleanRoomId}". Restam ${waitSeconds}s.`);
                    if (socket.connected) {
                        socket.emit('join-error', {
                            error: 'rate_limited',
                            message: `Muitas tentativas incorretas. Aguarde ${waitSeconds} segundos antes de tentar novamente.`
                        });
                    }
                    return false;
                }

                const initialRoomRef = room;
                const initialHash = room.passwordHash;
                const initialSalt = room.passwordSalt;
                const isValid = await verifyPassword(cleanPassword, initialHash, initialSalt);

                const checkNow = Date.now();
                const latestRoom = rooms.get(cleanRoomId);
                if (!latestRoom) {
                    if (socket.connected) {
                        socket.emit('join-error', {
                            error: 'room_closed',
                            message: 'A sala foi encerrada durante a autenticação. Tente entrar novamente.'
                        });
                    }
                    return false;
                }

                if (latestRoom !== initialRoomRef) {
                    if (latestRoom.passwordHash !== initialHash || latestRoom.passwordSalt !== initialSalt) {
                        if (socket.connected) {
                            socket.emit('join-error', {
                                error: 'invalid_password',
                                message: 'A sala foi recriada durante a entrada. Tente novamente.'
                            });
                        }
                        return false;
                    }
                    room = latestRoom;
                }

                if (!isValid) {
                    attemptData.count += 1;
                    attemptData.lastAttempt = checkNow;

                    // Penalidade progressiva após 5 tentativas incorretas
                    if (attemptData.count >= 5) {
                        const penaltySeconds = attemptData.count >= 10 ? 120 : (attemptData.count >= 7 ? 60 : 30);
                        attemptData.lockedUntil = checkNow + (penaltySeconds * 1000);
                        setLoginAttempt(attemptKey, attemptData, checkNow);

                        if (!socket.connected) return false;
                        console.warn(`[Security] Bloqueando ${clientKey} na sala "${cleanRoomId}" por ${penaltySeconds}s após ${attemptData.count} tentativas falhas.`);
                        socket.emit('join-error', {
                            error: 'rate_limited',
                            message: `Muitas tentativas incorretas. Bloqueado por ${penaltySeconds} segundos.`
                        });
                        return false;
                    }

                    setLoginAttempt(attemptKey, attemptData, checkNow);
                    if (!socket.connected) return false;
                    const remaining = 5 - attemptData.count;
                    console.log(`[Auth] Rejected socket ${socket.id} for room "${cleanRoomId}": Invalid password (${remaining} tentativas restantes)`);
                    socket.emit('join-error', {
                        error: 'invalid_password',
                        message: `Senha incorreta. ${remaining} tentativa(s) restante(s) antes do bloqueio.`
                    });
                    return false;
                }

                // Senha correta: limpa registro de falhas desta sala
                loginAttempts.delete(attemptKey);
                return true;
            });

            if (!verified) {
                return;
            }
        }

        if (!socket.connected) {
            if (isNewRoom && room.members.size === 0) {
                rooms.delete(cleanRoomId);
            }
            return;
        }

        const currentRoom = rooms.get(cleanRoomId);
        if (currentRoom) {
            room = currentRoom;
        }

        // Ignore forged clientId matching an active socket.id on the server
        const clientId = (rawClientId && !io.sockets.sockets.has(rawClientId) && !room.members.has(rawClientId))
            ? rawClientId
            : null;

        // Leave any previous room
        if (socket.roomId && socket.roomId !== cleanRoomId) {
            leaveCurrentRoom(socket);
        }

        // Evict stale/ghost socket if this client refreshed (F5) or reconnected
        if (clientId) {
            for (const [existingSocketId, existingClientId] of room.members.entries()) {
                if (existingClientId && existingClientId === clientId && existingSocketId !== socket.id) {
                    console.log(`[Evict] Replacing stale socket ${existingSocketId} with new socket ${socket.id} for client ${clientId}`);
                    const oldSocket = io.sockets.sockets.get(existingSocketId);
                    if (oldSocket) {
                        leaveCurrentRoom(oldSocket);
                        try { oldSocket.disconnect(true); } catch(e) {}
                    } else {
                        room.members.delete(existingSocketId);
                        if (room.userNames) room.userNames.delete(existingSocketId);
                        room.activeStreams.delete(existingSocketId);
                    }
                }
            }
        }

        // Re-register room in Map if eviction of sole member triggered room deletion
        if (!rooms.has(cleanRoomId)) {
            rooms.set(cleanRoomId, room);
        }

        const alreadyMember = socket.roomId === cleanRoomId && room.members.has(socket.id);
        if (!alreadyMember && room.members.size >= MAX_MEMBERS_PER_ROOM) {
            socket.emit('join-error', {
                error: 'room_full',
                message: 'A sala atingiu o limite máximo de participantes.'
            });
            return;
        }

        socket.join(cleanRoomId);
        socket.roomId = cleanRoomId;
        const displayName = cleanUserName || `Participante ${socket.id.substr(0, 5)}`;
        room.members.set(socket.id, clientId);
        if (!room.userNames) room.userNames = new Map();
        room.userNames.set(socket.id, displayName);

        const otherUsers = Array.from(room.members.keys()).filter(id => id !== socket.id);
        const activeStreams = Array.from(room.activeStreams).filter(id => id !== socket.id);

        console.log(`[->] Socket ${socket.id} joined room "${cleanRoomId}" as "${displayName}" (Members: ${room.members.size})`);

        // Send existing room members and active streamers to new user
        socket.emit('room-users', {
            users: otherUsers,
            userNames: Object.fromEntries(room.userNames),
            activeStreams: activeStreams,
            socketId: socket.id,
            memberCount: room.members.size,
            hasPassword: Boolean(room.passwordHash)
        });

        // Notify existing members about new user (avoid duplicate on same-socket re-join)
        if (!alreadyMember) {
            socket.to(cleanRoomId).emit('user-joined', {
                socketId: socket.id,
                userName: displayName,
                memberCount: room.members.size
            });
        }

        // Broadcast updated room member count to all
        io.to(cleanRoomId).emit('room-status', {
            memberCount: room.members.size
        });
    }));

    // Check room existence, member count & password requirement
    socket.on('check-room', safeHandler(socket, 'check-room', (data, callback) => {
        if (typeof callback !== 'function') return;

        if (!isPlainObject(data) || typeof data.roomId !== 'string' || !ROOM_ID_REGEX.test(data.roomId.trim().toLowerCase())) {
            return callback({
                exists: false,
                memberCount: 0,
                hasPassword: false
            });
        }

        const cleanRoomId = data.roomId.trim().toLowerCase();
        const room = rooms.get(cleanRoomId);
        callback({
            exists: Boolean(room && room.members.size > 0),
            memberCount: room ? room.members.size : 0,
            hasPassword: Boolean(room && room.passwordHash)
        });
    }));

    // Targeted WebRTC Signal Relay (Peer-to-Peer Mesh with Room Isolation)
    socket.on('signal', safeHandler(socket, 'signal', (data) => {
        if (!isPlainObject(data)) return;
        const targetId = typeof data.targetId === 'string' ? data.targetId.trim() : null;
        if (!targetId || targetId === socket.id || !isValidSignal(data.signal)) return;

        const senderRoom = socket.roomId;
        if (!senderRoom) return;

        // Security & Isolation: Verify target socket exists AND is in the EXACT same room
        const targetSocket = io.sockets.sockets.get(targetId);
        if (!targetSocket || targetSocket.roomId !== senderRoom) {
            // Drop signal if sender and target are in different rooms
            return;
        }

        io.to(targetId).emit('signal', {
            senderId: socket.id,
            signal: data.signal
        });
    }));

    // Broadcast stream state changes (strictly isolated to socket's authenticated room)
    socket.on('stream-state', safeHandler(socket, 'stream-state', (data) => {
        if (!isPlainObject(data)) return;
        if (data.state !== 'started' && data.state !== 'stopped') return;

        const senderRoom = socket.roomId;
        if (!senderRoom) return;

        const room = rooms.get(senderRoom);
        if (!room) return;

        if (data.state === 'started') {
            room.activeStreams.add(socket.id);
        } else {
            room.activeStreams.delete(socket.id);
        }

        socket.to(senderRoom).emit('stream-state', {
            senderId: socket.id,
            state: data.state
        });
    }));

    function leaveCurrentRoom(sock) {
        try {
            const rid = sock.roomId;
            if (rid && rooms.has(rid)) {
                const r = rooms.get(rid);
                r.members.delete(sock.id);
                if (r.userNames) r.userNames.delete(sock.id);
                const wasStreaming = r.activeStreams.has(sock.id);
                r.activeStreams.delete(sock.id);

                if (r.members.size === 0) {
                    rooms.delete(rid);
                    console.log(`[x] Room "${rid}" deleted (empty)`);
                } else {
                    if (wasStreaming) {
                        io.to(rid).emit('stream-state', {
                            senderId: sock.id,
                            state: 'stopped'
                        });
                    }
                    io.to(rid).emit('user-left', {
                        socketId: sock.id,
                        memberCount: r.members.size
                    });
                    io.to(rid).emit('room-status', {
                        memberCount: r.members.size
                    });
                }
                sock.leave(rid);
                sock.roomId = null;
            }
        } catch (err) {
            console.error(`[Error] Exception during leaveCurrentRoom for ${sock.id}:`, err.message);
        }
    }

    socket.on('disconnect', safeHandler(socket, 'disconnect', () => {
        console.log(`[-] Client disconnected: ${socket.id}`);
        leaveCurrentRoom(socket);
    }));

});

// Utility to get local network IP
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    server.listen(PORT, () => {
        const localIp = getLocalIp();
        const boundAddress = server.address();
        const actualPort = (boundAddress && typeof boundAddress === 'object') ? boundAddress.port : PORT;
        console.log(`\n==================================================`);
        console.log(`  🖥️ StreamGrid Multi-Screenshare rodando!`);
        console.log(`  Local:   http://localhost:${actualPort}`);
        console.log(`  Rede:    http://${localIp}:${actualPort}`);
        console.log(`==================================================\n`);
    });

    const gracefulShutdown = (signalName) => {
        console.log(`\n[Shutdown] Recebido ${signalName}, encerrando servidor graciosamente...`);
        const forceTimer = setTimeout(() => process.exit(1), 5000);
        if (typeof forceTimer.unref === 'function') forceTimer.unref();
        io.close(() => {
            server.close(() => {
                clearTimeout(forceTimer);
                process.exit(0);
            });
        });
    };
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = {
    app,
    server,
    io,
    rooms,
    loginAttempts,
    MAX_LOGIN_ATTEMPTS_ENTRIES,
    setLoginAttempt,
    hashPassword,
    verifyPassword,
    getCorsOrigin,
    createIceServersResolver,
    iceRateLimitMap
};

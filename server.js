const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const { hashPassword, verifyPassword } = require('./src/server/password');
const {
    getCorsOrigin,
    securityHeadersMiddleware,
    setIceEndpointCorsHeaders
} = require('./src/server/security-headers');
const {
    MAX_LOGIN_ATTEMPTS_ENTRIES,
    getHttpClientIp,
    getClientIdentifier,
    createHttpIceRateLimiter,
    createCheckRoomRateLimiter,
    createRoomCreationRateLimiter,
    resolveMaxSocketsPerIp,
    createIpConnectionTracker,
    createAttemptTracker
} = require('./src/server/rate-limit');
const { createIceServersResolver } = require('./src/server/ice');
const { isValidSignal, registerSignalingHandlers } = require('./src/server/signaling');

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

function createServerApp({ env = process.env, fetchImpl = global.fetch } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeadersMiddleware);

    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: getCorsOrigin(env),
            methods: ['GET', 'POST']
        },
        pingInterval: 5000,
        pingTimeout: 7000,
        maxHttpBufferSize: 1e5 // 100 KB max payload size
    });

    app.use((req, res, next) => {
        let normalizedPath = req.path || '';
        try {
            normalizedPath = decodeURIComponent(normalizedPath);
        } catch (_) {}
        if (/(?:^|\/)package\.json$/i.test(normalizedPath)) {
            return res.status(404).end();
        }
        return next();
    });

    app.use(express.static(path.join(__dirname, 'public')));

    const rooms = new Map();
    const attemptTracker = createAttemptTracker();
    const iceRateLimiter = createHttpIceRateLimiter();
    const checkRoomRateLimiter = createCheckRoomRateLimiter();
    const roomCreationRateLimiter = createRoomCreationRateLimiter();
    const ipConnectionTracker = createIpConnectionTracker({
        maxConnectionsPerIp: resolveMaxSocketsPerIp(env)
    });
    const defaultIceServersResolver = createIceServersResolver({ env, fetchImpl });

    io.use((socket, next) => {
        const clientIp = getClientIdentifier(socket, env);
        if (!ipConnectionTracker.tryAcquire(clientIp)) {
            return next(new Error('too_many_connections'));
        }
        let released = false;
        socket.once('disconnect', () => {
            if (!released) {
                released = true;
                ipConnectionTracker.release(clientIp);
            }
        });
        return next();
    });

    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            rooms: rooms.size,
            uptime: Math.floor(process.uptime())
        });
    });

    app.options('/ice-servers', (req, res) => {
        if (!setIceEndpointCorsHeaders(req, res, env)) {
            return res.status(403).end();
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).end();
    });

    app.get('/ice-servers', async (req, res, next) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            if (!setIceEndpointCorsHeaders(req, res, env)) {
                return res.status(403).json({ error: 'origin_not_allowed' });
            }
            const clientIp = getHttpClientIp(req, env);
            if (!iceRateLimiter.checkHttpIceRateLimit(clientIp)) {
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

    app.get('/favicon.ico', (_req, res) => res.status(204).end());

    app.use((req, res, next) => {
        if (/\.[a-z0-9]{1,8}$/i.test(req.path)) {
            return res.status(404).end();
        }
        return next();
    });

    app.get('*', (req, res) => {
        if (req.path !== '/') {
            const qIdx = req.originalUrl ? req.originalUrl.indexOf('?') : -1;
            const search = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
            return res.redirect(302, `/${search}`);
        }
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.use((err, _req, res, _next) => {
        console.error('[HTTP Error]', err && err.message ? err.message : err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'internal_error' });
        }
    });

    registerSignalingHandlers(io, {
        rooms,
        attemptTracker,
        checkRoomRateLimiter,
        roomCreationRateLimiter,
        env
    });

    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        attemptTracker.purgeExpired(now);
        iceRateLimiter.purgeExpired(now);
        checkRoomRateLimiter.purgeExpired(now);
        roomCreationRateLimiter.purgeExpired(now);
        for (const [roomId, room] of rooms.entries()) {
            if (!room || !room.members || room.members.size === 0) {
                rooms.delete(roomId);
            }
        }
    }, 600000);
    if (typeof cleanupInterval.unref === 'function') {
        cleanupInterval.unref();
    }

    function stopCleanupTimer() {
        clearInterval(cleanupInterval);
    }

    return {
        app,
        server,
        io,
        rooms,
        loginAttempts: attemptTracker.loginAttempts,
        MAX_LOGIN_ATTEMPTS_ENTRIES,
        setLoginAttempt: attemptTracker.setLoginAttempt,
        hashPassword,
        verifyPassword,
        getCorsOrigin,
        createIceServersResolver,
        iceRateLimitMap: iceRateLimiter.iceRateLimitMap,
        checkRoomRateLimiter,
        roomCreationRateLimiter,
        ipConnectionTracker,
        isValidSignal,
        stopCleanupTimer
    };
}

const defaultInstance = createServerApp();

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    const { server, io, stopCleanupTimer } = defaultInstance;
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
        stopCleanupTimer();
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
    createServerApp,
    ...defaultInstance
};

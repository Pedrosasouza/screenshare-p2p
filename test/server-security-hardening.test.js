const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getCorsOrigin } = require('../src/server/security-headers');
const {
    startTestServer,
    httpRequest,
    delay,
    waitForEvent,
    tryJoin,
    checkRoom
} = require('./helpers/test-server');

describe('Hardening HTTP, signal relay & loginAttempts', () => {
    let ts;

    before(async () => {
        ts = await startTestServer();
    });

    after(async () => {
        await ts.close();
    });

    it('T1: GET / e /health retornam headers de segurança sem X-Powered-By e com meta no-referrer', async () => {
        const res = await httpRequest(`${ts.baseUrl}/`);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
        assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(res.headers['x-frame-options'], 'DENY');
        assert.strictEqual(res.headers['x-powered-by'], undefined);
        assert.ok(res.body.includes('<meta name="referrer" content="no-referrer">'));

        const healthRes = await httpRequest(`${ts.baseUrl}/health`);
        assert.strictEqual(healthRes.statusCode, 200);
        assert.strictEqual(healthRes.headers['referrer-policy'], 'no-referrer');
        assert.strictEqual(healthRes.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(healthRes.headers['x-frame-options'], 'DENY');
        assert.strictEqual(healthRes.headers['x-powered-by'], undefined);
        assert.strictEqual(JSON.parse(healthRes.body).status, 'ok');

        for (const route of ['/', '/health', '/ice-servers']) {
            const routeRes = await httpRequest(`${ts.baseUrl}${route}`);
            assert.strictEqual(routeRes.statusCode, 200);
            const csp = routeRes.headers['content-security-policy'] || '';
            assert.ok(csp, `Content-Security-Policy header must exist on ${route}`);
            assert.ok(csp.includes("default-src 'self'"));
            assert.ok(csp.includes("style-src 'self'"));
            assert.strictEqual(csp.includes("'unsafe-inline'"), false);
            assert.ok(csp.includes("object-src 'none'"));
            assert.ok(csp.includes("frame-ancestors 'none'"));
            assert.strictEqual(routeRes.headers['referrer-policy'], 'no-referrer');
            assert.strictEqual(routeRes.headers['x-content-type-options'], 'nosniff');
            assert.strictEqual(routeRes.headers['x-frame-options'], 'DENY');
        }
    });

    it('T2: auto-sinalização é ignorada e relay entre peers legítimos funciona', async () => {
        const peerA = await ts.connectClient();
        const peerB = await ts.connectClient();
        const roomId = 'sala-signal-hardening';

        try {
            assert.strictEqual((await tryJoin(peerA, roomId)).status, 'joined');
            assert.strictEqual((await tryJoin(peerB, roomId)).status, 'joined');

            let selfEchoCount = 0;
            peerA.on('signal', () => {
                selfEchoCount += 1;
            });

            peerA.emit('signal', {
                targetId: peerA.id,
                signal: { type: 'offer', sdp: 'v=0\r\nself-signal' }
            });
            await checkRoom(peerA, roomId);
            assert.strictEqual(selfEchoCount, 0);

            const relayedPromise = waitForEvent(peerB, 'signal', 3000);

            peerA.emit('signal', {
                targetId: peerB.id,
                signal: { type: 'offer', sdp: 'v=0\r\nvalid-offer' }
            });

            const relayed = await relayedPromise;
            assert.strictEqual(relayed.senderId, peerA.id);
            assert.strictEqual(relayed.signal.type, 'offer');
            assert.strictEqual(relayed.signal.sdp, 'v=0\r\nvalid-offer');

            const iceRelayedPromise = waitForEvent(peerB, 'signal', 3000);

            peerA.emit('signal', { targetId: peerB.id, signal: { candidate: 12345 } });
            peerA.emit('signal', {
                targetId: peerB.id,
                signal: {
                    candidate: {
                        candidate: 'candidate:1 1 UDP 2122252543 127.0.0.1 54321 typ host',
                        sdpMid: '0',
                        sdpMLineIndex: 0
                    }
                }
            });
            const iceRelayed = await iceRelayedPromise;
            assert.strictEqual(iceRelayed.signal.candidate.sdpMid, '0');
        } finally {
            peerA.disconnect();
            peerB.disconnect();
        }
    });

    it('T3: loginAttempts respeita MAX_LOGIN_ATTEMPTS_ENTRIES com despejo de expiradas e mais antigas', () => {
        const { loginAttempts, MAX_LOGIN_ATTEMPTS_ENTRIES, setLoginAttempt } = ts;
        loginAttempts.clear();
        try {
            const now = Date.now();
            assert.strictEqual(typeof MAX_LOGIN_ATTEMPTS_ENTRIES, 'number');
            assert.ok(MAX_LOGIN_ATTEMPTS_ENTRIES >= 1000);

            const half = Math.floor(MAX_LOGIN_ATTEMPTS_ENTRIES / 2);
            for (let i = 0; i < half; i++) {
                loginAttempts.set(`expired:${i}`, { count: 1, lockedUntil: 0, lastAttempt: now - 700000 });
            }
            for (let i = 0; i < MAX_LOGIN_ATTEMPTS_ENTRIES - half; i++) {
                loginAttempts.set(`active:${i}`, { count: 5, lockedUntil: now + 30000, lastAttempt: now });
            }
            assert.strictEqual(loginAttempts.size, MAX_LOGIN_ATTEMPTS_ENTRIES);

            setLoginAttempt('new-after-expired', { count: 5, lockedUntil: now + 30000, lastAttempt: now }, now);
            assert.strictEqual(loginAttempts.has('expired:0'), false);
            assert.strictEqual(loginAttempts.has('active:0'), true);
            assert.strictEqual(loginAttempts.has('new-after-expired'), true);
            assert.strictEqual(loginAttempts.size, (MAX_LOGIN_ATTEMPTS_ENTRIES - half) + 1);

            let idx = 0;
            while (loginAttempts.size < MAX_LOGIN_ATTEMPTS_ENTRIES) {
                setLoginAttempt(`fill:${idx}`, { count: 2, lockedUntil: now + 30000, lastAttempt: now }, now);
                idx++;
            }
            assert.strictEqual(loginAttempts.size, MAX_LOGIN_ATTEMPTS_ENTRIES);

            setLoginAttempt('overflow-active', { count: 1, lockedUntil: 0, lastAttempt: now }, now);
            assert.strictEqual(loginAttempts.size, MAX_LOGIN_ATTEMPTS_ENTRIES);
            assert.strictEqual(loginAttempts.has('active:0'), false);
            assert.strictEqual(loginAttempts.has('overflow-active'), true);
        } finally {
            loginAttempts.clear();
        }
    });

    it('T4: senha só com espaços é rejeitada e caracteres de controle em userName são removidos', async () => {
        const wsSocket = await ts.connectClient();
        const peerSocket = await ts.connectClient();

        try {
            const wsRes = await tryJoin(wsSocket, 'sala-espacos', '   ');
            assert.strictEqual(wsRes.status, 'error');
            assert.strictEqual(wsRes.data.error, 'invalid_password_format');

            const validRes = await tryJoin(wsSocket, 'sala-ctrl-chars', '', 'Ali\r\nce\x00\x1b[31m');
            assert.strictEqual(validRes.status, 'joined');

            const peerRes = await tryJoin(peerSocket, 'sala-ctrl-chars', '', 'Bob');
            assert.strictEqual(peerRes.status, 'joined');

            const aliceName = peerRes.data.userNames && peerRes.data.userNames[wsSocket.id];
            assert.ok(typeof aliceName === 'string' && aliceName.length > 0);
            // eslint-disable-next-line no-control-regex
            assert.ok(!/[\x00-\x1f\x7f]/.test(aliceName));
        } finally {
            wsSocket.disconnect();
            peerSocket.disconnect();
        }
    });

    it('T5: entradas ativamente bloqueadas não são despejadas por flood sem bloqueio', () => {
        const { loginAttempts, MAX_LOGIN_ATTEMPTS_ENTRIES, setLoginAttempt } = ts;
        loginAttempts.clear();
        try {
            const now = Date.now();
            const half = Math.floor(MAX_LOGIN_ATTEMPTS_ENTRIES / 2);

            for (let i = 0; i < half; i++) {
                loginAttempts.set(`locked:${i}`, { count: 5, lockedUntil: now + 60000, lastAttempt: now });
            }
            for (let i = 0; i < MAX_LOGIN_ATTEMPTS_ENTRIES - half; i++) {
                loginAttempts.set(`unlocked:${i}`, { count: 1, lockedUntil: 0, lastAttempt: now });
            }

            setLoginAttempt('flood-trigger', { count: 1, lockedUntil: 0, lastAttempt: now }, now);

            assert.strictEqual(loginAttempts.has('locked:0'), true);
            assert.strictEqual(loginAttempts.has('unlocked:0'), false);
        } finally {
            loginAttempts.clear();
        }
    });

    it('T6: asset ausente retorna 404 e join-room aplica rate limit dedicado pré-scrypt', async () => {
        const missingJs = await httpRequest(`${ts.baseUrl}/arquivo-inexistente.js`);
        assert.strictEqual(missingJs.statusCode, 404);

        const floodSocket = await ts.connectClient();
        try {
            const results = await Promise.all(
                Array.from({ length: 15 }, (_, idx) =>
                    tryJoin(floodSocket, `sala-flood-${idx}`, `senha-${idx}`)
                )
            );
            const rateLimitedCount = results.filter(
                (r) => r.status === 'error' && r.data?.error === 'rate_limited'
            ).length;
            assert.ok(rateLimitedCount >= 1, 'Deveria limitar rajada de 15 join-room no mesmo socket');
        } finally {
            floodSocket.disconnect();
        }
    });

    it('T7: rotas aninhadas SPA redirecionam para raiz preservando query e CSP connect-src permanece válida', async () => {
        const res = await httpRequest(`${ts.baseUrl}/sala/demo?room=minha-sala`);
        assert.ok(res.statusCode >= 300 && res.statusCode < 400, `Esperado redirect para raiz, veio ${res.statusCode}`);
        assert.strictEqual(res.headers.location, '/?room=minha-sala');

        const homeRes = await httpRequest(`${ts.baseUrl}/`);
        const csp = homeRes.headers['content-security-policy'] || '';
        assert.ok(csp.includes('http://localhost:*') && csp.includes('http://127.0.0.1:*'));
        assert.strictEqual(csp.includes('[::1]'), false, 'Literais IPv6 com colchetes violam sintaxe CSP host-source em navegadores Chromium');
    });

    it('T8: evicção de socket zumbi ausente de io.sockets.sockets notifica stream-state stopped e user-left', () => {
        const { registerSignalingHandlers } = require('../src/server/signaling');
        const { hashPassword } = require('../src/server/password');
        const { createAttemptTracker } = require('../src/server/rate-limit');
        const rooms = new Map();
        const attemptTracker = createAttemptTracker();

        const roomEmissions = [];
        const listenersBySocket = new Map();
        const fakeIo = {
            sockets: { sockets: new Map() },
            to: (roomId) => ({
                emit: (event, payload) => roomEmissions.push({ roomId, event, payload })
            }),
            on: (ev, cb) => {
                if (ev === 'connection') listenersBySocket.set('__connection', cb);
            }
        };

        registerSignalingHandlers(fakeIo, {
            rooms,
            attemptTracker,
            hashPassword,
            getClientIdentifier: () => '127.0.0.1',
            checkRateLimit: () => true
        });

        // Pre-popula sala com socket zumbi já fora de io.sockets.sockets
        rooms.set('sala-zumbi', {
            passwordHash: null,
            passwordSalt: null,
            members: new Map([
                ['zombie-sock', 'client-reconn'],
                ['peer-stay', 'client-other']
            ]),
            userNames: new Map([
                ['zombie-sock', 'Zumbi'],
                ['peer-stay', 'Outro']
            ]),
            activeStreams: new Set(['zombie-sock'])
        });

        const sockHandlers = {};
        const newSock = {
            id: 'fresh-sock',
            connected: true,
            handshake: { address: '127.0.0.1', headers: {} },
            roomId: null,
            join: () => {},
            leave: () => {},
            emit: () => {},
            to: (roomId) => ({
                emit: (event, payload) => roomEmissions.push({ roomId, event, payload })
            }),
            on: (ev, fn) => { sockHandlers[ev] = fn; }
        };
        fakeIo.sockets.sockets.set('fresh-sock', newSock);
        listenersBySocket.get('__connection')(newSock);

        return sockHandlers['join-room']({ roomId: 'sala-zumbi', clientId: 'client-reconn', password: '', userName: 'Pedro' })
            .then(() => {
                assert.ok(
                    roomEmissions.some((e) => e.event === 'stream-state' && e.payload.senderId === 'zombie-sock' && e.payload.state === 'stopped'),
                    'Evicção de zumbi com stream ativo deve emitir stream-state: stopped'
                );
                assert.ok(
                    roomEmissions.some((e) => e.event === 'user-left' && e.payload.socketId === 'zombie-sock'),
                    'Evicção de zumbi deve emitir user-left aos peers restantes'
                );
            });
    });
});

describe('Hardening CORS produção, rate-limit de check-room, CSP estrita e bloqueio de package.json', () => {
    const { PassThrough } = require('stream');
    const http = require('http');

    function dispatchExpress(app, { method = 'GET', url = '/', headers = {} }) {
        return new Promise((resolve, reject) => {
            const socket = new PassThrough();
            const req = new http.IncomingMessage(socket);
            req.method = method;
            req.url = url;
            req.headers = Object.fromEntries(
                Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
            );
            const res = new http.ServerResponse(req);
            const outSocket = new PassThrough();
            const chunks = [];
            outSocket.on('data', (chunk) => chunks.push(chunk));
            res.assignSocket(outSocket);
            res.on('finish', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const bodyIndex = raw.indexOf('\r\n\r\n');
                resolve({
                    statusCode: res.statusCode,
                    headers: res.getHeaders(),
                    body: bodyIndex >= 0 ? raw.slice(bodyIndex + 4) : raw
                });
            });
            res.on('error', reject);
            app.handle(req, res, reject);
        });
    }

    it('T9: produção sem ALLOWED_ORIGINS não retorna wildcard CORS e /ice-servers bloqueia origem não autorizada com 403', async () => {
        const {
            parseAllowedOrigins,
            getCorsOrigin,
            setIceEndpointCorsHeaders
        } = require('../src/server/security-headers');

        assert.strictEqual(getCorsOrigin({}), '*');
        assert.strictEqual(getCorsOrigin({ NODE_ENV: 'development' }), '*');

        const origWarn = console.warn;
        const warnings = [];
        console.warn = (...args) => warnings.push(args.join(' '));
        let prodCors;
        try {
            const parsed = parseAllowedOrigins({ NODE_ENV: 'production' });
            assert.strictEqual(parsed.isProduction, true);
            assert.strictEqual(parsed.allowWildcard, false);
            assert.deepStrictEqual(parsed.allowed, []);

            prodCors = getCorsOrigin({ NODE_ENV: 'production' });
        } finally {
            console.warn = origWarn;
        }

        assert.notStrictEqual(prodCors, '*');
        assert.strictEqual(typeof prodCors, 'function');
        assert.ok(warnings.some((msg) => msg.includes('ALLOWED_ORIGINS')));

        await new Promise((resolve, reject) => {
            prodCors(undefined, (err, allowed) => {
                if (err) return reject(err);
                assert.strictEqual(allowed, true);
                resolve();
            });
        });

        await new Promise((resolve, reject) => {
            prodCors('https://evil.com', (err, allowed) => {
                try {
                    assert.ok(err instanceof Error);
                    assert.notStrictEqual(allowed, true);
                    resolve();
                } catch (assertionErr) {
                    reject(assertionErr);
                }
            });
        });

        const renderCors = getCorsOrigin({
            NODE_ENV: 'production',
            RENDER_EXTERNAL_URL: 'https://screenshare-demo.onrender.com/some/path'
        });
        assert.strictEqual(typeof renderCors, 'function');
        await new Promise((resolve, reject) => {
            renderCors('https://screenshare-demo.onrender.com', (err, allowed) => {
                if (err) return reject(err);
                assert.strictEqual(allowed, true);
                resolve();
            });
        });

        const capturedHeaders = {};
        const mockRes = {
            setHeader(k, v) { capturedHeaders[k.toLowerCase()] = v; }
        };
        const allowedDirect = setIceEndpointCorsHeaders(
            { headers: { origin: 'https://evil.com' } },
            mockRes,
            { NODE_ENV: 'production' }
        );
        assert.strictEqual(allowedDirect, false);
        assert.strictEqual(capturedHeaders['access-control-allow-origin'], undefined);

        const { createServerApp } = require('../server');

        const prodCtx = createServerApp({ env: { NODE_ENV: 'production' } });
        try {
            const blockedRes = await dispatchExpress(prodCtx.app, {
                url: '/ice-servers',
                headers: { Origin: 'https://evil.com' }
            });
            assert.strictEqual(blockedRes.statusCode, 403);
            assert.strictEqual(blockedRes.headers['access-control-allow-origin'], undefined);

            const sameOriginRes = await dispatchExpress(prodCtx.app, {
                url: '/ice-servers'
            });
            assert.strictEqual(sameOriginRes.statusCode, 200);
            assert.strictEqual(sameOriginRes.headers['access-control-allow-origin'], undefined);
        } finally {
            prodCtx.stopCleanupTimer();
        }
    });

    it('T10: check-room aplica rate-limit por IP entre múltiplos sockets distintos', async () => {
        const { registerSignalingHandlers } = require('../src/server/signaling');
        const {
            createAttemptTracker,
            createCheckRoomRateLimiter,
            CHECK_ROOM_RATE_LIMIT_MAX_REQUESTS
        } = require('../src/server/rate-limit');

        const rooms = new Map([
            ['sala-demo', {
                passwordHash: null,
                passwordSalt: null,
                members: new Map([['host-1', 'client-host']]),
                names: new Map([['host-1', 'Host']]),
                createdAt: Date.now()
            }]
        ]);

        let connectionHandler = null;
        const fakeIo = {
            sockets: { sockets: new Map() },
            to: () => ({ emit: () => {} }),
            on: (ev, cb) => {
                if (ev === 'connection') connectionHandler = cb;
            }
        };

        const checkRoomRateLimiter = createCheckRoomRateLimiter();
        registerSignalingHandlers(fakeIo, {
            rooms,
            attemptTracker: createAttemptTracker(),
            checkRoomRateLimiter,
            env: { TRUST_PROXY: 'false' }
        });

        const invokeCheckRoom = (socketId, ip) => {
            const handlers = {};
            const sock = {
                id: socketId,
                connected: true,
                handshake: { address: ip, headers: {} },
                roomId: null,
                join: () => {},
                leave: () => {},
                emit: () => {},
                to: () => ({ emit: () => {} }),
                on: (ev, fn) => { handlers[ev] = fn; }
            };
            fakeIo.sockets.sockets.set(socketId, sock);
            connectionHandler(sock);
            return new Promise((resolve) => {
                handlers['check-room']({ roomId: 'sala-demo' }, resolve);
            });
        };

        for (let i = 0; i < CHECK_ROOM_RATE_LIMIT_MAX_REQUESTS; i += 1) {
            const res = await invokeCheckRoom(`sock-ip1-${i}`, '203.0.113.99');
            assert.strictEqual(res.exists, true);
            assert.strictEqual(res.error, undefined);
        }

        const limitedRes = await invokeCheckRoom('sock-ip1-over', '203.0.113.99');
        assert.strictEqual(limitedRes.exists, false);
        assert.strictEqual(limitedRes.memberCount, 0);
        assert.strictEqual(limitedRes.hasPassword, false);
        assert.strictEqual(limitedRes.error, 'rate_limited');

        const otherIpRes = await invokeCheckRoom('sock-ip2-0', '198.51.100.42');
        assert.strictEqual(otherIpRes.exists, true);
        assert.strictEqual(otherIpRes.error, undefined);
    });

    it('T11: CSP remove unsafe-inline de style-src no servidor e Tauri e não há estilos inline em HTML/JS', () => {
        const fs = require('fs');
        const path = require('path');
        const { CONTENT_SECURITY_POLICY } = require('../src/server/security-headers');

        assert.ok(CONTENT_SECURITY_POLICY.includes("style-src 'self'"));
        assert.strictEqual(CONTENT_SECURITY_POLICY.includes("'unsafe-inline'"), false);

        const tauriConf = JSON.parse(
            fs.readFileSync(path.join(__dirname, '../src-tauri/tauri.conf.json'), 'utf8')
        );
        const tauriCsp = tauriConf.app && tauriConf.app.security && tauriConf.app.security.csp;
        assert.ok(tauriCsp && tauriCsp.includes("style-src 'self'"));
        assert.strictEqual(tauriCsp.includes("'unsafe-inline'"), false);

        const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
        assert.strictEqual(/\sstyle\s*=/i.test(html), false, 'public/index.html não deve conter atributos style="..."');

        const jsDir = path.join(__dirname, '../public/js');
        const jsFiles = [path.join(__dirname, '../public/app.js')];
        const collectJs = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) collectJs(full);
                else if (entry.name.endsWith('.js')) jsFiles.push(full);
            }
        };
        collectJs(jsDir);

        for (const filePath of jsFiles) {
            const content = fs.readFileSync(filePath, 'utf8');
            assert.strictEqual(
                /cssText|setAttribute\(\s*['"]style['"]/i.test(content),
                false,
                `${path.relative(path.join(__dirname, '..'), filePath)} não deve usar cssText ou setAttribute('style', ...)`
            );
        }
    });

    it('T12: requisições HTTP a qualquer package.json estático retornam 404 antes do express.static', async () => {
        const { createServerApp } = require('../server');
        const ctx = createServerApp({ env: { NODE_ENV: 'development' } });
        try {
            const blockedPaths = [
                '/package.json',
                '/js/package.json',
                '/js/modules/package.json',
                '/js/modules/package.json?v=1'
            ];
            for (const url of blockedPaths) {
                const res = await dispatchExpress(ctx.app, { url });
                assert.strictEqual(res.statusCode, 404, `Esperado 404 para ${url}, recebeu ${res.statusCode}`);
            }
        } finally {
            ctx.stopCleanupTimer();
        }
    });

    it('T13: join-room limita criação excessiva de novas salas por IP sem bloquear entradas em salas existentes', async () => {
        const {
            createAttemptTracker,
            createRoomCreationRateLimiter,
            ROOM_CREATE_RATE_LIMIT_MAX_REQUESTS
        } = require('../src/server/rate-limit');
        const { registerSignalingHandlers } = require('../src/server/signaling');

        const rooms = new Map([
            ['sala-existente', {
                passwordHash: null,
                passwordSalt: null,
                members: new Map([['seed-user', null]]),
                userNames: new Map([['seed-user', 'Host']]),
                activeStreams: new Set()
            }]
        ]);

        let connectionHandler = null;
        const fakeIo = {
            sockets: { sockets: new Map() },
            to: () => ({ emit: () => {} }),
            on: (ev, cb) => {
                if (ev === 'connection') connectionHandler = cb;
            }
        };

        registerSignalingHandlers(fakeIo, {
            rooms,
            attemptTracker: createAttemptTracker(),
            roomCreationRateLimiter: createRoomCreationRateLimiter(),
            env: { TRUST_PROXY: 'false' }
        });

        const invokeJoin = (socketId, ip, roomId) => {
            const handlers = {};
            return new Promise((resolve) => {
                const sock = {
                    id: socketId,
                    connected: true,
                    handshake: { address: ip, headers: {} },
                    roomId: null,
                    join: () => {},
                    leave: () => {},
                    to: () => ({ emit: () => {} }),
                    emit: (ev, payload) => {
                        if (ev === 'room-users' || ev === 'join-error') {
                            resolve({ event: ev, payload });
                        }
                    },
                    on: (ev, fn) => { handlers[ev] = fn; }
                };
                fakeIo.sockets.sockets.set(socketId, sock);
                connectionHandler(sock);
                handlers['join-room']({ roomId, password: 'secret', userName: 'Tester' });
            });
        };

        for (let i = 0; i < ROOM_CREATE_RATE_LIMIT_MAX_REQUESTS; i += 1) {
            const res = await invokeJoin(`sock-c-${i}`, '203.0.113.10', `nova-sala-${i}`);
            assert.strictEqual(res.event, 'room-users');
        }

        const blockedCreate = await invokeJoin('sock-c-over', '203.0.113.10', 'nova-sala-excedente');
        assert.strictEqual(blockedCreate.event, 'join-error');
        assert.strictEqual(blockedCreate.payload.error, 'rate_limited');
        assert.strictEqual(rooms.has('nova-sala-excedente'), false);

        const joinExistingRes = await invokeJoin('sock-existing', '203.0.113.10', 'sala-existente');
        assert.strictEqual(joinExistingRes.event, 'room-users');

        const otherIpRes = await invokeJoin('sock-other-ip', '198.51.100.77', 'sala-outro-ip');
        assert.strictEqual(otherIpRes.event, 'room-users');
    });

    it('T14: limite de conexões Socket.IO simultâneas por IP bloqueia excedente e libera após disconnect', async () => {
        const { io: ioClient } = require('socket.io-client');
        const ts = await startTestServer({
            env: {
                ...process.env,
                NODE_ENV: 'development',
                TRUST_PROXY: 'false',
                MAX_SOCKETS_PER_IP: '2'
            }
        });

        const connectRaw = () => new Promise((resolve, reject) => {
            const client = ioClient(ts.baseUrl, {
                transports: ['websocket'],
                reconnection: false,
                forceNew: true
            });
            const timer = setTimeout(() => {
                client.close();
                reject(new Error('Timeout conectando socket'));
            }, 3000);
            client.once('connect', () => {
                clearTimeout(timer);
                resolve({ ok: true, client });
            });
            client.once('connect_error', (err) => {
                clearTimeout(timer);
                client.close();
                resolve({ ok: false, error: err && err.message ? err.message : String(err) });
            });
        });

        let c1 = null;
        let c2 = null;
        let c4 = null;
        try {
            c1 = await connectRaw();
            c2 = await connectRaw();
            assert.strictEqual(c1.ok, true);
            assert.strictEqual(c2.ok, true);

            const c3 = await connectRaw();
            assert.strictEqual(c3.ok, false);
            assert.strictEqual(c3.error, 'too_many_connections');

            c1.client.disconnect();
            c1 = null;
            await delay(30);

            c4 = await connectRaw();
            if (!c4.ok) {
                await delay(50);
                c4 = await connectRaw();
            }
            assert.strictEqual(c4.ok, true);
        } finally {
            if (c1 && c1.client) c1.client.close();
            if (c2 && c2.client) c2.client.close();
            if (c4 && c4.client) c4.client.close();
            await ts.close();
        }
    });

    it('T15: ALLOWED_ORIGINS restringe CORS via getCorsOrigin e config Tauri desabilita devtools', async () => {
        const openCors = getCorsOrigin({});
        assert.strictEqual(openCors, '*');

        const restrictedCors = getCorsOrigin({ ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com' });
        assert.strictEqual(typeof restrictedCors, 'function');

        await new Promise((resolve, reject) => {
            restrictedCors('https://app.example.com', (err, allowed) => {
                if (err) return reject(err);
                assert.strictEqual(allowed, true);
                restrictedCors('https://evil.example.com', (err2, allowed2) => {
                    assert.ok(err2 instanceof Error);
                    assert.strictEqual(allowed2, undefined);
                    resolve();
                });
            });
        });

        const tauriConf = JSON.parse(fs.readFileSync(path.join(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'));
        assert.strictEqual(tauriConf.app.windows[0].devtools, false, 'Production Tauri config must disable devtools');
    });
});

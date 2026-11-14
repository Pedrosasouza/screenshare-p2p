const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, httpRequest } = require('./helpers/test-server');

function tryJoin(socket, roomId, password = '', userName = null) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout joining room "${roomId}"`));
        }, 4000);

        const onJoinError = (data) => {
            cleanup();
            resolve({ status: 'error', data });
        };
        const onRoomUsers = (data) => {
            cleanup();
            resolve({ status: 'joined', data });
        };

        function cleanup() {
            clearTimeout(timer);
            socket.off('join-error', onJoinError);
            socket.off('room-users', onRoomUsers);
        }

        socket.once('join-error', onJoinError);
        socket.once('room-users', onRoomUsers);
        socket.emit('join-room', { roomId, password, userName });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
            await delay(80);
            assert.strictEqual(selfEchoCount, 0);

            const relayedPromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timeout esperando relay para peerB')), 3000);
                peerB.once('signal', (payload) => {
                    clearTimeout(timer);
                    resolve(payload);
                });
            });

            peerA.emit('signal', {
                targetId: peerB.id,
                signal: { type: 'offer', sdp: 'v=0\r\nvalid-offer' }
            });

            const relayed = await relayedPromise;
            assert.strictEqual(relayed.senderId, peerA.id);
            assert.strictEqual(relayed.signal.type, 'offer');
            assert.strictEqual(relayed.signal.sdp, 'v=0\r\nvalid-offer');

            const iceRelayedPromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timeout esperando relay ICE para peerB')), 3000);
                peerB.once('signal', (payload) => {
                    clearTimeout(timer);
                    resolve(payload);
                });
            });

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

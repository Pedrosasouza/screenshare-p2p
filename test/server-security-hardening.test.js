const http = require('http');
const ioClient = require('socket.io-client');
const assert = require('assert');

let currentPort = 43650;
function getNextPort() {
    currentPort += 1;
    return currentPort;
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
    });
}

function connectSocket(url) {
    return new Promise((resolve, reject) => {
        const socket = ioClient(url, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false
        });

        const timer = setTimeout(() => {
            socket.disconnect();
            reject(new Error('Socket connection timeout'));
        }, 4000);

        socket.on('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });

        socket.on('connect_error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function tryJoin(socket, roomId, password = '') {
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
        socket.emit('join-room', { roomId, password });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: HARDENING HTTP, SIGNAL & LOGIN ATTEMPTS');
    console.log('===============================================================\n');

    let failures = 0;
    const {
        server,
        loginAttempts,
        MAX_LOGIN_ATTEMPTS_ENTRIES,
        setLoginAttempt
    } = require('../server.js');
    const port = getNextPort();
    const url = `http://localhost:${port}`;

    await new Promise((resolve) => server.listen(port, resolve));

    try {
        // T1: Cabeçalhos de segurança HTTP e meta no-referrer em GET /
        process.stdout.write('  [Teste] T1: GET / retorna headers de segurança e meta no-referrer sem X-Powered-By ... ');
        try {
            const res = await httpGet(`${url}/`);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
            assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
            assert.strictEqual(res.headers['x-frame-options'], 'DENY');
            assert.strictEqual(res.headers['x-powered-by'], undefined, 'X-Powered-By deve estar desabilitado');
            assert(
                res.body.includes('<meta name="referrer" content="no-referrer">'),
                'index.html deve incluir <meta name="referrer" content="no-referrer">'
            );

            // Também valida headers no endpoint /health
            const healthRes = await httpGet(`${url}/health`);
            assert.strictEqual(healthRes.statusCode, 200);
            assert.strictEqual(healthRes.headers['referrer-policy'], 'no-referrer');
            assert.strictEqual(healthRes.headers['x-content-type-options'], 'nosniff');
            assert.strictEqual(healthRes.headers['x-frame-options'], 'DENY');
            assert.strictEqual(healthRes.headers['x-powered-by'], undefined);

            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            failures++;
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        }

        // T2: Auto-sinalização bloqueada e relay normal entre peers preservado
        process.stdout.write('  [Teste] T2: Auto-sinalização é ignorada e relay entre peers legítimos funciona ... ');
        try {
            const peerA = await connectSocket(url);
            const peerB = await connectSocket(url);
            const roomId = 'sala-signal-hardening';

            assert.strictEqual((await tryJoin(peerA, roomId)).status, 'joined');
            assert.strictEqual((await tryJoin(peerB, roomId)).status, 'joined');

            let selfEchoCount = 0;
            peerA.on('signal', () => {
                selfEchoCount += 1;
            });

            // Auto-sinalização para si próprio deve ser ignorada
            peerA.emit('signal', {
                targetId: peerA.id,
                signal: { type: 'offer', sdp: 'v=0\r\nself-signal' }
            });
            await delay(80);
            assert.strictEqual(selfEchoCount, 0, 'Servidor não deve retransmitir signal para o próprio remetente');

            // Sinalização legítima para peerB na mesma sala deve ser entregue
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

            peerA.disconnect();
            peerB.disconnect();
            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            failures++;
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        }

        // T3: Limite de capacidade e despejo em loginAttempts
        process.stdout.write('  [Teste] T3: loginAttempts respeita MAX_LOGIN_ATTEMPTS_ENTRIES com despejo de expiradas e mais antigas ... ');
        try {
            loginAttempts.clear();
            const now = Date.now();
            assert.strictEqual(typeof MAX_LOGIN_ATTEMPTS_ENTRIES, 'number');
            assert(MAX_LOGIN_ATTEMPTS_ENTRIES >= 1000, 'Limite deve suportar operação normal');

            const half = Math.floor(MAX_LOGIN_ATTEMPTS_ENTRIES / 2);
            // Preenche metade com entradas expiradas e metade com entradas ativas
            for (let i = 0; i < half; i++) {
                loginAttempts.set(`expired:${i}`, {
                    count: 1,
                    lockedUntil: 0,
                    lastAttempt: now - 700000
                });
            }
            for (let i = 0; i < MAX_LOGIN_ATTEMPTS_ENTRIES - half; i++) {
                loginAttempts.set(`active:${i}`, {
                    count: 5,
                    lockedUntil: now + 30000,
                    lastAttempt: now
                });
            }
            assert.strictEqual(loginAttempts.size, MAX_LOGIN_ATTEMPTS_ENTRIES);

            // Ao inserir nova chave no limite, purga primeiro as expiradas mantendo ativas
            setLoginAttempt('new-after-expired', { count: 1, lockedUntil: 0, lastAttempt: now }, now);
            assert.strictEqual(loginAttempts.has('expired:0'), false, 'Entradas expiradas devem ser purgadas primeiro');
            assert.strictEqual(loginAttempts.has('active:0'), true, 'Entradas ativas devem ser preservadas quando há expiradas');
            assert.strictEqual(loginAttempts.has('new-after-expired'), true);
            assert.strictEqual(loginAttempts.size, (MAX_LOGIN_ATTEMPTS_ENTRIES - half) + 1);

            // Completa capacidade apenas com entradas ativas e insere mais 1 -> despeja a mais antiga (active:0)
            let idx = 0;
            while (loginAttempts.size < MAX_LOGIN_ATTEMPTS_ENTRIES) {
                setLoginAttempt(`fill:${idx}`, { count: 2, lockedUntil: now + 30000, lastAttempt: now }, now);
                idx++;
            }
            assert.strictEqual(loginAttempts.size, MAX_LOGIN_ATTEMPTS_ENTRIES);

            setLoginAttempt('overflow-active', { count: 1, lockedUntil: 0, lastAttempt: now }, now);
            assert.strictEqual(loginAttempts.size, MAX_LOGIN_ATTEMPTS_ENTRIES, 'Tamanho nunca deve exceder MAX_LOGIN_ATTEMPTS_ENTRIES');
            assert.strictEqual(loginAttempts.has('active:0'), false, 'Entrada ativa mais antiga deve ser removida em FIFO quando sem expiradas');
            assert.strictEqual(loginAttempts.has('overflow-active'), true);

            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            failures++;
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        } finally {
            loginAttempts.clear();
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests().catch((err) => {
    console.error('Erro fatal na suíte:', err);
    process.exit(1);
});

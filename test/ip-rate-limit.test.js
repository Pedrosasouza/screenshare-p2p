const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/test-server');

function tryJoin(socket, roomId, password) {
    return new Promise((resolve) => {
        const onJoinError = (data) => {
            cleanup();
            resolve({ status: 'error', data });
        };
        const onRoomUsers = (data) => {
            cleanup();
            resolve({ status: 'joined', data });
        };

        function cleanup() {
            socket.off('join-error', onJoinError);
            socket.off('room-users', onRoomUsers);
        }

        socket.once('join-error', onJoinError);
        socket.once('room-users', onRoomUsers);
        socket.emit('join-room', { roomId, password });
    });
}

describe('Rate limit por IP & cabeçalhos proxy', () => {
    it('T1: sem TRUST_PROXY, ignora X-Forwarded-For forjado e bloqueia na 5ª tentativa', async () => {
        const ts = await startTestServer({ env: { ...process.env, TRUST_PROXY: 'false' } });
        try {
            const ownerSocket = await ts.connectClient({ transports: ['websocket', 'polling'] });
            const createRes = await tryJoin(ownerSocket, 'sala-protegida', 'senha-correta');
            assert.strictEqual(createRes.status, 'joined', 'Criador deveria conseguir criar a sala');

            let lastResult = null;
            for (let i = 1; i <= 5; i++) {
                const forgedIp = `198.51.100.${i}`;
                const attackerSocket = await ts.connectClient({
                    transports: ['websocket', 'polling'],
                    extraHeaders: { 'x-forwarded-for': forgedIp }
                });
                lastResult = await tryJoin(attackerSocket, 'sala-protegida', `senha-errada-${i}`);
                attackerSocket.disconnect();
            }

            ownerSocket.disconnect();

            assert.strictEqual(lastResult.status, 'error', 'Tentativa deveria retornar erro');
            assert.strictEqual(
                lastResult.data.error,
                'rate_limited',
                `Na 5ª tentativa o erro deveria ser "rate_limited", mas foi "${lastResult.data.error}"`
            );
        } finally {
            await ts.close();
        }
    });

    it('T2: com TRUST_PROXY=true, defende contra IP injection usando IP à direita', async () => {
        const ts = await startTestServer({ env: { ...process.env, TRUST_PROXY: 'true' } });
        try {
            const ownerSocket = await ts.connectClient({ transports: ['websocket', 'polling'] });
            await tryJoin(ownerSocket, 'sala-proxy', 'senha-correta');

            let lastResult = null;
            for (let i = 1; i <= 5; i++) {
                const injectedChain = `10.0.0.${i}, 203.0.113.88`;
                const attackerSocket = await ts.connectClient({
                    transports: ['websocket', 'polling'],
                    extraHeaders: { 'x-forwarded-for': injectedChain }
                });
                lastResult = await tryJoin(attackerSocket, 'sala-proxy', `senha-errada-${i}`);
                attackerSocket.disconnect();
            }

            ownerSocket.disconnect();

            assert.strictEqual(lastResult.status, 'error');
            assert.strictEqual(
                lastResult.data.error,
                'rate_limited',
                'Deveria bloquear por rate_limited atribuindo ao IP real anexado pelo proxy à direita'
            );
        } finally {
            await ts.close();
        }
    });

    it('T3: normaliza ::FFFF:, IPv6 /64 e X-Forwarded-For com vírgula final', () => {
        const { getHttpClientIp, getClientIdentifier } = require('../src/server/rate-limit');
        const env = { TRUST_PROXY: 'true' };

        const reqTrailing = {
            headers: { 'x-forwarded-for': '198.51.100.7, ' },
            socket: { remoteAddress: '10.0.0.1' }
        };
        assert.strictEqual(getHttpClientIp(reqTrailing, env), '198.51.100.7');

        const reqUpperMapped = {
            headers: { 'x-forwarded-for': '::FFFF:203.0.113.5' },
            socket: { remoteAddress: '10.0.0.1' }
        };
        assert.strictEqual(getHttpClientIp(reqUpperMapped, env), '203.0.113.5');

        const sockA = {
            id: 's-a',
            handshake: { headers: { 'x-forwarded-for': '2001:0db8:0000:0001:aaaa::1, ' }, address: '10.0.0.1' }
        };
        const sockB = {
            id: 's-b',
            handshake: { headers: { 'x-forwarded-for': '2001:db8:0:1:bbbb::99' }, address: '10.0.0.1' }
        };
        assert.strictEqual(
            getClientIdentifier(sockA, env),
            getClientIdentifier(sockB, env),
            'Endereços IPv6 do mesmo /64 em formas não canônicas devem gerar mesma chave'
        );
    });

    it('T4: erro em withAttemptLock não gera unhandledRejection e permite próximas chamadas', async () => {
        const { createAttemptTracker } = require('../src/server/rate-limit');
        const tracker = createAttemptTracker();
        const unhandled = [];
        const onUnhandled = (reason) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            await assert.rejects(
                () => tracker.withAttemptLock('k1', async () => { throw new Error('scrypt fail'); }),
                /scrypt fail/
            );
            await new Promise((r) => setTimeout(r, 15));
            assert.strictEqual(unhandled.length, 0, 'tail interno de withAttemptLock não pode vazar unhandledRejection');

            const ok = await tracker.withAttemptLock('k1', async () => 'recovered');
            assert.strictEqual(ok, 'recovered');
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});

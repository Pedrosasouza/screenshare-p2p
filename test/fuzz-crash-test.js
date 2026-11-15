const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadClientModules } = require('./helpers/client-env');
const {
    startTestServer,
    httpRequest,
    delay,
    waitForEvent,
    tryJoin,
    checkRoom
} = require('./helpers/test-server');

describe('Reprodução de crashes, validação estrutural & segurança (Fuzzing)', () => {
    let ts;

    before(async () => {
        ts = await startTestServer();
    });

    after(async () => {
        await ts.close();
    });

    const fuzzCases = [
        ['T1: join-room com payload null', (s) => s.emit('join-room', null)],
        ['T2: join-room sem argumentos (undefined)', (s) => s.emit('join-room')],
        ['T3: join-room com roomId numérico', (s) => s.emit('join-room', { roomId: 12345 })],
        ['T4: join-room com senha booleana', (s) => s.emit('join-room', { roomId: 'teste', password: true })],
        ['T8: check-room sem argumentos', (s) => s.emit('check-room')],
        ['T8b: check-room com payload null', (s) => s.emit('check-room', null)],
        ['TSignal: signal com payload null', (s) => s.emit('signal', null)],
        ['TStream: stream-state com payload null', (s) => s.emit('stream-state', null)]
    ];

    for (const [label, emitFuzz] of fuzzCases) {
        it(label, async () => {
            const socket = await ts.connectClient();
            try {
                emitFuzz(socket);
                await checkRoom(socket, 'fuzz-health-probe');
                assert.strictEqual(ts.server.listening, true, 'Servidor deve permanecer ativo');
            } finally {
                socket.disconnect();
            }
        });
    }

    it('T-HEALTH: servidor permanece saudável via HTTP /health após payloads malformados', async () => {
        const health = await httpRequest(`${ts.baseUrl}/health`);
        assert.strictEqual(health.statusCode, 200);
    });

    it('T4-ASSERT: { password: true } responde com invalid_password_format', async () => {
        const socket = await ts.connectClient();
        try {
            const result = await tryJoin(socket, 'sala-teste', true);
            assert.strictEqual(result.status, 'error');
            assert.strictEqual(result.data?.error, 'invalid_password_format');
        } finally {
            socket.disconnect();
        }
    });

    it('T-SIGNAL: relay de SDP válido vs descarte de sinal inválido', async () => {
        const socketA = await ts.connectClient();
        const socketB = await ts.connectClient();
        try {
            assert.strictEqual((await tryJoin(socketA, 'sala-signal')).status, 'joined');
            assert.strictEqual((await tryJoin(socketB, 'sala-signal')).status, 'joined');

            const receivedSignals = [];
            socketB.on('signal', (data) => {
                receivedSignals.push(data.signal);
            });

            const validRelayed = waitForEvent(socketB, 'signal', 2000);
            socketA.emit('signal', { targetId: socketB.id, signal: 'not-an-object' });
            socketA.emit('signal', { targetId: socketB.id, signal: { foo: 'bar' } });

            const validSdp = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
            socketA.emit('signal', { targetId: socketB.id, signal: validSdp });
            await validRelayed;

            assert.strictEqual(receivedSignals.length, 1);
            assert.strictEqual(receivedSignals[0].type, 'offer');
        } finally {
            socketA.disconnect();
            socketB.disconnect();
        }
    });

    it('T-UNIT: sanitização real de sanitizeRoomId (acentos, emojis, limites)', async () => {
        const { sanitizeRoomId } = await loadClientModules(['room-utils']);
        const cases = [
            { input: 'Sala do João', expected: 'sala-do-joao' },
            { input: 'quarto #1 👍 . teste', expected: 'quarto-1-teste' },
            { input: '???', expected: '' },
            { input: 'a'.repeat(80), expected: 'a'.repeat(64) },
            { input: '  SALA---TESTE  ', expected: 'sala-teste' }
        ];
        for (const c of cases) {
            assert.strictEqual(sanitizeRoomId(c.input), c.expected);
        }
    });

    it('T8-ACK: check-room sem payload preserva o callback de ack', async () => {
        const socket = await ts.connectClient();
        try {
            const ackReceived = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ status: 'timeout' }), 1500);
                socket.emit('check-room', (res) => {
                    clearTimeout(timer);
                    resolve({ status: 'ack', res });
                });
            });
            assert.strictEqual(ackReceived.status, 'ack');
            assert.strictEqual(ackReceived.res?.exists, false);
        } finally {
            socket.disconnect();
        }
    });

    it('T-XSS: join-room com payload HTML é rejeitado com invalid_room', async () => {
        const socket = await ts.connectClient();
        try {
            const result = await tryJoin(socket, '<img src=x onerror=alert(1)>');
            assert.strictEqual(result.status, 'error');
            assert.strictEqual(result.data?.error, 'invalid_room');
        } finally {
            socket.disconnect();
        }
    });

    it('T7: eviction com 1 membro preserva sala e senha', async () => {
        const socketA = await ts.connectClient();
        const socketB = await ts.connectClient();
        const socketC = await ts.connectClient();

        try {
            assert.strictEqual(
                (await tryJoin(socketA, 'sala-secreta', 'senha-super-segura', 'user-1')).status,
                'joined'
            );

            const socketADisconnected = waitForEvent(socketA, 'disconnect', 2000).then(() => true, () => false);
            const [aWasEvicted, bJoinRes] = await Promise.all([
                socketADisconnected,
                tryJoin(socketB, 'sala-secreta', 'senha-super-segura', 'user-1')
            ]);
            assert.strictEqual(bJoinRes.status, 'joined');
            assert.ok(aWasEvicted && !socketA.connected, 'Socket A deve ser expulso pelo servidor');

            const checkResult = await checkRoom(socketC, 'sala-secreta');
            assert.strictEqual(checkResult?.exists, true);
            assert.strictEqual(checkResult?.hasPassword, true);
            assert.strictEqual(checkResult?.memberCount, 1);

            const cResult = await tryJoin(socketC, 'sala-secreta', '');
            assert.strictEqual(cResult.status, 'error');
            assert.strictEqual(cResult.data?.error, 'invalid_password');
        } finally {
            socketA.disconnect();
            socketB.disconnect();
            socketC.disconnect();
        }
    });

    it('T6: autorização de stream-state impede spoofing entre salas', async () => {
        const socketAlice = await ts.connectClient();
        const socketBob = await ts.connectClient();
        try {
            assert.strictEqual((await tryJoin(socketAlice, 'sala-a')).status, 'joined');
            assert.strictEqual((await tryJoin(socketBob, 'sala-b')).status, 'joined');

            let bobReceivedSpoofedEvent = false;
            socketBob.on('stream-state', () => {
                bobReceivedSpoofedEvent = true;
            });

            socketAlice.emit('stream-state', { roomId: 'sala-b', state: 'started' });
            await checkRoom(socketAlice, 'sala-b');
            await delay(20);

            assert.strictEqual(bobReceivedSpoofedEvent, false);
        } finally {
            socketAlice.disconnect();
            socketBob.disconnect();
        }
    });

    it('T-NICKNAME: server.js propaga userName em room-users e user-joined', async () => {
        const socketAlice = await ts.connectClient();
        const socketBob = await ts.connectClient();
        try {
            const aliceJoin = await tryJoin(socketAlice, 'sala-apelidos', '', null, 'Alice');
            assert.strictEqual(aliceJoin.status, 'joined');

            const bobJoinedPromise = waitForEvent(socketAlice, 'user-joined');
            const bobJoin = await tryJoin(socketBob, 'sala-apelidos', '', null, 'Bob');
            assert.strictEqual(bobJoin.status, 'joined');

            const bobJoinedEvent = await bobJoinedPromise;
            const bobRoomUsersEvent = bobJoin.data;

            assert.ok(bobJoinedEvent && bobJoinedEvent.userName === 'Bob');
            assert.ok(
                bobRoomUsersEvent &&
                bobRoomUsersEvent.userNames &&
                Object.values(bobRoomUsersEvent.userNames).includes('Alice')
            );
        } finally {
            socketAlice.disconnect();
            socketBob.disconnect();
        }
    });
});

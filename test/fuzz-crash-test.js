const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startTestServer, httpRequest } = require('./helpers/test-server');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
                await sleep(60);
                assert.strictEqual(ts.server.listening, true, 'Servidor deve permanecer ativo');
                const health = await httpRequest(`${ts.baseUrl}/health`);
                assert.strictEqual(health.statusCode, 200);
            } finally {
                socket.disconnect();
            }
        });
    }

    it('T4-ASSERT: { password: true } responde com invalid_password_format', async () => {
        const socket = await ts.connectClient();
        try {
            const result = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ status: 'timeout' }), 1500);
                socket.once('join-error', (data) => { clearTimeout(timer); resolve({ status: 'error', data }); });
                socket.once('room-users', (data) => { clearTimeout(timer); resolve({ status: 'joined', data }); });
                socket.emit('join-room', { roomId: 'sala-teste', password: true });
            });
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
            socketA.emit('join-room', { roomId: 'sala-signal' });
            socketB.emit('join-room', { roomId: 'sala-signal' });
            await sleep(150);

            const receivedSignals = [];
            socketB.on('signal', (data) => {
                receivedSignals.push(data.signal);
            });

            socketA.emit('signal', { targetId: socketB.id, signal: 'not-an-object' });
            socketA.emit('signal', { targetId: socketB.id, signal: { foo: 'bar' } });
            await sleep(100);

            const validSdp = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
            socketA.emit('signal', { targetId: socketB.id, signal: validSdp });
            await sleep(150);

            assert.strictEqual(receivedSignals.length, 1);
            assert.strictEqual(receivedSignals[0].type, 'offer');
        } finally {
            socketA.disconnect();
            socketB.disconnect();
        }
    });

    it('T-UNIT: sanitização real de sanitizeRoomId (acentos, emojis, limites)', async () => {
        const { sanitizeRoomId } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/room-utils.js')).href
        );
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
            const result = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ status: 'timeout' }), 1500);
                socket.once('join-error', (err) => { clearTimeout(timer); resolve({ status: 'rejected', err }); });
                socket.once('room-users', (data) => { clearTimeout(timer); resolve({ status: 'accepted', data }); });
                socket.emit('join-room', { roomId: '<img src=x onerror=alert(1)>' });
            });
            assert.strictEqual(result.status, 'rejected');
            assert.strictEqual(result.err?.error, 'invalid_room');
        } finally {
            socket.disconnect();
        }
    });

    it('T7: eviction com 1 membro preserva sala e senha', async () => {
        const socketA = await ts.connectClient();
        const socketB = await ts.connectClient();
        const socketC = await ts.connectClient();

        try {
            const roomAJoined = new Promise((resolve) => socketA.once('room-users', resolve));
            socketA.emit('join-room', { roomId: 'sala-secreta', password: 'senha-super-segura', clientId: 'user-1' });
            await roomAJoined;

            const socketADisconnected = new Promise((resolve) => {
                socketA.once('disconnect', () => resolve(true));
                setTimeout(() => resolve(false), 2000);
            });
            const bJoined = new Promise((resolve) => socketB.once('room-users', resolve));
            socketB.emit('join-room', { roomId: 'sala-secreta', password: 'senha-super-segura', clientId: 'user-1' });

            const [aWasEvicted] = await Promise.all([socketADisconnected, bJoined]);
            assert.ok(aWasEvicted && !socketA.connected, 'Socket A deve ser expulso pelo servidor');

            const checkResult = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ status: 'timeout' }), 1500);
                socketC.emit('check-room', { roomId: 'sala-secreta' }, (res) => {
                    clearTimeout(timer);
                    resolve({ status: 'ok', res });
                });
            });
            assert.strictEqual(checkResult.status, 'ok');
            assert.strictEqual(checkResult.res?.exists, true);
            assert.strictEqual(checkResult.res?.hasPassword, true);
            assert.strictEqual(checkResult.res?.memberCount, 1);

            const cResult = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ status: 'timeout' }), 2000);
                socketC.once('room-users', (data) => { clearTimeout(timer); resolve({ status: 'joined', data }); });
                socketC.once('join-error', (data) => { clearTimeout(timer); resolve({ status: 'rejected', data }); });
                socketC.emit('join-room', { roomId: 'sala-secreta', password: '' });
            });
            assert.strictEqual(cResult.status, 'rejected');
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
            socketAlice.emit('join-room', { roomId: 'sala-a' });
            socketBob.emit('join-room', { roomId: 'sala-b' });
            await sleep(150);

            let bobReceivedSpoofedEvent = false;
            socketBob.on('stream-state', () => {
                bobReceivedSpoofedEvent = true;
            });

            socketAlice.emit('stream-state', { roomId: 'sala-b', state: 'started' });
            await sleep(150);

            assert.strictEqual(bobReceivedSpoofedEvent, false);
        } finally {
            socketAlice.disconnect();
            socketBob.disconnect();
        }
    });
});

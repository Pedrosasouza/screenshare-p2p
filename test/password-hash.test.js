const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/server/password');
const { startTestServer } = require('./helpers/test-server');

function tryJoin(socket, roomId, password, clientId = null) {
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
        socket.emit('join-room', { roomId, password, clientId });
    });
}

function checkRoom(socket, roomId) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ status: 'timeout' }), 3000);
        socket.emit('check-room', { roomId }, (res) => {
            clearTimeout(timer);
            resolve({ status: 'ok', res });
        });
    });
}

describe('Armazenamento seguro de senhas (scrypt)', () => {
    let ts;

    before(async () => {
        ts = await startTestServer();
    });

    after(async () => {
        await ts.close();
    });

    it('T1: hashPassword e verifyPassword geram salt aleatório e validam corretamente', async () => {
        const pass = 'senha-super-secreta';
        const res1 = await hashPassword(pass);
        const res2 = await hashPassword(pass);

        assert.ok(res1 && res1.hash && res1.salt);
        assert.ok(Buffer.isBuffer(res1.hash), 'hash deve ser Buffer');
        assert.ok(Buffer.isBuffer(res1.salt), 'salt deve ser Buffer');
        assert.strictEqual(res1.salt.length, 16, 'salt deve ter 16 bytes');
        assert.strictEqual(res1.hash.length, 32, 'hash deve ter 32 bytes');

        assert.notDeepStrictEqual(res1.salt, res2.salt, 'salts devem ser distintos');
        assert.notDeepStrictEqual(res1.hash, res2.hash, 'hashes devem ser distintos');
        assert.ok(!res1.hash.toString('utf8').includes(pass), 'Hash não deve conter senha em texto puro');

        assert.strictEqual(await verifyPassword(pass, res1.hash, res1.salt), true);
        assert.strictEqual(await verifyPassword('senha-errada', res1.hash, res1.salt), false);
        assert.strictEqual(await verifyPassword('', res1.hash, res1.salt), false);
    });

    it('T2: inspeção de memória da sala não contém password em texto puro', async () => {
        const creatorSocket = await ts.connectClient();
        const secretPass = 'senha-em-memoria-987';
        const roomId = 'sala-teste-crypto';

        const joinRes = await tryJoin(creatorSocket, roomId, secretPass, 'user-criador');
        assert.strictEqual(joinRes.status, 'joined');

        const room = ts.rooms.get(roomId);
        assert.ok(room, 'A sala deve existir no Map de salas');
        assert.strictEqual(room.password, undefined, 'room.password NÃO deve existir em texto puro');
        assert.ok(Buffer.isBuffer(room.passwordHash));
        assert.ok(Buffer.isBuffer(room.passwordSalt));
        assert.strictEqual(room.passwordSalt.length, 16);
        assert.strictEqual(room.passwordHash.length, 32);
        assert.ok(!room.passwordHash.toString('utf8').includes(secretPass));

        creatorSocket.disconnect();
    });

    it('T3: fluxo de autenticação e proteção via Socket.IO', async () => {
        const roomId = 'sala-auth-flow';
        const pass = 'segredo-autorizacao';

        const creator = await ts.connectClient();
        const resCreate = await tryJoin(creator, roomId, pass, 'criador');
        assert.strictEqual(resCreate.status, 'joined');
        assert.strictEqual(resCreate.data.hasPassword, true);

        const checker = await ts.connectClient();
        const checkRes = await checkRoom(checker, roomId);
        assert.strictEqual(checkRes.status, 'ok');
        assert.strictEqual(checkRes.res.hasPassword, true);

        const wrongUser = await ts.connectClient();
        const resWrong = await tryJoin(wrongUser, roomId, 'senha-falsa', 'errado');
        assert.strictEqual(resWrong.status, 'error');
        assert.strictEqual(resWrong.data.error, 'invalid_password');

        const emptyUser = await ts.connectClient();
        const resEmpty = await tryJoin(emptyUser, roomId, '', 'vazio');
        assert.strictEqual(resEmpty.status, 'error');
        assert.strictEqual(resEmpty.data.error, 'invalid_password');

        const correctUser = await ts.connectClient();
        const resCorrect = await tryJoin(correctUser, roomId, pass, 'correto');
        assert.strictEqual(resCorrect.status, 'joined');

        creator.disconnect();
        checker.disconnect();
        wrongUser.disconnect();
        emptyUser.disconnect();
        correctUser.disconnect();
    });

    it('T4: sala pública sem senha não cria hash nem exige autenticação', async () => {
        const pubId = 'sala-publica-teste';
        const pubCreator = await ts.connectClient();
        const pubRes = await tryJoin(pubCreator, pubId, '', 'pub-criador');
        assert.strictEqual(pubRes.status, 'joined');
        assert.strictEqual(pubRes.data.hasPassword, false);

        const room = ts.rooms.get(pubId);
        assert.strictEqual(room.password, undefined);
        assert.strictEqual(room.passwordHash, null);
        assert.strictEqual(room.passwordSalt, null);

        const pubJoiner = await ts.connectClient();
        const joinRes = await tryJoin(pubJoiner, pubId, '', 'pub-membro');
        assert.strictEqual(joinRes.status, 'joined');

        pubCreator.disconnect();
        pubJoiner.disconnect();
    });
});

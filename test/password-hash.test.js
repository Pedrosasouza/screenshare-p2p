const ioClient = require('socket.io-client');
const assert = require('assert');

let currentPort = 42350;
function getNextPort() {
    currentPort += 1;
    return currentPort;
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

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: ARMAZENAMENTO SEGURO DE SENHAS (SCRYPT)');
    console.log('===============================================================\n');

    let failures = 0;

    // Carrega o módulo do servidor
    let serverModule;
    try {
        serverModule = require('../server.js');
    } catch (e) {
        serverModule = {};
    }

    // Teste 1: Validação de Funções Criptográficas scrypt + salt aleatório
    process.stdout.write('  [Teste] T1: Funções hashPassword e verifyPassword exportadas e seguras ... ');
    if (typeof serverModule.hashPassword !== 'function' || typeof serverModule.verifyPassword !== 'function') {
        console.log('\x1b[31mFALHOU (server.js não exporta hashPassword ou verifyPassword)\x1b[0m');
        failures++;
    } else {
        try {
            const pass = 'senha-super-secreta';
            const res1 = await serverModule.hashPassword(pass);
            const res2 = await serverModule.hashPassword(pass);

            assert(res1 && res1.hash && res1.salt, 'hashPassword deve retornar objeto com hash e salt');
            assert(Buffer.isBuffer(res1.hash), 'hash deve ser um Buffer');
            assert(Buffer.isBuffer(res1.salt), 'salt deve ser um Buffer');
            assert.strictEqual(res1.salt.length, 16, 'salt deve ter 16 bytes aleatórios');
            assert.strictEqual(res1.hash.length, 32, 'hash deve ter 32 bytes derivados');

            assert.notDeepStrictEqual(res1.salt, res2.salt, 'Dois hashes devem ter salts aleatórios distintos');
            assert.notDeepStrictEqual(res1.hash, res2.hash, 'Dois hashes devem ser distintos devido ao salt');

            assert(!res1.hash.toString('utf8').includes(pass), 'Hash não deve conter a senha em texto puro');

            const valid = await serverModule.verifyPassword(pass, res1.hash, res1.salt);
            assert.strictEqual(valid, true, 'verifyPassword deve retornar true para a senha correta');

            const invalid = await serverModule.verifyPassword('senha-errada', res1.hash, res1.salt);
            assert.strictEqual(invalid, false, 'verifyPassword deve retornar false para senha incorreta');

            const empty = await serverModule.verifyPassword('', res1.hash, res1.salt);
            assert.strictEqual(empty, false, 'verifyPassword deve retornar false para senha vazia');

            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            failures++;
        }
    }

    // Inicia o servidor HTTP/Socket.IO em porta dinâmica caso exportado
    const port = getNextPort();
    const server = serverModule.server;
    let url = `http://localhost:${port}`;

    if (!server || typeof server.listen !== 'function' || !serverModule.rooms) {
        process.stdout.write('  [Teste] T2: Inspeção de memória (rooms não contém plaintext) ... ');
        console.log('\x1b[31mFALHOU (server ou rooms não exportados)\x1b[0m');
        failures++;

        process.stdout.write('  [Teste] T3: Fluxo de autenticação e proteção via Socket.IO ... ');
        console.log('\x1b[31mFALHOU (servidor indisponível)\x1b[0m');
        failures++;
    } else {
        await new Promise((resolve) => server.listen(port, resolve));

        // Teste 2: Inspeção da Memória Interna da Sala
        process.stdout.write('  [Teste] T2: Inspeção de memória (rooms não contém plaintext) ... ');
        try {
            const creatorSocket = await connectSocket(url);
            const secretPass = 'senha-em-memoria-987';
            const roomId = 'sala-teste-crypto';

            const joinRes = await tryJoin(creatorSocket, roomId, secretPass, 'user-criador');
            assert.strictEqual(joinRes.status, 'joined', 'Criador deveria entrar na sala');

            const room = serverModule.rooms.get(roomId);
            assert(room, 'A sala deve existir no Map de salas');

            // Asserções estritas de segurança em memória:
            assert.strictEqual(room.password, undefined, 'room.password NÃO deve existir em texto puro');
            assert(Buffer.isBuffer(room.passwordHash), 'room.passwordHash deve ser um Buffer');
            assert(Buffer.isBuffer(room.passwordSalt), 'room.passwordSalt deve ser um Buffer');
            assert.strictEqual(room.passwordSalt.length, 16, 'room.passwordSalt deve ter 16 bytes');
            assert.strictEqual(room.passwordHash.length, 32, 'room.passwordHash deve ter 32 bytes');
            assert(!room.passwordHash.toString('utf8').includes(secretPass), 'Hash não pode conter texto da senha');

            creatorSocket.disconnect();
            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            failures++;
        }

        // Teste 3: Fluxo Completo de Autenticação via Socket.IO
        process.stdout.write('  [Teste] T3: Fluxo de autenticação e proteção via Socket.IO ... ');
        try {
            const roomId = 'sala-auth-flow';
            const pass = 'segredo-autorizacao';

            // 1. Criador cria a sala
            const creator = await connectSocket(url);
            const resCreate = await tryJoin(creator, roomId, pass, 'criador');
            assert.strictEqual(resCreate.status, 'joined');
            assert.strictEqual(resCreate.data.hasPassword, true, 'hasPassword deve ser true no room-users');

            // 2. check-room indica hasPassword = true
            const checker = await connectSocket(url);
            const checkRes = await checkRoom(checker, roomId);
            assert.strictEqual(checkRes.status, 'ok');
            assert.strictEqual(checkRes.res.hasPassword, true, 'check-room deve indicar hasPassword = true');

            // 3. Usuário com senha incorreta é rejeitado
            const wrongUser = await connectSocket(url);
            const resWrong = await tryJoin(wrongUser, roomId, 'senha-falsa', 'errado');
            assert.strictEqual(resWrong.status, 'error');
            assert.strictEqual(resWrong.data.error, 'invalid_password');

            // 4. Usuário sem senha é rejeitado
            const emptyUser = await connectSocket(url);
            const resEmpty = await tryJoin(emptyUser, roomId, '', 'vazio');
            assert.strictEqual(resEmpty.status, 'error');
            assert.strictEqual(resEmpty.data.error, 'invalid_password');

            // 5. Usuário com a senha correta entra com sucesso
            const correctUser = await connectSocket(url);
            const resCorrect = await tryJoin(correctUser, roomId, pass, 'correto');
            assert.strictEqual(resCorrect.status, 'joined');

            // Limpeza
            creator.disconnect();
            checker.disconnect();
            wrongUser.disconnect();
            emptyUser.disconnect();
            correctUser.disconnect();

            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            failures++;
        }

        // Teste 4: Sala pública (sem senha) não cria hash nem exige autenticação
        process.stdout.write('  [Teste] T4: Sala pública (sem senha) ... ');
        try {
            const pubId = 'sala-publica-teste';
            const pubCreator = await connectSocket(url);
            const pubRes = await tryJoin(pubCreator, pubId, '', 'pub-criador');
            assert.strictEqual(pubRes.status, 'joined');
            assert.strictEqual(pubRes.data.hasPassword, false);

            const room = serverModule.rooms.get(pubId);
            assert.strictEqual(room.password, undefined);
            assert.strictEqual(room.passwordHash, null);
            assert.strictEqual(room.passwordSalt, null);

            const pubJoiner = await connectSocket(url);
            const joinRes = await tryJoin(pubJoiner, pubId, '', 'pub-membro');
            assert.strictEqual(joinRes.status, 'joined');

            pubCreator.disconnect();
            pubJoiner.disconnect();
            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            failures++;
        }

        // Fecha o servidor
        await new Promise((resolve) => server.close(resolve));
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Erro fatal na suíte:', err);
    process.exit(1);
});

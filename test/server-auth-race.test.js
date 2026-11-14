const ioClient = require('socket.io-client');
const assert = require('assert');

let currentPort = 43500;
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

function tryJoin(socket, roomId, password, clientId = null, userName = null) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting join response for room "${roomId}"`));
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

        socket.emit('join-room', { roomId, password, clientId, userName });
    });
}

function checkRoom(socket, roomId) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('check-room timeout')), 3000);
        socket.emit('check-room', { roomId }, (res) => {
            clearTimeout(timer);
            resolve(res);
        });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: ISOLAMENTO DE RATE LIMIT & RACE NO JOIN');
    console.log('===============================================================\n');

    let failures = 0;
    const serverModule = require('../server.js');
    const { server, rooms } = serverModule;
    const port = getNextPort();
    const url = `http://localhost:${port}`;

    await new Promise((resolve) => server.listen(port, resolve));

    try {
        // Teste 1: Escopo por sala em loginAttempts (sem bypass via criação/entrada em outra sala)
        process.stdout.write('  [Teste] T1: loginAttempts isolado por sala não permite resetar bloqueio via outra sala ... ');
        try {
            const ownerTarget = await connectSocket(url);
            const ownerOther = await connectSocket(url);

            const targetRoom = 'sala-alvo';
            const otherRoom = 'sala-outra';
            const dummyRoom = 'sala-dummy';

            const resTarget = await tryJoin(ownerTarget, targetRoom, 'segredo-alvo');
            assert.strictEqual(resTarget.status, 'joined');

            const resOther = await tryJoin(ownerOther, otherRoom, 'segredo-outra');
            assert.strictEqual(resOther.status, 'joined');

            const attacker = await connectSocket(url);

            // 4 tentativas erradas na sala-alvo
            for (let i = 1; i <= 4; i++) {
                const res = await tryJoin(attacker, targetRoom, `errada-${i}`);
                assert.strictEqual(res.status, 'error');
                assert.strictEqual(res.data.error, 'invalid_password', `Tentativa ${i} deveria ser invalid_password`);
            }

            // Criar sala-dummy (com senha) e entrar em sala-outra com senha válida
            const dummySocket = await connectSocket(url);
            const dummyRes = await tryJoin(dummySocket, dummyRoom, 'senha-dummy');
            assert.strictEqual(dummyRes.status, 'joined', 'Criação da sala-dummy deveria funcionar');

            const otherRes = await tryJoin(attacker, otherRoom, 'segredo-outra');
            assert.strictEqual(otherRes.status, 'joined', 'Entrada na sala-outra com senha válida deveria funcionar');

            // 5ª tentativa errada na sala-alvo ainda deve disparar rate_limited
            const fifthRes = await tryJoin(attacker, targetRoom, 'errada-5');
            assert.strictEqual(fifthRes.status, 'error');
            assert.strictEqual(
                fifthRes.data.error,
                'rate_limited',
                `5ª tentativa em sala-alvo deveria retornar rate_limited, mas retornou "${fifthRes.data.error}"`
            );

            ownerTarget.disconnect();
            ownerOther.disconnect();
            attacker.disconnect();
            dummySocket.disconnect();
            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            failures++;
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        }

        // Teste 2: Desconexão imediata durante scrypt no join-room não cria sala zumbi nem membro fantasma
        process.stdout.write('  [Teste] T2: Desconexão durante scrypt no join-room não deixa sala zumbi nem membro fantasma ... ');
        try {
            const raceRoom = 'sala-race-scrypt';
            const racerSocket = await connectSocket(url);
            const observerSocket = await connectSocket(url);

            racerSocket.emit('join-room', { roomId: raceRoom, password: 'senha-scrypt-race' });
            // Desconecta logo após enviar o frame para atingir a janela assíncrona do scrypt
            await delay(2);
            racerSocket.disconnect();

            // Aguarda tempo suficiente para o scrypt no servidor finalizar
            await delay(200);

            const checkRes = await checkRoom(observerSocket, raceRoom);
            assert.strictEqual(checkRes.exists, false, 'Sala zumbi não deve existir após desconexão durante scrypt');
            assert.strictEqual(checkRes.memberCount, 0, 'Não deve restar membro fantasma na sala');
            assert.strictEqual(rooms.has(raceRoom), false, 'Map rooms não deve reter sala vazia criada por socket desconectado');

            observerSocket.disconnect();
            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            failures++;
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        }

        // Teste 3: Re-envio de join-room na mesma sala pelo mesmo socket não gera user-joined duplicado
        process.stdout.write('  [Teste] T3: Re-envio de join-room pelo mesmo socket não emite user-joined duplicado ... ');
        try {
            const dupRoom = 'sala-rejoin-dup';
            const userA = await connectSocket(url);
            const userB = await connectSocket(url);

            const joinA = await tryJoin(userA, dupRoom, 'senha-dup', 'client-a', 'Alice');
            assert.strictEqual(joinA.status, 'joined');

            let userJoinedCount = 0;
            userA.on('user-joined', (payload) => {
                if (payload && payload.socketId === userB.id) {
                    userJoinedCount += 1;
                }
            });

            const joinB1 = await tryJoin(userB, dupRoom, 'senha-dup', 'client-b', 'Bob');
            assert.strictEqual(joinB1.status, 'joined');

            await delay(50);
            assert.strictEqual(userJoinedCount, 1, 'Primeiro join de userB deve emitir exatamente 1 user-joined');

            // Re-envia join-room na mesma sala pelo mesmo socket
            const joinB2 = await tryJoin(userB, dupRoom, 'senha-dup', 'client-b', 'Bob');
            assert.strictEqual(joinB2.status, 'joined');

            await delay(80);
            assert.strictEqual(
                userJoinedCount,
                1,
                `Re-envio de join-room não deve emitir user-joined duplicado (recebido: ${userJoinedCount})`
            );

            const checkRes = await checkRoom(userA, dupRoom);
            assert.strictEqual(checkRes.memberCount, 2, 'memberCount deve permanecer 2');

            userA.disconnect();
            userB.disconnect();
            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            failures++;
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
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

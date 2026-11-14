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
    const { server, rooms, hashPassword } = serverModule;
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

        // Teste 4: Eviction não pode ser explorada usando socket.id de outra pessoa como clientId
        process.stdout.write('  [Teste] T4: Spoofing de socket.id no clientId não expulsa outro membro ... ');
        {
            let victim = null;
            let attacker = null;
            try {
                const spoofRoom = 'sala-evict-spoof';
                victim = await connectSocket(url);
                attacker = await connectSocket(url);

                const joinVictim = await tryJoin(victim, spoofRoom, 'segredo-spoof', null, 'Victim');
                assert.strictEqual(joinVictim.status, 'joined');

                let victimDisconnected = false;
                victim.once('disconnect', () => {
                    victimDisconnected = true;
                });

                // Attacker tenta usar victim.id como se fosse seu clientId persistente
                const joinAttacker = await tryJoin(attacker, spoofRoom, 'segredo-spoof', victim.id, 'Attacker');
                await delay(100);

                assert.strictEqual(victimDisconnected, false, 'Victim não deve ser desconectado por spoofing de socket.id');
                assert.strictEqual(victim.connected, true, 'Victim deve permanecer conectado');
                assert(
                    joinAttacker.status === 'error' || (await checkRoom(victim, spoofRoom)).memberCount >= 1,
                    'Sala não deve aceitar eviction forjada por socket.id'
                );

                console.log('\x1b[32mPASSOU\x1b[0m');
            } catch (err) {
                failures++;
                console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            } finally {
                if (victim) victim.disconnect();
                if (attacker) attacker.disconnect();
            }
        }

        // Teste 5: Tentativas concorrentes de senha errada não podem burlar limite de loginAttempts
        process.stdout.write('  [Teste] T5: Rajada concorrente de senhas erradas respeita bloqueio anti-brute-force ... ');
        {
            let owner = null;
            let attacker = null;
            try {
                const raceBfRoom = 'sala-bf-race';
                owner = await connectSocket(url);
                attacker = await connectSocket(url);

                assert.strictEqual((await tryJoin(owner, raceBfRoom, 'senha-correta-bf')).status, 'joined');

                // Dispara 5 tentativas erradas simultaneamente antes do primeiro scrypt concluir
                const burstResults = await new Promise((resolve, reject) => {
                    const collected = [];
                    const timer = setTimeout(() => {
                        attacker.off('join-error', onErr);
                        reject(new Error(`Timeout aguardando 5 join-errors (recebidos=${collected.length})`));
                    }, 5000);
                    const onErr = (errData) => {
                        collected.push(errData);
                        if (collected.length === 5) {
                            clearTimeout(timer);
                            attacker.off('join-error', onErr);
                            resolve(collected);
                        }
                    };
                    attacker.on('join-error', onErr);
                    for (let i = 1; i <= 5; i++) {
                        attacker.emit('join-room', { roomId: raceBfRoom, password: `errada-${i}` });
                    }
                });
                assert.strictEqual(burstResults.length, 5, 'Todas as 5 devem receber join-error');

                // A 6ª tentativa deve obrigatoriamente encontrar rate_limited (sem reset/perda de contagem na race)
                const sixth = await tryJoin(attacker, raceBfRoom, 'errada-6');
                assert.strictEqual(sixth.status, 'error');
                assert.strictEqual(
                    sixth.data.error,
                    'rate_limited',
                    `6ª tentativa pós-rajada deveria retornar rate_limited, mas retornou "${sixth.data.error}"`
                );

                console.log('\x1b[32mPASSOU\x1b[0m');
            } catch (err) {
                failures++;
                console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            } finally {
                if (owner) owner.disconnect();
                if (attacker) attacker.disconnect();
            }
        }

        // Teste 6: Split-brain — se a instância da sala mudar durante verifyPassword, revalida contra a sala atual
        process.stdout.write('  [Teste] T6: Substituição de sala durante verifyPassword não admite membro em sala obsoleta ... ');
        {
            const splitRoom = 'sala-split-brain';
            let oldOwner = null;
            let newOwner = null;
            let challenger = null;
            try {
                oldOwner = await connectSocket(url);
                newOwner = await connectSocket(url);
                challenger = await connectSocket(url);

                assert.strictEqual((await tryJoin(oldOwner, splitRoom, 'senha-antiga')).status, 'joined');

                const newCreds = await hashPassword('senha-totalmente-nova');
                const joinPromise = tryJoin(challenger, splitRoom, 'senha-antiga', 'challenger-c1', 'Challenger');

                // Enquanto verifyPassword('senha-antiga') roda em background, substitui a sala por uma nova com outra senha
                await delay(2);
                const replacementMembers = new Map([[newOwner.id, 'new-owner-c1']]);
                const replacementUserNames = new Map([[newOwner.id, 'NewOwner']]);
                rooms.set(splitRoom, {
                    passwordHash: newCreds.hash,
                    passwordSalt: newCreds.salt,
                    members: replacementMembers,
                    userNames: replacementUserNames,
                    activeStreams: new Set()
                });

                const res = await joinPromise;
                assert.strictEqual(
                    res.status,
                    'error',
                    `Challenger com senha antiga não deve ser admitido após substituição da sala (status=${res.status})`
                );
                assert.strictEqual(
                    rooms.get(splitRoom).members.has(challenger.id),
                    false,
                    'Challenger não pode constar nos membros da sala substituída'
                );

                console.log('\x1b[32mPASSOU\x1b[0m');
            } catch (err) {
                failures++;
                console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            } finally {
                if (oldOwner) oldOwner.disconnect();
                if (newOwner) newOwner.disconnect();
                if (challenger) challenger.disconnect();
                rooms.delete(splitRoom);
            }
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

        // Teste 4: Tentar trocar para sala cheia (room_full) preserva usuário na sala atual
        process.stdout.write('  [Teste] T4: Troca de sala que retorna room_full preserva usuário na sala anterior ... ');
        try {
            const { rooms } = require('../server.js');
            const srcRoom = 'sala-origem-cheia';
            const fullRoom = 'sala-destino-cheia';

            const user = await connectSocket(url);
            const peerInSrc = await connectSocket(url);
            assert.strictEqual((await tryJoin(user, srcRoom, '')).status, 'joined');
            assert.strictEqual((await tryJoin(peerInSrc, srcRoom, '')).status, 'joined');

            // Popula sala destino até o limite máximo
            const fakeMembers = new Map();
            const fakeNames = new Map();
            for (let i = 0; i < 32; i++) {
                fakeMembers.set(`ghost-sock-${i}`, `ghost-client-${i}`);
                fakeNames.set(`ghost-sock-${i}`, `Ghost ${i}`);
            }
            rooms.set(fullRoom, {
                passwordHash: null,
                passwordSalt: null,
                members: fakeMembers,
                userNames: fakeNames,
                activeStreams: new Set()
            });

            const switchRes = await tryJoin(user, fullRoom, '');
            assert.strictEqual(switchRes.status, 'error');
            assert.strictEqual(switchRes.data.error, 'room_full');

            // Verifica que user permanece na sala de origem e ainda consegue sinalizar peerInSrc
            const srcInfo = await checkRoom(user, srcRoom);
            assert.strictEqual(srcInfo.memberCount, 2, 'Usuário não deve ter sido ejetado da sala de origem');

            const relayPromise = new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Sinal não retransmitido na sala de origem')), 2000);
                peerInSrc.once('signal', (msg) => {
                    clearTimeout(t);
                    resolve(msg);
                });
            });
            user.emit('signal', { targetId: peerInSrc.id, signal: { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' } });
            const relayed = await relayPromise;
            assert.strictEqual(relayed.senderId, user.id);

            rooms.delete(fullRoom);
            user.disconnect();
            peerInSrc.disconnect();
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

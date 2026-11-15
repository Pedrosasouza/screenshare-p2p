'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/server/password');
const { createAttemptTracker, getHttpClientIp, getClientIdentifier } = require('../src/server/rate-limit');
const { startTestServer, delay, waitForEvent, tryJoin, checkRoom } = require('./helpers/test-server');

describe('Autenticação scrypt, isolamento de rate limit & race conditions no join', () => {
    let ts;

    before(async () => {
        ts = await startTestServer();
    });

    after(async () => {
        await ts.close();
    });

    it('T1: loginAttempts isolado por sala não permite resetar bloqueio via outra sala', async () => {
        const ownerTarget = await ts.connectClient();
        const ownerOther = await ts.connectClient();
        const attacker = await ts.connectClient();
        const dummySocket = await ts.connectClient();

        try {
            assert.strictEqual((await tryJoin(ownerTarget, 'sala-alvo', 'segredo-alvo')).status, 'joined');
            assert.strictEqual((await tryJoin(ownerOther, 'sala-outra', 'segredo-outra')).status, 'joined');

            for (let i = 1; i <= 4; i++) {
                const res = await tryJoin(attacker, 'sala-alvo', `errada-${i}`);
                assert.strictEqual(res.status, 'error');
                assert.strictEqual(res.data.error, 'invalid_password');
            }

            assert.strictEqual((await tryJoin(dummySocket, 'sala-dummy', 'senha-dummy')).status, 'joined');
            assert.strictEqual((await tryJoin(attacker, 'sala-outra', 'segredo-outra')).status, 'joined');

            const fifthRes = await tryJoin(attacker, 'sala-alvo', 'errada-5');
            assert.strictEqual(fifthRes.status, 'error');
            assert.strictEqual(fifthRes.data.error, 'rate_limited');
        } finally {
            ownerTarget.disconnect();
            ownerOther.disconnect();
            attacker.disconnect();
            dummySocket.disconnect();
        }
    });

    it('T2: desconexão durante scrypt no join-room não deixa sala zumbi nem membro fantasma', async () => {
        const raceRoom = 'sala-race-scrypt';
        const racerSocket = await ts.connectClient();
        const observerSocket = await ts.connectClient();

        try {
            racerSocket.emit('join-room', { roomId: raceRoom, password: 'senha-scrypt-race' });
            await delay(2);
            racerSocket.disconnect();

            await delay(200);

            const checkRes = await checkRoom(observerSocket, raceRoom);
            assert.strictEqual(checkRes.exists, false);
            assert.strictEqual(checkRes.memberCount, 0);
            assert.strictEqual(ts.rooms.has(raceRoom), false);
        } finally {
            racerSocket.disconnect();
            observerSocket.disconnect();
        }
    });

    it('T3: re-envio de join-room pelo mesmo socket não emite user-joined duplicado', async () => {
        const dupRoom = 'sala-rejoin-dup';
        const userA = await ts.connectClient();
        const userB = await ts.connectClient();

        try {
            assert.strictEqual((await tryJoin(userA, dupRoom, 'senha-dup', 'client-a', 'Alice')).status, 'joined');

            let userJoinedCount = 0;
            userA.on('user-joined', (payload) => {
                if (payload && payload.socketId === userB.id) {
                    userJoinedCount += 1;
                }
            });

            assert.strictEqual((await tryJoin(userB, dupRoom, 'senha-dup', 'client-b', 'Bob')).status, 'joined');
            await checkRoom(userA, dupRoom);
            assert.strictEqual(userJoinedCount, 1);

            assert.strictEqual((await tryJoin(userB, dupRoom, 'senha-dup', 'client-b', 'Bob')).status, 'joined');
            const checkRes = await checkRoom(userA, dupRoom);
            assert.strictEqual(userJoinedCount, 1);
            assert.strictEqual(checkRes.memberCount, 2);
        } finally {
            userA.disconnect();
            userB.disconnect();
        }
    });

    it('T4a: spoofing de socket.id no clientId não expulsa outro membro', async () => {
        const spoofRoom = 'sala-evict-spoof';
        const victim = await ts.connectClient();
        const attacker = await ts.connectClient();

        try {
            assert.strictEqual((await tryJoin(victim, spoofRoom, 'segredo-spoof', null, 'Victim')).status, 'joined');

            let victimDisconnected = false;
            victim.once('disconnect', () => {
                victimDisconnected = true;
            });

            const joinAttacker = await tryJoin(attacker, spoofRoom, 'segredo-spoof', victim.id, 'Attacker');
            const spoofCheck = await checkRoom(victim, spoofRoom);

            assert.strictEqual(victimDisconnected, false);
            assert.strictEqual(victim.connected, true);
            assert.ok(
                joinAttacker.status === 'error' || spoofCheck.memberCount >= 1
            );
        } finally {
            victim.disconnect();
            attacker.disconnect();
        }
    });

    it('T4b: troca de sala que retorna room_full preserva usuário na sala anterior', async () => {
        const srcRoom = 'sala-origem-cheia';
        const fullRoom = 'sala-destino-cheia';
        const user = await ts.connectClient();
        const peerInSrc = await ts.connectClient();

        try {
            assert.strictEqual((await tryJoin(user, srcRoom, '')).status, 'joined');
            assert.strictEqual((await tryJoin(peerInSrc, srcRoom, '')).status, 'joined');

            const fakeMembers = new Map();
            const fakeNames = new Map();
            for (let i = 0; i < 32; i++) {
                fakeMembers.set(`ghost-sock-${i}`, `ghost-client-${i}`);
                fakeNames.set(`ghost-sock-${i}`, `Ghost ${i}`);
            }
            ts.rooms.set(fullRoom, {
                passwordHash: null,
                passwordSalt: null,
                members: fakeMembers,
                userNames: fakeNames,
                activeStreams: new Set()
            });

            const switchRes = await tryJoin(user, fullRoom, '');
            assert.strictEqual(switchRes.status, 'error');
            assert.strictEqual(switchRes.data.error, 'room_full');

            const srcInfo = await checkRoom(user, srcRoom);
            assert.strictEqual(srcInfo.memberCount, 2);

            const relayPromise = waitForEvent(peerInSrc, 'signal', 2000);
            user.emit('signal', {
                targetId: peerInSrc.id,
                signal: { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }
            });
            const relayed = await relayPromise;
            assert.strictEqual(relayed.senderId, user.id);
        } finally {
            ts.rooms.delete(fullRoom);
            user.disconnect();
            peerInSrc.disconnect();
        }
    });

    it('T5: rajada concorrente de senhas erradas respeita bloqueio anti-brute-force', async () => {
        const raceBfRoom = 'sala-bf-race';
        const owner = await ts.connectClient();
        const attacker = await ts.connectClient();

        try {
            assert.strictEqual((await tryJoin(owner, raceBfRoom, 'senha-correta-bf')).status, 'joined');

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
            assert.strictEqual(burstResults.length, 5);

            const sixth = await tryJoin(attacker, raceBfRoom, 'errada-6');
            assert.strictEqual(sixth.status, 'error');
            assert.strictEqual(sixth.data.error, 'rate_limited');
        } finally {
            owner.disconnect();
            attacker.disconnect();
        }
    });

    it('T6: substituição de sala durante verifyPassword não admite membro em sala obsoleta', async () => {
        const splitRoom = 'sala-split-brain';
        const oldOwner = await ts.connectClient();
        const newOwner = await ts.connectClient();
        const challenger = await ts.connectClient();

        try {
            assert.strictEqual((await tryJoin(oldOwner, splitRoom, 'senha-antiga')).status, 'joined');

            const newCreds = await ts.hashPassword('senha-totalmente-nova');
            const joinPromise = tryJoin(challenger, splitRoom, 'senha-antiga', 'challenger-c1', 'Challenger');

            await delay(2);
            ts.rooms.set(splitRoom, {
                passwordHash: newCreds.hash,
                passwordSalt: newCreds.salt,
                members: new Map([[newOwner.id, 'new-owner-c1']]),
                userNames: new Map([[newOwner.id, 'NewOwner']]),
                activeStreams: new Set()
            });

            const res = await joinPromise;
            assert.strictEqual(res.status, 'error');
            assert.strictEqual(ts.rooms.get(splitRoom).members.has(challenger.id), false);
        } finally {
            oldOwner.disconnect();
            newOwner.disconnect();
            challenger.disconnect();
            ts.rooms.delete(splitRoom);
        }
    });

    it('T7: join-room concorrente no mesmo socket mantém cliente e servidor na última sala', async () => {
        const roomA = 'sala-lenta-scrypt';
        const roomB = 'sala-rapida-pub';
        const ownerA = await ts.connectClient();
        const ownerB = await ts.connectClient();
        const switcher = await ts.connectClient();

        try {
            assert.strictEqual((await tryJoin(ownerA, roomA, 'segredo-a')).status, 'joined');
            assert.strictEqual((await tryJoin(ownerB, roomB, '')).status, 'joined');

            const receivedRoomUsers = [];
            switcher.on('room-users', (data) => {
                receivedRoomUsers.push(data);
            });

            switcher.emit('join-room', { roomId: roomA, password: 'segredo-a', userName: 'Switcher' });
            switcher.emit('join-room', { roomId: roomB, password: '', userName: 'Switcher' });

            for (let i = 0; i < 60 && !receivedRoomUsers.some((u) => Array.isArray(u.users) && u.users.includes(ownerB.id)); i++) {
                await delay(15);
            }

            const infoA = await checkRoom(ownerA, roomA);
            const infoB = await checkRoom(ownerB, roomB);
            assert.strictEqual(infoA.memberCount, 1);
            assert.strictEqual(infoB.memberCount, 2);
            assert.ok(receivedRoomUsers.length >= 1);
            const lastUsers = receivedRoomUsers[receivedRoomUsers.length - 1];
            assert.ok(lastUsers.users.includes(ownerB.id));
            assert.ok(!lastUsers.users.includes(ownerA.id));
        } finally {
            ownerA.disconnect();
            ownerB.disconnect();
            switcher.disconnect();
        }
    });

    it('P1: hashPassword e verifyPassword geram salt aleatório e validam corretamente', async () => {
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

    it('P2: inspeção de memória da sala não contém password em texto puro', async () => {
        const creatorSocket = await ts.connectClient();
        const secretPass = 'senha-em-memoria-987';
        const roomId = 'sala-teste-crypto';

        try {
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
        } finally {
            creatorSocket.disconnect();
        }
    });

    it('P3: fluxo de autenticação e proteção via Socket.IO', async () => {
        const roomId = 'sala-auth-flow';
        const pass = 'segredo-autorizacao';

        const creator = await ts.connectClient();
        const checker = await ts.connectClient();
        const wrongUser = await ts.connectClient();
        const emptyUser = await ts.connectClient();
        const correctUser = await ts.connectClient();

        try {
            const resCreate = await tryJoin(creator, roomId, pass, 'criador');
            assert.strictEqual(resCreate.status, 'joined');
            assert.strictEqual(resCreate.data.hasPassword, true);

            const checkRes = await checkRoom(checker, roomId);
            assert.strictEqual(checkRes.exists, true);
            assert.strictEqual(checkRes.hasPassword, true);

            const resWrong = await tryJoin(wrongUser, roomId, 'senha-falsa', 'errado');
            assert.strictEqual(resWrong.status, 'error');
            assert.strictEqual(resWrong.data.error, 'invalid_password');

            const resEmpty = await tryJoin(emptyUser, roomId, '', 'vazio');
            assert.strictEqual(resEmpty.status, 'error');
            assert.strictEqual(resEmpty.data.error, 'invalid_password');

            const resCorrect = await tryJoin(correctUser, roomId, pass, 'correto');
            assert.strictEqual(resCorrect.status, 'joined');
        } finally {
            creator.disconnect();
            checker.disconnect();
            wrongUser.disconnect();
            emptyUser.disconnect();
            correctUser.disconnect();
        }
    });

    it('P4: sala pública sem senha não cria hash nem exige autenticação', async () => {
        const pubId = 'sala-publica-teste';
        const pubCreator = await ts.connectClient();
        const pubJoiner = await ts.connectClient();
        try {
            const pubRes = await tryJoin(pubCreator, pubId, '', 'pub-criador');
            assert.strictEqual(pubRes.status, 'joined');
            assert.strictEqual(pubRes.data.hasPassword, false);

            const room = ts.rooms.get(pubId);
            assert.strictEqual(room.password, undefined);
            assert.strictEqual(room.passwordHash, null);
            assert.strictEqual(room.passwordSalt, null);

            const joinRes = await tryJoin(pubJoiner, pubId, '', 'pub-membro');
            assert.strictEqual(joinRes.status, 'joined');
        } finally {
            pubCreator.disconnect();
            pubJoiner.disconnect();
        }
    });
});

describe('Rate limit por IP & cabeçalhos proxy', () => {
    it('IP1: sem TRUST_PROXY, ignora X-Forwarded-For forjado e bloqueia na 5ª tentativa', async () => {
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

    it('IP2: com TRUST_PROXY=true, defende contra IP injection usando IP à direita', async () => {
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

    it('IP3: normaliza ::FFFF:, IPv6 /64 e X-Forwarded-For com vírgula final', () => {
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

    it('IP4: erro em withAttemptLock não gera unhandledRejection e permite próximas chamadas', async () => {
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

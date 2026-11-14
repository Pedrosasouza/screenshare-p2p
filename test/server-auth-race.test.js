const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/test-server');

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

describe('Isolamento de rate limit & race conditions no join', () => {
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
            await delay(50);
            assert.strictEqual(userJoinedCount, 1);

            assert.strictEqual((await tryJoin(userB, dupRoom, 'senha-dup', 'client-b', 'Bob')).status, 'joined');
            await delay(80);
            assert.strictEqual(userJoinedCount, 1);

            const checkRes = await checkRoom(userA, dupRoom);
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
            await delay(100);

            assert.strictEqual(victimDisconnected, false);
            assert.strictEqual(victim.connected, true);
            assert.ok(
                joinAttacker.status === 'error' || (await checkRoom(victim, spoofRoom)).memberCount >= 1
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

            const relayPromise = new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Sinal não retransmitido na sala de origem')), 2000);
                peerInSrc.once('signal', (msg) => {
                    clearTimeout(t);
                    resolve(msg);
                });
            });
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

            await delay(300);

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
});

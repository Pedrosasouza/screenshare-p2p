const { hashPassword, verifyPassword } = require('./password');
const { getClientIdentifier, safeHandler, createCheckRoomRateLimiter } = require('./rate-limit');

const ROOM_ID_REGEX = /^[a-z0-9_-]{3,64}$/;
const MAX_ROOMS = 2000;
const MAX_MEMBERS_PER_ROOM = 32;

function isPlainObject(obj) {
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

function sanitizeControlChars(str) {
    // eslint-disable-next-line no-control-regex
    return String(str).replace(/[\x00-\x1f\x7f]/g, '');
}

function isValidSignal(signal) {
    if (!isPlainObject(signal)) return false;
    const isSdp = typeof signal.type === 'string' &&
        (signal.type === 'offer' || signal.type === 'answer') &&
        typeof signal.sdp === 'string' &&
        signal.sdp.length > 0 &&
        signal.sdp.length <= 65536;
    const icePayload = isPlainObject(signal.candidate) ? signal.candidate : signal;
    const hasIceField = icePayload.candidate !== undefined || icePayload.sdpMid !== undefined || icePayload.sdpMLineIndex !== undefined;
    const candidateOk = icePayload.candidate === undefined || (typeof icePayload.candidate === 'string' && icePayload.candidate.length <= 8192);
    const sdpMidOk = icePayload.sdpMid === undefined || icePayload.sdpMid === null || (typeof icePayload.sdpMid === 'string' && icePayload.sdpMid.length <= 64);
    const sdpMLineOk = icePayload.sdpMLineIndex === undefined || icePayload.sdpMLineIndex === null || (Number.isInteger(icePayload.sdpMLineIndex) && icePayload.sdpMLineIndex >= 0);
    const isIce = hasIceField && candidateOk && sdpMidOk && sdpMLineOk && Boolean(icePayload.candidate || icePayload.sdpMid !== undefined || icePayload.sdpMLineIndex !== undefined);
    const isKeyframeReq = signal.type === 'request-keyframe';
    return isSdp || isIce || isKeyframeReq;
}

function registerSignalingHandlers(
    io,
    {
        rooms,
        attemptTracker,
        checkRoomRateLimiter = createCheckRoomRateLimiter(),
        env = process.env
    }
) {
    const {
        loginAttempts,
        withAttemptLock,
        getAttemptKey,
        setLoginAttempt
    } = attemptTracker;

    function leaveCurrentRoom(sock) {
        try {
            const rid = sock.roomId;
            if (rid && rooms.has(rid)) {
                const r = rooms.get(rid);
                r.members.delete(sock.id);
                if (r.userNames) r.userNames.delete(sock.id);
                const wasStreaming = r.activeStreams.has(sock.id);
                r.activeStreams.delete(sock.id);

                if (r.members.size === 0) {
                    rooms.delete(rid);
                    console.log(`[x] Room "${rid}" deleted (empty)`);
                } else {
                    if (wasStreaming) {
                        io.to(rid).emit('stream-state', {
                            senderId: sock.id,
                            state: 'stopped'
                        });
                    }
                    io.to(rid).emit('user-left', {
                        socketId: sock.id,
                        memberCount: r.members.size
                    });
                    io.to(rid).emit('room-status', {
                        memberCount: r.members.size
                    });
                }
                sock.leave(rid);
                sock.roomId = null;
            }
        } catch (err) {
            console.error(`[Error] Exception during leaveCurrentRoom for ${sock.id}:`, err.message);
        }
    }

    io.on('connection', (socket) => {
        console.log(`[+] Client connected: ${socket.id}`);

        socket.on('join-room', safeHandler(socket, 'join-room', async (data) => {
            if (!isPlainObject(data)) return;

            const reqGen = (socket._joinGen || 0) + 1;
            socket._joinGen = reqGen;
            const prevQueue = socket._joinQueue || Promise.resolve();
            const nextQueue = prevQueue.catch(() => {}).then(async () => {
                if (!socket.connected) return;

                const rawRoomId = typeof data.roomId === 'string' ? data.roomId.trim().toLowerCase() : '';
                if (!ROOM_ID_REGEX.test(rawRoomId)) {
                    socket.emit('join-error', {
                        error: 'invalid_room',
                        message: 'Nome de sala inválido. Use de 3 a 64 caracteres alfanuméricos, hífen ou underline.'
                    });
                    return;
                }
                const cleanRoomId = rawRoomId;

                if (data.password !== undefined && data.password !== null && typeof data.password !== 'string') {
                    socket.emit('join-error', {
                        error: 'invalid_password_format',
                        message: 'Formato de senha inválido.'
                    });
                    return;
                }

                if (typeof data.password === 'string' && (data.password.length > 100 || (data.password.length > 0 && data.password.trim().length === 0))) {
                    socket.emit('join-error', {
                        error: 'invalid_password_format',
                        message: data.password.length > 100
                            ? 'A senha excede o limite de 100 caracteres.'
                            : 'A senha não pode conter apenas espaços.'
                    });
                    return;
                }

                const cleanPassword = typeof data.password === 'string' ? data.password.trim() : '';
                const rawClientId = typeof data.clientId === 'string' ? sanitizeControlChars(data.clientId).trim().slice(0, 100) : null;
                const cleanUserName = typeof data.userName === 'string' ? sanitizeControlChars(data.userName).trim().slice(0, 32) : '';

                let room = rooms.get(cleanRoomId);
                const clientKey = getClientIdentifier(socket, env);
                const attemptKey = getAttemptKey(clientKey, cleanRoomId);

                let isNewRoom = false;
                if (!room) {
                    if (rooms.size >= MAX_ROOMS) {
                        socket.emit('join-error', {
                            error: 'server_busy',
                            message: 'Limite máximo de salas ativas atingido. Tente novamente em instantes.'
                        });
                        return;
                    }
                    const { hash, salt } = await hashPassword(cleanPassword);
                    if (!socket.connected || socket._joinGen !== reqGen) {
                        return;
                    }
                    room = rooms.get(cleanRoomId);
                    if (!room) {
                        if (rooms.size >= MAX_ROOMS) {
                            socket.emit('join-error', {
                                error: 'server_busy',
                                message: 'Limite máximo de salas ativas atingido. Tente novamente em instantes.'
                            });
                            return;
                        }
                        room = {
                            passwordHash: hash,
                            passwordSalt: salt,
                            members: new Map(),
                            userNames: new Map(),
                            activeStreams: new Set()
                        };
                        rooms.set(cleanRoomId, room);
                        loginAttempts.delete(attemptKey);
                        isNewRoom = true;
                    }
                }

                if (!isNewRoom && room.passwordHash) {
                    const verified = await withAttemptLock(attemptKey, async () => {
                        const now = Date.now();
                        const attemptData = loginAttempts.get(attemptKey) || { count: 0, lockedUntil: 0, lastAttempt: now };

                        if (attemptData.lockedUntil > now) {
                            const waitSeconds = Math.ceil((attemptData.lockedUntil - now) / 1000);
                            console.warn(`[Security] Bloqueio anti-força bruta ativo para ${clientKey} na sala "${cleanRoomId}". Restam ${waitSeconds}s.`);
                            if (socket.connected) {
                                socket.emit('join-error', {
                                    error: 'rate_limited',
                                    message: `Muitas tentativas incorretas. Aguarde ${waitSeconds} segundos antes de tentar novamente.`
                                });
                            }
                            return false;
                        }

                        const initialRoomRef = room;
                        const initialHash = room.passwordHash;
                        const initialSalt = room.passwordSalt;
                        const isValid = await verifyPassword(cleanPassword, initialHash, initialSalt);

                        const checkNow = Date.now();
                        const latestRoom = rooms.get(cleanRoomId);
                        if (!latestRoom) {
                            if (socket.connected) {
                                socket.emit('join-error', {
                                    error: 'room_closed',
                                    message: 'A sala foi encerrada durante a autenticação. Tente entrar novamente.'
                                });
                            }
                            return false;
                        }

                        if (latestRoom !== initialRoomRef) {
                            if (latestRoom.passwordHash !== initialHash || latestRoom.passwordSalt !== initialSalt) {
                                if (socket.connected) {
                                    socket.emit('join-error', {
                                        error: 'invalid_password',
                                        message: 'A sala foi recriada durante a entrada. Tente novamente.'
                                    });
                                }
                                return false;
                            }
                            room = latestRoom;
                        }

                        if (!isValid) {
                            attemptData.count += 1;
                            attemptData.lastAttempt = checkNow;

                            if (attemptData.count >= 5) {
                                const penaltySeconds = attemptData.count >= 10 ? 120 : (attemptData.count >= 7 ? 60 : 30);
                                attemptData.lockedUntil = checkNow + (penaltySeconds * 1000);
                                setLoginAttempt(attemptKey, attemptData, checkNow);

                                if (!socket.connected) return false;
                                console.warn(`[Security] Bloqueando ${clientKey} na sala "${cleanRoomId}" por ${penaltySeconds}s após ${attemptData.count} tentativas falhas.`);
                                socket.emit('join-error', {
                                    error: 'rate_limited',
                                    message: `Muitas tentativas incorretas. Bloqueado por ${penaltySeconds} segundos.`
                                });
                                return false;
                            }

                            setLoginAttempt(attemptKey, attemptData, checkNow);
                            if (!socket.connected) return false;
                            const remaining = 5 - attemptData.count;
                            console.log(`[Auth] Rejected socket ${socket.id} for room "${cleanRoomId}": Invalid password (${remaining} tentativas restantes)`);
                            socket.emit('join-error', {
                                error: 'invalid_password',
                                message: `Senha incorreta. ${remaining} tentativa(s) restante(s) antes do bloqueio.`
                            });
                            return false;
                        }

                        loginAttempts.delete(attemptKey);
                        return true;
                    });

                    if (!verified) {
                        return;
                    }
                }

                if (!socket.connected || socket._joinGen !== reqGen) {
                    if (isNewRoom && room.members.size === 0) {
                        rooms.delete(cleanRoomId);
                    }
                    return;
                }

                const currentRoom = rooms.get(cleanRoomId);
                if (currentRoom) {
                    room = currentRoom;
                }

                const clientId = (rawClientId && !io.sockets.sockets.has(rawClientId) && !room.members.has(rawClientId))
                    ? rawClientId
                    : null;

                const alreadyMember = socket.roomId === cleanRoomId && room.members.has(socket.id);
                let evictableCount = 0;
                if (clientId) {
                    for (const [existingSocketId, existingClientId] of room.members.entries()) {
                        if (existingClientId && existingClientId === clientId && existingSocketId !== socket.id) {
                            evictableCount += 1;
                        }
                    }
                }
                if (!alreadyMember && (room.members.size - evictableCount) >= MAX_MEMBERS_PER_ROOM) {
                    socket.emit('join-error', {
                        error: 'room_full',
                        message: 'A sala atingiu o limite máximo de participantes.'
                    });
                    return;
                }

                if (socket.roomId && socket.roomId !== cleanRoomId) {
                    leaveCurrentRoom(socket);
                }

                if (clientId) {
                    for (const [existingSocketId, existingClientId] of room.members.entries()) {
                        if (existingClientId && existingClientId === clientId && existingSocketId !== socket.id) {
                            console.log(`[Evict] Replacing stale socket ${existingSocketId} with new socket ${socket.id} for client ${clientId}`);
                            const oldSocket = io.sockets.sockets.get(existingSocketId);
                            if (oldSocket) {
                                leaveCurrentRoom(oldSocket);
                                try { oldSocket.disconnect(true); } catch (_) {}
                            } else {
                                room.members.delete(existingSocketId);
                                if (room.userNames) room.userNames.delete(existingSocketId);
                                const hadStream = room.activeStreams.delete(existingSocketId);
                                if (hadStream) {
                                    io.to(cleanRoomId).emit('stream-state', {
                                        senderId: existingSocketId,
                                        state: 'stopped'
                                    });
                                }
                                io.to(cleanRoomId).emit('user-left', {
                                    socketId: existingSocketId,
                                    memberCount: room.members.size
                                });
                                io.to(cleanRoomId).emit('room-status', {
                                    memberCount: room.members.size
                                });
                            }
                        }
                    }
                }

                if (!rooms.has(cleanRoomId)) {
                    rooms.set(cleanRoomId, room);
                }

                socket.join(cleanRoomId);
                socket.roomId = cleanRoomId;
                const displayName = cleanUserName || `Participante ${socket.id.substr(0, 5)}`;
                room.members.set(socket.id, clientId);
                if (!room.userNames) room.userNames = new Map();
                room.userNames.set(socket.id, displayName);

                const otherUsers = Array.from(room.members.keys()).filter((id) => id !== socket.id);
                const activeStreams = Array.from(room.activeStreams).filter((id) => id !== socket.id);

                console.log(`[->] Socket ${socket.id} joined room "${cleanRoomId}" as "${displayName}" (Members: ${room.members.size})`);

                socket.emit('room-users', {
                    users: otherUsers,
                    userNames: Object.fromEntries(room.userNames),
                    activeStreams,
                    socketId: socket.id,
                    memberCount: room.members.size,
                    hasPassword: Boolean(room.passwordHash)
                });

                if (!alreadyMember) {
                    socket.to(cleanRoomId).emit('user-joined', {
                        socketId: socket.id,
                        userName: displayName,
                        memberCount: room.members.size
                    });
                }

                io.to(cleanRoomId).emit('room-status', {
                    memberCount: room.members.size
                });
            });
            socket._joinQueue = nextQueue;
            return nextQueue;
        }));

        socket.on('check-room', safeHandler(socket, 'check-room', (data, callback) => {
            if (typeof callback !== 'function') return;

            const clientKey = getClientIdentifier(socket, env);
            if (checkRoomRateLimiter && !checkRoomRateLimiter.check(clientKey)) {
                return callback({
                    exists: false,
                    memberCount: 0,
                    hasPassword: false,
                    error: 'rate_limited',
                    message: 'Muitas consultas de sala. Aguarde alguns instantes.'
                });
            }

            if (!isPlainObject(data) || typeof data.roomId !== 'string' || !ROOM_ID_REGEX.test(data.roomId.trim().toLowerCase())) {
                return callback({
                    exists: false,
                    memberCount: 0,
                    hasPassword: false
                });
            }

            const cleanRoomId = data.roomId.trim().toLowerCase();
            const room = rooms.get(cleanRoomId);
            callback({
                exists: Boolean(room && room.members.size > 0),
                memberCount: room ? room.members.size : 0,
                hasPassword: Boolean(room && room.passwordHash)
            });
        }));

        socket.on('signal', safeHandler(socket, 'signal', (data) => {
            if (!isPlainObject(data)) return;
            const targetId = typeof data.targetId === 'string' ? data.targetId.trim() : null;
            if (!targetId || targetId === socket.id || !isValidSignal(data.signal)) return;

            const senderRoom = socket.roomId;
            if (!senderRoom) return;

            const targetSocket = io.sockets.sockets.get(targetId);
            if (!targetSocket || targetSocket.roomId !== senderRoom) {
                return;
            }

            io.to(targetId).emit('signal', {
                senderId: socket.id,
                signal: data.signal
            });
        }));

        socket.on('stream-state', safeHandler(socket, 'stream-state', (data) => {
            if (!isPlainObject(data)) return;
            if (data.state !== 'started' && data.state !== 'stopped') return;

            const senderRoom = socket.roomId;
            if (!senderRoom) return;

            const room = rooms.get(senderRoom);
            if (!room) return;

            if (data.state === 'started') {
                room.activeStreams.add(socket.id);
            } else {
                room.activeStreams.delete(socket.id);
            }

            socket.to(senderRoom).emit('stream-state', {
                senderId: socket.id,
                state: data.state
            });
        }));

        socket.on('disconnect', () => {
            console.log(`[-] Client disconnected: ${socket.id}`);
            leaveCurrentRoom(socket);
        });
    });
}

module.exports = {
    ROOM_ID_REGEX,
    MAX_ROOMS,
    MAX_MEMBERS_PER_ROOM,
    isPlainObject,
    sanitizeControlChars,
    isValidSignal,
    registerSignalingHandlers
};

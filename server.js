const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const { scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(scrypt);

// Cryptographic Password Hashing & Safe Verification (scrypt + random 16-byte salt)
async function hashPassword(password) {
    if (typeof password !== 'string' || !password) {
        return { hash: null, salt: null };
    }
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 32);
    return { hash, salt };
}

async function verifyPassword(password, storedHash, storedSalt) {
    if (typeof password !== 'string' || !password || !Buffer.isBuffer(storedHash) || !Buffer.isBuffer(storedSalt)) {
        return false;
    }
    try {
        const derivedKey = await scryptAsync(password, storedSalt, storedHash.length);
        return timingSafeEqual(derivedKey, storedHash);
    } catch (_) {
        return false;
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingInterval: 5000,
    pingTimeout: 7000,
    maxHttpBufferSize: 1e5 // 100 KB max payload size
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route to ensure index.html is always served
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active rooms and members
const rooms = new Map();

// Anti-Brute Force Protection for Password-Protected Rooms
// Key: client IP or socket ID -> { count: number, lockedUntil: number, lastAttempt: number }
const loginAttempts = new Map();

// Validation and sanitization helpers
const ROOM_ID_REGEX = /^[a-z0-9_-]{3,64}$/;

function isPlainObject(obj) {
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

function isValidSignal(signal) {
    if (!isPlainObject(signal)) return false;
    const isSdp = typeof signal.type === 'string' && (signal.type === 'offer' || signal.type === 'answer') && typeof signal.sdp === 'string';
    const isIce = Boolean(signal.candidate || signal.sdpMid !== undefined || signal.sdpMLineIndex !== undefined);
    return isSdp || isIce;
}

function checkRateLimit(socket, eventName, windowMs = 1000) {
    const now = Date.now();
    if (!socket._rateLimit) {
        socket._rateLimit = new Map();
    }
    let tracker = socket._rateLimit.get(eventName);
    if (!tracker || now > tracker.resetAt) {
        tracker = { count: 0, resetAt: now + windowMs };
        socket._rateLimit.set(eventName, tracker);
    }
    tracker.count += 1;
    // Permite maior vazão para rajadas de candidatos ICE no WebRTC Mesh (até 250/s)
    const maxEvents = eventName === 'signal' ? 250 : 50;
    return tracker.count <= maxEvents;
}

function safeHandler(socket, eventName, handler) {
    return async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        const payload = args[0];

        if (!checkRateLimit(socket, eventName)) {
            if (typeof ack === 'function') {
                try { ack({ error: 'rate_limited' }); } catch (_) {}
            }
            return;
        }

        try {
            await Promise.resolve(handler(payload, ack));
        } catch (err) {
            if (!socket._errorLogCount) socket._errorLogCount = 0;
            if (socket._errorLogCount < 5) {
                console.warn(`[Security/Error] Exception in "${eventName}" from ${socket.id}:`, err.message);
                socket._errorLogCount++;
            }
            if (typeof ack === 'function') {
                try { ack({ error: 'server_error' }); } catch (_) {}
            }
            socket.emit('server-error', {
                event: eventName,
                message: 'Invalid payload or server error.'
            });
        }
    };
}

function getClientIdentifier(socket) {
    const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';

    if (trustProxy) {
        const forwarded = socket.handshake.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim()) {
            const parts = forwarded.split(',');
            // Extrai o IP anexado pelo proxy confiável de borda (mais à direita)
            const safeIp = parts[parts.length - 1].trim().replace(/^::ffff:/, '');
            if (safeIp) return safeIp;
        }
    }

    // Padrão seguro: utiliza o endereço da conexão física do socket
    const rawAddress = socket.handshake.address;
    if (typeof rawAddress === 'string' && rawAddress.trim()) {
        return rawAddress.trim().replace(/^::ffff:/, '');
    }

    return socket.id;
}

// Limpeza periódica da memória a cada 10 minutos
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of loginAttempts.entries()) {
        if (now > data.lockedUntil && (now - data.lastAttempt > 600000)) {
            loginAttempts.delete(key);
        }
    }
}, 600000);

io.on('connection', (socket) => {
    console.log(`[+] Client connected: ${socket.id}`);

    socket.on('join-room', safeHandler(socket, 'join-room', async (data) => {
        if (!isPlainObject(data)) return;

        const rawRoomId = typeof data.roomId === 'string' ? data.roomId.trim().toLowerCase() : '';
        if (!ROOM_ID_REGEX.test(rawRoomId)) {
            socket.emit('join-error', {
                error: 'invalid_room',
                message: 'Nome de sala inválido. Use de 3 a 64 caracteres alfanuméricos, hífen ou underline.'
            });
            return;
        }
        const cleanRoomId = rawRoomId;

        // Password format validation: reject if provided and not string
        if (data.password !== undefined && data.password !== null && typeof data.password !== 'string') {
            socket.emit('join-error', {
                error: 'invalid_password_format',
                message: 'Formato de senha inválido.'
            });
            return;
        }

        if (typeof data.password === 'string' && data.password.length > 100) {
            socket.emit('join-error', {
                error: 'invalid_password_format',
                message: 'A senha excede o limite de 100 caracteres.'
            });
            return;
        }

        const cleanPassword = typeof data.password === 'string' ? data.password.trim() : '';
        const clientId = typeof data.clientId === 'string' ? data.clientId.trim().slice(0, 100) : null;
        const cleanUserName = typeof data.userName === 'string' ? data.userName.trim().slice(0, 32) : '';

        let room = rooms.get(cleanRoomId);
        const clientKey = getClientIdentifier(socket);
        const now = Date.now();
        const attemptData = loginAttempts.get(clientKey) || { count: 0, lockedUntil: 0, lastAttempt: now };

        // Verifica se o IP/Cliente está temporariamente bloqueado por força bruta
        if (attemptData.lockedUntil > now) {
            const waitSeconds = Math.ceil((attemptData.lockedUntil - now) / 1000);
            console.warn(`[Security] Bloqueio anti-força bruta ativo para ${clientKey}. Restam ${waitSeconds}s.`);
            socket.emit('join-error', {
                error: 'rate_limited',
                message: `Muitas tentativas incorretas. Aguarde ${waitSeconds} segundos antes de tentar novamente.`
            });
            return;
        }

        let isNewRoom = false;
        if (!room) {
            const { hash, salt } = await hashPassword(cleanPassword);
            room = rooms.get(cleanRoomId);
            if (!room) {
                room = {
                    passwordHash: hash,
                    passwordSalt: salt,
                    members: new Map(), // socketId -> clientId
                    userNames: new Map(), // socketId -> userName
                    activeStreams: new Set()
                };
                rooms.set(cleanRoomId, room);
                loginAttempts.delete(clientKey);
                isNewRoom = true;
            }
        }

        if (!isNewRoom && room.passwordHash) {
            // Password-protected room check via constant-time verification
            const isValid = await verifyPassword(cleanPassword, room.passwordHash, room.passwordSalt);
            if (!isValid) {
                attemptData.count += 1;
                attemptData.lastAttempt = now;

                // Penalidade progressiva após 5 tentativas incorretas
                if (attemptData.count >= 5) {
                    const penaltySeconds = attemptData.count >= 10 ? 120 : (attemptData.count >= 7 ? 60 : 30);
                    attemptData.lockedUntil = now + (penaltySeconds * 1000);
                    loginAttempts.set(clientKey, attemptData);

                    console.warn(`[Security] Bloqueando ${clientKey} por ${penaltySeconds}s após ${attemptData.count} tentativas falhas.`);
                    socket.emit('join-error', {
                        error: 'rate_limited',
                        message: `Muitas tentativas incorretas. Bloqueado por ${penaltySeconds} segundos.`
                    });
                    return;
                }

                loginAttempts.set(clientKey, attemptData);
                const remaining = 5 - attemptData.count;
                console.log(`[Auth] Rejected socket ${socket.id} for room "${cleanRoomId}": Invalid password (${remaining} tentativas restantes)`);
                socket.emit('join-error', {
                    error: 'invalid_password',
                    message: `Senha incorreta. ${remaining} tentativa(s) restante(s) antes do bloqueio.`
                });
                return;
            }

            // Senha correta: limpa registro de falhas
            loginAttempts.delete(clientKey);
        }

        // Leave any previous room
        if (socket.roomId && socket.roomId !== cleanRoomId) {
            leaveCurrentRoom(socket);
        }

        // Evict stale/ghost socket if this client refreshed (F5) or reconnected
        if (clientId) {
            for (const [existingSocketId, existingClientId] of room.members.entries()) {
                if (existingClientId === clientId && existingSocketId !== socket.id) {
                    console.log(`[Evict] Replacing stale socket ${existingSocketId} with new socket ${socket.id} for client ${clientId}`);
                    const oldSocket = io.sockets.sockets.get(existingSocketId);
                    if (oldSocket) {
                        leaveCurrentRoom(oldSocket);
                        try { oldSocket.disconnect(true); } catch(e) {}
                    } else {
                        room.members.delete(existingSocketId);
                        room.activeStreams.delete(existingSocketId);
                    }
                }
            }
        }

        // Re-register room in Map if eviction of sole member triggered room deletion
        if (!rooms.has(cleanRoomId)) {
            rooms.set(cleanRoomId, room);
        }

        socket.join(cleanRoomId);
        socket.roomId = cleanRoomId;
        const displayName = cleanUserName || `Participante ${socket.id.substr(0, 5)}`;
        room.members.set(socket.id, clientId || socket.id);
        if (!room.userNames) room.userNames = new Map();
        room.userNames.set(socket.id, displayName);

        const otherUsers = Array.from(room.members.keys()).filter(id => id !== socket.id);
        const activeStreams = Array.from(room.activeStreams).filter(id => id !== socket.id);

        console.log(`[->] Socket ${socket.id} joined room "${cleanRoomId}" as "${displayName}" (Members: ${room.members.size})`);

        // Send existing room members and active streamers to new user
        socket.emit('room-users', {
            users: otherUsers,
            userNames: Object.fromEntries(room.userNames),
            activeStreams: activeStreams,
            socketId: socket.id,
            memberCount: room.members.size,
            hasPassword: Boolean(room.passwordHash)
        });

        // Notify existing members about new user
        socket.to(cleanRoomId).emit('user-joined', {
            socketId: socket.id,
            userName: displayName,
            memberCount: room.members.size
        });

        // Broadcast updated room member count to all
        io.to(cleanRoomId).emit('room-status', {
            memberCount: room.members.size
        });
    }));

    // Check room existence, member count & password requirement
    socket.on('check-room', safeHandler(socket, 'check-room', (data, callback) => {
        if (typeof callback !== 'function') return;

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

    // Targeted WebRTC Signal Relay (Peer-to-Peer Mesh with Room Isolation)
    socket.on('signal', safeHandler(socket, 'signal', (data) => {
        if (!isPlainObject(data)) return;
        const targetId = typeof data.targetId === 'string' ? data.targetId.trim() : null;
        if (!targetId || !isValidSignal(data.signal)) return;

        const senderRoom = socket.roomId;
        if (!senderRoom) return;

        // Security & Isolation: Verify target socket exists AND is in the EXACT same room
        const targetSocket = io.sockets.sockets.get(targetId);
        if (!targetSocket || targetSocket.roomId !== senderRoom) {
            // Drop signal if sender and target are in different rooms
            return;
        }

        io.to(targetId).emit('signal', {
            senderId: socket.id,
            signal: data.signal
        });
    }));

    // Broadcast stream state changes (strictly isolated to socket's authenticated room)
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

    socket.on('disconnect', safeHandler(socket, 'disconnect', () => {
        console.log(`[-] Client disconnected: ${socket.id}`);
        leaveCurrentRoom(socket);
    }));

});

// Utility to get local network IP
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    server.listen(PORT, () => {
        const localIp = getLocalIp();
        console.log(`\n==================================================`);
        console.log(`  🖥️ StreamGrid Multi-Screenshare rodando!`);
        console.log(`  Local:   http://localhost:${PORT}`);
        console.log(`  Rede:    http://${localIp}:${PORT}`);
        console.log(`==================================================\n`);
    });
}

module.exports = {
    app,
    server,
    io,
    rooms,
    hashPassword,
    verifyPassword
};

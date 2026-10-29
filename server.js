const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingInterval: 5000,
    pingTimeout: 7000
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
// Key: client IP or socket ID -> { count: number, lockedUntil: number }
const loginAttempts = new Map();

function getClientIdentifier(socket) {
    // Captura IP real considerando proxies reversos como Cloudflare / Render
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address || socket.id;
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

    socket.on('join-room', ({ roomId, clientId, password }) => {
        const cleanRoomId = (roomId || '').trim().toLowerCase();
        if (!cleanRoomId) return;

        let room = rooms.get(cleanRoomId);
        const cleanPassword = (password || '').trim();

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

        if (!room) {
            room = {
                password: cleanPassword || null,
                members: new Map(), // socketId -> clientId
                activeStreams: new Set()
            };
            rooms.set(cleanRoomId, room);
            loginAttempts.delete(clientKey);
        } else if (room.password) {
            // Password-protected room check
            if (room.password !== cleanPassword) {
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

        socket.join(cleanRoomId);
        socket.roomId = cleanRoomId;
        room.members.set(socket.id, clientId || socket.id);

        const otherUsers = Array.from(room.members.keys()).filter(id => id !== socket.id);
        const activeStreams = Array.from(room.activeStreams).filter(id => id !== socket.id);

        console.log(`[->] Socket ${socket.id} joined room "${cleanRoomId}" (Members: ${room.members.size})`);

        // Send existing room members and active streamers to new user
        socket.emit('room-users', {
            users: otherUsers,
            activeStreams: activeStreams,
            socketId: socket.id,
            memberCount: room.members.size,
            hasPassword: Boolean(room.password)
        });

        // Notify existing members about new user
        socket.to(cleanRoomId).emit('user-joined', {
            socketId: socket.id,
            memberCount: room.members.size
        });

        // Broadcast updated room member count to all
        io.to(cleanRoomId).emit('room-status', {
            memberCount: room.members.size
        });
    });

    // Check room existence, member count & password requirement
    socket.on('check-room', ({ roomId }, callback) => {
        const cleanRoomId = (roomId || '').trim().toLowerCase();
        const room = rooms.get(cleanRoomId);
        if (typeof callback === 'function') {
            callback({
                exists: Boolean(room && room.members.size > 0),
                memberCount: room ? room.members.size : 0,
                hasPassword: Boolean(room && room.password)
            });
        }
    });

    // Targeted WebRTC Signal Relay (Peer-to-Peer Mesh with Room Isolation)
    socket.on('signal', ({ targetId, signal }) => {
        if (!targetId || !signal) return;
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
            signal
        });
    });

    // Broadcast stream state changes (started/stopped screen share)
    socket.on('stream-state', ({ roomId, state }) => {
        const cleanRoomId = (roomId || socket.roomId || '').trim().toLowerCase();
        const room = rooms.get(cleanRoomId);
        if (room) {
            if (state === 'started') {
                room.activeStreams.add(socket.id);
            } else {
                room.activeStreams.delete(socket.id);
            }
        }
        socket.to(cleanRoomId).emit('stream-state', {
            senderId: socket.id,
            state
        });
    });

    function leaveCurrentRoom(sock) {
        const rid = sock.roomId;
        if (rid && rooms.has(rid)) {
            const r = rooms.get(rid);
            r.members.delete(sock.id);
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
    }

    socket.on('disconnect', () => {
        console.log(`[-] Client disconnected: ${socket.id}`);
        leaveCurrentRoom(socket);
    });

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
server.listen(PORT, () => {
    const localIp = getLocalIp();
    console.log(`\n==================================================`);
    console.log(`  🖥️ StreamGrid Multi-Screenshare rodando!`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Rede:    http://${localIp}:${PORT}`);
    console.log(`==================================================\n`);
});

const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { createServerApp } = require('../../server.js');

async function startTestServer(options = {}) {
    const appCtx = createServerApp(options);
    const { server, io, stopCleanupTimer } = appCtx;
    const sockets = new Set();

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    function connectClient(socketOptions = {}) {
        const client = ioClient(baseUrl, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
            ...socketOptions
        });
        sockets.add(client);
        return new Promise((resolve, reject) => {
            const onConnect = () => {
                cleanupListeners();
                resolve(client);
            };
            const onError = (err) => {
                cleanupListeners();
                reject(err);
            };
            const cleanupListeners = () => {
                client.off('connect', onConnect);
                client.off('connect_error', onError);
            };
            client.once('connect', onConnect);
            client.once('connect_error', onError);
        });
    }

    async function close() {
        for (const client of sockets) {
            try { client.disconnect(); } catch (_) {}
        }
        sockets.clear();
        stopCleanupTimer();
        await new Promise((resolve) => io.close(() => resolve()));
        if (server.listening) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }

    return {
        ...appCtx,
        port,
        baseUrl,
        connectClient,
        close
    };
}

function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {} }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(socket, event, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, onEvent);
            reject(new Error(`Timeout waiting for "${event}"`));
        }, timeoutMs);
        const onEvent = (payload) => {
            clearTimeout(timer);
            resolve(payload);
        };
        socket.once(event, onEvent);
    });
}

function tryJoin(socket, roomId, password = '', clientId = null, userName = null, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting join response for room "${roomId}"`));
        }, timeoutMs);

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

function checkRoom(socket, roomId, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`Timeout on check-room "${roomId}"`));
            }
        }, timeoutMs);
        socket.emit('check-room', { roomId }, (res) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(res);
            }
        });
    });
}

module.exports = {
    startTestServer,
    httpRequest,
    delay,
    waitForEvent,
    tryJoin,
    checkRoom
};

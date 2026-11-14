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

module.exports = {
    startTestServer,
    httpRequest
};

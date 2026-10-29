const { spawn } = require('child_process');
const path = require('path');
const ioClient = require('socket.io-client');
const assert = require('assert');

let currentPort = 41200;
function getNextPort() {
    currentPort += 1;
    return currentPort;
}

class TestServer {
    constructor(port = getNextPort(), envOverrides = {}) {
        this.port = port;
        this.url = `http://localhost:${this.port}`;
        this.process = null;
        this.envOverrides = envOverrides;
    }

    start() {
        return new Promise((resolve, reject) => {
            this.process = spawn('node', [path.resolve(__dirname, '../server.js')], {
                env: { ...process.env, PORT: String(this.port), ...this.envOverrides },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let isResolved = false;
            const timer = setTimeout(() => {
                if (!isResolved) {
                    reject(new Error(`Server startup timeout on port ${this.port}`));
                }
            }, 6000);

            this.process.stdout.on('data', data => {
                const str = data.toString();
                if (!isResolved && str.includes(`http://localhost:${this.port}`)) {
                    isResolved = true;
                    clearTimeout(timer);
                    resolve();
                }
            });

            this.process.on('error', err => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    stop() {
        if (this.process && !this.process.killed) {
            try { this.process.kill('SIGINT'); } catch (_) {}
        }
    }
}

function connectSocket(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const socket = ioClient(url, {
            extraHeaders,
            transports: ['websocket', 'polling'],
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

        socket.on('connect_error', err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function tryJoin(socket, roomId, password) {
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

        socket.emit('join-room', { roomId, password });
    });
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: RATE LIMIT POR IP & CABEÇALHOS PROXY');
    console.log('===============================================================\n');

    let failures = 0;

    // Teste 1: Padrão sem TRUST_PROXY (Ignora X-Forwarded-For forjado e bloqueia na 5ª tentativa)
    const serverDefault = new TestServer();
    try {
        await serverDefault.start();
        process.stdout.write('  [Teste] T1: Rate limit bloqueia força bruta mesmo com X-Forwarded-For forjado ... ');

        // Cria a sala protegida com o criador
        const ownerSocket = await connectSocket(serverDefault.url);
        const createRes = await tryJoin(ownerSocket, 'sala-protegida', 'senha-correta');
        assert.strictEqual(createRes.status, 'joined', 'Criador deveria conseguir criar a sala');

        // Atacante tenta 5 vezes com headers forjados diferentes
        let lastResult = null;
        for (let i = 1; i <= 5; i++) {
            const forgedIp = `198.51.100.${i}`;
            const attackerSocket = await connectSocket(serverDefault.url, { 'x-forwarded-for': forgedIp });
            const res = await tryJoin(attackerSocket, 'sala-protegida', `senha-errada-${i}`);
            attackerSocket.disconnect();
            lastResult = res;
        }

        ownerSocket.disconnect();

        // Na 5ª tentativa, com a proteção correta, o servidor deve responder com rate_limited
        assert.strictEqual(lastResult.status, 'error', 'Tentativa deveria retornar erro');
        assert.strictEqual(
            lastResult.data.error,
            'rate_limited',
            `Na 5ª tentativa o erro deveria ser "rate_limited", mas foi "${lastResult.data.error}". O servidor confiou no header forjado!`
        );

        console.log('PASSOU (Atacante bloqueado com rate_limited)');
    } catch (err) {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe:', err.message);
    } finally {
        serverDefault.stop();
    }

    // Teste 2: TRUST_PROXY=true (Permite identificação quando explicitamente habilitado e defende contra injeção de múltiplos IPs)
    const serverProxy = new TestServer(getNextPort(), { TRUST_PROXY: 'true' });
    try {
        await serverProxy.start();
        process.stdout.write('  [Teste] T2: Com TRUST_PROXY=true, proxy upstream é seguro contra IP injection ... ');

        const ownerSocket = await connectSocket(serverProxy.url);
        await tryJoin(ownerSocket, 'sala-proxy', 'senha-correta');

        // Simula atacante tentando injetar IPs forjados à esquerda, enquanto o proxy reverso anexou o IP real à direita
        let lastResult = null;
        for (let i = 1; i <= 5; i++) {
            const injectedChain = `10.0.0.${i}, 203.0.113.88`;
            const attackerSocket = await connectSocket(serverProxy.url, { 'x-forwarded-for': injectedChain });
            const res = await tryJoin(attackerSocket, 'sala-proxy', `senha-errada-${i}`);
            attackerSocket.disconnect();
            lastResult = res;
        }

        ownerSocket.disconnect();

        assert.strictEqual(lastResult.status, 'error');
        assert.strictEqual(
            lastResult.data.error,
            'rate_limited',
            `Deveria bloquear por rate_limited atribuindo ao IP real anexado pelo proxy à direita`
        );

        console.log('PASSOU (Rate limit funcional e seguro através de proxy)');
    } catch (err) {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe:', err.message);
    } finally {
        serverProxy.stop();
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ Resultado: ${failures} falhas encontradas.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests();

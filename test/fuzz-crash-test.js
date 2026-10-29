const { spawn, execSync } = require('child_process');
const { io } = require('socket.io-client');
const path = require('path');

let currentPort = 39890;

function getNextPort() {
    currentPort += 1;
    return currentPort;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Logic mirror of public/app.js sanitizeRoomId for pure unit testing
function sanitizeRoomId(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .trim()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-+/g, '-')
        .slice(0, 64);
}

class TestServer {
    constructor(port = getNextPort()) {
        this.port = port;
        this.url = `http://localhost:${this.port}`;
        this.process = null;
        this.exited = false;
        this.exitCode = null;
        this.exitSignal = null;
        this.stderr = '';
        this.stdout = '';
    }

    start() {
        return new Promise((resolve, reject) => {
            this.exited = false;
            this.exitCode = null;
            this.exitSignal = null;
            this.stderr = '';
            this.stdout = '';

            this.process = spawn('node', [path.resolve(__dirname, '../server.js')], {
                env: { ...process.env, PORT: String(this.port) },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let isResolved = false;

            const checkReady = (str) => {
                if (!isResolved && str.includes(`http://localhost:${this.port}`)) {
                    isResolved = true;
                    resolve();
                }
            };

            this.process.stdout.on('data', data => {
                const str = data.toString();
                this.stdout += str;
                checkReady(str);
            });

            this.process.stderr.on('data', data => {
                this.stderr += data.toString();
            });

            this.process.on('exit', (code, signal) => {
                this.exited = true;
                this.exitCode = code;
                this.exitSignal = signal;
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`Server exited prematurely with code ${code}`));
                }
            });

            this.process.on('error', err => {
                if (!isResolved) {
                    isResolved = true;
                    reject(err);
                }
            });

            setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    resolve();
                }
            }, 5000);
        });
    }

    stop() {
        if (this.process && !this.exited) {
            try {
                if (process.platform === 'win32') {
                    execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: 'ignore' });
                } else {
                    this.process.kill('SIGKILL');
                }
            } catch (_) {}
            this.exited = true;
        }
    }
}

function createClient(serverUrl) {
    return io(serverUrl, {
        transports: ['websocket', 'polling'],
        forceNew: true,
        reconnection: false,
        timeout: 4000
    });
}

function waitForConnect(socket, timeout = 4000) {
    return new Promise((resolve, reject) => {
        if (socket.connected) return resolve();
        const timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
        socket.once('connect', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('connect_error', err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function runCrashTest(testName, payloadFn) {
    process.stdout.write(`  [Teste] ${testName} ... `);
    const server = new TestServer();
    try {
        await server.start();
    } catch (err) {
        console.log(`\x1b[31mERRO AO INICIAR SERVIDOR (${err.message})\x1b[0m`);
        return { passed: false, crashed: false };
    }

    const socket = createClient(server.url);
    try {
        await waitForConnect(socket);
    } catch (err) {
        server.stop();
        console.log(`\x1b[31mFALHA AO CONECTAR (${err.message})\x1b[0m`);
        return { passed: false, crashed: false };
    }

    payloadFn(socket);

    await sleep(400);
    try { socket.disconnect(); } catch (_) {}

    const crashed = server.exited;
    const stderrSummary = server.stderr.split('\n').map(s => s.trim()).filter(Boolean).slice(-3).join(' ') || '';

    if (crashed) {
        console.log(`\x1b[31mCRASH DETECTADO (Exit Code: ${server.exitCode})\x1b[0m`);
        if (stderrSummary) {
            console.log(`         \x1b[33m└─ Detalhe: ${stderrSummary.slice(0, 140)}...\x1b[0m`);
        }
    } else {
        console.log(`\x1b[32mSOBREVIVEU (Sem crash)\x1b[0m`);
    }

    server.stop();
    await sleep(150);
    return { passed: !crashed, crashed, stderr: server.stderr };
}

async function runPasswordTypeCheckTest() {
    process.stdout.write(`  [Teste] T4-ASSERT: { password: true } responde com invalid_password_format ... `);
    const server = new TestServer();
    await server.start();
    const socket = createClient(server.url);

    try {
        await waitForConnect(socket);

        const result = await new Promise(resolve => {
            socket.once('join-error', data => resolve({ status: 'error', data }));
            socket.once('room-users', data => resolve({ status: 'joined', data }));
            setTimeout(() => resolve({ status: 'timeout' }), 1500);
            socket.emit('join-room', { roomId: 'sala-teste', password: true });
        });

        socket.disconnect();
        server.stop();

        if (result.status === 'error' && result.data?.error === 'invalid_password_format') {
            console.log(`\x1b[32mPASSOU (Rejeição explícita: invalid_password_format)\x1b[0m`);
            return { passed: true };
        } else {
            console.log(`\x1b[31mFALHOU (${JSON.stringify(result)})\x1b[0m`);
            return { passed: false };
        }
    } catch (err) {
        server.stop();
        console.log(`\x1b[31mERRO (${err.message})\x1b[0m`);
        return { passed: false };
    }
}

async function runSignalRelayTest() {
    process.stdout.write(`  [Teste] T-SIGNAL: Relay de SDP válido vs descarte de sinal inválido ... `);
    const server = new TestServer();
    await server.start();

    const socketA = createClient(server.url);
    const socketB = createClient(server.url);

    try {
        await waitForConnect(socketA);
        await waitForConnect(socketB);

        socketA.emit('join-room', { roomId: 'sala-signal' });
        socketB.emit('join-room', { roomId: 'sala-signal' });
        await sleep(350);

        let receivedSignals = [];
        socketB.on('signal', data => {
            receivedSignals.push(data.signal);
        });

        // 1. Envia sinal inválido (lixo / tipo errado)
        socketA.emit('signal', { targetId: socketB.id, signal: 'not-an-object' });
        socketA.emit('signal', { targetId: socketB.id, signal: { foo: 'bar' } });
        await sleep(200);

        // 2. Envia sinal válido (SDP offer)
        const validSdp = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
        socketA.emit('signal', { targetId: socketB.id, signal: validSdp });
        await sleep(350);

        socketA.disconnect();
        socketB.disconnect();
        server.stop();

        if (receivedSignals.length === 1 && receivedSignals[0].type === 'offer') {
            console.log(`\x1b[32mPASSOU (Apenas SDP legítimo foi retransmitido; sinais inválidos descartados)\x1b[0m`);
            return { passed: true };
        } else {
            console.log(`\x1b[31mFALHOU (Sinais recebidos: ${receivedSignals.length})\x1b[0m`);
            return { passed: false };
        }
    } catch (err) {
        server.stop();
        console.log(`\x1b[31mERRO (${err.message})\x1b[0m`);
        return { passed: false };
    }
}

async function runSanitizeRoomIdUnitTest() {
    process.stdout.write(`  [Teste] T-UNIT: Sanitização pura de sanitizeRoomId (acentos, emojis, limites) ... `);
    const cases = [
        { input: 'Sala do João', expected: 'sala-do-joao' },
        { input: 'quarto #1 👍 . teste', expected: 'quarto-1-teste' },
        { input: '???', expected: '' },
        { input: 'a'.repeat(80), expected: 'a'.repeat(64) },
        { input: '  SALA---TESTE  ', expected: 'sala-teste' }
    ];

    let allPass = true;
    for (const c of cases) {
        const out = sanitizeRoomId(c.input);
        if (out !== c.expected) {
            allPass = false;
            console.log(`\x1b[31mFALHOU no input "${c.input}" -> recebido "${out}" != esperado "${c.expected}"\x1b[0m`);
            return { passed: false };
        }
    }

    console.log(`\x1b[32mPASSOU (Todos os casos de normalização validados)\x1b[0m`);
    return { passed: true };
}

async function runCheckRoomAckTest() {
    process.stdout.write(`  [Teste] T8-ACK: check-room sem payload preserva o callback de ack ... `);
    const server = new TestServer();
    await server.start();
    const socket = createClient(server.url);

    try {
        await waitForConnect(socket);

        const ackReceived = await new Promise(resolve => {
            const timer = setTimeout(() => resolve({ status: 'timeout' }), 1500);
            socket.emit('check-room', (res) => {
                clearTimeout(timer);
                resolve({ status: 'ack', res });
            });
        });

        socket.disconnect();
        server.stop();

        if (ackReceived.status === 'ack') {
            console.log(`\x1b[32mPASSOU (Ack retornado: exists=${ackReceived.res?.exists})\x1b[0m`);
            return { passed: true };
        } else {
            console.log(`\x1b[31mFALHOU (Callback pendurado / timeout)\x1b[0m`);
            return { passed: false };
        }
    } catch (err) {
        server.stop();
        console.log(`\x1b[31mERRO (${err.message})\x1b[0m`);
        return { passed: false };
    }
}

async function runXssRoomIdTest() {
    process.stdout.write(`  [Teste] T-XSS: join-room com payload HTML (<img src=x onerror=alert(1)>) ... `);
    const server = new TestServer();
    await server.start();
    const socket = createClient(server.url);

    try {
        await waitForConnect(socket);

        const result = await new Promise(resolve => {
            socket.once('join-error', err => resolve({ status: 'rejected', err }));
            socket.once('room-users', data => resolve({ status: 'accepted', data }));
            setTimeout(() => resolve({ status: 'timeout' }), 1500);
            socket.emit('join-room', { roomId: '<img src=x onerror=alert(1)>' });
        });

        socket.disconnect();
        server.stop();

        if (result.status === 'rejected' && result.err?.error === 'invalid_room') {
            console.log(`\x1b[32mPASSOU (Rejeitado com invalid_room)\x1b[0m`);
            return { passed: true };
        } else if (result.status === 'accepted') {
            console.log(`\x1b[31mVULNERÁVEL (Aceitou tag HTML como roomId!)\x1b[0m`);
            return { passed: false };
        } else {
            console.log(`\x1b[33mRESULTADO INESPERADO (${result.status})\x1b[0m`);
            return { passed: false };
        }
    } catch (err) {
        server.stop();
        console.log(`\x1b[31mERRO (${err.message})\x1b[0m`);
        return { passed: false };
    }
}

async function runEvictionBugTest() {
    process.stdout.write(`  [Teste] T7: Eviction com 1 membro & Preservação de Senha ... `);
    const server = new TestServer();
    await server.start();

    const socketA = createClient(server.url);
    const socketB = createClient(server.url);
    const socketC = createClient(server.url);

    try {
        await waitForConnect(socketA);
        await waitForConnect(socketB);
        await waitForConnect(socketC);

        // 1. Socket A entra na sala protegida por senha com clientId 'user-1'
        const roomAJoined = new Promise(resolve => {
            socketA.once('room-users', resolve);
        });
        socketA.emit('join-room', { roomId: 'sala-secreta', password: 'senha-super-segura', clientId: 'user-1' });
        await roomAJoined;

        // 2. Enquanto Socket A ainda está ativo, Socket B conecta com o MESMO clientId 'user-1'
        const socketADisconnected = new Promise(resolve => {
            socketA.once('disconnect', () => resolve(true));
            setTimeout(() => resolve(false), 2000);
        });

        socketB.emit('join-room', { roomId: 'sala-secreta', password: 'senha-super-segura', clientId: 'user-1' });
        await socketADisconnected;

        // 3. Agora Socket C tenta entrar na sala 'sala-secreta' SEM senha
        const cResult = await new Promise(resolve => {
            socketC.once('room-users', data => resolve({ status: 'joined', data }));
            socketC.once('join-error', data => resolve({ status: 'rejected', data }));
            setTimeout(() => resolve({ status: 'timeout' }), 2000);
            socketC.emit('join-room', { roomId: 'sala-secreta', password: '' });
        });

        socketA.disconnect();
        socketB.disconnect();
        socketC.disconnect();
        server.stop();

        if (cResult.status === 'joined') {
            console.log(`\x1b[31mVULNERÁVEL (Sala ficou órfã e perdeu a senha pós-eviction!)\x1b[0m`);
            return { passed: false, bugConfirmed: true };
        } else if (cResult.status === 'rejected' && cResult.data?.error === 'invalid_password') {
            console.log(`\x1b[32mPASSOU (Senha preservada e Socket C sem senha foi rejeitado com invalid_password)\x1b[0m`);
            return { passed: true, bugConfirmed: false };
        } else {
            console.log(`\x1b[33mRESULTADO INESPERADO (${cResult.status})\x1b[0m`);
            return { passed: false, bugConfirmed: false };
        }
    } catch (err) {
        server.stop();
        console.log(`\x1b[31mERRO NO TESTE (${err.message})\x1b[0m`);
        return { passed: false, bugConfirmed: false };
    }
}

async function runStreamStateSpoofTest() {
    process.stdout.write(`  [Teste] T6: Autorização de stream-state (Anti-Spoofing) ... `);
    const server = new TestServer();
    await server.start();

    const socketAlice = createClient(server.url);
    const socketBob = createClient(server.url);

    try {
        await waitForConnect(socketAlice);
        await waitForConnect(socketBob);

        socketAlice.emit('join-room', { roomId: 'sala-a' });
        socketBob.emit('join-room', { roomId: 'sala-b' });
        await sleep(350);

        let bobReceivedSpoofedEvent = false;
        socketBob.on('stream-state', () => {
            bobReceivedSpoofedEvent = true;
        });

        socketAlice.emit('stream-state', { roomId: 'sala-b', state: 'started' });
        await sleep(400);

        socketAlice.disconnect();
        socketBob.disconnect();
        server.stop();

        if (bobReceivedSpoofedEvent) {
            console.log(`\x1b[31mVULNERÁVEL (Bob recebeu evento de sala alheia!)\x1b[0m`);
            return { passed: false, bugConfirmed: true };
        } else {
            console.log(`\x1b[32mPASSOU (Evento restrito exclusivamente à sala da sessão de Alice)\x1b[0m`);
            return { passed: true, bugConfirmed: false };
        }
    } catch (err) {
        server.stop();
        console.log(`\x1b[31mERRO NO TESTE (${err.message})\x1b[0m`);
        return { passed: false, bugConfirmed: false };
    }
}

async function main() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: REPRODUÇÃO DE CRASHES & SEGURANÇA');
    console.log('===============================================================\n');

    console.log('[1] Testes de Resiliência e Prevenção de Crash (Fuzzing):');
    const t1 = await runCrashTest('T1: join-room com payload null', s => s.emit('join-room', null));
    const t2 = await runCrashTest('T2: join-room sem argumentos (undefined)', s => s.emit('join-room'));
    const t3 = await runCrashTest('T3: join-room com roomId numérico { roomId: 12345 }', s => s.emit('join-room', { roomId: 12345 }));
    const t4 = await runCrashTest('T4: join-room com senha booleana { password: true }', s => s.emit('join-room', { roomId: 'teste', password: true }));
    const t8 = await runCrashTest('T8: check-room sem argumentos', s => s.emit('check-room'));
    const t8b = await runCrashTest('T8b: check-room com payload null', s => s.emit('check-room', null));
    const tSignal = await runCrashTest('TSignal: signal com payload null', s => s.emit('signal', null));
    const tStream = await runCrashTest('TStream: stream-state com payload null', s => s.emit('stream-state', null));

    console.log('\n[2] Testes de Validação Estrutural e Respostas Semânticas:');
    const tPassAssert = await runPasswordTypeCheckTest();
    const tSignalRelay = await runSignalRelayTest();
    const tUnitSanitize = await runSanitizeRoomIdUnitTest();
    const tAck = await runCheckRoomAckTest();
    const tXss = await runXssRoomIdTest();

    console.log('\n[3] Testes de Integridade de Estado & Autorização:');
    const t7 = await runEvictionBugTest();
    const t6 = await runStreamStateSpoofTest();

    console.log('\n===============================================================');
    const allTests = [t1, t2, t3, t4, t8, t8b, tSignal, tStream, tPassAssert, tSignalRelay, tUnitSanitize, tAck, tXss, t7, t6];
    const passedCount = allTests.filter(t => t.passed).length;
    console.log(`  Resultado Consolidado: ${passedCount}/${allTests.length} testes passaram.`);
    console.log('===============================================================\n');

    if (passedCount !== allTests.length) {
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('Erro fatal no executor de testes:', err);
    process.exit(1);
});

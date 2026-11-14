const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function extractFn(source, name, isAsync = false) {
    const prefix = isAsync ? 'async\\s+function' : '(?:async\\s+)?function';
    const regex = new RegExp(`${prefix}\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    if (!match) {
        throw new Error(`Função ${name} não encontrada em public/app.js`);
    }
    return match[0];
}

function createScreenShareSandbox(appJs, overrides = {}) {
    const events = [];

    class MockMediaStream {
        constructor(tracks = []) {
            this._tracks = tracks;
        }
        getTracks() {
            return this._tracks;
        }
        getVideoTracks() {
            return this._tracks.filter((t) => t.kind === 'video');
        }
        getAudioTracks() {
            return this._tracks.filter((t) => t.kind === 'audio');
        }
    }

    const sandbox = {
        Promise,
        Error,
        Math,
        Number,
        Map,
        Set,
        MediaStream: MockMediaStream,
        console: {
            log: () => {},
            warn: () => {},
            error: () => {}
        },
        navigator: {
            connection: null,
            mediaDevices: {
                getDisplayMedia: async () => new MockMediaStream([]),
                enumerateDevices: async () => [],
                getUserMedia: async () => new MockMediaStream([])
            }
        },
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        contentHintMode: 'motion',
        currentUserName: 'Tester',
        roomId: 'sala-teste',
        localStream: null,
        peers: new Map(),
        streamGrid: { appendChild: () => {} },
        btnStartShare: { hidden: false },
        btnStopShare: { hidden: true },
        btnQualityToggle: { hidden: true },
        document: { getElementById: () => null },
        socket: { emit: () => {} },
        getVideoConstraints: () => ({ width: 1920, height: 1080 }),
        configureSenderParams: () => {},
        addLocalTracksToPC: () => {},
        sendOffer: () => {},
        updateGridState: () => {},
        startQualityMonitor: () => {},
        stopQualityMonitor: () => {},
        showToast: (msg, type) => events.push({ type: 'toast', msg, toastType: type }),
        createStreamTile: () => ({ id: '' }),
        startExcludeDiscordCapture: async () => null,
        startAppAudioCapture: async () => null,
        stopAppAudioCapture: () => events.push({ type: 'stopAppAudioCapture' }),
        ...overrides
    };

    vm.createContext(sandbox);
    vm.runInContext(extractFn(appJs, 'addLocalTracksToPC'), sandbox);
    vm.runInContext(extractFn(appJs, 'stopScreenShare'), sandbox);
    vm.runInContext(extractFn(appJs, 'startScreenShare', true), sandbox);

    return { sandbox, events, MockMediaStream };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: CICLO DE VIDA SCREENSHARE & REPLACETRACK');
    console.log('===============================================================\n');

    let failures = 0;
    const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

    // T1: startScreenShare chamado com localStream ativo chama stopScreenShare antes de nova captura
    process.stdout.write('  [Teste] T1: startScreenShare chama stopScreenShare antes de nova captura quando localStream está ativo ... ');
    try {
        const callOrder = [];
        const oldTrack = { id: 'old-v', kind: 'video', stopped: false, stop() { this.stopped = true; callOrder.push('oldTrack.stop'); } };
        const newVideoTrack = { id: 'new-v', kind: 'video', stopped: false, stop() { this.stopped = true; } };

        const { sandbox, MockMediaStream } = createScreenShareSandbox(appJs);
        sandbox.localStream = new MockMediaStream([oldTrack]);

        const origStop = sandbox.stopScreenShare;
        sandbox.stopScreenShare = function () {
            callOrder.push('stopScreenShare');
            return origStop.call(this);
        };
        sandbox.navigator.mediaDevices.getDisplayMedia = async () => {
            callOrder.push('getDisplayMedia');
            return new MockMediaStream([newVideoTrack]);
        };

        await sandbox.startScreenShare('none');

        assert.strictEqual(callOrder[0], 'stopScreenShare', 'stopScreenShare deve executar antes da nova captura');
        assert.strictEqual(callOrder[1], 'oldTrack.stop', 'Tracks antigas devem ser paradas antes de getDisplayMedia');
        assert.strictEqual(callOrder[2], 'getDisplayMedia', 'getDisplayMedia deve rodar após stopScreenShare');
        assert.strictEqual(oldTrack.stopped, true);
        assert.strictEqual(sandbox.localStream.getVideoTracks()[0], newVideoTrack);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2: Erro após getDisplayMedia limpa screenStream, audioTrack, cableStream e chama stopAppAudioCapture
    process.stdout.write('  [Teste] T2: Erro pós-getDisplayMedia limpa tracks, cableStream e chama stopAppAudioCapture ... ');
    try {
        // 2a: getVideoTracks() vazio no modo exclude_discord
        const leakedScreenAudio = { id: 'scr-a', kind: 'audio', stopped: false, stop() { this.stopped = true; } };
        const wasapiAudioTrack = { id: 'wasapi-a', kind: 'audio', stopped: false, stop() { this.stopped = true; } };

        const envA = createScreenShareSandbox(appJs, {
            startExcludeDiscordCapture: async () => wasapiAudioTrack
        });
        envA.sandbox.navigator.mediaDevices.getDisplayMedia = async () =>
            new envA.MockMediaStream([leakedScreenAudio]); // sem videoTrack!

        await envA.sandbox.startScreenShare('exclude_discord');

        assert.strictEqual(leakedScreenAudio.stopped, true, 'Tracks de screenStream devem ser paradas quando não há vídeo');
        assert.strictEqual(wasapiAudioTrack.stopped, true, 'audioTrack WASAPI deve ser parado');
        assert(envA.events.some((e) => e.type === 'stopAppAudioCapture'), 'stopAppAudioCapture deve ser chamado no modo exclude_discord');
        assert.strictEqual(envA.sandbox.localStream, null, 'localStream deve permanecer null');

        // 2b: Falha em createStreamTile após localStream atribuído no modo app
        const videoTrackB = { id: 'v-b', kind: 'video', stopped: false, stop() { this.stopped = true; } };
        const appAudioTrackB = { id: 'app-a', kind: 'audio', stopped: false, stop() { this.stopped = true; } };

        const envB = createScreenShareSandbox(appJs, {
            startAppAudioCapture: async () => appAudioTrackB,
            createStreamTile: () => { throw new Error('DOM tile failure'); }
        });
        envB.sandbox.navigator.mediaDevices.getDisplayMedia = async () =>
            new envB.MockMediaStream([videoTrackB]);

        await envB.sandbox.startScreenShare('app', 1234);

        assert.strictEqual(videoTrackB.stopped, true, 'videoTrack de screenStream deve ser parado quando createStreamTile falha');
        assert.strictEqual(appAudioTrackB.stopped, true, 'audioTrack do modo app deve ser parado quando createStreamTile falha');
        assert(envB.events.some((e) => e.type === 'stopAppAudioCapture'), 'stopAppAudioCapture deve ser chamado no modo app');
        assert.strictEqual(envB.sandbox.localStream, null, 'localStream deve ser revertido para null após falha');

        // 2c: Modo system com cableOutputId e múltiplas tracks no cableStream + erro em createStreamTile
        const videoTrackC = { id: 'v-c', kind: 'video', stopped: false, stop() { this.stopped = true; } };
        const cableTrack1 = { id: 'cab-1', kind: 'audio', stopped: false, stop() { this.stopped = true; } };
        const cableTrackExtra = { id: 'cab-2', kind: 'audio', stopped: false, stop() { this.stopped = true; } };

        const envC = createScreenShareSandbox(appJs, {
            createStreamTile: () => { throw new Error('Tile fail on cable'); }
        });
        envC.sandbox.navigator.mediaDevices.enumerateDevices = async () => [
            { kind: 'audioinput', deviceId: 'cable-id-1', label: 'CABLE Output (VB-Audio Virtual Cable)' }
        ];
        envC.sandbox.navigator.mediaDevices.getDisplayMedia = async () =>
            new envC.MockMediaStream([videoTrackC]);
        envC.sandbox.navigator.mediaDevices.getUserMedia = async () =>
            new envC.MockMediaStream([cableTrack1, cableTrackExtra]);

        await envC.sandbox.startScreenShare('system');

        assert.strictEqual(cableTrackExtra.stopped, true, 'Tracks excedentes de cableStream devem ser paradas');
        assert.strictEqual(cableTrack1.stopped, true, 'audioTrack principal de cableStream deve ser parado no rollback');
        assert.strictEqual(videoTrackC.stopped, true, 'videoTrack deve ser parado no rollback');
        assert.strictEqual(envC.sandbox.localStream, null);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T3: replaceTrack retornando Promise.reject(...) e retorno síncrono undefined não geram unhandledRejection
    process.stdout.write('  [Teste] T3: replaceTrack rejeitado em addLocalTracksToPC, stopScreenShare e user-joined sem unhandledRejection ... ');
    let unhandledError = null;
    const onUnhandled = (reason) => {
        unhandledError = reason;
    };
    process.on('unhandledRejection', onUnhandled);

    try {
        const { sandbox, MockMediaStream } = createScreenShareSandbox(appJs);
        const videoTrack = { id: 'v-1', kind: 'video', stop() {} };
        const audioTrack = { id: 'a-1', kind: 'audio', stop() {} };
        sandbox.localStream = new MockMediaStream([videoTrack, audioTrack]);

        let replaceCalls = 0;
        const rejectingVideoSender = {
            track: null,
            _kind: 'video',
            dtlsTransport: {},
            replaceTrack: () => {
                replaceCalls++;
                return Promise.reject(new Error('InvalidStateError: sender stopped'));
            }
        };
        const syncAudioSender = {
            track: null,
            _kind: 'audio',
            dtlsTransport: {},
            replaceTrack: () => {
                replaceCalls++;
                return undefined;
            }
        };

        const mockPC = {
            getSenders: () => [rejectingVideoSender, syncAudioSender],
            addTrack: () => ({})
        };

        sandbox.addLocalTracksToPC(mockPC);
        assert.strictEqual(replaceCalls, 2);

        sandbox.peers.set('peer-1', { pc: mockPC });
        sandbox.stopScreenShare();
        assert.strictEqual(replaceCalls, 4);

        // Verifica também que o bloco de user-joined trata Promise.reject no replaceTrack
        const userJoinedBlock = appJs.match(/socket\.on\('user-joined'[\s\S]*?\n\}\);/);
        assert(userJoinedBlock, 'Handler user-joined deve existir em public/app.js');
        assert(
            userJoinedBlock[0].includes('Promise.resolve(vSender.replaceTrack('),
            'user-joined deve encapsular vSender.replaceTrack com Promise.resolve(...).catch(...)'
        );

        // Permite drenar microtasks para garantir que nenhum unhandledRejection dispare
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(unhandledError, null, `Não deve ocorrer unhandledRejection (capturado: ${unhandledError})`);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    } finally {
        process.off('unhandledRejection', onUnhandled);
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

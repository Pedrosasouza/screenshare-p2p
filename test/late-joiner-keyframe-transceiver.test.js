const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Extrai isValidSignal diretamente de server.js para teste isolado
function loadServerHelpers() {
    const serverJsPath = path.resolve(__dirname, '../server.js');
    const serverJs = fs.readFileSync(serverJsPath, 'utf8');

    const fnMatch = serverJs.match(/function\s+isValidSignal\s*\([\s\S]*?\n\}/);
    if (!fnMatch) {
        throw new Error('Não foi possível localizar isValidSignal em server.js');
    }

    const sandbox = {
        isPlainObject: (obj) => obj !== null && typeof obj === 'object' && !Array.isArray(obj)
    };
    vm.createContext(sandbox);
    const isValidSignal = vm.runInContext(`(${fnMatch[0]})`, sandbox);
    return { isValidSignal };
}

// Extrai e prepara o ambiente para testar app.js
function loadAppFunctions() {
    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const { loadClientBundleSource } = require('./helpers/client-source');
    const appJs = loadClientBundleSource();
    const addLocalTracksMatch = appJs.match(/function\s+addLocalTracksToPC\s*\([\s\S]*?\n\}/);
    const configureSenderParamsMatch = appJs.match(/function\s+configureSenderParams\s*\([\s\S]*?\n\}/);
    const getMaxBitrateMatch = appJs.match(/function\s+getMaxBitrateForPeerCount\s*\([\s\S]*?\n\}/);

    if (!addLocalTracksMatch) {
        throw new Error('Não foi possível localizar addLocalTracksToPC em public/app.js');
    }

    const helpers = {};
    const sandbox = {
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        peers: new Map(),
        localStream: null,
        configureSenderParams: () => {}
    };
    vm.createContext(sandbox);

    if (getMaxBitrateMatch) {
        try {
            sandbox.getMaxBitrateForPeerCount = vm.runInContext(`(${getMaxBitrateMatch[0]})`, sandbox);
        } catch (_) {}
    }
    if (configureSenderParamsMatch) {
        try {
            sandbox.configureSenderParams = vm.runInContext(`(${configureSenderParamsMatch[0]})`, sandbox);
        } catch (_) {}
    }
    if (addLocalTracksMatch) {
        helpers.addLocalTracksToPC = vm.runInContext(`(${addLocalTracksMatch[0]})`, sandbox);
    }

    helpers.sandbox = sandbox;
    helpers.appJs = appJs;
    return helpers;
}

async function runTDDSuites() {
    console.log('\n===============================================================');
    console.log('  🧪 TDD: KEYFRAME RECOVERY & TRANSCEIVER REUSE (RED PHASE)');
    console.log('===============================================================\n');

    let failures = 0;

    // -------------------------------------------------------------
    // Teste 1: server.js deve aceitar sinal { type: 'request-keyframe' }
    // -------------------------------------------------------------
    process.stdout.write('  [Teste] T1: server.js isValidSignal autoriza { type: "request-keyframe" } ... ');
    try {
        const { isValidSignal } = loadServerHelpers();

        const kfSignal = { type: 'request-keyframe' };
        const validSdpOffer = { type: 'offer', sdp: 'v=0...' };
        const invalidSignal = { type: 'invalid-type' };
        const fakeObject = { foo: 'bar' };

        assert.strictEqual(isValidSignal(kfSignal), true, 'Sinal request-keyframe DEVE ser válido');
        assert.strictEqual(isValidSignal(validSdpOffer), true, 'SDP offer normal deve continuar válido');
        assert.strictEqual(isValidSignal(invalidSignal), false, 'Tipos arbitrários devem ser rejeitados');
        assert.strictEqual(isValidSignal(fakeObject), false, 'Objetos sem type/ice devem ser rejeitados');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // -------------------------------------------------------------
    // Teste 2: addLocalTracksToPC deve REUTILIZAR sender existente (replaceTrack) em vez de addTrack
    // -------------------------------------------------------------
    process.stdout.write('  [Teste] T2: addLocalTracksToPC reutiliza sender existente sem duplicar canais ... ');
    try {
        const { addLocalTracksToPC, sandbox } = loadAppFunctions();

        const videoTrack = { id: 'v-track-1', kind: 'video' };
        sandbox.localStream = {
            getTracks: () => [videoTrack]
        };

        let replaceTrackCalls = 0;
        let addTrackCalls = 0;
        let lastReplacedTrack = null;

        // Mock de Sender que já existe no PeerConnection, mas cuja trilha estava nula (após stopScreenShare)
        const mockExistingSender = {
            track: null,
            dtlsTransport: {}, // Conexão de transporte estabelecida
            replaceTrack: async (track) => {
                replaceTrackCalls++;
                lastReplacedTrack = track;
            }
        };

        const mockPC = {
            getSenders: () => [mockExistingSender],
            addTrack: (track, stream) => {
                addTrackCalls++;
                return { track };
            }
        };

        addLocalTracksToPC(mockPC);

        assert.strictEqual(replaceTrackCalls, 1, 'Deve chamar replaceTrack no sender existente');
        assert.strictEqual(lastReplacedTrack, videoTrack, 'replaceTrack deve receber a nova trilha de vídeo');
        assert.strictEqual(addTrackCalls, 0, 'NÃO deve chamar addTrack quando sender compatível já existe (evita duplicação no SDP)');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // -------------------------------------------------------------
    // Teste 3: stopScreenShare deve usar replaceTrack(null) em vez de removeTrack
    // -------------------------------------------------------------
    process.stdout.write('  [Teste] T3: public/app.js stopScreenShare usa replaceTrack(null) para não destruir transceivers ... ');
    try {
        const { appJs } = loadAppFunctions();

        const stopScreenShareMatch = appJs.match(/function\s+stopScreenShare\s*\([\s\S]*?\n\}/);
        assert.ok(stopScreenShareMatch, 'stopScreenShare deve existir em public/app.js');
        const code = stopScreenShareMatch[0];

        assert.ok(
            code.includes('replaceTrack(null)') || code.includes('replaceTrack( null )'),
            'stopScreenShare deve chamar sender.replaceTrack(null) para silenciar a trilha de forma limpa'
        );
        assert.ok(
            !code.includes('removeTrack(sender)'),
            'stopScreenShare NÃO deve chamar removeTrack(sender), pois cria senders zumbis no WebRTC'
        );

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // -------------------------------------------------------------
    // Teste 4: Transmissor escuta signal request-keyframe e força IDR frame via replaceTrack
    // -------------------------------------------------------------
    process.stdout.write('  [Teste] T4: public/app.js trata sinal request-keyframe com replaceTrack para IDR imediato ... ');
    try {
        const { appJs } = loadAppFunctions();

        const signalHandlerMatch = appJs.match(/socket\.on\('signal'[\s\S]*?\n\}\);/);
        assert.ok(signalHandlerMatch, 'Handler de socket.on("signal") deve existir em public/app.js');
        const signalCode = signalHandlerMatch[0];

        assert.ok(
            signalCode.includes('request-keyframe'),
            'socket.on("signal") deve conter verificação para signal.type === "request-keyframe"'
        );
        assert.ok(
            signalCode.includes('replaceTrack'),
            'Ao receber request-keyframe, deve forçar emissão de IDR frame via replaceTrack'
        );

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // -------------------------------------------------------------
    // Teste 5: Receptor monitora videoWidth === 0 e emite request-keyframe
    // -------------------------------------------------------------
    process.stdout.write('  [Teste] T5: public/app.js receptor detecta videoWidth 0 e solicita keyframe automaticamente ... ');
    try {
        const { appJs } = loadAppFunctions();

        assert.ok(
            appJs.includes('request-keyframe'),
            'public/app.js deve conter a lógica de emissão do sinal request-keyframe para o transmissor'
        );
        assert.ok(
            appJs.includes('videoWidth'),
            'public/app.js deve inspecionar videoWidth para identificar quando os frames ainda não foram decodificados'
        );

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes de TDD passaram.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam (Fase RED esperada antes da implementação).`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTDDSuites().catch(err => {
    console.error('Erro de execução do teste TDD:', err);
    process.exit(1);
});

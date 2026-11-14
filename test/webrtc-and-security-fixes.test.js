const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const assert = require('assert');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    if (!match) {
        throw new Error(`Função ${name} não encontrada em public/app.js`);
    }
    return match[0];
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: CORREÇÕES WEBRTC, SEGURANÇA E PRIVACY');
    console.log('===============================================================\n');

    let failures = 0;
    const { loadClientBundleSource } = require('./helpers/client-source');
    const appJs = loadClientBundleSource();
    const privacyMd = fs.readFileSync(path.resolve(__dirname, '../PRIVACY.md'), 'utf8');
    const tauriCfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'));

    // T1: addLocalTracksToPC usa transceivers para não misturar áudio e vídeo
    process.stdout.write('  [Teste] T1: addLocalTracksToPC não reutiliza sender de vídeo para áudio ... ');
    try {
        const sandbox = {
            selectedVideoResolution: '1080p',
            selectedVideoFps: 60,
            contentHintMode: 'motion',
            peers: new Map(),
            localStream: null
        };
        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'getMaxBitrateForPeerCount'), sandbox);
        vm.runInContext(extractFn(appJs, 'configureSenderParams'), sandbox);
        vm.runInContext(extractFn(appJs, 'addLocalTracksToPC'), sandbox);

        const videoSender = { track: null, dtlsTransport: {}, replaceTrackCalledWith: null, replaceTrack(t) { this.replaceTrackCalledWith = t; this.track = t; } };
        const videoTransceiver = { sender: videoSender, receiver: { track: { kind: 'video' } } };
        const addedTracks = [];
        const mockPC = {
            getSenders: () => [videoSender],
            getTransceivers: () => [videoTransceiver],
            addTrack: (track) => {
                const s = { track, dtlsTransport: {} };
                addedTracks.push(track);
                return s;
            }
        };

        const newVideoTrack = { id: 'v2', kind: 'video' };
        const newAudioTrack = { id: 'a1', kind: 'audio' };
        sandbox.localStream = { getTracks: () => [newVideoTrack, newAudioTrack] };

        sandbox.addLocalTracksToPC(mockPC);

        assert.strictEqual(videoSender.replaceTrackCalledWith, newVideoTrack, 'Sender de vídeo nulo deve reutilizar a nova track de vídeo');
        assert.strictEqual(addedTracks.length, 1, 'Nova track de áudio deve chamar addTrack sem sobrescrever sender de vídeo');
        assert.strictEqual(addedTracks[0], newAudioTrack);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T2: toggleQualityMode respeita selectedVideoFps e atualiza degradationPreference corretamente
    process.stdout.write('  [Teste] T2: toggleQualityMode respeita FPS selecionado (30/60) e degradationPreference ... ');
    try {
        let appliedParams = null;
        const mockSender = {
            track: { kind: 'video' },
            getParameters: () => ({ encodings: [{}] }),
            setParameters: async (p) => { appliedParams = p; }
        };
        const sandbox = {
            selectedVideoResolution: '1080p',
            selectedVideoFps: 30,
            contentHintMode: 'motion',
            peers: new Map([['p1', { pc: { getSenders: () => [mockSender] } }]]),
            localStream: { getVideoTracks: () => [{ contentHint: 'motion' }] },
            qualityModeLabel: { textContent: '' },
            btnQualityToggle: { title: '' },
            console: { log: () => {} }
        };
        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'getMaxBitrateForPeerCount'), sandbox);
        vm.runInContext(extractFn(appJs, 'configureSenderParams'), sandbox);
        vm.runInContext(extractFn(appJs, 'toggleQualityMode'), sandbox);

        // motion -> detail
        sandbox.toggleQualityMode();
        assert.strictEqual(sandbox.contentHintMode, 'detail');
        assert.strictEqual(appliedParams.degradationPreference, 'maintain-resolution');
        assert.strictEqual(appliedParams.encodings[0].maxFramerate, 30);

        // detail -> motion (mantendo selectedVideoFps = 30!)
        sandbox.toggleQualityMode();
        assert.strictEqual(sandbox.contentHintMode, 'motion');
        assert.strictEqual(appliedParams.degradationPreference, 'maintain-framerate');
        assert.strictEqual(appliedParams.encodings[0].maxFramerate, 30, 'Modo Fluido não deve forçar 60 FPS quando usuário escolheu 30 FPS');

        // detail mode em configureSenderParams também deve manter maintain-resolution e <= 30fps
        sandbox.selectedVideoFps = 60;
        sandbox.contentHintMode = 'detail';
        sandbox.configureSenderParams(mockSender, 'video');
        assert.strictEqual(appliedParams.degradationPreference, 'maintain-resolution');
        assert.strictEqual(appliedParams.encodings[0].maxFramerate, 30);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T3: removePeerConnection limpa _keyframeCheckInterval e _iceRestartTimeout
    process.stdout.write('  [Teste] T3: removePeerConnection cancela timers ativos do peer ... ');
    try {
        let clearedIntervals = [];
        let clearedTimeouts = [];
        const sandbox = {
            peers: new Map([
                ['p1', {
                    pc: { close: () => {} },
                    stream: { getTracks: () => [] },
                    tileEl: null,
                    _keyframeCheckInterval: 101,
                    _iceRestartTimeout: 202
                }]
            ]),
            clearInterval: (id) => clearedIntervals.push(id),
            clearTimeout: (id) => clearedTimeouts.push(id),
            updateGridState: () => {}
        };
        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'disposeTileElement'), sandbox);
        vm.runInContext(extractFn(appJs, 'clearPeerTimers'), sandbox);
        vm.runInContext(extractFn(appJs, 'removePeerConnection'), sandbox);

        sandbox.removePeerConnection('p1');
        assert.deepStrictEqual(clearedIntervals, [101]);
        assert.deepStrictEqual(clearedTimeouts, [202]);
        assert.strictEqual(sandbox.peers.size, 0);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T4: setPeerConnectionStatus evita innerHTML com mensagem dinâmica (Anti-XSS)
    process.stdout.write('  [Teste] T4: setPeerConnectionStatus usa textContent sem interpolar innerHTML ... ');
    try {
        const fnCode = extractFn(appJs, 'setPeerConnectionStatus');
        assert.ok(!fnCode.includes('innerHTML'), 'setPeerConnectionStatus não deve usar innerHTML');
        assert.ok(fnCode.includes('textContent'), 'setPeerConnectionStatus deve usar textContent');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T5: server.js /health endpoint e getCorsOrigin com ALLOWED_ORIGINS
    process.stdout.write('  [Teste] T5: server.js expõe /health e suporta ALLOWED_ORIGINS ... ');
    try {
        const { server, getCorsOrigin } = require('../server');
        const prevOrigins = process.env.ALLOWED_ORIGINS;

        delete process.env.ALLOWED_ORIGINS;
        assert.strictEqual(getCorsOrigin(), '*');

        process.env.ALLOWED_ORIGINS = 'https://screenshare-p2p.onrender.com, http://localhost:3000';
        const corsCheck = getCorsOrigin();
        assert.strictEqual(typeof corsCheck, 'function');
        await new Promise((resolve, reject) => {
            corsCheck('https://screenshare-p2p.onrender.com', (err, ok) => {
                if (err || !ok) return reject(new Error('Deveria permitir origem autorizada'));
                corsCheck('https://evil.example.com', (err2) => {
                    if (!err2) return reject(new Error('Deveria bloquear origem não autorizada'));
                    resolve();
                });
            });
        });
        if (prevOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = prevOrigins;

        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;
        const healthBody = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/health`, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
            }).on('error', reject);
        });
        await new Promise(resolve => server.close(resolve));

        assert.strictEqual(healthBody.status, 200);
        assert.strictEqual(healthBody.body.status, 'ok');
        assert.strictEqual(typeof healthBody.body.rooms, 'number');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T6: PRIVACY.md e tauri.conf.json alinhados
    process.stdout.write('  [Teste] T6: PRIVACY.md documenta STUN + TURN e Tauri desativa devtools ... ');
    try {
        assert.ok(privacyMd.includes('openrelay.metered.ca'), 'PRIVACY.md deve documentar uso de TURN fallback openrelay.metered.ca');
        assert.ok(privacyMd.includes('stun.l.google.com:19302'), 'PRIVACY.md deve documentar STUN');
        assert.strictEqual(tauriCfg.app.windows[0].devtools, false, 'devtools deve estar desabilitado em produção');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T7: collectPeerTelemetry & evaluatePeerQoS + telemetria no HTML
    process.stdout.write('  [Teste] T7: Telemetria WebRTC, par ICE nominated e aplicação de maxFramerate ... ');
    try {
        const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
        ['statsVideoTelemetry', 'statsCodecEncoder', 'statsQualityLimitation', 'statsIceRoute'].forEach(id => {
            assert.ok(html.includes(`id="${id}"`), `index.html deve definir #${id}`);
        });

        let appliedParams = null;
        let setParamsCalls = 0;
        const senderState = {
            track: { kind: 'video' },
            getParameters: () => ({ encodings: [{ maxBitrate: 1800000, maxFramerate: 30 }] }),
            setParameters: async (p) => {
                setParamsCalls++;
                appliedParams = p;
            }
        };

        const sampleReports = [
            { id: 'loc1', type: 'local-candidate', candidateType: 'srflx' },
            { id: 'rem1', type: 'remote-candidate', candidateType: 'relay' },
            { id: 'codec1', type: 'codec', mimeType: 'video/H264' },
            { id: 'cp1', type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 2500000, currentRoundTripTime: 0.035, localCandidateId: 'loc1', remoteCandidateId: 'rem1' },
            { id: 'cp2', type: 'candidate-pair', state: 'succeeded', nominated: false, availableOutgoingBitrate: 400000, currentRoundTripTime: 0.25 },
            { id: 'out1', type: 'outbound-rtp', kind: 'video', timestamp: 2000, bytesSent: 500000, framesPerSecond: 60, frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'none', encoderImplementation: 'OpenH264', codecId: 'codec1' }
        ];

        const sandbox = {
            selectedVideoResolution: '720p',
            selectedVideoFps: 60,
            contentHintMode: 'motion',
            peers: new Map([['p1', { pc: {} }]]),
            localStream: { active: true },
            console: { log: () => {} }
        };
        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'getMaxBitrateForPeerCount'), sandbox);
        vm.runInContext(extractFn(appJs, 'collectPeerTelemetry'), sandbox);
        vm.runInContext(extractFn(appJs, 'evaluatePeerQoS'), sandbox);

        const t1 = sandbox.collectPeerTelemetry(sampleReports, { timestamp: 1000, outboundBytes: 250000 });
        assert.strictEqual(t1.availableOutgoingBitrate, 2500000, 'Deve priorizar candidate-pair nominated sobre o não-nominated');
        assert.strictEqual(t1.iceRoute, 'srflx → relay');
        assert.strictEqual(t1.outbound.codec, 'H264');
        assert.strictEqual(t1.outbound.encoder, 'OpenH264');
        assert.strictEqual(t1.outbound.kbps, 2000, 'Delta de bitrate deve calcular 2000 kbps em 1s');

        const mockPeerObj = {
            pc: {
                connectionState: 'connected',
                getStats: async () => sampleReports,
                getSenders: () => [senderState]
            }
        };
        await sandbox.evaluatePeerQoS('p1', mockPeerObj);
        assert.strictEqual(setParamsCalls, 1, 'Deve chamar setParameters quando maxFramerate recupera mesmo sem grande variação de bitrate');
        assert.strictEqual(appliedParams.encodings[0].maxFramerate, 60, 'Deve restaurar 60 FPS acima do limiar escalado de recuperação');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todas as correções validadas com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});

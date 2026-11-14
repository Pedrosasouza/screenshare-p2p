const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.resolve(__dirname, '../public/app.js');
const appJs = fs.readFileSync(appPath, 'utf8');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Function ${name} not found in public/app.js`);
    return match[0];
}

function createHarness(overrides = {}) {
    const toasts = [];
    const displayMediaCalls = [];
    const localVideo = { srcObject: { id: 'old-local-stream' } };
    let localTileRemoved = false;
    let srcObjectBeforeRemove = null;

    const localTileMock = overrides.localTile || {
        id: 'localStreamTile',
        querySelector: (sel) => (sel === 'video' ? localVideo : null),
        remove() {
            srcObjectBeforeRemove = localVideo.srcObject;
            localTileRemoved = true;
        }
    };

    class MockMediaStream {
        constructor(tracks = []) {
            this._tracks = tracks;
        }
        getTracks() { return this._tracks; }
        getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
        getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
    }

    const sandbox = {
        Map,
        Set,
        RegExp,
        Promise,
        Number,
        Error,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        MediaStream: MockMediaStream,
        localStream: null,
        peers: new Map(),
        roomId: 'room-1',
        currentUserName: 'Pedro',
        contentHintMode: 'motion',
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        streamGrid: {
            appendChild() {}
        },
        btnStartShare: { hidden: false },
        btnStopShare: { hidden: true },
        btnQualityToggle: { hidden: true },
        socket: { emit() {} },
        navigator: {
            connection: null,
            mediaDevices: {
                getDisplayMedia: async (constraints) => {
                    displayMediaCalls.push(constraints);
                    if (overrides.getDisplayMediaImpl) {
                        return overrides.getDisplayMediaImpl(constraints);
                    }
                    const vTrack = { kind: 'video', contentHint: '', stop() {} };
                    return new MockMediaStream([vTrack]);
                }
            }
        },
        document: {
            getElementById: (id) => (id === 'localStreamTile' ? localTileMock : null)
        },
        getVideoConstraints: (res, fps) => ({ width: res === '720p' ? 1280 : 1920, frameRate: fps }),
        startExcludeDiscordCapture: overrides.startExcludeDiscordCapture || (async () => ({ kind: 'audio', contentHint: '', label: 'desktop', stop() {} })),
        startAppAudioCapture: overrides.startAppAudioCapture || (async () => ({ kind: 'audio', contentHint: '', label: 'app', stop() {} })),
        stopAppAudioCapture() {},
        createStreamTile: () => ({ id: '', querySelector: () => ({ play: async () => {} }), remove() {} }),
        startTilePlayback() {},
        updateGridState() {},
        addLocalTracksToPC() {},
        sendOffer() {},
        startQualityMonitor() {},
        stopQualityMonitor() {},
        showToast: (msg, type) => toasts.push({ msg, type })
    };

    vm.createContext(sandbox);
    const sdpMatch = appJs.match(/function prioritizePreferredVideoCodecs[\s\S]*?function optimizeSDP[\s\S]*?\n\}/);
    assert(sdpMatch, 'Could not find prioritizePreferredVideoCodecs / optimizeSDP');

    const code = [
        sdpMatch[0],
        extractFn(appJs, 'getMaxBitrateForPeerCount'),
        extractFn(appJs, 'configureSenderParams'),
        extractFn(appJs, 'startScreenShare'),
        extractFn(appJs, 'stopScreenShare')
    ].join('\n\n');

    vm.runInContext(code, sandbox, { filename: 'public/app.js' });

    return {
        sandbox,
        toasts,
        displayMediaCalls,
        localVideo,
        MockMediaStream,
        isLocalTileRemoved: () => localTileRemoved,
        getSrcObjectBeforeRemove: () => srcObjectBeforeRemove
    };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: QUALIDADE DE ÁUDIO, OPUS SDP & SCREENSHARE');
    console.log('===============================================================\n');

    // T1: optimizeSDP injects/preserves stereo=1, sprop-stereo=1, maxaveragebitrate=128000, useinbandfec=1, usedtx=0 idempotently
    process.stdout.write('  [Teste] T1: optimizeSDP injeta parâmetros Opus completos com idempotência ... ');
    {
        const h = createHarness();
        const partialOpusSdp = [
            'v=0',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'a=rtpmap:111 opus/48000/2',
            'a=fmtp:111 minptime=10;stereo=1',
            'm=video 9 UDP/TLS/RTP/SAVPF 98',
            'a=rtpmap:98 VP8/90000'
        ].join('\r\n');

        const pass1 = h.sandbox.optimizeSDP(partialOpusSdp);
        const pass2 = h.sandbox.optimizeSDP(pass1);
        assert.strictEqual(pass1, pass2, 'optimizeSDP must be idempotent on partial Opus fmtp');

        const fmtpLine = pass1.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
        assert(fmtpLine, 'Opus fmtp line should exist');
        for (const expected of ['minptime=10', 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000', 'useinbandfec=1', 'usedtx=0']) {
            assert(fmtpLine.includes(expected), `Opus fmtp should include ${expected}: ${fmtpLine}`);
        }
        assert.strictEqual(fmtpLine.match(/stereo=1/g).length, 2, 'stereo=1 and sprop-stereo=1 should appear once each');

        const noFmtpSdp = [
            'v=0',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'a=rtpmap:111 opus/48000/2'
        ].join('\r\n');
        const injectedPass1 = h.sandbox.optimizeSDP(noFmtpSdp);
        const injectedPass2 = h.sandbox.optimizeSDP(injectedPass1);
        assert.strictEqual(injectedPass1, injectedPass2, 'optimizeSDP must be idempotent when fmtp was injected');
        const injectedLine = injectedPass1.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
        assert(injectedLine.includes('usedtx=0') && injectedLine.includes('useinbandfec=1'));
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: configureSenderParams configures audio maxBitrate=128000 while preserving video config
    process.stdout.write('  [Teste] T2: configureSenderParams aplica 128kbps em audio e preserva video ... ');
    {
        const h = createHarness();
        let audioSetParams = null;
        const audioSender = {
            getParameters: () => ({ encodings: [{}] }),
            setParameters: async (p) => { audioSetParams = p; }
        };
        h.sandbox.configureSenderParams(audioSender, 'audio');
        assert(audioSetParams, 'setParameters should be called for audio');
        assert.strictEqual(audioSetParams.encodings[0].maxBitrate, 128000);

        let videoSetParams = null;
        const videoSender = {
            getParameters: () => ({ encodings: [{}] }),
            setParameters: async (p) => { videoSetParams = p; }
        };
        h.sandbox.configureSenderParams(videoSender, 'video');
        assert(videoSetParams, 'setParameters should be called for video');
        assert.strictEqual(videoSetParams.degradationPreference, 'maintain-framerate');
        assert(videoSetParams.encodings[0].maxBitrate > 0);
        assert.strictEqual(videoSetParams.encodings[0].maxFramerate, 60);
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: startScreenShare sets contentHint='music', blocks concurrent execution, and warns on app mode without targetPid
    process.stdout.write('  [Teste] T3: startScreenShare define contentHint=music, evita reentrância e avisa sem PID ... ');
    {
        let resolveFirstDisplayMedia;
        let displayCalls = 0;
        const capturedAudioTrack = { kind: 'audio', contentHint: '', label: 'desktop', stop() {} };

        const h = createHarness({
            getDisplayMediaImpl: () => {
                displayCalls++;
                if (displayCalls === 1) {
                    return new Promise((r) => { resolveFirstDisplayMedia = r; });
                }
                return Promise.resolve(new h.MockMediaStream([{ kind: 'video', contentHint: '', stop() {} }]));
            },
            startExcludeDiscordCapture: async () => capturedAudioTrack
        });

        const p1 = h.sandbox.startScreenShare('exclude_discord');
        // Concurrent call while p1 is still awaiting getDisplayMedia must return immediately
        const p2 = h.sandbox.startScreenShare('exclude_discord');
        await p2;
        assert.strictEqual(displayCalls, 1, 'Concurrent startScreenShare must be skipped while first is starting');

        resolveFirstDisplayMedia(new h.MockMediaStream([{ kind: 'video', contentHint: '', stop() {} }]));
        await p1;
        assert.strictEqual(capturedAudioTrack.contentHint, 'music', 'Audio track contentHint must be set to music');

        // Subsequent call after completion (in app mode with no targetPid) must run and warn cleanly
        await h.sandbox.startScreenShare('app', null);
        assert.strictEqual(displayCalls, 2, 'Guard must reset in finally so subsequent startScreenShare runs');
        assert.strictEqual(h.displayMediaCalls[1].audio, false, 'Fallback app mode without targetPid captures video with audio: false');
        assert(h.toasts.some((t) => t.type === 'warning' && t.msg.includes('Nenhum aplicativo selecionado')), 'Warning toast expected when audioMode=app without targetPid');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T4: stopScreenShare clears localVideo.srcObject = null before removing localStreamTile
    process.stdout.write('  [Teste] T4: stopScreenShare zera video.srcObject antes de remover localStreamTile ... ');
    {
        const h = createHarness();
        h.sandbox.localStream = new h.MockMediaStream([{ kind: 'video', stop() {} }]);
        h.sandbox.stopScreenShare();

        assert.strictEqual(h.isLocalTileRemoved(), true, 'localTile.remove() must be called');
        assert.strictEqual(h.getSrcObjectBeforeRemove(), null, 'localVideo.srcObject must be nulled before remove()');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    console.log('\n===============================================================');
    console.log('  ✅ Resultado: Todos os testes de qualidade e mídia passaram.');
    console.log('===============================================================\n');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockDocument, createMockElement } = require('./helpers/mock-dom');
const { MockMediaStream, createMockTrack, createMockSender } = require('./helpers/mock-webrtc');

async function loadModules() {
    const [sdp, qosMonitorMod, screenShareMod] = await Promise.all([
        import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/sdp.js')).href),
        import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/qos-monitor.js')).href),
        import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/screen-share.js')).href)
    ]);
    return { sdp, qosMonitorMod, screenShareMod };
}

function createScreenShareHarness(screenShareMod, overrides = {}) {
    const toasts = [];
    const displayMediaCalls = [];
    const doc = createMockDocument();
    const localVideo = createMockElement('video');
    localVideo.srcObject = { id: 'old-local-stream' };
    let localTileRemoved = false;
    let srcObjectBeforeRemove = null;

    const localTile = createMockElement('div', { id: 'localStreamTile', className: 'stream-tile' });
    localTile.appendChild(localVideo);
    const origRemove = localTile.remove.bind(localTile);
    localTile.remove = () => {
        srcObjectBeforeRemove = localVideo.srcObject;
        localTileRemoved = true;
        origRemove();
    };
    doc.body.appendChild(localTile);

    const state = {
        localStream: null,
        isSharing: false,
        activeShareGeneration: 0,
        currentRoomId: 'room-1',
        currentUserName: 'Pedro',
        contentHintMode: 'motion',
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60
    };

    const dom = {
        streamGrid: createMockElement('div', { id: 'streamGrid' }),
        btnStartShare: createMockElement('button', { id: 'btnStartShare' }),
        btnStopShare: createMockElement('button', { id: 'btnStopShare' }),
        btnQualityToggle: createMockElement('button', { id: 'btnQualityToggle' })
    };
    doc.body.appendChild(dom.streamGrid);

    const ctrl = screenShareMod.createScreenShareController({
        state,
        dom,
        getSocket: () => ({ emit: () => {} }),
        getPeers: () => new Map(),
        getWebRtc: () => ({ addLocalTracksToPC: () => {}, sendOffer: () => {} }),
        getGrid: () => ({
            createStreamTile: (_id, stream) => {
                const tile = createMockElement('div', { id: 'localStreamTile', className: 'stream-tile' });
                const v = createMockElement('video');
                v.srcObject = stream;
                v.play = async () => {};
                tile.appendChild(v);
                return tile;
            },
            startTilePlayback: () => {},
            updateGridState: () => {},
            updateEchoWarningVisibility: () => {}
        }),
        getQosMonitor: () => ({ startQualityMonitor: () => {}, stopQualityMonitor: () => {} }),
        startExcludeDiscordCapture: overrides.startExcludeDiscordCapture || (async () => createMockTrack('audio', 'a-desk', { label: 'desktop' })),
        startAppAudioCapture: overrides.startAppAudioCapture || (async () => createMockTrack('audio', 'a-app', { label: 'app' })),
        stopAppAudioCapture: () => {},
        showToast: (msg, type) => toasts.push({ msg, type }),
        documentObj: doc,
        navigatorObj: {
            connection: null,
            mediaDevices: {
                getDisplayMedia: async (constraints) => {
                    displayMediaCalls.push(constraints);
                    if (overrides.getDisplayMediaImpl) {
                        return overrides.getDisplayMediaImpl(constraints);
                    }
                    return new MockMediaStream([createMockTrack('video', 'v-1')]);
                }
            }
        },
        MediaStreamCtor: MockMediaStream
    });

    return {
        ctrl,
        state,
        dom,
        localVideo,
        toasts,
        displayMediaCalls,
        isLocalTileRemoved: () => localTileRemoved,
        getSrcObjectBeforeRemove: () => srcObjectBeforeRemove
    };
}

describe('Qualidade de áudio, Opus SDP & ScreenShare', () => {
    it('T1: optimizeSDP injeta parâmetros Opus completos com idempotência', async () => {
        const { sdp } = await loadModules();
        const partialOpusSdp = [
            'v=0',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'a=rtpmap:111 opus/48000/2',
            'a=fmtp:111 minptime=10;stereo=1',
            'm=video 9 UDP/TLS/RTP/SAVPF 98',
            'a=rtpmap:98 VP8/90000'
        ].join('\r\n');

        const pass1 = sdp.optimizeSDP(partialOpusSdp);
        const pass2 = sdp.optimizeSDP(pass1);
        assert.strictEqual(pass1, pass2);

        const fmtpLine = pass1.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
        assert.ok(fmtpLine);
        for (const expected of ['minptime=10', 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000', 'useinbandfec=1', 'usedtx=0']) {
            assert.ok(fmtpLine.includes(expected), `Opus fmtp deve incluir ${expected}`);
        }
        assert.strictEqual(fmtpLine.match(/stereo=1/g).length, 2);

        const noFmtpSdp = [
            'v=0',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'a=rtpmap:111 opus/48000/2'
        ].join('\r\n');
        const injectedPass1 = sdp.optimizeSDP(noFmtpSdp);
        const injectedPass2 = sdp.optimizeSDP(injectedPass1);
        assert.strictEqual(injectedPass1, injectedPass2);
        const injectedLine = injectedPass1.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
        assert.ok(injectedLine.includes('usedtx=0') && injectedLine.includes('useinbandfec=1'));
    });

    it('T2: configureSenderParams aplica 128kbps em audio e preserva video', async () => {
        const { qosMonitorMod } = await loadModules();
        const monitor = qosMonitorMod.createQosMonitor({
            state: {
                selectedVideoResolution: '1080p',
                selectedVideoFps: 60,
                contentHintMode: 'motion'
            },
            dom: {},
            getPeers: () => new Map()
        });

        const audioSender = createMockSender(createMockTrack('audio'));
        monitor.configureSenderParams(audioSender, 'audio');
        assert.strictEqual(audioSender.appliedParams[0].encodings[0].maxBitrate, 128000);

        const videoSender = createMockSender(createMockTrack('video'));
        monitor.configureSenderParams(videoSender, 'video');
        assert.strictEqual(videoSender.appliedParams[0].degradationPreference, 'maintain-framerate');
        assert.ok(videoSender.appliedParams[0].encodings[0].maxBitrate > 0);
        assert.strictEqual(videoSender.appliedParams[0].encodings[0].maxFramerate, 60);
    });

    it('T3: startScreenShare define contentHint=music, evita reentrância e avisa sem PID', async () => {
        const { screenShareMod } = await loadModules();
        let resolveFirstDisplayMedia;
        let displayCalls = 0;
        const capturedAudioTrack = createMockTrack('audio', 'desk-a', { label: 'desktop' });

        const h = createScreenShareHarness(screenShareMod, {
            getDisplayMediaImpl: () => {
                displayCalls++;
                if (displayCalls === 1) {
                    return new Promise((r) => { resolveFirstDisplayMedia = r; });
                }
                return Promise.resolve(new MockMediaStream([createMockTrack('video', 'v-2')]));
            },
            startExcludeDiscordCapture: async () => capturedAudioTrack
        });

        const p1 = h.ctrl.startScreenShare('exclude_discord');
        const p2 = h.ctrl.startScreenShare('exclude_discord');
        await p2;
        assert.strictEqual(displayCalls, 1, 'Chamada concorrente deve ser ignorada enquanto primeira inicia');

        resolveFirstDisplayMedia(new MockMediaStream([createMockTrack('video', 'v-1')]));
        await p1;
        assert.strictEqual(capturedAudioTrack.contentHint, 'music');

        await h.ctrl.startScreenShare('app', null);
        assert.strictEqual(displayCalls, 2);
        assert.strictEqual(h.displayMediaCalls[1].audio, false);
        assert.ok(
            h.toasts.some((t) => t.type === 'warning' && t.msg.includes('Nenhum aplicativo selecionado'))
        );
    });

    it('T4: stopScreenShare zera video.srcObject antes de remover localStreamTile', async () => {
        const { screenShareMod } = await loadModules();
        const h = createScreenShareHarness(screenShareMod);
        h.state.localStream = new MockMediaStream([createMockTrack('video')]);
        h.state.isSharing = true;

        h.ctrl.stopScreenShare();
        assert.strictEqual(h.isLocalTileRemoved(), true);
        assert.strictEqual(h.getSrcObjectBeforeRemove(), null);
    });
});

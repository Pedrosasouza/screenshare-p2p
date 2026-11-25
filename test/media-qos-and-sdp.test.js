'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockDocument, createMockElement } = require('./helpers/mock-dom');
const { MockMediaStream, createMockTrack, createMockSender } = require('./helpers/mock-webrtc');
const { loadClientModules } = require('./helpers/client-env');

async function loadModules() {
    return loadClientModules(['sdp', 'qos', 'qos-monitor', 'share-config-modal', 'screen-share', 'ui-feedback']);
}

const SAMPLE_SDP_CHROME = [
    'v=0',
    'o=- 1234567890 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 98 100',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:98 VP8/90000',
    'a=rtpmap:100 VP9/90000',
    'a=fmtp:100 profile-id=0'
].join('\r\n');

const SAMPLE_SDP_NO_FMTP = [
    'v=0',
    'o=- 9876543210 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:111 opus/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 98',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:98 VP8/90000'
].join('\r\n');

function makeStatsMap(availableOutgoingBitrate) {
    return new Map([
        ['pair-1', {
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            currentRoundTripTime: 0.02,
            availableOutgoingBitrate
        }],
        ['out-v', {
            type: 'outbound-rtp',
            kind: 'video',
            qualityLimitationReason: 'none',
            framesPerSecond: 60
        }]
    ]);
}

function createScreenShareHarness(createScreenShareController, overrides = {}) {
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

    const ctrl = createScreenShareController({
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

describe('Otimização e parsing de SDP WebRTC (sdp.js)', () => {
    it('T1: aplica parâmetros Opus (stereo=1, 128kbps) no payload correto preservando originais', async () => {
        const { optimizeSDP } = await loadModules();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const opusFmtp = lines.find((l) => l.startsWith('a=fmtp:111'));
        assert.ok(opusFmtp, 'Deveria existir uma linha a=fmtp:111');
        assert.ok(opusFmtp.includes('stereo=1'), 'Linha Opus deveria conter stereo=1');
        assert.ok(opusFmtp.includes('sprop-stereo=1'), 'Linha Opus deveria conter sprop-stereo=1');
        assert.ok(opusFmtp.includes('maxaveragebitrate=128000'), 'Linha Opus deveria conter maxaveragebitrate=128000');
        assert.ok(opusFmtp.includes('minptime=10'), 'Parâmetros originais do Opus deveriam ser preservados');
    });

    it('T2: aplica parâmetros de bitrate Google em H264 preservando profile-level-id', async () => {
        const { optimizeSDP } = await loadModules();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const h264Fmtp = lines.find((l) => l.startsWith('a=fmtp:96'));
        assert.ok(h264Fmtp, 'Deveria existir uma linha a=fmtp:96');
        assert.ok(h264Fmtp.includes('x-google-min-bitrate=400'), 'Deveria conter x-google-min-bitrate=400');
        assert.ok(h264Fmtp.includes('x-google-start-bitrate=1500'), 'Deveria conter x-google-start-bitrate=1500');
        assert.ok(h264Fmtp.includes('x-google-max-bitrate=6000'), 'Deveria conter x-google-max-bitrate=6000');
        assert.ok(h264Fmtp.includes('profile-level-id=42e01f'), 'profile-level-id original deveria ser preservado');
    });

    it('T3: injeta a=fmtp para Opus e VP8 quando ausentes originalmente', async () => {
        const { optimizeSDP } = await loadModules();
        const optimized = optimizeSDP(SAMPLE_SDP_NO_FMTP);
        const lines = optimized.split('\r\n');

        const opusFmtp = lines.find((l) => l.startsWith('a=fmtp:111'));
        assert.ok(opusFmtp, 'Deveria injetar a=fmtp:111 para Opus');
        assert.ok(opusFmtp.includes('stereo=1'), 'Linha Opus injetada deve ter stereo=1');

        const vp8Fmtp = lines.find((l) => l.startsWith('a=fmtp:98'));
        assert.ok(vp8Fmtp, 'Deveria injetar a=fmtp:98 para VP8');
        assert.ok(vp8Fmtp.includes('x-google-max-bitrate=6000'), 'Linha VP8 injetada deve ter x-google-max-bitrate=6000');
    });

    it('T4: inclui limites b=AS:6000 e b=TIAS:6000000 sem duplicações e após c= conforme RFC 4566', async () => {
        const { optimizeSDP } = await loadModules();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const asCount = lines.filter((l) => l === 'b=AS:6000').length;
        const tiasCount = lines.filter((l) => l === 'b=TIAS:6000000').length;

        assert.strictEqual(asCount, 1, 'Deveria existir exatamente 1 linha b=AS:6000');
        assert.strictEqual(tiasCount, 1, 'Deveria existir exatamente 1 linha b=TIAS:6000000');

        const mVideoIdx = lines.findIndex((l) => l.startsWith('m=video'));
        const cVideoIdx = lines.findIndex((l, idx) => idx > mVideoIdx && l.startsWith('c='));
        const asIdx = lines.indexOf('b=AS:6000');
        const tiasIdx = lines.indexOf('b=TIAS:6000000');
        assert.ok(cVideoIdx > mVideoIdx, 'c= deve existir após m=video');
        assert.ok(asIdx > cVideoIdx, 'b=AS deve aparecer após c= conforme RFC 4566');
        assert.ok(tiasIdx > cVideoIdx, 'b=TIAS deve aparecer após c= conforme RFC 4566');
    });

    it('T5: garante idempotência ao executar optimizeSDP duas vezes seguidas', async () => {
        const { optimizeSDP } = await loadModules();
        const pass1 = optimizeSDP(SAMPLE_SDP_CHROME);
        const pass2 = optimizeSDP(pass1);

        assert.strictEqual(pass1, pass2, 'Segunda execução deve produzir saída idêntica à primeira');
    });

    it('T6: prioriza VP8 e VP9 antes de H264 na linha m=video', async () => {
        const { optimizeSDP } = await loadModules();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const mVideoLine = optimized.split('\r\n').find((l) => l.startsWith('m=video'));
        assert.ok(mVideoLine, 'Deveria existir linha m=video');
        const payloads = mVideoLine.split(' ').slice(3);
        assert.deepStrictEqual(payloads, ['98', '100', '96'], 'Ordem esperada em m=video: VP8 (98), VP9 (100), H264 (96)');
    });
});

describe('Seleção de resolução (720p/1080p) e FPS (30/60)', () => {
    it('T1: getVideoConstraints mapeia resoluções e framerates corretamente', async () => {
        const { getVideoConstraints } = await loadModules();

        const c1080_60 = getVideoConstraints('1080p', 60);
        assert.strictEqual(c1080_60.width.ideal, 1920);
        assert.strictEqual(c1080_60.width.max, 1920);
        assert.strictEqual(c1080_60.height.ideal, 1080);
        assert.strictEqual(c1080_60.height.max, 1080);
        assert.strictEqual(c1080_60.frameRate.ideal, 60);
        assert.strictEqual(c1080_60.frameRate.max, 60);

        const c720_30 = getVideoConstraints('720p', 30);
        assert.strictEqual(c720_30.width.ideal, 1280);
        assert.strictEqual(c720_30.width.max, 1280);
        assert.strictEqual(c720_30.height.ideal, 720);
        assert.strictEqual(c720_30.height.max, 720);
        assert.strictEqual(c720_30.frameRate.ideal, 30);
        assert.strictEqual(c720_30.frameRate.max, 30);

        const c1080_30 = getVideoConstraints('1080p', 30);
        assert.strictEqual(c1080_30.height.ideal, 1080);
        assert.strictEqual(c1080_30.frameRate.ideal, 30);

        const c720_60 = getVideoConstraints('720p', 60);
        assert.strictEqual(c720_60.height.ideal, 720);
        assert.strictEqual(c720_60.frameRate.ideal, 60);
    });

    it('T2: getMaxBitrateForPeerCount adequa teto de bitrate por perfil', async () => {
        const { getMaxBitrateForPeerCount } = await loadModules();

        const b1080_60 = getMaxBitrateForPeerCount(1, '1080p', 60);
        const b1080_30 = getMaxBitrateForPeerCount(1, '1080p', 30);
        const b720_60 = getMaxBitrateForPeerCount(1, '720p', 60);
        const b720_30 = getMaxBitrateForPeerCount(1, '720p', 30);

        assert.strictEqual(b1080_60, 6000000, '1080p60 para 1 peer deve ser 6.0 Mbps');
        assert.strictEqual(b1080_30, 4000000, '1080p30 para 1 peer deve ser 4.0 Mbps');
        assert.strictEqual(b720_60, 2800000, '720p60 para 1 peer deve ser 2.8 Mbps');
        assert.strictEqual(b720_30, 1800000, '720p30 para 1 peer deve ser 1.8 Mbps');
        assert.ok(b720_30 < b1080_60, 'Perfil 720p30 deve alocar menos bitrate que 1080p60');
    });

    it('T3: public/index.html contém seletores de 1080p/720p e 60fps/30fps', () => {
        const htmlPath = path.resolve(__dirname, '../public/index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        assert.ok(html.includes('name="videoResolution"') && html.includes('value="1080p"'));
        assert.ok(html.includes('name="videoResolution"') && html.includes('value="720p"'));
        assert.ok(html.includes('name="videoFps"') && html.includes('value="60"'));
        assert.ok(html.includes('name="videoFps"') && html.includes('value="30"'));
    });

    it('T4: alocação multi-peer e degradationPreference=balanced por padrão', async () => {
        const { getMaxBitrateForPeerCount, createQosMonitor } = await loadModules();

        const b2Peers = getMaxBitrateForPeerCount(2, '1080p', 60);
        const b3Peers = getMaxBitrateForPeerCount(3, '1080p', 60);

        assert.ok(b2Peers <= 2500000, `Bitrate para 2 peers (${b2Peers}) deve ser <= 2.5 Mbps para não saturar upload`);
        assert.ok(b3Peers <= 1800000, `Bitrate para 3 peers (${b3Peers}) deve ser <= 1.8 Mbps`);
        assert.ok(2 * b2Peers <= 5500000, 'Total upload para 2 peers deve ser <= 5.5 Mbps');
        assert.ok(3 * b3Peers <= 5500000, 'Total upload para 3 peers deve ser <= 5.5 Mbps');

        const state = {
            selectedVideoResolution: '1080p',
            selectedVideoFps: 60
        };
        const monitor = createQosMonitor({
            state,
            dom: {},
            getPeers: () => new Map()
        });

        const mockSender = {
            getParameters: () => ({ encodings: [{}] }),
            setParameters: async (p) => { mockSender.appliedParams = p; }
        };
        monitor.configureSenderParams(mockSender, 'video');
        assert.strictEqual(
            mockSender.appliedParams.degradationPreference,
            'balanced',
            'degradationPreference deve ser balanced por padrão'
        );
        assert.strictEqual(mockSender.appliedParams.encodings[0].scaleResolutionDownBy, 1);
    });
});

describe('QoS adaptativo, Modal de Compartilhamento & Chime WebAudio', () => {
    it('T1: evaluatePeerQoS converge sem dead-zone e reduz sob congestão', async () => {
        const { createQosMonitor } = await loadModules();
        let availableBitrate = 720000;
        const expectedMidTarget = Math.floor(720000 * 0.70);
        let setParamsCalls = 0;

        const videoSender = createMockSender(createMockTrack('video'), {
            params: { encodings: [{ maxBitrate: 350000, maxFramerate: 60 }] }
        });
        const origSetParams = videoSender.setParameters.bind(videoSender);
        videoSender.setParameters = async (p) => {
            setParamsCalls++;
            return origSetParams(p);
        };

        const peerObj = {
            _qosTelemetryState: null,
            tileEl: null,
            pc: {
                connectionState: 'connected',
                getStats: async () => makeStatsMap(availableBitrate),
                getSenders: () => [videoSender]
            }
        };

        const state = {
            localStream: { id: 'local' },
            selectedVideoFps: 60,
            selectedVideoResolution: '1080p',
            contentHintMode: 'motion'
        };

        const monitor1 = createQosMonitor({
            state,
            dom: {},
            getPeers: () => new Map([['peer-123456', peerObj]])
        });

        await monitor1.evaluatePeerQoS('peer-123456', peerObj);
        assert.ok(videoSender.getParameters().encodings[0].maxBitrate > 350000);

        for (let i = 0; i < 8; i++) {
            await monitor1.evaluatePeerQoS('peer-123456', peerObj);
        }
        assert.strictEqual(videoSender.getParameters().encodings[0].maxBitrate, expectedMidTarget);

        const callsAtConvergence = setParamsCalls;
        await monitor1.evaluatePeerQoS('peer-123456', peerObj);
        assert.strictEqual(setParamsCalls, callsAtConvergence);

        const monitorCap = createQosMonitor({
            state,
            dom: {},
            getPeers: () => new Map([['p1', peerObj], ['p2', {}], ['p3', {}]])
        });
        videoSender.getParameters().encodings[0].maxBitrate = 680000;
        availableBitrate = 5500000;
        for (let i = 0; i < 8; i++) {
            await monitorCap.evaluatePeerQoS('peer-123456', peerObj);
        }
        assert.strictEqual(videoSender.getParameters().encodings[0].maxBitrate, 1800000);

        availableBitrate = 400000;
        for (let i = 0; i < 10; i++) {
            await monitor1.evaluatePeerQoS('peer-123456', peerObj);
        }
        assert.strictEqual(videoSender.getParameters().encodings[0].maxBitrate, 350000);
    });

    it('T1b: evaluatePeerQoS nunca excede peerCap quando há 6+ peers em 720p30', async () => {
        const { createQosMonitor } = await loadModules();

        for (const [peerCount, expectedCap] of [[6, 300000], [10, 180000]]) {
            for (const initialBitrate of [expectedCap, 1000000]) {
                let availableBitrate = 8000000;
                const videoSender = createMockSender(createMockTrack('video'), {
                    params: { encodings: [{ maxBitrate: initialBitrate, maxFramerate: 30 }] }
                });
                const peerObj = {
                    _qosTelemetryState: null,
                    tileEl: null,
                    pc: {
                        connectionState: 'connected',
                        getStats: async () => makeStatsMap(availableBitrate),
                        getSenders: () => [videoSender]
                    }
                };
                const peers = new Map(
                    Array.from({ length: peerCount }, (_, idx) => [`peer-${idx}`, idx === 0 ? peerObj : {}])
                );
                const monitor = createQosMonitor({
                    state: {
                        localStream: { id: 'local' },
                        selectedVideoFps: 30,
                        selectedVideoResolution: '720p',
                        contentHintMode: 'motion'
                    },
                    dom: {},
                    getPeers: () => peers
                });

                await monitor.evaluatePeerQoS('peer-0', peerObj);
                assert.ok(
                    videoSender.getParameters().encodings[0].maxBitrate <= expectedCap,
                    `peerCount=${peerCount} initial=${initialBitrate} should clamp <= ${expectedCap}`
                );
                assert.strictEqual(videoSender.getParameters().encodings[0].maxBitrate, expectedCap);

                availableBitrate = 200000;
                await monitor.evaluatePeerQoS('peer-0', peerObj);
                assert.strictEqual(videoSender.getParameters().encodings[0].maxBitrate, expectedCap);
            }
        }
    });

    it('T2: openShareConfigModal protege null em closest() e sincroniza appSelectorContainer', async () => {
        const { createShareConfigModalController } = await loadModules();

        function makeDom({ checkedValue = null, nullSystemCard = false } = {}) {
            const doc = createMockDocument();
            const shareConfigModal = createMockElement('div', { id: 'shareConfigModal', hidden: true });

            const desktopCard1 = createMockElement('div', { className: 'audio-option-card' });
            const desktopCard2 = createMockElement('div', { className: 'audio-option-card' });
            const sysCard = createMockElement('div', { className: 'audio-option-card' });

            const audioSourceExcludeDiscord = createMockElement('input', { type: 'radio', name: 'audioSourceType', value: 'exclude_discord' });
            const audioSourceApp = createMockElement('input', { type: 'radio', name: 'audioSourceType', value: 'app' });
            const audioSourceSystem = createMockElement('input', { type: 'radio', name: 'audioSourceType', value: 'system' });
            const appSelectorContainer = createMockElement('div', { id: 'appSelectorContainer', hidden: false });

            desktopCard1.appendChild(audioSourceExcludeDiscord);
            desktopCard2.appendChild(audioSourceApp);
            if (!nullSystemCard) {
                sysCard.appendChild(audioSourceSystem);
            }

            if (checkedValue === 'app') audioSourceApp.checked = true;
            else if (checkedValue === 'exclude_discord') audioSourceExcludeDiscord.checked = true;
            else if (checkedValue === 'system') audioSourceSystem.checked = true;

            doc.body.appendChild(desktopCard1);
            doc.body.appendChild(desktopCard2);
            if (nullSystemCard) doc.body.appendChild(audioSourceSystem);
            else doc.body.appendChild(sysCard);
            doc.body.appendChild(appSelectorContainer);
            doc.body.appendChild(shareConfigModal);

            return {
                doc,
                dom: { shareConfigModal, audioSourceExcludeDiscord, audioSourceApp, audioSourceSystem, appSelectorContainer },
                desktopCard1,
                desktopCard2
            };
        }

        const webEnv = makeDom({ nullSystemCard: true });
        const webCtrl = createShareConfigModalController({
            state: { selectedAudioSource: null },
            dom: webEnv.dom,
            isDesktopApp: () => false,
            documentObj: webEnv.doc
        });
        assert.doesNotThrow(() => webCtrl.openShareConfigModal());
        assert.strictEqual(webEnv.dom.audioSourceSystem.checked, true);
        assert.strictEqual(webEnv.dom.appSelectorContainer.hidden, true);
        assert.strictEqual(webEnv.desktopCard1.hidden, true);
        assert.strictEqual(webEnv.desktopCard2.hidden, true);

        const appEnv = makeDom({ checkedValue: 'app' });
        appEnv.dom.appSelectorContainer.hidden = true;
        const appCtrl = createShareConfigModalController({
            state: { selectedAudioSource: 'app' },
            dom: appEnv.dom,
            isDesktopApp: () => true,
            documentObj: appEnv.doc
        });
        appCtrl.openShareConfigModal();
        assert.strictEqual(appEnv.dom.appSelectorContainer.hidden, false);

        const otherEnv = makeDom({ checkedValue: 'exclude_discord' });
        otherEnv.dom.appSelectorContainer.hidden = false;
        const otherCtrl = createShareConfigModalController({
            state: { selectedAudioSource: 'exclude_discord' },
            dom: otherEnv.dom,
            isDesktopApp: () => true,
            documentObj: otherEnv.doc
        });
        otherCtrl.openShareConfigModal();
        assert.strictEqual(otherEnv.dom.appSelectorContainer.hidden, true);
    });

    it('T3: playPresenceChime registra osc.onended e desconecta nós WebAudio', async () => {
        const { playPresenceChime } = await loadModules();
        const createdOscillators = [];
        const createdGains = [];

        class MockAudioContext {
            constructor() {
                this.state = 'running';
                this.currentTime = 1.0;
                this.destination = { id: 'dest' };
            }
            resume() { return Promise.resolve(); }
            createOscillator() {
                const osc = {
                    type: '',
                    onended: null,
                    disconnectCalls: 0,
                    frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                    connect() {},
                    disconnect() { this.disconnectCalls++; },
                    start() {},
                    stop() {}
                };
                createdOscillators.push(osc);
                return osc;
            }
            createGain() {
                const gain = {
                    disconnectCalls: 0,
                    gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                    connect() {},
                    disconnect() { this.disconnectCalls++; }
                };
                createdGains.push(gain);
                return gain;
            }
        }

        const prevWin = global.window;
        global.window = { AudioContext: MockAudioContext };
        try {
            playPresenceChime('join');
            playPresenceChime('leave');
            assert.strictEqual(createdOscillators.length, 2);
            assert.strictEqual(createdGains.length, 2);

            for (let i = 0; i < 2; i++) {
                const osc = createdOscillators[i];
                const gain = createdGains[i];
                assert.strictEqual(typeof osc.onended, 'function');
                assert.strictEqual(osc.disconnectCalls, 0);
                assert.strictEqual(gain.disconnectCalls, 0);
                osc.onended();
                assert.strictEqual(osc.disconnectCalls, 1);
                assert.strictEqual(gain.disconnectCalls, 1);
            }
        } finally {
            if (prevWin === undefined) delete global.window;
            else global.window = prevWin;
        }
    });
});

describe('Qualidade de áudio, Opus SDP & ScreenShare', () => {
    it('T1: optimizeSDP injeta parâmetros Opus completos com idempotência', async () => {
        const { optimizeSDP } = await loadModules();
        const partialOpusSdp = [
            'v=0',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'a=rtpmap:111 opus/48000/2',
            'a=fmtp:111 minptime=10;stereo=1',
            'm=video 9 UDP/TLS/RTP/SAVPF 98',
            'a=rtpmap:98 VP8/90000'
        ].join('\r\n');

        const pass1 = optimizeSDP(partialOpusSdp);
        const pass2 = optimizeSDP(pass1);
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
        const injectedPass1 = optimizeSDP(noFmtpSdp);
        const injectedPass2 = optimizeSDP(injectedPass1);
        assert.strictEqual(injectedPass1, injectedPass2);
        const injectedLine = injectedPass1.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
        assert.ok(injectedLine.includes('usedtx=0') && injectedLine.includes('useinbandfec=1'));
    });

    it('T2: configureSenderParams aplica 128kbps em audio e preserva video', async () => {
        const { createQosMonitor } = await loadModules();
        const monitor = createQosMonitor({
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
        assert.strictEqual(videoSender.appliedParams[0].degradationPreference, 'balanced');
        assert.ok(videoSender.appliedParams[0].encodings[0].maxBitrate > 0);
        assert.strictEqual(videoSender.appliedParams[0].encodings[0].maxFramerate, 60);
        assert.strictEqual(videoSender.appliedParams[0].encodings[0].scaleResolutionDownBy, 1);
    });

    it('T3: startScreenShare define contentHint=music, evita reentrância e avisa sem PID', async () => {
        const { createScreenShareController } = await loadModules();
        let resolveFirstDisplayMedia;
        let displayCalls = 0;
        const capturedAudioTrack = createMockTrack('audio', 'desk-a', { label: 'desktop' });

        const h = createScreenShareHarness(createScreenShareController, {
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
        const { createScreenShareController } = await loadModules();
        const h = createScreenShareHarness(createScreenShareController);
        h.state.localStream = new MockMediaStream([createMockTrack('video')]);
        h.state.isSharing = true;

        h.ctrl.stopScreenShare();
        assert.strictEqual(h.isLocalTileRemoved(), true);
        assert.strictEqual(h.getSrcObjectBeforeRemove(), null);
    });
});

describe('Escolha de qualidade por espectador com teto máximo do transmissor', () => {
    it('T1: getAvailableViewerPresets filtra opções estritamente até o limite do transmissor', async () => {
        const { getAvailableViewerPresets } = await loadModules();

        const p1080_60 = getAvailableViewerPresets({ resolution: '1080p', fps: 60 }).map((p) => p.id);
        assert.deepStrictEqual(p1080_60, ['auto', '1080p60', '1080p30', '720p60', '720p30', '480p30']);

        const p1080_30 = getAvailableViewerPresets({ resolution: '1080p', fps: 30 }).map((p) => p.id);
        assert.deepStrictEqual(p1080_30, ['auto', '1080p30', '720p30', '480p30']);

        const p720_60 = getAvailableViewerPresets({ resolution: '720p', fps: 60 }).map((p) => p.id);
        assert.deepStrictEqual(p720_60, ['auto', '720p60', '720p30', '480p30']);

        const p720_30 = getAvailableViewerPresets({ resolution: '720p', fps: 30 }).map((p) => p.id);
        assert.deepStrictEqual(p720_30, ['auto', '720p30', '480p30']);
    });

    it('T2: resolveEffectiveEncodingProfile calcula scaleResolutionDownBy e faz clamp contra o teto do transmissor', async () => {
        const { resolveEffectiveEncodingProfile } = await loadModules();

        const from1080To720 = resolveEffectiveEncodingProfile({ resolution: '1080p', fps: 60 }, '720p30', 1);
        assert.strictEqual(from1080To720.resolution, '720p');
        assert.strictEqual(from1080To720.maxFramerate, 30);
        assert.strictEqual(from1080To720.scaleResolutionDownBy, 1.5);
        assert.strictEqual(from1080To720.maxBitrate, 1800000);

        const from1080To480 = resolveEffectiveEncodingProfile({ resolution: '1080p', fps: 60 }, '480p30', 1);
        assert.strictEqual(from1080To480.resolution, '480p');
        assert.strictEqual(from1080To480.maxFramerate, 30);
        assert.strictEqual(from1080To480.scaleResolutionDownBy, 2.25);
        assert.strictEqual(from1080To480.maxBitrate, 900000);

        const from720To480 = resolveEffectiveEncodingProfile({ resolution: '720p', fps: 30 }, '480p30', 1);
        assert.strictEqual(from720To480.scaleResolutionDownBy, 1.5);

        // Pedido acima do limite do transmissor sofre clamp estrito
        const clamped = resolveEffectiveEncodingProfile({ resolution: '720p', fps: 30 }, '1080p60', 1);
        assert.strictEqual(clamped.resolution, '720p');
        assert.strictEqual(clamped.maxFramerate, 30);
        assert.strictEqual(clamped.scaleResolutionDownBy, 1);
        assert.strictEqual(clamped.maxBitrate, 1800000);
    });

    it('T3: applyPeerViewerQuality e evaluatePeerQoS isolam perfis e modos (balanced/motion/detail) com clone de track por espectador', async () => {
        const { createQosMonitor } = await loadModules();

        const baseTrack = createMockTrack('video', 'v-base');
        const senderAuto = createMockSender(baseTrack, {
            params: { encodings: [{ maxBitrate: 2500000, maxFramerate: 60 }] }
        });
        const senderMotion = createMockSender(baseTrack, {
            params: { encodings: [{ maxBitrate: 2500000, maxFramerate: 60 }] }
        });
        const senderDetail = createMockSender(baseTrack, {
            params: { encodings: [{ maxBitrate: 2500000, maxFramerate: 60 }] }
        });

        const peerAuto = {
            viewerQualityPreset: 'auto',
            viewerOptimizationMode: 'balanced',
            pc: {
                connectionState: 'connected',
                getStats: async () => makeStatsMap(8000000),
                getSenders: () => [senderAuto]
            }
        };
        const peerMotion = {
            viewerQualityPreset: '480p30',
            viewerOptimizationMode: 'motion',
            pc: {
                connectionState: 'connected',
                getStats: async () => makeStatsMap(8000000),
                getSenders: () => [senderMotion]
            }
        };
        const peerDetail = {
            viewerQualityPreset: 'auto',
            viewerOptimizationMode: 'detail',
            pc: {
                connectionState: 'connected',
                getStats: async () => makeStatsMap(8000000),
                getSenders: () => [senderDetail]
            }
        };

        const peers = new Map([
            ['peer-auto', peerAuto],
            ['peer-motion', peerMotion],
            ['peer-detail', peerDetail]
        ]);
        const localStream = new MockMediaStream([baseTrack]);
        const state = {
            localStream,
            activeStreamMaxQuality: { resolution: '1080p', fps: 60 },
            selectedVideoResolution: '1080p',
            selectedVideoFps: 60
        };

        const monitor = createQosMonitor({ state, getPeers: () => peers });
        monitor.applyPeerViewerQuality('peer-auto', peerAuto);
        monitor.applyPeerViewerQuality('peer-motion', peerMotion);
        monitor.applyPeerViewerQuality('peer-detail', peerDetail);

        // Peer Auto (Equilibrado): usa baseTrack neutra e degradationPreference=balanced
        assert.strictEqual(senderAuto.track, baseTrack);
        assert.strictEqual(baseTrack.contentHint, '');
        assert.strictEqual(senderAuto.getParameters().degradationPreference, 'balanced');
        assert.strictEqual(senderAuto.getParameters().encodings[0].scaleResolutionDownBy, 1);
        assert.strictEqual(senderAuto.getParameters().encodings[0].maxFramerate, 60);

        // Peer Motion (Fluido + 480p30): usa clone com contentHint=motion e maintain-framerate
        assert.notStrictEqual(senderMotion.track, baseTrack);
        assert.strictEqual(senderMotion.track.contentHint, 'motion');
        assert.strictEqual(senderMotion.getParameters().degradationPreference, 'maintain-framerate');
        assert.strictEqual(senderMotion.getParameters().encodings[0].scaleResolutionDownBy, 2.25);
        assert.strictEqual(senderMotion.getParameters().encodings[0].maxFramerate, 30);
        const expectedLowCap = Math.round(900000 * 0.30);
        assert.strictEqual(senderMotion.getParameters().encodings[0].maxBitrate, expectedLowCap);

        // Peer Detail (Nítido + Auto): usa clone separado com contentHint=detail, maintain-resolution e 30 FPS
        assert.notStrictEqual(senderDetail.track, baseTrack);
        assert.notStrictEqual(senderDetail.track, senderMotion.track);
        assert.strictEqual(senderDetail.track.contentHint, 'detail');
        assert.strictEqual(senderDetail.getParameters().degradationPreference, 'maintain-resolution');
        assert.strictEqual(senderDetail.getParameters().encodings[0].scaleResolutionDownBy, 1);
        assert.strictEqual(senderDetail.getParameters().encodings[0].maxFramerate, 30);

        // Mesmo com 8 Mbps disponíveis, evaluatePeerQoS preserva teto e modo individual de cada peer
        for (let i = 0; i < 5; i++) {
            await monitor.evaluatePeerQoS('peer-motion', peerMotion);
        }
        assert.strictEqual(senderMotion.getParameters().encodings[0].maxBitrate, expectedLowCap);
        assert.strictEqual(senderMotion.getParameters().encodings[0].maxFramerate, 30);
        assert.strictEqual(senderMotion.getParameters().encodings[0].scaleResolutionDownBy, 2.25);
        assert.strictEqual(senderMotion.getParameters().degradationPreference, 'maintain-framerate');

        // Limpeza de clones encerra trilhas clonadas sem parar prematuramente a trilha base
        const motionClone = senderMotion.track;
        const detailClone = senderDetail.track;
        monitor.disposeVideoTrackClones(localStream);
        assert.strictEqual(motionClone.stopped, true);
        assert.strictEqual(detailClone.stopped, true);
        assert.strictEqual(baseTrack.stopped, false);
    });
});

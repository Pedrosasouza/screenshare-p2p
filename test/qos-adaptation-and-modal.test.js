const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockDocument, createMockElement } = require('./helpers/mock-dom');
const { createMockTrack, createMockSender } = require('./helpers/mock-webrtc');

async function loadModules() {
    const [qosMonitorMod, shareModalMod, uiFeedback] = await Promise.all([
        import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/qos-monitor.js')).href),
        import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/share-config-modal.js')).href),
        import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/ui-feedback.js')).href)
    ]);
    return { qosMonitorMod, shareModalMod, uiFeedback };
}

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

describe('QoS adaptativo, Modal de Compartilhamento & Chime WebAudio', () => {
    it('T1: evaluatePeerQoS converge sem dead-zone e reduz sob congestão', async () => {
        const { qosMonitorMod } = await loadModules();
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

        // 1 peer -> peerCap = 6000000
        const monitor1 = qosMonitorMod.createQosMonitor({
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

        // Convergência até peerCap real para 3 peers em 1080p60 (from 680kbps -> peerCap)
        const monitorCap = qosMonitorMod.createQosMonitor({
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

        // Alta congestão reduz de volta para 350000
        availableBitrate = 400000;
        for (let i = 0; i < 10; i++) {
            await monitor1.evaluatePeerQoS('peer-123456', peerObj);
        }
        assert.strictEqual(videoSender.getParameters().encodings[0].maxBitrate, 350000);
    });

    it('T2: openShareConfigModal protege null em closest() e sincroniza appSelectorContainer', async () => {
        const { shareModalMod } = await loadModules();

        function makeDom({ checkedValue = null, nullSystemCard = false } = {}) {
            const doc = createMockDocument();
            const shareConfigModal = createMockElement('div', { id: 'shareConfigModal' });
            shareConfigModal.hidden = true;
            shareConfigModal.style.display = 'none';

            const desktopCard1 = createMockElement('div', { className: 'audio-option-card' });
            const desktopCard2 = createMockElement('div', { className: 'audio-option-card' });
            const sysCard = createMockElement('div', { className: 'audio-option-card' });

            const audioSourceExcludeDiscord = createMockElement('input', { type: 'radio', name: 'audioSourceType', value: 'exclude_discord' });
            const audioSourceApp = createMockElement('input', { type: 'radio', name: 'audioSourceType', value: 'app' });
            const audioSourceSystem = createMockElement('input', { type: 'radio', name: 'audioSourceType', value: 'system' });
            const appSelectorContainer = createMockElement('div', { id: 'appSelectorContainer' });
            appSelectorContainer.style.display = 'block';

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

        // Modo Web com sysCard ausente (closest null) e appSelectorContainer sujo='block'
        const webEnv = makeDom({ nullSystemCard: true });
        const webCtrl = shareModalMod.createShareConfigModalController({
            state: { selectedAudioSource: null },
            dom: webEnv.dom,
            isDesktopApp: () => false,
            documentObj: webEnv.doc
        });
        assert.doesNotThrow(() => webCtrl.openShareConfigModal());
        assert.strictEqual(webEnv.dom.audioSourceSystem.checked, true);
        assert.strictEqual(webEnv.dom.appSelectorContainer.style.display, 'none');
        assert.strictEqual(webEnv.desktopCard1.style.display, 'none');
        assert.strictEqual(webEnv.desktopCard2.style.display, 'none');

        // Modo Desktop com radio 'app' marcado
        const appEnv = makeDom({ checkedValue: 'app' });
        appEnv.dom.appSelectorContainer.style.display = 'none';
        const appCtrl = shareModalMod.createShareConfigModalController({
            state: { selectedAudioSource: 'app' },
            dom: appEnv.dom,
            isDesktopApp: () => true,
            documentObj: appEnv.doc
        });
        appCtrl.openShareConfigModal();
        assert.strictEqual(appEnv.dom.appSelectorContainer.style.display, 'flex');

        // Modo Desktop com radio 'exclude_discord' marcado
        const otherEnv = makeDom({ checkedValue: 'exclude_discord' });
        otherEnv.dom.appSelectorContainer.style.display = 'block';
        const otherCtrl = shareModalMod.createShareConfigModalController({
            state: { selectedAudioSource: 'exclude_discord' },
            dom: otherEnv.dom,
            isDesktopApp: () => true,
            documentObj: otherEnv.doc
        });
        otherCtrl.openShareConfigModal();
        assert.strictEqual(otherEnv.dom.appSelectorContainer.style.display, 'none');
    });

    it('T3: playPresenceChime registra osc.onended e desconecta nós WebAudio', async () => {
        const { uiFeedback } = await loadModules();
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
            uiFeedback.playPresenceChime('join');
            uiFeedback.playPresenceChime('leave');
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

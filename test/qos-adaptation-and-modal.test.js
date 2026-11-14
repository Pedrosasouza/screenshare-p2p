const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.resolve(__dirname, '../public/app.js');
const { loadClientBundleSource } = require('./helpers/client-source');
const appJs = loadClientBundleSource();
function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Function ${name} not found in public/app.js`);
    return match[0];
}

function createHarness(overrides = {}) {
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
                startedAt: null,
                stoppedAt: null,
                frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                connect() {},
                disconnect() { this.disconnectCalls++; },
                start(t) { this.startedAt = t; },
                stop(t) { this.stoppedAt = t; }
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

    const appSelectorContainer = { style: { display: 'block' } };
    const desktopCard1 = { style: { display: '' } };
    const desktopCard2 = { style: { display: '' } };
    const audioSourceExcludeDiscord = {
        checked: false,
        closest: () => desktopCard1
    };
    const audioSourceApp = {
        checked: false,
        closest: () => desktopCard2
    };
    const audioSourceSystem = {
        checked: false,
        closest: () => (overrides.nullSystemCard ? null : { style: { border: '' } })
    };
    const shareConfigModal = {
        style: { display: 'none' },
        attributes: { hidden: '' },
        removeAttribute(k) { delete this.attributes[k]; },
        setAttribute(k, v) { this.attributes[k] = v; }
    };

    const sandbox = {
        Math,
        Number,
        Promise,
        Boolean,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        localStream: overrides.localStream !== undefined ? overrides.localStream : { id: 'local' },
        selectedVideoFps: 60,
        selectedVideoResolution: '1080p',
        contentHintMode: 'motion',
        collectPeerTelemetry: overrides.collectPeerTelemetry || (() => ({
            availableOutgoingBitrate: overrides.availableBitrate ?? 720000,
            currentRoundTripTime: 0.02,
            outbound: { qualityLimitationReason: 'none', fps: 60 },
            inbound: null,
            nextState: {}
        })),
        getMaxBitrateForPeerCount: () => overrides.peerCap ?? 6000000,
        isDesktopApp: () => Boolean(overrides.isDesktop),
        updateEchoWarningVisibility() {},
        checkDiscordStatus() {},
        fetchWindowList() {},
        audioSourceExcludeDiscord,
        audioSourceApp,
        audioSourceSystem,
        appSelectorContainer,
        shareConfigModal,
        document: {
            querySelector: (sel) => {
                if (sel === 'input[name="audioSourceType"]:checked') {
                    return overrides.checkedAudioRadio !== undefined ? overrides.checkedAudioRadio : null;
                }
                return null;
            }
        },
        window: {
            AudioContext: MockAudioContext
        }
    };

    vm.createContext(sandbox);
    const code = [
        extractFn(appJs, 'playPresenceChime'),
        extractFn(appJs, 'evaluatePeerQoS'),
        extractFn(appJs, 'openShareConfigModal')
    ].join('\n\n');
    vm.runInContext(code, sandbox, { filename: 'public/app.js' });

    return {
        sandbox,
        createdOscillators,
        createdGains,
        appSelectorContainer,
        desktopCard1,
        desktopCard2,
        audioSourceSystem,
        shareConfigModal
    };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: QOS ADAPTATIVO, MODAL & CHIME WEBAUDIO');
    console.log('===============================================================\n');

    // T1: evaluatePeerQoS escapes 350kbps without dead-zone, converges to boundedTarget, stops firing, and drops on congestion
    process.stdout.write('  [Teste] T1: evaluatePeerQoS converge sem dead-zone e reduz sob congestão ... ');
    {
        let availableBitrate = 720000; // targetBitrate = Math.floor(720000 * 0.70)
        const expectedMidTarget = Math.floor(720000 * 0.70);
        let setParamsCalls = 0;
        const senderParams = {
            encodings: [{ maxBitrate: 350000, maxFramerate: 60 }]
        };
        const peerObj = {
            _qosRateState: null,
            tileEl: null,
            pc: {
                connectionState: 'connected',
                getStats: async () => new Map(),
                getSenders: () => [{
                    track: { kind: 'video' },
                    getParameters: () => senderParams,
                    setParameters: async (p) => {
                        setParamsCalls++;
                        senderParams.encodings[0] = { ...p.encodings[0] };
                    }
                }]
            }
        };

        const h = createHarness({
            peerCap: 6000000,
            collectPeerTelemetry: () => ({
                availableOutgoingBitrate: availableBitrate,
                currentRoundTripTime: 0.02,
                outbound: { qualityLimitationReason: 'none', fps: 60 },
                inbound: null,
                nextState: {}
            })
        });

        // Step 1: Must escape 350000 immediately (old >100k smoothed delta was stuck forever at 350000)
        await h.sandbox.evaluatePeerQoS('peer-123456', peerObj);
        assert(senderParams.encodings[0].maxBitrate > 350000, 'Bitrate must climb out of 350000 floor on medium gap');

        // Converge completely to boundedTarget = Math.floor(720000 * 0.70)
        for (let i = 0; i < 8; i++) {
            await h.sandbox.evaluatePeerQoS('peer-123456', peerObj);
        }
        assert.strictEqual(senderParams.encodings[0].maxBitrate, expectedMidTarget, 'Bitrate must converge cleanly to boundedTarget');

        // Once converged, subsequent ticks must NOT keep invoking setParameters
        const callsAtConvergence = setParamsCalls;
        await h.sandbox.evaluatePeerQoS('peer-123456', peerObj);
        assert.strictEqual(setParamsCalls, callsAtConvergence, 'Converged bitrate must not re-trigger setParameters');

        // Also test convergence to peerCap (e.g. 680000 -> peerCap 800000)
        senderParams.encodings[0].maxBitrate = 680000;
        availableBitrate = 5500000; // targetBitrate = peerCap
        const hCap = createHarness({
            peerCap: 800000,
            collectPeerTelemetry: () => ({
                availableOutgoingBitrate: availableBitrate,
                currentRoundTripTime: 0.02,
                outbound: { qualityLimitationReason: 'none', fps: 60 },
                inbound: null,
                nextState: {}
            })
        });
        for (let i = 0; i < 4; i++) {
            await hCap.sandbox.evaluatePeerQoS('peer-123456', peerObj);
        }
        assert.strictEqual(senderParams.encodings[0].maxBitrate, 800000, 'Bitrate must converge cleanly to peerCap');

        // High congestion: availableBitrate < 600000 drops back down to 350000
        availableBitrate = 400000;
        for (let i = 0; i < 10; i++) {
            await h.sandbox.evaluatePeerQoS('peer-123456', peerObj);
        }
        assert.strictEqual(senderParams.encodings[0].maxBitrate, 350000, 'Severe congestion must reduce bitrate down to 350000');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: openShareConfigModal handles null .closest('.audio-option-card') and syncs appSelectorContainer visibility
    process.stdout.write('  [Teste] T2: openShareConfigModal protege null em closest() e sincroniza appSelectorContainer ... ');
    {
        // Web mode with null .closest() and stale appSelectorContainer='block'
        const hWeb = createHarness({ isDesktop: false, nullSystemCard: true });
        assert.doesNotThrow(() => hWeb.sandbox.openShareConfigModal());
        assert.strictEqual(hWeb.audioSourceSystem.checked, true, 'Web mode forces audioSourceSystem');
        assert.strictEqual(hWeb.appSelectorContainer.style.display, 'none', 'Web mode hides appSelectorContainer');
        assert.strictEqual(hWeb.desktopCard1.style.display, 'none');
        assert.strictEqual(hWeb.desktopCard2.style.display, 'none');

        // Desktop mode with 'app' radio checked
        const hDesktopApp = createHarness({
            isDesktop: true,
            checkedAudioRadio: { value: 'app' }
        });
        hDesktopApp.appSelectorContainer.style.display = 'none';
        hDesktopApp.sandbox.openShareConfigModal();
        assert.strictEqual(hDesktopApp.appSelectorContainer.style.display, 'flex', 'Desktop mode with app checked shows selector as flex');

        // Desktop mode with non-app radio checked
        const hDesktopOther = createHarness({
            isDesktop: true,
            checkedAudioRadio: { value: 'exclude_discord' }
        });
        hDesktopOther.appSelectorContainer.style.display = 'block';
        hDesktopOther.sandbox.openShareConfigModal();
        assert.strictEqual(hDesktopOther.appSelectorContainer.style.display, 'none', 'Desktop mode with exclude_discord hides selector');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: playPresenceChime attaches osc.onended and disconnects osc and gain
    process.stdout.write('  [Teste] T3: playPresenceChime registra osc.onended e desconecta nós WebAudio ... ');
    {
        const h = createHarness();
        h.sandbox.playPresenceChime('join');
        h.sandbox.playPresenceChime('leave');
        assert.strictEqual(h.createdOscillators.length, 2);
        assert.strictEqual(h.createdGains.length, 2);

        for (let i = 0; i < 2; i++) {
            const osc = h.createdOscillators[i];
            const gain = h.createdGains[i];
            assert.strictEqual(typeof osc.onended, 'function', 'osc.onended must be assigned');
            assert.strictEqual(osc.disconnectCalls, 0);
            assert.strictEqual(gain.disconnectCalls, 0);
            osc.onended();
            assert.strictEqual(osc.disconnectCalls, 1, 'osc.disconnect must be called in onended');
            assert.strictEqual(gain.disconnectCalls, 1, 'gain.disconnect must be called in onended');
        }
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    console.log('\n===============================================================');
    console.log('  ✅ Resultado: Todos os testes de QoS, modal e WebAudio passaram.');
    console.log('===============================================================\n');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});

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
    const createdNodes = [];
    const createdContexts = [];
    let stopDesktopCalls = 0;

    class MockAudioWorkletNode {
        constructor(ctx, name, options) {
            this.ctx = ctx;
            this.name = name;
            this.options = options;
            this.posted = [];
            this.disconnected = false;
            this.connectedTo = null;
            this.port = {
                postMessage: (data, transfer) => {
                    if (overrides.throwOnPostMessage) {
                        throw new Error('Port disconnected');
                    }
                    this.posted.push({ data, transfer });
                }
            };
            createdNodes.push(this);
        }
        connect(dest) {
            this.connectedTo = dest;
        }
        disconnect() {
            this.disconnected = true;
        }
    }

    class MockAudioContext {
        constructor(opts) {
            this.opts = opts;
            this.state = 'running';
            this.addModuleCalls = 0;
            this.resumeCalls = 0;
            this.suspendCalls = 0;
            this.audioWorklet = {
                addModule: async (url) => {
                    this.addModuleCalls++;
                    if (overrides.onAddModule) {
                        return overrides.onAddModule(this, url, this.addModuleCalls);
                    }
                }
            };
            createdContexts.push(this);
        }
        async resume() {
            this.resumeCalls++;
            this.state = 'running';
        }
        async suspend() {
            this.suspendCalls++;
            this.state = 'suspended';
        }
        createMediaStreamDestination() {
            const track = { id: `track-${createdNodes.length}`, kind: 'audio' };
            return {
                stream: {
                    getAudioTracks: () => (overrides.emptyAudioTracks ? [] : [track])
                }
            };
        }
    }

    const desktopApi = {
        isDesktop: () => true,
        startAppAudioCapture: overrides.startAppAudioCapture || (async (pid) => ({
            pid,
            sample_rate: 48000,
            channels: 2,
            mode: 'include'
        })),
        startExcludeDiscordCapture: overrides.startExcludeDiscordCapture || (async () => ({
            pid: 0,
            sample_rate: 48000,
            channels: 2,
            mode: 'exclude'
        })),
        stopAppAudioCapture: async () => {
            stopDesktopCalls++;
        }
    };

    const varsMatch = appJs.match(/let availableWindows[\s\S]*?const audioWorkletLoadedContexts = new WeakSet\(\);/);
    assert(varsMatch, 'Desktop audio state declarations not found in public/app.js');

    const sandbox = {
        WeakSet,
        ArrayBuffer,
        Float32Array,
        Promise,
        Error,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        AudioWorkletNode: MockAudioWorkletNode,
        window: {
            __TAURI_INTERNALS__: {},
            AudioContext: MockAudioContext,
            StreamGridDesktop: desktopApi
        }
    };

    vm.createContext(sandbox);
    const code = [
        varsMatch[0],
        extractFn(appJs, 'isDesktopApp'),
        extractFn(appJs, 'forwardPcmBufferToWorklet'),
        extractFn(appJs, 'prepareHelperAudioWorklet'),
        extractFn(appJs, 'startDesktopCaptureWith'),
        extractFn(appJs, 'startAppAudioCapture'),
        extractFn(appJs, 'startExcludeDiscordCapture'),
        extractFn(appJs, 'stopAppAudioCapture'),
        'function __getTestState() { return { activeAudioWorkletNode, desktopCaptureGeneration, helperAudioDestination, helperAudioContext }; }'
    ].join('\n\n');
    vm.runInContext(code, sandbox, { filename: 'public/app.js' });

    return {
        sandbox,
        createdNodes,
        createdContexts,
        getState: () => sandbox.__getTestState(),
        getStopDesktopCalls: () => stopDesktopCalls
    };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: SESSÃO DESKTOP WASAPI / AUDIOWORKLET');
    console.log('===============================================================\n');

    // T1: stopAppAudioCapture invalidates generation so late IPC onPcm cannot reach new session's worklet
    process.stdout.write('  [Teste] T1: stopAppAudioCapture invalida geração e bloqueia onPcm tardio ... ');
    {
        const onPcmCallbacks = [];
        const h = createHarness({
            startAppAudioCapture: async (pid, onPcm) => {
                onPcmCallbacks.push(onPcm);
                return { pid, sample_rate: 48000, channels: 2, mode: 'include' };
            }
        });

        await h.sandbox.startAppAudioCapture(101);
        assert.strictEqual(h.createdNodes.length, 1);
        const node1 = h.createdNodes[0];

        h.sandbox.stopAppAudioCapture();
        assert.strictEqual(h.getState().activeAudioWorkletNode, null);

        // Start session 2
        await h.sandbox.startAppAudioCapture(202);
        assert.strictEqual(h.createdNodes.length, 2);
        const node2 = h.createdNodes[1];

        // Stale IPC PCM buffer from session 1 must NOT reach node2
        const staleBuf = new Float32Array([0.5, -0.5]).buffer;
        onPcmCallbacks[0](staleBuf);
        assert.strictEqual(node2.posted.length, 0, 'Stale session-1 PCM must not reach session-2 worklet');
        assert.strictEqual(
            node1.posted.filter((m) => m.data instanceof Float32Array).length,
            0,
            'Session-1 node should receive no stale PCM'
        );

        // Active session-2 IPC PCM buffer DOES reach node2
        const freshBuf = new Float32Array([0.25, -0.25]).buffer;
        onPcmCallbacks[1](freshBuf);
        assert.strictEqual(node2.posted.length, 1, 'Active session-2 PCM must be forwarded');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: Overlapping startAppAudioCapture calls: older attempt is cancelled, never overwrites or stops newer session
    process.stdout.write('  [Teste] T2: Chamadas concorrentes de startAppAudioCapture preservam apenas a sessão mais nova ... ');
    {
        let rejectFirstStart;
        let markFirstEntered;
        const firstEntered = new Promise((r) => { markFirstEntered = r; });
        let callIndex = 0;
        const onPcmByCall = [];

        const h = createHarness({
            startAppAudioCapture: (pid, onPcm) => {
                callIndex++;
                onPcmByCall.push(onPcm);
                if (callIndex === 1) {
                    markFirstEntered();
                    return new Promise((_resolve, reject) => {
                        rejectFirstStart = reject;
                    });
                }
                return Promise.resolve({ pid, sample_rate: 48000, channels: 2, mode: 'include' });
            }
        });

        const p1 = h.sandbox.startAppAudioCapture(111);
        const p1Settled = p1.then(
            () => { throw new Error('p1 should not resolve'); },
            (err) => err
        );
        await firstEntered;

        const p2 = h.sandbox.startAppAudioCapture(222);
        const track2 = await p2;
        assert(track2 && track2.kind === 'audio', 'Second session should resolve with audio track');
        const activeNodeAfterP2 = h.getState().activeAudioWorkletNode;
        assert(activeNodeAfterP2, 'Second session worklet should be active');
        const stopCallsBeforeP1Fail = h.getStopDesktopCalls();

        // First call now fails late in startFn -> its catch must NOT call stopAppAudioCapture on session 2
        rejectFirstStart(new Error('WASAPI init timeout'));
        const err1 = await p1Settled;
        assert.match(err1.message, /WASAPI init timeout/);

        assert.strictEqual(h.getState().activeAudioWorkletNode, activeNodeAfterP2, 'Failed old session must not clear new worklet');
        assert.strictEqual(h.getStopDesktopCalls(), stopCallsBeforeP1Fail, 'Failed old session must not stop new desktop capture');

        // Late PCM on session 1 callback is ignored; session 2 callback works
        onPcmByCall[0](new Float32Array([1, -1]).buffer);
        assert.strictEqual(activeNodeAfterP2.posted.length, 0);
        onPcmByCall[1](new Float32Array([0.1, -0.1]).buffer);
        assert.strictEqual(activeNodeAfterP2.posted.length, 1);
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: addModule failure propagates & does not poison WeakSet; success caches per AudioContext instance
    process.stdout.write('  [Teste] T3: Erro em addModule é propagado e WeakSet evita recarga no mesmo AudioContext ... ');
    {
        let shouldFailModule = true;
        const h = createHarness({
            onAddModule: async () => {
                if (shouldFailModule) {
                    throw new Error('Failed to load audio-worklet-processor.js');
                }
            }
        });

        await assert.rejects(
            () => h.sandbox.prepareHelperAudioWorklet(),
            /Failed to load audio-worklet-processor\.js/
        );
        assert.strictEqual(h.createdContexts.length, 1);
        assert.strictEqual(h.createdContexts[0].addModuleCalls, 1);
        assert.strictEqual(h.createdNodes.length, 0, 'No AudioWorkletNode created after addModule failure');

        // Retry succeeds on same AudioContext because failed load was NOT marked in WeakSet
        shouldFailModule = false;
        await h.sandbox.prepareHelperAudioWorklet();
        assert.strictEqual(h.createdContexts[0].addModuleCalls, 2, 'Retry must invoke addModule again after failure');
        assert.strictEqual(h.createdNodes.length, 1);

        // Third call on the same open AudioContext skips addModule via WeakSet
        await h.sandbox.prepareHelperAudioWorklet();
        assert.strictEqual(h.createdContexts[0].addModuleCalls, 2, 'WeakSet must skip duplicate addModule on same AudioContext');
        assert.strictEqual(h.createdNodes.length, 2);

        // If AudioContext is closed and recreated, addModule runs once for the new instance
        h.createdContexts[0].state = 'closed';
        await h.sandbox.prepareHelperAudioWorklet();
        assert.strictEqual(h.createdContexts.length, 2);
        assert.strictEqual(h.createdContexts[1].addModuleCalls, 1, 'New AudioContext instance must load module once');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T4: forwardPcmBufferToWorklet swallows postMessage errors when port is disconnected
    process.stdout.write('  [Teste] T4: forwardPcmBufferToWorklet não lança erro se port.postMessage falhar ... ');
    {
        const h = createHarness({ throwOnPostMessage: true });
        await h.sandbox.prepareHelperAudioWorklet();
        assert(h.getState().activeAudioWorkletNode, 'Worklet node should exist');

        const buf = new Float32Array([0.5, -0.5, 0.25, -0.25]).buffer;
        assert.doesNotThrow(() => {
            h.sandbox.forwardPcmBufferToWorklet(buf);
        }, 'Disconnected port postMessage error must be handled safely');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T5: fetchWindowList exibe estado de erro e wasapi-capture-stopped notifica interrupção inesperada
    process.stdout.write('  [Teste] T5: fetchWindowList sinaliza erro em #selectAudioApp e onCaptureStopped notifica queda ... ');
    {
        const appendedOptions = [];
        const selectEl = {
            innerHTML: '<option value="1">Antigo</option>',
            appendChild(opt) { appendedOptions.push(opt); }
        };
        let captureStoppedCb = null;
        const desktopBridgePath = path.resolve(__dirname, '../public/js/desktop-bridge.js');
        const bridgeCode = fs.readFileSync(desktopBridgePath, 'utf8');
        const desktopAudioSrc = fs.readFileSync(path.resolve(__dirname, '../public/js/modules/desktop-audio.js'), 'utf8');

        assert(
            typeof extractFn === 'function' && desktopAudioSrc.includes('registerDesktopCaptureListeners'),
            'desktop-audio.js deve exportar registerDesktopCaptureListeners'
        );

        const win = {
            __TAURI_INTERNALS__: {},
            __TAURI__: {
                core: {
                    Channel: class {},
                    invoke: async (cmd) => {
                        if (cmd === 'list_windows') throw new Error('COM timeout');
                        return null;
                    }
                },
                event: {
                    listen: async (eventName, cb) => {
                        if (eventName === 'wasapi-capture-stopped') captureStoppedCb = cb;
                        return () => { captureStoppedCb = null; };
                    }
                }
            }
        };
        vm.runInNewContext(bridgeCode, { window: win, globalThis: win });
        assert.strictEqual(typeof win.StreamGridDesktop.onCaptureStopped, 'function', 'desktop-bridge deve expor onCaptureStopped');

        const cleanedModuleCode = desktopAudioSrc
            .replace(/^export\s+/gm, '')
            .replace(/import\s+[\s\S]*?;\n/g, '');
        const modSandbox = {
            WeakSet,
            ArrayBuffer,
            Float32Array,
            Promise,
            Error,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            document: {
                getElementById: (id) => (id === 'selectAudioApp' ? selectEl : null),
                createElement: () => ({ value: '', textContent: '' })
            },
            window: win
        };
        vm.createContext(modSandbox);
        vm.runInContext(cleanedModuleCode, modSandbox);

        await modSandbox.fetchWindowList();
        assert(appendedOptions.length === 1, 'Erro em fetchWindowList deve renderizar 1 option explicativa');
        assert.strictEqual(appendedOptions[0].value, '');
        assert(
            /erro/i.test(appendedOptions[0].textContent),
            `Texto de erro esperado em #selectAudioApp, recebido "${appendedOptions[0].textContent}"`
        );

        let notifiedPayload = null;
        await modSandbox.registerDesktopCaptureListeners((payload) => {
            notifiedPayload = payload;
        });
        assert.strictEqual(typeof captureStoppedCb, 'function', 'Deve registrar listener em wasapi-capture-stopped');
        captureStoppedCb({ payload: { pid: 4321, reason: 'device_invalidated' } });
        assert(notifiedPayload && notifiedPayload.pid === 4321, 'Callback de queda inesperada deve receber payload do evento');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    console.log('\n===============================================================');
    console.log('  ✅ Resultado: Todos os testes da sessão desktop passaram.');
    console.log('===============================================================\n');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});

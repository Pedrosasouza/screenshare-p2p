const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BRIDGE_PATH = path.resolve(__dirname, '../public/js/desktop-bridge.js');
const DESKTOP_AUDIO_URL = pathToFileURL(path.resolve(__dirname, '../public/js/modules/desktop-audio.js')).href;

let moduleSeq = 0;

async function withDesktopEnv(overrides, fn) {
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
            if (overrides.onResume) {
                await overrides.onResume(this);
            }
            this.state = 'running';
        }
        async suspend() {
            this.suspendCalls++;
            if (overrides.onSuspend) {
                await overrides.onSuspend(this);
            }
            this.state = 'suspended';
        }
        createMediaStreamDestination() {
            const track = { id: `track-${createdNodes.length}`, kind: 'audio', stop() {} };
            return {
                stream: {
                    getAudioTracks: () => (overrides.emptyAudioTracks ? [] : [track])
                }
            };
        }
    }

    const desktopApi = overrides.customDesktopApi || {
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

    const prevWindow = global.window;
    const prevDoc = global.document;
    const prevNodeCtor = global.AudioWorkletNode;

    const windowObj = overrides.windowObj || {
        __TAURI_INTERNALS__: {},
        AudioContext: MockAudioContext,
        StreamGridDesktop: desktopApi
    };
    if (!windowObj.AudioContext) windowObj.AudioContext = MockAudioContext;

    global.window = windowObj;
    global.AudioWorkletNode = MockAudioWorkletNode;
    if (overrides.documentObj) {
        global.document = overrides.documentObj;
    }

    try {
        const mod = await import(`${DESKTOP_AUDIO_URL}?session=${++moduleSeq}`);
        return await fn({
            mod,
            windowObj,
            createdNodes,
            createdContexts,
            getStopDesktopCalls: () => stopDesktopCalls
        });
    } finally {
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
        if (prevDoc === undefined) delete global.document;
        else global.document = prevDoc;
        if (prevNodeCtor === undefined) delete global.AudioWorkletNode;
        else global.AudioWorkletNode = prevNodeCtor;
    }
}

describe('Sessão Desktop WASAPI / AudioWorklet (desktop-audio.js)', () => {
    it('T1: stopAppAudioCapture invalida geração e bloqueia onPcm tardio', async () => {
        const onPcmCallbacks = [];
        await withDesktopEnv({
            startAppAudioCapture: async (pid, onPcm) => {
                onPcmCallbacks.push(onPcm);
                return { pid, sample_rate: 48000, channels: 2, mode: 'include' };
            }
        }, async ({ mod, createdNodes }) => {
            await mod.startAppAudioCapture(101);
            assert.strictEqual(createdNodes.length, 1);
            const node1 = createdNodes[0];

            mod.stopAppAudioCapture();
            assert.strictEqual(node1.disconnected, true);

            await mod.startAppAudioCapture(202);
            assert.strictEqual(createdNodes.length, 2);
            const node2 = createdNodes[1];

            // Callback antigo de sessão 1 não pode chegar ao node2
            onPcmCallbacks[0](new Float32Array([0.5, -0.5]).buffer);
            assert.strictEqual(node2.posted.length, 0);
            assert.strictEqual(node1.posted.filter((m) => m.data instanceof Float32Array).length, 0);

            // Callback ativo da sessão 2 chega normalmente ao node2
            onPcmCallbacks[1](new Float32Array([0.25, -0.25]).buffer);
            assert.strictEqual(node2.posted.length, 1);
        });
    });

    it('T2: chamadas concorrentes de startAppAudioCapture preservam apenas a sessão mais nova', async () => {
        let rejectFirstStart;
        let markFirstEntered;
        const firstEntered = new Promise((r) => { markFirstEntered = r; });
        let callIndex = 0;
        const onPcmByCall = [];

        await withDesktopEnv({
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
        }, async ({ mod, createdNodes, getStopDesktopCalls }) => {
            const p1 = mod.startAppAudioCapture(111);
            const p1Settled = p1.then(() => { throw new Error('p1 should not resolve'); }, (err) => err);
            await firstEntered;

            const track2 = await mod.startAppAudioCapture(222);
            assert.ok(track2 && track2.kind === 'audio');
            const node2 = createdNodes[createdNodes.length - 1];
            const stopCallsBeforeP1Fail = getStopDesktopCalls();

            rejectFirstStart(new Error('WASAPI init timeout'));
            const err1 = await p1Settled;
            assert.match(err1.message, /WASAPI init timeout/);

            assert.strictEqual(node2.disconnected, false);
            assert.strictEqual(getStopDesktopCalls(), stopCallsBeforeP1Fail);

            onPcmByCall[0](new Float32Array([1, -1]).buffer);
            assert.strictEqual(node2.posted.length, 0);
            onPcmByCall[1](new Float32Array([0.1, -0.1]).buffer);
            assert.strictEqual(node2.posted.length, 1);
        });
    });

    it('T3: erro em addModule é propagado e WeakSet evita recarga no mesmo AudioContext', async () => {
        let shouldFailModule = true;
        await withDesktopEnv({
            onAddModule: async () => {
                if (shouldFailModule) {
                    throw new Error('Failed to load audio-worklet-processor.js');
                }
            }
        }, async ({ mod, createdContexts, createdNodes }) => {
            await assert.rejects(
                () => mod.prepareHelperAudioWorklet(),
                /Failed to load audio-worklet-processor\.js/
            );
            assert.strictEqual(createdContexts.length, 1);
            assert.strictEqual(createdContexts[0].addModuleCalls, 1);
            assert.strictEqual(createdNodes.length, 0);

            shouldFailModule = false;
            await mod.prepareHelperAudioWorklet();
            assert.strictEqual(createdContexts[0].addModuleCalls, 2);
            assert.strictEqual(createdNodes.length, 1);

            await mod.prepareHelperAudioWorklet();
            assert.strictEqual(createdContexts[0].addModuleCalls, 2);
            assert.strictEqual(createdNodes.length, 2);

            createdContexts[0].state = 'closed';
            await mod.prepareHelperAudioWorklet();
            assert.strictEqual(createdContexts.length, 2);
            assert.strictEqual(createdContexts[1].addModuleCalls, 1);
        });
    });

    it('T4: forwardPcmBufferToWorklet não lança erro se port.postMessage falhar', async () => {
        await withDesktopEnv({ throwOnPostMessage: true }, async ({ mod, createdNodes }) => {
            await mod.prepareHelperAudioWorklet();
            assert.strictEqual(createdNodes.length, 1);
            const buf = new Float32Array([0.5, -0.5, 0.25, -0.25]).buffer;
            assert.doesNotThrow(() => mod.forwardPcmBufferToWorklet(buf));
        });
    });

    it('T5: fetchWindowList sinaliza erro em #selectAudioApp e onCaptureStopped notifica queda', async () => {
        const appendedOptions = [];
        const selectEl = {
            innerHTML: '<option value="1">Antigo</option>',
            appendChild(opt) { appendedOptions.push(opt); }
        };
        let captureStoppedCb = null;

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

        // Carrega desktop-bridge real sobre win
        const prevWindow = global.window;
        delete require.cache[BRIDGE_PATH];
        global.window = win;
        try {
            require(BRIDGE_PATH);
        } finally {
            delete require.cache[BRIDGE_PATH];
            if (prevWindow === undefined) delete global.window;
            else global.window = prevWindow;
        }
        assert.strictEqual(typeof win.StreamGridDesktop.onCaptureStopped, 'function');

        await withDesktopEnv({
            windowObj: win,
            documentObj: {
                getElementById: (id) => (id === 'selectAudioApp' ? selectEl : null),
                createElement: () => ({ value: '', textContent: '' })
            }
        }, async ({ mod }) => {
            await mod.fetchWindowList();
            assert.strictEqual(appendedOptions.length, 1);
            assert.strictEqual(appendedOptions[0].value, '');
            assert.match(appendedOptions[0].textContent, /erro/i);

            let notifiedPayload = null;
            await mod.registerDesktopCaptureListeners((payload) => {
                notifiedPayload = payload;
            });
            assert.strictEqual(typeof captureStoppedCb, 'function');
            captureStoppedCb({ payload: { pid: 4321, reason: 'device_invalidated' } });
            assert.ok(notifiedPayload && notifiedPayload.pid === 4321);
        });
    });

    it('T6: cancelamento em voo durante startFn fecha backend tardio sem matar nova sessão', async () => {
        let resolveFirst;
        let markFirstEntered;
        const firstEntered = new Promise((r) => { markFirstEntered = r; });

        await withDesktopEnv({
            startAppAudioCapture: async (pid) => {
                if (pid === 101) {
                    markFirstEntered();
                    return new Promise((resolve) => { resolveFirst = resolve; });
                }
                return { pid, sample_rate: 48000, channels: 2, mode: 'include' };
            }
        }, async ({ mod, getStopDesktopCalls }) => {
            const p1 = mod.startAppAudioCapture(101);
            const p1Settled = p1.then(() => null, (err) => err);
            await firstEntered;

            mod.stopAppAudioCapture();
            assert.strictEqual(getStopDesktopCalls(), 1);

            resolveFirst({ pid: 101, sample_rate: 48000, channels: 2, mode: 'include' });
            const err1 = await p1Settled;
            assert.ok(err1 instanceof Error);
            assert.strictEqual(getStopDesktopCalls(), 2);
        });

        let resolveStale;
        let markStaleEntered;
        const staleEntered = new Promise((r) => { markStaleEntered = r; });
        await withDesktopEnv({
            startAppAudioCapture: async (pid) => {
                if (pid === 303) {
                    markStaleEntered();
                    return new Promise((resolve) => { resolveStale = resolve; });
                }
                return { pid, sample_rate: 48000, channels: 2, mode: 'include' };
            }
        }, async ({ mod, getStopDesktopCalls }) => {
            const pStale = mod.startAppAudioCapture(303);
            const pStaleSettled = pStale.then(() => null, (err) => err);
            await staleEntered;

            mod.stopAppAudioCapture();
            assert.strictEqual(getStopDesktopCalls(), 1);

            const freshTrack = await mod.startAppAudioCapture(404);
            assert.ok(freshTrack && freshTrack.kind === 'audio');

            resolveStale({ pid: 303, sample_rate: 48000, channels: 2, mode: 'include' });
            await pStaleSettled;
            assert.strictEqual(getStopDesktopCalls(), 1);
        });
    });

    it('T7: prepareHelperAudioWorklet serializa suspend em voo antes de resume', async () => {
        let releaseSuspend;
        let suspendStarted = false;
        const timeline = [];

        await withDesktopEnv({
            onSuspend: () => {
                suspendStarted = true;
                timeline.push('suspend:start');
                return new Promise((resolve) => {
                    releaseSuspend = () => {
                        timeline.push('suspend:end');
                        resolve();
                    };
                });
            },
            onResume: () => {
                timeline.push('resume');
            }
        }, async ({ mod, createdContexts }) => {
            await mod.startAppAudioCapture(501);
            const ctx = createdContexts[0];
            assert.strictEqual(ctx.state, 'running');

            mod.stopAppAudioCapture();
            assert.strictEqual(suspendStarted, true);

            let restartDone = false;
            const restartPromise = mod.startAppAudioCapture(502).then((track) => {
                restartDone = true;
                return track;
            });

            await Promise.resolve();
            await Promise.resolve();
            assert.strictEqual(restartDone, false);

            releaseSuspend();
            const track = await restartPromise;
            assert.ok(track && track.kind === 'audio');
            assert.strictEqual(ctx.state, 'running');
            assert.deepStrictEqual(timeline, ['suspend:start', 'suspend:end', 'resume']);
        });
    });

    it('T8: wasapi-capture-stopped obsoleto não encerra captura WASAPI recém-iniciada', async () => {
        let onStopCb = null;
        let stopIpcCalls = 0;
        let unexpectedNotifications = 0;

        await withDesktopEnv({
            customDesktopApi: {
                isDesktop: () => true,
                startAppAudioCapture: async (pid) => ({ pid, generation: 2, sample_rate: 48000, channels: 2, mode: 'include' }),
                stopAppAudioCapture: async () => { stopIpcCalls++; },
                onCaptureStopped: async (cb) => {
                    onStopCb = cb;
                    return () => {};
                }
            }
        }, async ({ mod }) => {
            await mod.registerDesktopCaptureListeners(() => {
                unexpectedNotifications++;
            });
            const track2 = await mod.startAppAudioCapture(202);
            assert.ok(track2 && track2.kind === 'audio');

            onStopCb({ pid: 101, generation: 1, reason: 'device_invalidated' });
            assert.strictEqual(stopIpcCalls, 0);
            assert.strictEqual(unexpectedNotifications, 0);

            onStopCb({ pid: 202, generation: 2, reason: 'device_invalidated' });
            assert.strictEqual(stopIpcCalls, 1);
            assert.strictEqual(unexpectedNotifications, 1);
        });
    });
});

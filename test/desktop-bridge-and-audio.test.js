'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BRIDGE_PATH = path.resolve(__dirname, '../public/js/desktop-bridge.js');
const DESKTOP_AUDIO_URL = pathToFileURL(path.resolve(__dirname, '../public/js/modules/desktop-audio.js')).href;

let moduleSeq = 0;

function loadDesktopBridgeWithWindow(mockWindow) {
    const prevWindow = global.window;
    const prevDescriptor = Object.getOwnPropertyDescriptor(global, 'window');
    delete require.cache[BRIDGE_PATH];
    global.window = mockWindow;
    try {
        return require(BRIDGE_PATH);
    } finally {
        delete require.cache[BRIDGE_PATH];
        if (prevDescriptor) {
            Object.defineProperty(global, 'window', prevDescriptor);
        } else if (prevWindow === undefined) {
            delete global.window;
        } else {
            global.window = prevWindow;
        }
    }
}

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

describe('Desktop Bridge (Tauri v2 IPC & Modo Web)', () => {
    it('T1: opera em modo Web puro sem __TAURI__ com fallbacks seguros', async () => {
        const win = {};
        const bridge = loadDesktopBridgeWithWindow(win);

        assert.strictEqual(bridge.isDesktop(), false);
        assert.strictEqual(win.StreamGridDesktop.isDesktop(), false);

        const status = await bridge.getDiscordStatus();
        assert.strictEqual(status.detected, false);
        assert.strictEqual(status.pid, 0);

        const windows = await bridge.listWindows();
        assert.strictEqual(windows.length, 0);

        await bridge.stopAppAudioCapture();
        await assert.rejects(() => bridge.startExcludeDiscordCapture(() => {}), /indisponível/i);
    });

    it('T2: invoca comandos Tauri v2 e encaminha ArrayBuffer via Channel', async () => {
        const calls = [];
        class FakeChannel {
            constructor() {
                this.onmessage = null;
            }
        }
        const win = {
            __TAURI_INTERNALS__: {},
            __TAURI__: {
                core: {
                    Channel: FakeChannel,
                    invoke: async (cmd, args) => {
                        calls.push({ cmd, args });
                        if (cmd === 'get_discord_status') {
                            return { detected: true, pid: 4242, name: 'Discord Desktop' };
                        }
                        if (cmd === 'list_windows') {
                            return [{ pid: 9001, title: 'Game', exe: 'game.exe' }];
                        }
                        if (cmd === 'start_capture' || cmd === 'start_exclude_discord') {
                            const samplePcm = new Float32Array([0.25, -0.25, 0.5, -0.5]);
                            args.onAudio.onmessage(samplePcm.buffer);
                            return {
                                pid: args.pid || 4242,
                                sample_rate: 48000,
                                channels: 2,
                                format: 'f32le',
                                mode: cmd === 'start_exclude_discord' ? 'exclude' : 'include'
                            };
                        }
                        return null;
                    }
                },
                event: {
                    listen: async (eventName, cb) => {
                        calls.push({ cmd: 'listen', eventName });
                        cb({ payload: { pid: 8888, generation: 1, mode: 'exclude_discord', reason: 'rebound' } });
                        return () => {};
                    }
                }
            }
        };

        const bridge = loadDesktopBridgeWithWindow(win);
        assert.strictEqual(bridge.isDesktop(), true);

        const discord = await bridge.getDiscordStatus();
        assert.strictEqual(discord.detected, true);
        assert.strictEqual(discord.pid, 4242);

        const list = await bridge.listWindows();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].pid, 9001);

        const received = [];
        const started = await bridge.startAppAudioCapture(9001, (buf) => received.push(buf));
        assert.strictEqual(started.sample_rate, 48000);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(Object.prototype.toString.call(received[0]), '[object ArrayBuffer]');
        assert.strictEqual(received[0].byteLength, 16);
        const defaultCall = calls.find((c) => c.cmd === 'start_capture' && c.args.pid === 9001);
        assert.strictEqual(defaultCall.args.exclude, false);

        const receivedExcludeOpt = [];
        await bridge.startAppAudioCapture(9002, (buf) => receivedExcludeOpt.push(buf), { exclude: true });
        assert.strictEqual(receivedExcludeOpt.length, 1);
        const optExcludeCall = calls.find((c) => c.cmd === 'start_capture' && c.args.pid === 9002);
        assert.strictEqual(optExcludeCall.args.exclude, true);

        const receivedExcludeHelper = [];
        await bridge.startExcludeAppCapture(9003, (buf) => receivedExcludeHelper.push(buf));
        assert.strictEqual(receivedExcludeHelper.length, 1);
        const helperExcludeCall = calls.find((c) => c.cmd === 'start_capture' && c.args.pid === 9003);
        assert.strictEqual(helperExcludeCall.args.exclude, true);

        const receivedExclude = [];
        await bridge.startExcludeDiscordCapture((buf) => receivedExclude.push(buf));
        assert.strictEqual(receivedExclude.length, 1);

        await bridge.stopAppAudioCapture();
        assert.ok(calls.some((c) => c.cmd === 'stop_capture'));

        const reboundPayloads = [];
        await bridge.onCaptureRebound((payload) => reboundPayloads.push(payload));
        assert.strictEqual(reboundPayloads.length, 1);
        assert.strictEqual(reboundPayloads[0].pid, 8888);
        assert.ok(calls.some((c) => c.cmd === 'listen' && c.eventName === 'wasapi-capture-rebound'));

        await assert.rejects(() => bridge.startAppAudioCapture(0, () => {}), /PID inválido/i);
        await assert.rejects(() => bridge.startAppAudioCapture(4294967296, () => {}), /PID inválido/i);
    });

    it('T3: client modules e index.html usam desktop-bridge sem legado Neutralino/WS 45454', () => {
        const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
        const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
        const modulesDir = path.resolve(__dirname, '../public/js/modules');
        const moduleSources = fs.readdirSync(modulesDir)
            .filter((f) => f.endsWith('.js'))
            .map((f) => fs.readFileSync(path.join(modulesDir, f), 'utf8'));
        const allClientJs = [appJs, ...moduleSources].join('\n');

        assert.ok(indexHtml.includes('js/desktop-bridge.js'), 'index.html deve carregar js/desktop-bridge.js');
        assert.ok(!indexHtml.includes('js/neutralino.js'), 'index.html não deve mais carregar js/neutralino.js');
        assert.ok(!allClientJs.includes('Neutralino'), 'código cliente não deve referenciar Neutralino');
        assert.ok(!allClientJs.includes('NL_PORT'), 'código cliente não deve referenciar window.NL_PORT');
        assert.ok(!allClientJs.includes('127.0.0.1:45454'), 'código cliente não deve abrir WebSocket na porta 45454');
        assert.ok(appJs.includes('isDesktopApp('), 'app.js deve usar isDesktopApp()');
    });
});

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

            onPcmCallbacks[0](new Float32Array([0.5, -0.5]).buffer);
            assert.strictEqual(node2.posted.length, 0);
            assert.strictEqual(node1.posted.filter((m) => m.data instanceof Float32Array).length, 0);

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

    it('T9: startExcludeAppCapture repassa exclude=true para StreamGridDesktop.startAppAudioCapture', async () => {
        const startCalls = [];
        await withDesktopEnv({
            startAppAudioCapture: async (pid, onPcm, options) => {
                startCalls.push({ pid, hasCb: typeof onPcm === 'function', options });
                return { pid, sample_rate: 48000, channels: 2, mode: options && options.exclude ? 'exclude' : 'include' };
            }
        }, async ({ mod, windowObj }) => {
            const track = await mod.startExcludeAppCapture(7777, windowObj);
            assert.ok(track && track.kind === 'audio');
            assert.strictEqual(track._isDesktopWasapiTrack, true);
            assert.strictEqual(startCalls.length, 1);
            assert.strictEqual(startCalls[0].pid, 7777);
            assert.strictEqual(startCalls[0].hasCb, true);
            assert.deepStrictEqual(startCalls[0].options, { exclude: true });
        });
    });

    it('T10: wasapi-capture-rebound atualiza PID da sessão ativa para futuros eventos de parada', async () => {
        let onStopCb = null;
        let onReboundCb = null;
        let stopIpcCalls = 0;
        const stopNotifications = [];
        const reboundNotifications = [];

        await withDesktopEnv({
            customDesktopApi: {
                isDesktop: () => true,
                startExcludeDiscordCapture: async () => ({
                    pid: 4242,
                    generation: 3,
                    sample_rate: 48000,
                    channels: 2,
                    mode: 'exclude'
                }),
                stopAppAudioCapture: async () => { stopIpcCalls++; },
                onCaptureStopped: async (cb) => {
                    onStopCb = cb;
                    return () => {};
                },
                onCaptureRebound: async (cb) => {
                    onReboundCb = cb;
                    return () => {};
                }
            }
        }, async ({ mod, windowObj }) => {
            await mod.registerDesktopCaptureListeners(
                (payload) => stopNotifications.push(payload),
                windowObj,
                (payload) => reboundNotifications.push(payload)
            );
            const track = await mod.startExcludeDiscordCapture(windowObj);
            assert.ok(track && track.kind === 'audio');

            onReboundCb({ pid: 9991, generation: 2, mode: 'exclude_discord', reason: 'stale' });
            assert.strictEqual(reboundNotifications.length, 0);

            onReboundCb({ pid: 9999, generation: 3, mode: 'system_fallback', reason: 'Discord encerrado' });
            assert.strictEqual(reboundNotifications.length, 1);
            assert.strictEqual(stopIpcCalls, 0);

            onStopCb({ pid: 4242, generation: 3, reason: 'stale_pid' });
            assert.strictEqual(stopNotifications.length, 0);

            onStopCb({ pid: 9999, generation: 3, reason: 'device_error' });
            assert.strictEqual(stopIpcCalls, 1);
            assert.strictEqual(stopNotifications.length, 1);
        });
    });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PATH = path.resolve(__dirname, '../public/js/desktop-bridge.js');

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

        const receivedExclude = [];
        await bridge.startExcludeDiscordCapture((buf) => receivedExclude.push(buf));
        assert.strictEqual(receivedExclude.length, 1);

        await bridge.stopAppAudioCapture();
        assert.ok(calls.some((c) => c.cmd === 'stop_capture'));

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

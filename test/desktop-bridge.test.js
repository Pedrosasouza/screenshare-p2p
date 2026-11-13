const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: DESKTOP BRIDGE (TAURI V2 IPC & MODO WEB)');
    console.log('===============================================================\n');

    let failures = 0;
    const bridgeCode = fs.readFileSync(path.resolve(__dirname, '../public/js/desktop-bridge.js'), 'utf8');
    const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

    // T1: Modo Web puro (sem __TAURI__) retorna fallbacks seguros sem lançar erro
    process.stdout.write('  [Teste] T1: desktop-bridge opera em modo Web sem __TAURI__ ... ');
    try {
        const win = {};
        const sandbox = { window: win, globalThis: win };
        vm.runInNewContext(bridgeCode, sandbox);

        assert.strictEqual(win.StreamGridDesktop.isDesktop(), false);
        const status = await win.StreamGridDesktop.getDiscordStatus();
        assert.strictEqual(status.detected, false);
        assert.strictEqual(status.pid, 0);
        const windows = await win.StreamGridDesktop.listWindows();
        assert.strictEqual(windows.length, 0);
        await win.StreamGridDesktop.stopAppAudioCapture();
        await assert.rejects(() => win.StreamGridDesktop.startExcludeDiscordCapture(() => {}), /indisponível/i);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T2: Modo Desktop Tauri v2 invoca comandos e encaminha PCM via Channel
    process.stdout.write('  [Teste] T2: desktop-bridge invoca comandos Tauri v2 e repassa ArrayBuffer via Channel ... ');
    try {
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
                            return { pid: args.pid || 4242, sample_rate: 48000, channels: 2, format: 'f32le', mode: cmd === 'start_exclude_discord' ? 'exclude' : 'include' };
                        }
                        return null;
                    }
                }
            }
        };
        const sandbox = { window: win, globalThis: win };
        vm.runInNewContext(bridgeCode, sandbox);

        assert.strictEqual(win.StreamGridDesktop.isDesktop(), true);
        const discord = await win.StreamGridDesktop.getDiscordStatus();
        assert.strictEqual(discord.detected, true);
        assert.strictEqual(discord.pid, 4242);

        const list = await win.StreamGridDesktop.listWindows();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].pid, 9001);

        const received = [];
        const started = await win.StreamGridDesktop.startAppAudioCapture(9001, (buf) => received.push(buf));
        assert.strictEqual(started.sample_rate, 48000);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(Object.prototype.toString.call(received[0]), '[object ArrayBuffer]');
        assert.strictEqual(received[0].byteLength, 16);

        const receivedExclude = [];
        await win.StreamGridDesktop.startExcludeDiscordCapture((buf) => receivedExclude.push(buf));
        assert.strictEqual(receivedExclude.length, 1);

        await win.StreamGridDesktop.stopAppAudioCapture();
        assert.ok(calls.some(c => c.cmd === 'stop_capture'));

        await assert.rejects(() => win.StreamGridDesktop.startAppAudioCapture(0, () => {}), /PID inválido/i);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    // T3: public/app.js e public/index.html livres de referências legadas ao Neutralino/WS 45454
    process.stdout.write('  [Teste] T3: public/app.js e index.html usam desktop-bridge sem legado Neutralino ... ');
    try {
        assert.ok(indexHtml.includes('js/desktop-bridge.js'), 'index.html deve carregar js/desktop-bridge.js');
        assert.ok(!indexHtml.includes('js/neutralino.js'), 'index.html não deve mais carregar js/neutralino.js');
        assert.ok(!appJs.includes('Neutralino'), 'app.js não deve referenciar Neutralino');
        assert.ok(!appJs.includes('NL_PORT'), 'app.js não deve referenciar window.NL_PORT');
        assert.ok(!appJs.includes('127.0.0.1:45454'), 'app.js não deve abrir WebSocket na porta 45454');
        assert.ok(appJs.includes('isDesktopApp()'), 'app.js deve usar isDesktopApp()');
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes do Desktop Bridge Tauri v2 passaram.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Erro inesperado no teste:', err);
    process.exit(1);
});

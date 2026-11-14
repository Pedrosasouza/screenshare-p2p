const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const appPath = path.join(rootDir, 'public', 'app.js');
const indexPath = path.join(rootDir, 'public', 'index.html');
const stylePath = path.join(rootDir, 'public', 'style.css');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Função ${name} não encontrada em public/app.js`);
    return match[0];
}

function extractSocketHandler(source, eventName) {
    const regex = new RegExp(`socket\\.on\\('${eventName}'[\\s\\S]*?\\n\\}\\);`);
    const match = source.match(regex);
    assert(match, `Handler socket.on('${eventName}') não encontrado em public/app.js`);
    return match[0];
}

function extractDomContentLoaded(source) {
    const match = source.match(/window\.addEventListener\('DOMContentLoaded'[\s\S]*?\n\}\);/);
    assert(match, "Handler window.addEventListener('DOMContentLoaded') não encontrado em public/app.js");
    return match[0];
}

function extractCopyLinkBlock(source) {
    const marker = '// Copy Invite Link';
    const start = source.indexOf(marker);
    assert(start !== -1, 'Bloco // Copy Invite Link não encontrado em public/app.js');
    const end = source.indexOf('\nwindow.addEventListener(', start);
    assert(end !== -1, 'Fim do bloco // Copy Invite Link não encontrado em public/app.js');
    return source.slice(start, end);
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: #pass=, STATUS HEADER, PREFS & CSP/LIMPEZA');
    console.log('===============================================================\n');

    let failures = 0;
    const { loadClientBundleSource } = require('./helpers/client-source');
    const appJs = loadClientBundleSource();
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    const styleCss = fs.readFileSync(stylePath, 'utf8');

    // T1 (Item A): btnCopyLink gera #pass= em vez de ?pass=, e DOMContentLoaded lê #pass= e ?pass= limpando ambos
    process.stdout.write('  [Teste] T1 (Item A): btnCopyLink usa #pass= e DOMContentLoaded lê #pass= / ?pass= limpando URL ... ');
    try {
        const clipboardWrites = [];
        let copyHandler = null;
        const btnCopyLink = {
            innerHTML: '<i class="fa-regular fa-copy"></i> <span class="btn-text">Copiar Link</span>',
            addEventListener(ev, fn) {
                if (ev === 'click') copyHandler = fn;
            }
        };

        const windowObj = {
            location: {
                protocol: 'https:',
                origin: 'https://screenshare-p2p.onrender.com',
                pathname: '/',
                search: '?room=casal-1',
                hash: '#pass=segredo-hash'
            },
            history: {
                state: null,
                replaced: [],
                replaceState(s, _t, url) {
                    this.replaced.push(url);
                    const parsed = new URL(url, 'https://screenshare-p2p.onrender.com');
                    windowObj.location.pathname = parsed.pathname;
                    windowObj.location.search = parsed.search;
                    windowObj.location.hash = parsed.hash;
                }
            },
            addEventListener() {}
        };

        const sandbox = {
            URLSearchParams,
            encodeURIComponent,
            setTimeout,
            clearTimeout,
            roomId: 'casal-1',
            currentRoomPassword: 'segredo-hash',
            btnCopyLink,
            window: windowObj,
            navigator: {
                clipboard: {
                    writeText: (txt) => {
                        clipboardWrites.push(txt);
                        return Promise.resolve();
                    }
                }
            },
            showToast() {}
        };

        vm.createContext(sandbox);
        vm.runInContext(extractCopyLinkBlock(appJs), sandbox);
        assert(copyHandler, 'Listener click de btnCopyLink deve existir');
        await copyHandler();

        assert.strictEqual(clipboardWrites.length, 1);
        assert.strictEqual(
            clipboardWrites[0],
            'https://screenshare-p2p.onrender.com/?room=casal-1#pass=segredo-hash',
            'Link copiado deve usar #pass= e não ?pass='
        );
        assert(!clipboardWrites[0].includes('?pass=') && !clipboardWrites[0].includes('&pass='), 'Link não deve vazar senha na query string');

        // Agora testa DOMContentLoaded lendo #pass= e limpando da URL
        const joinCalls = [];
        const domListeners = {};
        const windowDom = {
            location: {
                protocol: 'https:',
                origin: 'https://screenshare-p2p.onrender.com',
                pathname: '/',
                search: '?room=casal-1',
                hash: '#pass=segredo-hash&outro=1'
            },
            history: {
                state: null,
                replaced: [],
                replaceState(s, _t, url) {
                    this.replaced.push(url);
                    const parsed = new URL(url, 'https://screenshare-p2p.onrender.com');
                    windowDom.location.pathname = parsed.pathname;
                    windowDom.location.search = parsed.search;
                    windowDom.location.hash = parsed.hash;
                }
            },
            addEventListener(ev, fn) { domListeners[ev] = fn; }
        };

        const domSandbox = {
            URLSearchParams,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            STORAGE_KEY: 'streamgrid_last_room',
            window: windowDom,
            localStorage: { getItem: () => null, removeItem() {} },
            inputCreateRoomPassword: { value: '' },
            inputJoinRoomPassword: { value: '' },
            inputJoinRoomId: { value: '' },
            initTheme() {},
            sanitizeRoomId: (s) => (s || '').trim().toLowerCase(),
            getSessionRoomPassword: () => '',
            openRoomModal() {},
            showRoomError() {},
            joinRoom: (r, p) => joinCalls.push({ r, p })
        };
        vm.createContext(domSandbox);
        vm.runInContext(extractDomContentLoaded(appJs), domSandbox);
        domListeners.DOMContentLoaded();

        assert.deepStrictEqual(joinCalls, [{ r: 'casal-1', p: 'segredo-hash' }], 'DOMContentLoaded deve ler senha de #pass=');
        assert.strictEqual(windowDom.history.replaced.length, 1);
        assert(!windowDom.location.hash.includes('segredo-hash'), 'Hash #pass= deve ser removido da barra de endereço');
        assert(windowDom.location.hash.includes('outro=1'), 'Outros parâmetros do hash devem ser preservados');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2 (Item B): Indicador fixo de status da sinalização no header
    process.stdout.write('  [Teste] T2 (Item B): Header possui #connectionStatusPill e transiciona entre estados ... ');
    try {
        assert(indexHtml.includes('id="connectionStatusPill"'), 'index.html deve conter #connectionStatusPill');
        assert(indexHtml.includes('id="connectionStatusText"'), 'index.html deve conter #connectionStatusText');
        assert(/\.connection-status-pill/.test(styleCss), 'style.css deve estilizar .connection-status-pill');

        const pill = {
            className: 'info-pill connection-status-pill',
            dataset: {},
            title: '',
            setAttribute(k, v) { if (k === 'data-status') this.dataset.status = v; }
        };
        const textEl = { textContent: '' };
        const socketHandlers = {};
        const timers = new Map();
        let nextId = 1;

        const socket = {
            id: 's1',
            connected: false,
            on(ev, fn) { socketHandlers[ev] = fn; },
            emit() {}
        };

        const sandbox = {
            Map,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            COLD_START_NOTICE_DELAY_MS: 3000,
            coldStartTimer: null,
            hasShownColdStartToast: false,
            wasSocketDisconnected: false,
            hasShownConnectErrorToast: false,
            myId: '',
            roomId: '',
            pendingRoomJoin: null,
            currentRoomPassword: '',
            currentUserName: '',
            clientId: 'c1',
            socket,
            document: {
                getElementById: (id) => {
                    if (id === 'connectionStatusPill') return pill;
                    if (id === 'connectionStatusText') return textEl;
                    return null;
                }
            },
            setTimeout: (fn, ms) => {
                const id = nextId++;
                timers.set(id, { fn, ms });
                return id;
            },
            clearTimeout: (id) => timers.delete(id),
            showToast() {}
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'setSignalingStatus'), sandbox);
        vm.runInContext(extractFn(appJs, 'scheduleColdStartNotice'), sandbox);
        vm.runInContext(extractFn(appJs, 'cancelColdStartNotice'), sandbox);
        vm.runInContext(extractSocketHandler(appJs, 'connect'), sandbox);
        vm.runInContext(extractSocketHandler(appJs, 'disconnect'), sandbox);
        vm.runInContext(extractSocketHandler(appJs, 'connect_error'), sandbox);

        sandbox.scheduleColdStartNotice();
        const [tid, entry] = Array.from(timers.entries())[0];
        timers.delete(tid);
        entry.fn();
        assert.strictEqual(pill.dataset.status, 'waking');
        assert(/acordando/i.test(textEl.textContent));

        socket.connected = true;
        socketHandlers.connect();
        assert.strictEqual(pill.dataset.status, 'connected');
        assert(/conectado/i.test(textEl.textContent));

        socket.connected = false;
        socketHandlers.disconnect('transport close');
        assert.strictEqual(pill.dataset.status, 'reconnecting');
        assert(/reconectando/i.test(textEl.textContent));

        socketHandlers.connect_error(new Error('offline'));
        assert.strictEqual(pill.dataset.status, 'offline');
        assert(/offline/i.test(textEl.textContent));

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T3 (Item C): Persistência de audioSourceType e contentHintMode em localStorage
    process.stdout.write('  [Teste] T3 (Item C): Persiste audioSourceType e contentHintMode em localStorage ... ');
    try {
        const audioKeyMatch = appJs.match(/const AUDIO_SOURCE_KEY\s*=\s*'([^']+)';/);
        const hintKeyMatch = appJs.match(/const CONTENT_HINT_KEY\s*=\s*'([^']+)';/);
        assert(audioKeyMatch, 'AUDIO_SOURCE_KEY não encontrada em public/app.js');
        assert(hintKeyMatch, 'CONTENT_HINT_KEY não encontrada em public/app.js');

        const localMap = new Map([
            [audioKeyMatch[1], 'app'],
            [hintKeyMatch[1], 'detail']
        ]);

        const qualityLabel = { textContent: '' };
        const btnQuality = { title: '' };
        const radios = {
            exclude_discord: { value: 'exclude_discord', checked: true, closest: () => ({ classList: { toggle() {} }, style: {} }) },
            app: { value: 'app', checked: false, closest: () => ({ classList: { toggle() {} }, style: {} }) },
            system: { value: 'system', checked: false, closest: () => ({ classList: { toggle() {} }, style: {} }) },
            none: { value: 'none', checked: false, closest: () => ({ classList: { toggle() {} }, style: {} }) }
        };
        const radioList = Object.values(radios);

        const sandbox = {
            Boolean,
            Number,
            AUDIO_SOURCE_KEY: audioKeyMatch[1],
            CONTENT_HINT_KEY: hintKeyMatch[1],
            contentHintMode: 'motion',
            selectedVideoResolution: '1080p',
            selectedVideoFps: 60,
            localStream: null,
            peers: new Map(),
            qualityModeLabel: qualityLabel,
            btnQualityToggle: btnQuality,
            audioSourceExcludeDiscord: radios.exclude_discord,
            audioSourceApp: radios.app,
            audioSourceSystem: radios.system,
            audioSourceNone: radios.none,
            appSelectorContainer: { style: { display: 'none' } },
            shareConfigModal: { style: { display: 'none' }, removeAttribute() {} },
            localStorage: {
                getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
                setItem: (k, v) => localMap.set(k, String(v))
            },
            document: {
                querySelector: (sel) => {
                    if (sel === 'input[name="audioSourceType"]:checked') {
                        return radioList.find((r) => r.checked) || null;
                    }
                    return null;
                },
                querySelectorAll: (sel) => (sel === 'input[name="audioSourceType"]' ? radioList : [])
            },
            isDesktopApp: () => true,
            updateEchoWarningVisibility() {},
            checkDiscordStatus() {},
            fetchWindowList() {}
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'loadSavedClientPreferences'), sandbox);
        vm.runInContext(extractFn(appJs, 'applyQualityModeUI'), sandbox);
        vm.runInContext(extractFn(appJs, 'toggleQualityMode'), sandbox);
        vm.runInContext(extractFn(appJs, 'openShareConfigModal'), sandbox);

        sandbox.loadSavedClientPreferences();
        assert.strictEqual(sandbox.contentHintMode, 'detail', 'Deve restaurar contentHintMode=detail do localStorage');
        assert.strictEqual(qualityLabel.textContent, 'Nítido');

        sandbox.toggleQualityMode();
        assert.strictEqual(sandbox.contentHintMode, 'motion');
        assert.strictEqual(localMap.get(hintKeyMatch[1]), 'motion', 'toggleQualityMode deve salvar no localStorage');

        sandbox.openShareConfigModal();
        assert.strictEqual(radios.app.checked, true, 'openShareConfigModal em Desktop deve restaurar áudio salvo (app)');
        assert.strictEqual(sandbox.appSelectorContainer.style.display, 'flex');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T4 (Item E - limpeza): disposeTileElement centralizado e sem systemCard.style.border inline
    process.stdout.write('  [Teste] T4 (Item E): disposeTileElement unifica cleanup e remove borda inline residual ... ');
    try {
        assert(!/systemCard\.style\.border\s*=/.test(appJs), 'openShareConfigModal não deve definir systemCard.style.border inline');

        let unmuteCleaned = 0;
        let removedCount = 0;
        let exitFsCalls = 0;
        const videoEl = { srcObject: { id: 'stream-1' } };
        const tileEl = {
            _cleanupTapUnmute: () => { unmuteCleaned += 1; },
            querySelector: (sel) => (sel === 'video' ? videoEl : null),
            remove: () => { removedCount += 1; }
        };

        const sandbox = {
            Promise,
            document: {
                fullscreenElement: tileEl,
                exitFullscreen: () => {
                    exitFsCalls += 1;
                    return Promise.resolve();
                }
            }
        };

        vm.createContext(sandbox);
        vm.runInContext(extractFn(appJs, 'disposeTileElement'), sandbox);
        sandbox.disposeTileElement(tileEl);

        assert.strictEqual(unmuteCleaned, 1);
        assert.strictEqual(videoEl.srcObject, null);
        assert.strictEqual(exitFsCalls, 1);
        assert.strictEqual(removedCount, 1);

        const cleanupSrc = extractFn(appJs, 'cleanupRoomState');
        const removePeerSrc = extractFn(appJs, 'removePeerConnection');
        const removeTileSrc = extractFn(appJs, 'removeStreamTile');
        assert(cleanupSrc.includes('disposeTileElement('), 'cleanupRoomState deve usar disposeTileElement');
        assert(removePeerSrc.includes('disposeTileElement('), 'removePeerConnection deve usar disposeTileElement');
        assert(removeTileSrc.includes('disposeTileElement('), 'removeStreamTile deve usar disposeTileElement');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T5 (Item E - CSP Web): server.js envia Content-Security-Policy seguro
    process.stdout.write('  [Teste] T5 (Item E): server.js envia Content-Security-Policy em GET / e /health ... ');
    try {
        const { server } = require('../server.js');
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        try {
            const res = await httpGet(`http://127.0.0.1:${port}/`);
            const csp = res.headers['content-security-policy'];
            assert(typeof csp === 'string' && csp.length > 0, 'Header Content-Security-Policy ausente');
            assert(csp.includes("default-src 'self'"), 'CSP deve definir default-src self');
            assert(csp.includes("script-src 'self' blob:"), 'CSP deve restringir script-src a self e blob:');
            assert(!csp.includes("'unsafe-inline'") || !csp.match(/script-src[^;]*'unsafe-inline'/), 'script-src não deve permitir unsafe-inline');
            assert(csp.includes("object-src 'none'"), 'CSP deve bloquear object-src');
            assert(csp.includes("frame-ancestors 'none'"), 'CSP deve bloquear frame-ancestors');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Todos os 5 testes passaram com sucesso!');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests();

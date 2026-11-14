const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    if (!match) {
        throw new Error(`Função ${name} não encontrada em public/app.js`);
    }
    return match[0];
}

function extractDomContentLoaded(source) {
    const match = source.match(/window\.addEventListener\('DOMContentLoaded'[\s\S]*?\n\}\);/);
    if (!match) {
        throw new Error("Handler window.addEventListener('DOMContentLoaded') não encontrado em public/app.js");
    }
    return match[0];
}

function createSignalingHarness(appJs, {
    locationHref = 'https://screenshare-p2p.onrender.com/',
    initialStorage = {},
    isDesktop = false
} = {}) {
    const urlObj = new URL(locationHref);
    const storageMap = new Map(Object.entries(initialStorage));
    const setItemCalls = [];
    const removeItemCalls = [];
    const replacedUrls = [];
    const domListeners = {};

    const windowObj = {
        location: {
            protocol: urlObj.protocol,
            origin: urlObj.origin,
            hostname: urlObj.hostname,
            pathname: urlObj.pathname,
            search: urlObj.search,
            hash: urlObj.hash
        },
        history: {
            state: null,
            replaceState(state, _title, url) {
                replacedUrls.push({ state, url });
                const next = new URL(url, urlObj.origin);
                windowObj.location.pathname = next.pathname;
                windowObj.location.search = next.search;
                windowObj.location.hash = next.hash;
            }
        },
        addEventListener(event, fn) {
            domListeners[event] = fn;
        }
    };

    if (isDesktop) {
        windowObj.__TAURI__ = {};
    }

    const sandbox = {
        URL,
        URLSearchParams,
        SERVER_URL_STORAGE_KEY: 'streamgrid_server_url',
        STORAGE_KEY: 'screenshare_room_id',
        window: windowObj,
        localStorage: {
            getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
            setItem: (k, v) => {
                setItemCalls.push({ k, v: String(v) });
                storageMap.set(k, String(v));
            },
            removeItem: (k) => {
                removeItemCalls.push(k);
                storageMap.delete(k);
            }
        },
        // Mocks mínimos para o handler DOMContentLoaded
        initTheme: () => {},
        inputCreateRoomPassword: { value: '' },
        inputJoinRoomPassword: { value: '' },
        inputJoinRoomId: { value: '' },
        sanitizeRoomId: (s) => (s || '').trim().toLowerCase(),
        joinRoom: () => {},
        openRoomModal: () => {},
        showRoomError: () => {}
    };

    vm.createContext(sandbox);
    vm.runInContext(extractFn(appJs, 'isDesktopApp'), sandbox);
    vm.runInContext(extractFn(appJs, 'resolveSignalingServerUrl'), sandbox);
    vm.runInContext(extractDomContentLoaded(appJs), sandbox);

    return {
        sandbox,
        storageMap,
        setItemCalls,
        removeItemCalls,
        replacedUrls,
        domListeners
    };
}

function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: SEGURANÇA DE URL DE SINALIZAÇÃO & ?pass=');
    console.log('===============================================================\n');

    let failures = 0;
    const { loadClientBundleSource } = require('./helpers/client-source');
    const appJs = loadClientBundleSource();
    // T1: Web rejeita ?server=https://evil.com, retorna origin e não grava em localStorage
    process.stdout.write('  [Teste] T1: Web rejeita ?server=https://evil.com e não grava em localStorage ... ');
    try {
        const h = createSignalingHarness(appJs, {
            locationHref: 'https://screenshare-p2p.onrender.com/?room=abc&server=https://evil.com'
        });
        const resolved = h.sandbox.resolveSignalingServerUrl();
        assert.strictEqual(resolved, 'https://screenshare-p2p.onrender.com');
        assert.strictEqual(h.setItemCalls.length, 0, 'Não deve gravar ?server= em localStorage');
        assert.strictEqual(h.storageMap.has('streamgrid_server_url'), false);
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2: Web rejeita http://evil.com, credenciais embutidas e esquemas inválidos
    process.stdout.write('  [Teste] T2: Web rejeita ?server=http://evil.com e URL com credenciais embutidas ... ');
    try {
        const hHttp = createSignalingHarness(appJs, {
            locationHref: 'https://screenshare-p2p.onrender.com/?server=http://evil.com'
        });
        assert.strictEqual(hHttp.sandbox.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
        assert.strictEqual(hHttp.setItemCalls.length, 0);

        const hCreds = createSignalingHarness(appJs, {
            locationHref: 'https://screenshare-p2p.onrender.com/?server=https://user:pass@screenshare-p2p.onrender.com'
        });
        assert.strictEqual(hCreds.sandbox.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
        assert.strictEqual(hCreds.setItemCalls.length, 0);

        const hSameOriginWithPath = createSignalingHarness(appJs, {
            locationHref: 'https://screenshare-p2p.onrender.com/?server=https://screenshare-p2p.onrender.com/custom?x=1'
        });
        assert.strictEqual(hSameOriginWithPath.sandbox.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
        assert.strictEqual(hSameOriginWithPath.setItemCalls.length, 0);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T3: Web aceita loopback ?server=http://localhost:3000 sem persistir em localStorage
    process.stdout.write('  [Teste] T3: Web aceita loopback local sem persistir em localStorage ... ');
    try {
        for (const loopbackUrl of [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://[::1]:3000'
        ]) {
            const h = createSignalingHarness(appJs, {
                locationHref: `https://screenshare-p2p.onrender.com/?server=${encodeURIComponent(loopbackUrl)}`
            });
            const resolved = h.sandbox.resolveSignalingServerUrl();
            assert.strictEqual(resolved, loopbackUrl, `Deveria aceitar loopback ${loopbackUrl}`);
            assert.strictEqual(h.setItemCalls.length, 0, 'Loopback via ?server= não deve persistir em localStorage');
        }
        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T4: Desktop aceita https remoto na sessão e valida/limpa localStorage
    process.stdout.write('  [Teste] T4: Desktop aceita https remoto e remove valores inseguros do localStorage ... ');
    try {
        // 4a. ?server=https://meu-servidor.example.com aceito sem gravar em localStorage
        const hParam = createSignalingHarness(appJs, {
            locationHref: 'http://tauri.localhost/?server=https://meu-servidor.example.com/path/',
            isDesktop: true
        });
        assert.strictEqual(hParam.sandbox.resolveSignalingServerUrl(), 'https://meu-servidor.example.com');
        assert.strictEqual(hParam.setItemCalls.length, 0, 'Query ?server= no Desktop não deve auto-persistir');

        // 4b. Valor válido em localStorage é aceito e normalizado
        const hValidStorage = createSignalingHarness(appJs, {
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'https://meu-servidor.example.com/sub/' },
            isDesktop: true
        });
        assert.strictEqual(hValidStorage.sandbox.resolveSignalingServerUrl(), 'https://meu-servidor.example.com');
        assert.strictEqual(hValidStorage.removeItemCalls.length, 0);

        // 4c. Valor inválido http://remoto-inseguro.com é descartado e removido do localStorage
        const hHttpStorage = createSignalingHarness(appJs, {
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'http://remoto-inseguro.com' },
            isDesktop: true
        });
        assert.strictEqual(hHttpStorage.sandbox.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
        assert.strictEqual(hHttpStorage.removeItemCalls.includes('streamgrid_server_url'), true);
        assert.strictEqual(hHttpStorage.storageMap.has('streamgrid_server_url'), false);

        // 4d. Valor com credenciais embutidas também é removido do localStorage
        const hCredStorage = createSignalingHarness(appJs, {
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'https://user:secret@meu-servidor.example.com' },
            isDesktop: true
        });
        assert.strictEqual(hCredStorage.sandbox.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
        assert.strictEqual(hCredStorage.removeItemCalls.includes('streamgrid_server_url'), true);
        assert.strictEqual(hCredStorage.storageMap.has('streamgrid_server_url'), false);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T5: DOMContentLoaded remove ?pass= da URL via replaceState preservando ?room=
    process.stdout.write('  [Teste] T5: DOMContentLoaded remove ?pass= via replaceState mantendo ?room= ... ');
    try {
        const h = createSignalingHarness(appJs, {
            locationHref: 'https://screenshare-p2p.onrender.com/?room=sala-casal&pass=segredo123'
        });
        h.domListeners['DOMContentLoaded']();

        assert.strictEqual(h.replacedUrls.length, 1, 'Deve chamar history.replaceState uma vez para limpar pass');
        assert.strictEqual(h.replacedUrls[0].url, '/?room=sala-casal');
        assert.strictEqual(h.sandbox.window.location.search, '?room=sala-casal');
        assert.strictEqual(h.sandbox.inputJoinRoomPassword.value, 'segredo123');

        // Também limpa quando há somente ?pass=
        const hOnlyPass = createSignalingHarness(appJs, {
            locationHref: 'https://screenshare-p2p.onrender.com/?pass=segredo123'
        });
        hOnlyPass.domListeners['DOMContentLoaded']();
        assert.strictEqual(hOnlyPass.replacedUrls.length, 1);
        assert.strictEqual(hOnlyPass.replacedUrls[0].url, '/');
        assert.strictEqual(hOnlyPass.sandbox.window.location.search, '');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests();

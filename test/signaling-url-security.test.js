const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModules() {
    const signalingUrl = await import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/signaling-url.js')).href);
    const roomModalMod = await import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/room-modal.js')).href);
    return { signalingUrl, roomModalMod };
}

function createWindowAndStorage({
    locationHref = 'https://screenshare-p2p.onrender.com/',
    initialStorage = {},
    isDesktop = false
} = {}) {
    const urlObj = new URL(locationHref);
    const storageMap = new Map(Object.entries(initialStorage));
    const setItemCalls = [];
    const removeItemCalls = [];
    const replacedUrls = [];

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
        }
    };

    if (isDesktop) {
        windowObj.__TAURI__ = {};
    }

    const storage = {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => {
            setItemCalls.push({ k, v: String(v) });
            storageMap.set(k, String(v));
        },
        removeItem: (k) => {
            removeItemCalls.push(k);
            storageMap.delete(k);
        }
    };

    return { windowObj, storage, storageMap, setItemCalls, removeItemCalls, replacedUrls };
}

async function withMockedGlobals(windowObj, storage, fn) {
    const prevWindow = global.window;
    const prevStorage = global.localStorage;
    global.window = windowObj;
    global.localStorage = storage;
    try {
        return await fn();
    } finally {
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
        if (prevStorage === undefined) delete global.localStorage;
        else global.localStorage = prevStorage;
    }
}

describe('Segurança de URL de sinalização & ?pass=', () => {
    it('T1: Web rejeita ?server=https://evil.com, retorna origin e não grava em localStorage', async () => {
        const { signalingUrl } = await loadModules();
        const env = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?room=abc&server=https://evil.com'
        });

        await withMockedGlobals(env.windowObj, env.storage, () => {
            const resolved = signalingUrl.resolveSignalingServerUrl();
            assert.strictEqual(resolved, 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(env.setItemCalls.length, 0, 'Não deve gravar ?server= em localStorage');
            assert.strictEqual(env.storageMap.has('streamgrid_server_url'), false);
        });
    });

    it('T2: Web rejeita http://evil.com, credenciais embutidas e esquemas inválidos', async () => {
        const { signalingUrl } = await loadModules();

        const envHttp = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?server=http://evil.com'
        });
        await withMockedGlobals(envHttp.windowObj, envHttp.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envHttp.setItemCalls.length, 0);
        });

        const envCreds = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?server=https://user:pass@screenshare-p2p.onrender.com'
        });
        await withMockedGlobals(envCreds.windowObj, envCreds.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envCreds.setItemCalls.length, 0);
        });

        const envSameOriginPath = createWindowAndStorage({
            locationHref: 'https://screenshare-p2p.onrender.com/?server=https://screenshare-p2p.onrender.com/custom?x=1'
        });
        await withMockedGlobals(envSameOriginPath.windowObj, envSameOriginPath.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envSameOriginPath.setItemCalls.length, 0);
        });
    });

    it('T3: Web aceita loopback local sem persistir em localStorage', async () => {
        const { signalingUrl } = await loadModules();

        for (const loopbackUrl of [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://[::1]:3000'
        ]) {
            const env = createWindowAndStorage({
                locationHref: `https://screenshare-p2p.onrender.com/?server=${encodeURIComponent(loopbackUrl)}`
            });
            await withMockedGlobals(env.windowObj, env.storage, () => {
                const resolved = signalingUrl.resolveSignalingServerUrl();
                assert.strictEqual(resolved, loopbackUrl, `Deveria aceitar loopback ${loopbackUrl}`);
                assert.strictEqual(env.setItemCalls.length, 0, 'Loopback via ?server= não deve persistir em localStorage');
            });
        }
    });

    it('T4: Desktop aceita https remoto na sessão e valida/limpa localStorage', async () => {
        const { signalingUrl } = await loadModules();

        // 4a. ?server=https://meu-servidor.example.com aceito sem gravar em localStorage
        const envParam = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/?server=https://meu-servidor.example.com/path/',
            isDesktop: true
        });
        await withMockedGlobals(envParam.windowObj, envParam.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://meu-servidor.example.com');
            assert.strictEqual(envParam.setItemCalls.length, 0, 'Query ?server= no Desktop não deve auto-persistir');
        });

        // 4b. Valor válido em localStorage é aceito e normalizado
        const envValidStorage = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'https://meu-servidor.example.com/sub/' },
            isDesktop: true
        });
        await withMockedGlobals(envValidStorage.windowObj, envValidStorage.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://meu-servidor.example.com');
            assert.strictEqual(envValidStorage.removeItemCalls.length, 0);
        });

        // 4c. Valor inválido http://remoto-inseguro.com é descartado e removido do localStorage
        const envHttpStorage = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'http://remoto-inseguro.com' },
            isDesktop: true
        });
        await withMockedGlobals(envHttpStorage.windowObj, envHttpStorage.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envHttpStorage.removeItemCalls.includes('streamgrid_server_url'), true);
            assert.strictEqual(envHttpStorage.storageMap.has('streamgrid_server_url'), false);
        });

        // 4d. Valor com credenciais embutidas também é removido do localStorage
        const envCredStorage = createWindowAndStorage({
            locationHref: 'http://tauri.localhost/',
            initialStorage: { streamgrid_server_url: 'https://user:secret@meu-servidor.example.com' },
            isDesktop: true
        });
        await withMockedGlobals(envCredStorage.windowObj, envCredStorage.storage, () => {
            assert.strictEqual(signalingUrl.resolveSignalingServerUrl(), 'https://screenshare-p2p.onrender.com');
            assert.strictEqual(envCredStorage.removeItemCalls.includes('streamgrid_server_url'), true);
            assert.strictEqual(envCredStorage.storageMap.has('streamgrid_server_url'), false);
        });
    });

    it('T5: applyInitialUrlAndRestore remove ?pass= via replaceState mantendo ?room=', async () => {
        const { roomModalMod } = await loadModules();

        function createControllerForHref(locationHref) {
            const env = createWindowAndStorage({ locationHref });
            const dom = {
                inputCreateRoomPassword: { value: '' },
                inputJoinRoomPassword: { value: '' },
                inputJoinRoomId: { value: '' }
            };
            const state = {
                currentRoomId: null,
                currentUserName: ''
            };
            const ctrl = roomModalMod.createRoomModalController({
                state,
                dom,
                getSocket: () => ({ connected: true, emit: () => {} }),
                onCleanupRoomState: () => {},
                getMembership: () => ({}),
                showToast: () => {},
                getSessionRoomPassword: () => '',
                clearSessionRoomPassword: () => {},
                onThemeInit: () => {},
                onLoadPreferences: () => {},
                storage: env.storage,
                windowObj: env.windowObj
            });
            return { env, dom, ctrl };
        }

        const withRoom = createControllerForHref('https://screenshare-p2p.onrender.com/?room=sala-casal&pass=segredo123');
        withRoom.ctrl.applyInitialUrlAndRestore();
        assert.strictEqual(withRoom.env.replacedUrls.length, 1, 'Deve chamar history.replaceState uma vez para limpar pass');
        assert.strictEqual(withRoom.env.replacedUrls[0].url, '/?room=sala-casal');
        assert.strictEqual(withRoom.env.windowObj.location.search, '?room=sala-casal');
        assert.strictEqual(withRoom.dom.inputJoinRoomPassword.value, 'segredo123');

        const onlyPass = createControllerForHref('https://screenshare-p2p.onrender.com/?pass=segredo123');
        onlyPass.ctrl.applyInitialUrlAndRestore();
        assert.strictEqual(onlyPass.env.replacedUrls.length, 1);
        assert.strictEqual(onlyPass.env.replacedUrls[0].url, '/');
        assert.strictEqual(onlyPass.env.windowObj.location.search, '');
    });
});

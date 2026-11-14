'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { describe, it } = require('node:test');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const rootDir = path.resolve(__dirname, '..');

async function importClientModule(relPath) {
    return import(pathToFileURL(path.join(rootDir, 'public', 'js', 'modules', relPath)).href);
}

describe('buildInviteUrl, pure module imports & initApp #btnCopyLink integration', () => {
    it('returns serverUrl/?room=... in Tauri desktop mode instead of tauri.localhost', async () => {
        const { buildInviteUrl } = await importClientModule('signaling-url.js');
        assert.equal(typeof buildInviteUrl, 'function');

        const url = buildInviteUrl({
            roomId: 'sala-casal',
            password: 'seg redo',
            isDesktop: true,
            serverUrl: 'https://screenshare-p2p.onrender.com',
            origin: 'http://tauri.localhost',
            pathname: '/'
        });
        assert.equal(url, 'https://screenshare-p2p.onrender.com/?room=sala-casal#pass=seg%20redo');

        const urlTauriProto = buildInviteUrl({
            roomId: 'sala-2',
            password: '',
            isDesktop: false,
            serverUrl: 'https://custom.example.com/',
            origin: 'tauri://localhost',
            pathname: '/index.html'
        });
        assert.equal(urlTauriProto, 'https://custom.example.com/?room=sala-2');
    });

    it('preserves web origin and pathname in browser mode', async () => {
        const { buildInviteUrl } = await importClientModule('signaling-url.js');

        const url = buildInviteUrl({
            roomId: 'casal-1',
            password: '123',
            isDesktop: false,
            serverUrl: 'https://screenshare-p2p.onrender.com',
            origin: 'https://screenshare-p2p.onrender.com',
            pathname: '/'
        });
        assert.equal(url, 'https://screenshare-p2p.onrender.com/?room=casal-1#pass=123');

        const subpathUrl = buildInviteUrl({
            roomId: 'team',
            password: '',
            isDesktop: false,
            serverUrl: 'https://example.org',
            origin: 'https://example.org',
            pathname: '/app/'
        });
        assert.equal(subpathUrl, 'https://example.org/app/?room=team');
    });

    it('imports all client modules cleanly in Node without undeclared globals', async () => {
        const modules = [
            'desktop-audio.js',
            'ice-config.js',
            'qos.js',
            'room-utils.js',
            'sdp.js',
            'signaling-url.js',
            'tile-dom.js',
            'ui-feedback.js'
        ];
        const loaded = {};
        for (const name of modules) {
            loaded[name] = await importClientModule(name);
            assert.equal(typeof loaded[name], 'object');
        }

        assert.equal(loaded['qos.js'].getMaxBitrateForPeerCount(), 6_000_000);
        assert.equal(loaded['qos.js'].getMaxBitrateForPeerCount(2, '720p', 30), 810_000);

        let fsNotified = 0;
        loaded['tile-dom.js'].registerFullscreenChangeHandler(() => { fsNotified++; });
        const mockTile = {
            classList: {
                set: new Set(),
                contains(c) { return this.set.has(c); },
                add(c) { this.set.add(c); },
                remove(c) { this.set.delete(c); }
            },
            querySelector() { return {}; }
        };
        loaded['tile-dom.js'].enterPseudoFullscreen(mockTile);
        assert.equal(fsNotified, 1);
        loaded['tile-dom.js'].registerFullscreenChangeHandler(null);
    });

    it('wires #btnCopyLink through initApp() in Web and Tauri Desktop modes and tears down cleanly', async () => {
        const appUrl = pathToFileURL(path.join(rootDir, 'public', 'app.js')).href;
        const { initApp } = await import(`${appUrl}?smoke=${Date.now()}`);

        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        const copyResetTimers = new Set();
        global.setTimeout = (fn, ms) => {
            if (ms === 2500) {
                const handle = { fn };
                copyResetTimers.add(handle);
                return handle;
            }
            return origSetTimeout(fn, ms);
        };
        global.clearTimeout = (id) => {
            if (copyResetTimers.has(id)) {
                copyResetTimers.delete(id);
                return;
            }
            return origClearTimeout(id);
        };

        try {
            // Desktop mode (#btnCopyLink inside http://tauri.localhost uses serverUrl)
            const desktopClipboard = [];
            const btnCopyDesktop = createMockElement('button', {
                id: 'btnCopyLink',
                innerHTML: '<i class="fa-solid fa-link"></i> <span class="btn-text">Copiar Link</span>'
            });
            const appDesktop = initApp({
                windowObj: {
                    __TAURI_INTERNALS__: {},
                    location: { protocol: 'http:', origin: 'http://tauri.localhost', pathname: '/', search: '', hash: '' },
                    addEventListener() {},
                    removeEventListener() {},
                    matchMedia: () => ({ matches: false })
                },
                documentObj: createMockDocument({ btnCopyLink: btnCopyDesktop }),
                navigatorObj: { clipboard: { writeText: async (txt) => { desktopClipboard.push(txt); } } },
                storage: createMockStorage(),
                ioFactory: () => ({ id: 'd1', connected: false, on() {}, emit() {}, disconnect() {} }),
                serverUrl: 'https://screenshare-p2p.onrender.com'
            });

            try {
                appDesktop.state.roomId = 'desktop-room';
                appDesktop.state.currentRoomPassword = 'abc';
                btnCopyDesktop.click();
                await Promise.resolve();
                assert.equal(desktopClipboard[0], 'https://screenshare-p2p.onrender.com/?room=desktop-room#pass=abc');
            } finally {
                appDesktop.teardownClientSession();
            }

            // Web mode (#btnCopyLink preserves web origin + pathname)
            const webClipboard = [];
            const btnCopyWeb = createMockElement('button', {
                id: 'btnCopyLink',
                innerHTML: '<i class="fa-solid fa-link"></i> <span class="btn-text">Copiar Link</span>'
            });
            const appWeb = initApp({
                windowObj: {
                    location: { protocol: 'https:', origin: 'https://web.example.com', pathname: '/stream/', search: '', hash: '' },
                    addEventListener() {},
                    removeEventListener() {},
                    matchMedia: () => ({ matches: false })
                },
                documentObj: createMockDocument({ btnCopyLink: btnCopyWeb }),
                navigatorObj: { clipboard: { writeText: async (txt) => { webClipboard.push(txt); } } },
                storage: createMockStorage(),
                ioFactory: () => ({ id: 'w1', connected: false, on() {}, emit() {}, disconnect() {} }),
                serverUrl: 'https://web.example.com'
            });

            try {
                appWeb.state.roomId = 'web-room';
                appWeb.state.currentRoomPassword = '';
                btnCopyWeb.click();
                await Promise.resolve();
                assert.equal(webClipboard[0], 'https://web.example.com/stream/?room=web-room');
            } finally {
                appWeb.teardownClientSession();
            }
        } finally {
            copyResetTimers.clear();
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
        }
    });
});

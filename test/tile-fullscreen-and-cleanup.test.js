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

function createTileMock(peerId, videoObj, onCleanup) {
    const classes = new Set(['stream-tile']);
    const tile = {
        dataset: { peerId },
        inDom: true,
        removed: false,
        children: [],
        _cleanupTapUnmute: onCleanup || null,
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c)
        },
        appendChild: (c) => tile.children.push(c),
        querySelector: (sel) => {
            if (sel === 'video') return videoObj;
            if (sel === '.btn-exit-pseudo-fs') return tile.children.find((c) => c.className === 'btn-exit-pseudo-fs') || null;
            return null;
        },
        remove: () => {
            tile.inDom = false;
            tile.removed = true;
        }
    };
    return tile;
}

function createHarness() {
    const peers = new Map();
    let exitFullscreenCalls = 0;

    class MockMediaStream {
        constructor(tracks = []) { this._tracks = tracks; }
        getTracks() { return this._tracks; }
        getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
    }

    const doc = {
        hidden: false,
        fullscreenElement: null,
        webkitFullscreenElement: null,
        _listeners: {},
        addEventListener(ev, fn) { this._listeners[ev] = fn; },
        createElement(tag) {
            return {
                tagName: tag,
                className: '',
                innerHTML: '',
                title: '',
                addEventListener() {},
                remove() {}
            };
        },
        querySelector(sel) {
            if (sel === '.stream-tile.pseudo-fullscreen') {
                for (const peerObj of peers.values()) {
                    if (peerObj.tileEl && peerObj.tileEl.inDom && peerObj.tileEl.classList.contains('pseudo-fullscreen')) {
                        return peerObj.tileEl;
                    }
                }
                return null;
            }
            return null;
        },
        exitFullscreen() {
            exitFullscreenCalls++;
            doc.fullscreenElement = null;
            return Promise.resolve();
        }
    };

    const sandbox = {
        Map,
        Set,
        Promise,
        MediaStream: MockMediaStream,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        peers,
        document: doc,
        clearPeerTimers() {},
        updateGridState() {},
        clearInterval() {},
        clearTimeout() {}
    };

    vm.createContext(sandbox);
    const code = [
        extractFn(appJs, 'disposeTileElement'),
        extractFn(appJs, 'updateBackgroundTracksOptimization'),
        extractFn(appJs, 'removePeerConnection'),
        extractFn(appJs, 'removeStreamTile'),
        extractFn(appJs, 'toggleTileFullscreen'),
        extractFn(appJs, 'enterPseudoFullscreen')
    ].join('\n\n');
    vm.runInContext(code, sandbox, { filename: 'public/app.js' });

    return {
        sandbox,
        peers,
        doc,
        MockMediaStream,
        getExitFullscreenCalls: () => exitFullscreenCalls
    };
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: FULLSCREEN, BACKGROUND TRACKS & CLEANUP');
    console.log('===============================================================\n');

    // T1: removeStreamTile on fullscreen tile exits fullscreen, runs _cleanupTapUnmute, nulls srcObject, and re-enables other peers
    process.stdout.write('  [Teste] T1: removeStreamTile em tile fullscreen reabilita tracks de outros peers ... ');
    {
        const h = createHarness();
        let cleanupCalled = 0;
        const videoA = { srcObject: { id: 'stream-a' } };
        const tileA = createTileMock('peer-a', videoA, () => { cleanupCalled++; });
        const trackA = { kind: 'video', enabled: true, stop() {} };
        const trackB = { kind: 'video', enabled: true, stop() {} };

        h.peers.set('peer-a', {
            pc: { close() {} },
            stream: new h.MockMediaStream([trackA]),
            tileEl: tileA
        });
        h.peers.set('peer-b', {
            pc: { close() {} },
            stream: new h.MockMediaStream([trackB]),
            tileEl: createTileMock('peer-b', { srcObject: { id: 'stream-b' } })
        });

        // Put peer-a into pseudo-fullscreen + native fullscreenElement
        h.sandbox.enterPseudoFullscreen(tileA);
        h.doc.fullscreenElement = tileA;
        assert.strictEqual(trackB.enabled, false, 'Peer B should be disabled while Peer A is fullscreen');

        h.sandbox.removeStreamTile('peer-a');

        assert.strictEqual(cleanupCalled, 1, '_cleanupTapUnmute must be invoked');
        assert.strictEqual(videoA.srcObject, null, 'videoA.srcObject must be nulled');
        assert.strictEqual(tileA.removed, true, 'tileA must be removed');
        assert.strictEqual(h.getExitFullscreenCalls(), 1, 'document.exitFullscreen must be called');
        assert.strictEqual(trackB.enabled, true, 'Peer B video track must be re-enabled after Peer A tile removal');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: removePeerConnection on fullscreen peer cleans up tile & re-enables remaining peers
    process.stdout.write('  [Teste] T2: removePeerConnection em peer fullscreen limpa listeners e restaura tracks ... ');
    {
        const h = createHarness();
        let cleanupCalled = 0;
        const videoA = { srcObject: { id: 'stream-a' } };
        const tileA = createTileMock('peer-a', videoA, () => { cleanupCalled++; });
        const trackA = { kind: 'video', enabled: true, stop() {} };
        const trackB = { kind: 'video', enabled: true, stop() {} };

        h.peers.set('peer-a', {
            pc: { close() {} },
            stream: new h.MockMediaStream([trackA]),
            tileEl: tileA
        });
        h.peers.set('peer-b', {
            pc: { close() {} },
            stream: new h.MockMediaStream([trackB]),
            tileEl: createTileMock('peer-b', { srcObject: { id: 'stream-b' } })
        });

        h.sandbox.enterPseudoFullscreen(tileA);
        assert.strictEqual(trackB.enabled, false);

        h.sandbox.removePeerConnection('peer-a');

        assert.strictEqual(h.peers.has('peer-a'), false);
        assert.strictEqual(cleanupCalled, 1);
        assert.strictEqual(videoA.srcObject, null);
        assert.strictEqual(tileA.removed, true);
        assert.strictEqual(trackB.enabled, true, 'Remaining peer track must be re-enabled');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: toggleTileFullscreen safely handles legacy non-Promise returns and sync throws
    process.stdout.write('  [Teste] T3: toggleTileFullscreen trata retorno undefined e throw síncrono sem crash ... ');
    {
        const h = createHarness();

        // Case A: webkitRequestFullscreen returns undefined (does not throw .catch on undefined)
        const tileLegacy = createTileMock('peer-legacy', { srcObject: null });
        tileLegacy.webkitRequestFullscreen = () => undefined;
        assert.doesNotThrow(() => h.sandbox.toggleTileFullscreen(tileLegacy));

        // Case B: webkitRequestFullscreen throws synchronously -> falls back to pseudo-fullscreen
        const tileThrow = createTileMock('peer-throw', { srcObject: null });
        tileThrow.webkitRequestFullscreen = () => { throw new Error('Fullscreen disallowed'); };
        assert.doesNotThrow(() => h.sandbox.toggleTileFullscreen(tileThrow));
        assert.strictEqual(tileThrow.classList.contains('pseudo-fullscreen'), true, 'Sync throw must fall back to pseudo-fullscreen');

        // Case C: legacy exitFullscreen returning undefined
        h.doc.fullscreenElement = tileLegacy;
        h.doc.exitFullscreen = () => undefined;
        assert.doesNotThrow(() => h.sandbox.toggleTileFullscreen(tileLegacy));
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    console.log('\n===============================================================');
    console.log('  ✅ Resultado: Todos os testes de fullscreen e cleanup passaram.');
    console.log('===============================================================\n');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.resolve(__dirname, '../public/app.js');
const stylePath = path.resolve(__dirname, '../public/style.css');

const { loadClientBundleSource } = require('./helpers/client-source');
const appJs = loadClientBundleSource();
const styleCss = fs.readFileSync(stylePath, 'utf8');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Function ${name} not found in public/app.js`);
    return match[0];
}

function extractSocketHandler(source, eventName) {
    const regex = new RegExp(`socket\\.on\\('${eventName}'[\\s\\S]*?\\n\\}\\);`);
    const match = source.match(regex);
    assert(match, `Handler socket.on('${eventName}') not found in public/app.js`);
    return match[0];
}

function createMockElement(tagName) {
    const listeners = {};
    const classes = new Set();
    const attrs = new Map();
    const el = {
        tagName: tagName.toUpperCase(),
        className: '',
        innerHTML: '',
        textContent: '',
        title: '',
        type: '',
        min: '',
        max: '',
        step: '',
        value: '',
        muted: false,
        volume: 1,
        dataset: {},
        style: {},
        children: [],
        parentNode: null,
        classList: {
            add: (...cls) => cls.forEach((c) => classes.add(c)),
            remove: (...cls) => cls.forEach((c) => classes.delete(c)),
            contains: (c) => classes.has(c)
        },
        setAttribute(k, v) {
            attrs.set(String(k), String(v));
            if (k === 'muted') this.muted = true;
        },
        removeAttribute(k) {
            attrs.delete(String(k));
            if (k === 'muted') this.muted = false;
        },
        getAttribute(k) {
            return attrs.has(String(k)) ? attrs.get(String(k)) : null;
        },
        hasAttribute(k) {
            return attrs.has(String(k));
        },
        appendChild(child) {
            child.parentNode = el;
            el.children.push(child);
            return child;
        },
        remove() {
            if (el.parentNode) {
                el.parentNode.children = el.parentNode.children.filter((c) => c !== el);
                el.parentNode = null;
            }
        },
        addEventListener(type, fn) {
            listeners[type] = listeners[type] || [];
            listeners[type].push(fn);
        },
        dispatchEvent(evt) {
            const event = typeof evt === 'string' ? { type: evt } : { ...evt };
            event.target = event.target || el;
            event.stopPropagation = event.stopPropagation || (() => {});
            (listeners[event.type] || []).forEach((fn) => fn.call(el, event));
        },
        querySelector(sel) {
            const walk = (node) => {
                for (const child of node.children) {
                    if (sel.startsWith('.')) {
                        const cls = sel.slice(1);
                        if (child.classList.contains(cls) || child.className.split(/\s+/).includes(cls)) {
                            return child;
                        }
                    } else if (child.tagName === sel.toUpperCase()) {
                        return child;
                    }
                    const nested = walk(child);
                    if (nested) return nested;
                }
                return null;
            };
            return walk(el);
        }
    };
    return el;
}

function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: CONEXÃO OFFLINE, VOLUME & HUD DOS TILES');
    console.log('===============================================================\n');

    // T1: Socket connection lifecycle toasts + offline joinRoom feedback
    process.stdout.write('  [Teste] T1: Toasts de disconnect, connect_error (sem spam), reconnect e joinRoom offline ... ');
    {
        const toasts = [];
        const socketHandlers = {};
        const emitted = [];
        const socket = {
            id: 'sock-test-1',
            connected: false,
            on(event, fn) {
                socketHandlers[event] = fn;
            },
            emit(event, payload) {
                emitted.push({ event, payload });
            }
        };

        const flagsMatch = appJs.match(/let wasSocketDisconnected\s*=\s*false;\r?\nlet hasShownConnectErrorToast\s*=\s*false;/);
        assert(flagsMatch, 'Connection state flags not found in public/app.js');

        const sandbox = {
            console: { log: () => {}, warn: () => {}, error: () => {} },
            socket,
            myId: '',
            roomId: '',
            pendingRoomJoin: null,
            currentRoomPassword: '',
            currentUserName: 'Pedro',
            clientId: 'client-1',
            USERNAME_KEY: 'screenshare_username',
            localStorage: { setItem() {}, getItem: () => null },
            clearRoomError() {},
            openRoomModal() {},
            showRoomError() {},
            sanitizeRoomId: (id) => String(id || '').trim().toLowerCase(),
            generateRandomRoomId: () => 'rand-room',
            showToast: (msg, type, duration) => toasts.push({ msg, type, duration })
        };

        vm.createContext(sandbox);
        const code = [
            flagsMatch[0],
            extractFn(appJs, 'joinRoom'),
            extractSocketHandler(appJs, 'connect'),
            extractSocketHandler(appJs, 'disconnect'),
            extractSocketHandler(appJs, 'connect_error')
        ].join('\n\n');
        vm.runInContext(code, sandbox, { filename: 'public/app.js' });

        // Offline joinRoom stores pendingRoomJoin and shows info toast
        sandbox.joinRoom('minha-sala', '1234', 'Pedro');
        assert(sandbox.pendingRoomJoin && sandbox.pendingRoomJoin.roomId === 'minha-sala', 'pendingRoomJoin must be stored offline');
        assert.strictEqual(emitted.length, 0, 'Must not emit join-room while disconnected');
        assert.strictEqual(toasts.length, 1);
        assert.strictEqual(toasts[0].type, 'info');

        // Consecutive connect_error events only show 1 error toast
        socketHandlers.connect_error(new Error('timeout'));
        socketHandlers.connect_error(new Error('timeout 2'));
        assert.strictEqual(toasts.filter((t) => t.type === 'error').length, 1, 'connect_error must not spam toasts');

        const getFlags = () => vm.runInContext('({ wasSocketDisconnected, hasShownConnectErrorToast })', sandbox);

        // Initial connect after connect_error shows success toast and clears flag
        socket.connected = true;
        socketHandlers.connect();
        assert.strictEqual(emitted.length, 1, 'Pending room must be emitted on connect');
        assert.strictEqual(toasts[toasts.length - 1].type, 'success');
        assert.strictEqual(getFlags().hasShownConnectErrorToast, false);

        // Intentional client disconnect does NOT show warning toast
        const countBeforeClientDisconnect = toasts.length;
        socketHandlers.disconnect('io client disconnect');
        assert.strictEqual(toasts.length, countBeforeClientDisconnect, 'Intentional disconnect must not warn');

        // Unexpected disconnect shows warning toast and sets wasSocketDisconnected
        socketHandlers.disconnect('transport close');
        assert.strictEqual(toasts[toasts.length - 1].type, 'warning');
        assert.strictEqual(getFlags().wasSocketDisconnected, true);

        // Reconnect after unexpected disconnect shows success toast and resets flags
        socketHandlers.connect_error(new Error('retry'));
        socketHandlers.connect();
        assert.strictEqual(toasts[toasts.length - 1].type, 'success');
        assert.strictEqual(getFlags().wasSocketDisconnected, false);
        assert.strictEqual(getFlags().hasShownConnectErrorToast, false);
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: createStreamTile remembers last non-zero volume and sets aria-label on dynamic controls
    process.stdout.write('  [Teste] T2: createStreamTile preserva último volume não-zero e define aria-label ... ');
    {
        const sandbox = {
            navigator: { userAgent: 'Mozilla/5.0' },
            updateBackgroundTracksOptimization() {},
            toggleTileFullscreen() {},
            document: {
                createElement: (tag) => createMockElement(tag)
            }
        };

        vm.createContext(sandbox);
        const code = [
            extractFn(appJs, 'createStreamTile'),
            extractFn(appJs, 'enterPseudoFullscreen')
        ].join('\n\n');
        vm.runInContext(code, sandbox, { filename: 'public/app.js' });

        const tile = sandbox.createStreamTile('peer-vol', { id: 's-vol' }, 'Ana', false);
        const video = tile.querySelector('video');
        const overlay = tile.querySelector('.tile-controls-overlay');
        const buttons = overlay.children.filter((c) => c.tagName === 'BUTTON');
        const slider = overlay.children.find((c) => c.tagName === 'INPUT');
        const [muteBtn, fsBtn] = buttons;

        assert.strictEqual(muteBtn.getAttribute('aria-label'), 'Silenciar / Ativar Som');
        assert.strictEqual(slider.getAttribute('aria-label'), 'Volume');
        assert.strictEqual(fsBtn.getAttribute('aria-label'), 'Tela Cheia');

        // Adjust volume to 0.35, mute via button, then unmute via button -> restores 0.35
        slider.value = '0.35';
        slider.dispatchEvent({ type: 'input', target: slider });
        assert.strictEqual(video.volume, 0.35);

        muteBtn.dispatchEvent({ type: 'click' });
        assert.strictEqual(video.muted, true);
        assert.strictEqual(slider.value, '0');

        muteBtn.dispatchEvent({ type: 'click' });
        assert.strictEqual(video.muted, false);
        assert.strictEqual(video.volume, 0.35, 'Unmuting must restore remembered volume 0.35');
        assert.strictEqual(slider.value, '0.35');

        // Fallback to 1 on a fresh tile muted/unmuted without slider change
        const freshTile = sandbox.createStreamTile('peer-fresh', { id: 's-fresh' }, 'Bob', false);
        const freshVideo = freshTile.querySelector('video');
        const freshOverlay = freshTile.querySelector('.tile-controls-overlay');
        const freshMuteBtn = freshOverlay.children.find((c) => c.tagName === 'BUTTON');
        const freshSlider = freshOverlay.children.find((c) => c.tagName === 'INPUT');

        freshSlider.value = '0';
        freshSlider.dispatchEvent({ type: 'input', target: freshSlider });
        assert.strictEqual(freshVideo.muted, true);

        freshMuteBtn.dispatchEvent({ type: 'click' });
        assert.strictEqual(freshVideo.muted, false);
        assert.strictEqual(freshVideo.volume, 1, 'Fallback volume must be 1 when no non-zero adjustment happened');
        assert.strictEqual(freshSlider.value, '1');

        // enterPseudoFullscreen exitBtn aria-label
        sandbox.enterPseudoFullscreen(tile);
        const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
        assert.strictEqual(exitBtn.getAttribute('aria-label'), 'Sair da Tela Cheia');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: style.css defines consistent translucent dark HUD styling for .tile-controls-overlay .btn-icon
    process.stdout.write('  [Teste] T3: style.css mantém contraste consistente em .tile-controls-overlay .btn-icon ... ');
    {
        const baseMatch = styleCss.match(/\.tile-controls-overlay\s+\.btn-icon\s*\{[\s\S]*?\}/);
        const hoverMatch = styleCss.match(/\.tile-controls-overlay\s+\.btn-icon:hover\s*\{[\s\S]*?\}/);
        assert(baseMatch, 'Missing .tile-controls-overlay .btn-icon rule');
        assert(hoverMatch, 'Missing .tile-controls-overlay .btn-icon:hover rule');
        assert(
            baseMatch[0].includes('rgba(255, 255, 255, 0.1)') &&
            baseMatch[0].includes('color: #f8fafc') &&
            !baseMatch[0].includes('--btn-secondary-bg'),
            '.tile-controls-overlay .btn-icon must use explicit dark-overlay-compatible background/color'
        );
        assert(
            hoverMatch[0].includes('rgba(255, 255, 255, 0.2)') &&
            hoverMatch[0].includes('color: #ffffff'),
            '.tile-controls-overlay .btn-icon:hover must brighten consistently'
        );
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    console.log('\n===============================================================');
    console.log('  ✅ Resultado: Todos os testes de conexão, volume e HUD passaram.');
    console.log('===============================================================\n');
}

runTests();

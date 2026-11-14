'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');

async function loadModules() {
    const [shareModalMod, appMod] = await Promise.all([
        import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/share-config-modal.js')).href),
        import(`${pathToFileURL(path.join(ROOT_DIR, 'public/app.js')).href}?escape=${Date.now()}`)
    ]);
    return { ...shareModalMod, ...appMod };
}

test('shareConfigModal closes on backdrop click (e.target === shareConfigModal) and stays open on inner click', async () => {
    const { createShareConfigModalController } = await loadModules();
    const shareConfigModal = createMockElement('div', { id: 'shareConfigModal' });
    const innerCard = createMockElement('div', { className: 'modal-card' });
    shareConfigModal.appendChild(innerCard);

    const doc = createMockDocument({ shareConfigModal });
    const ctrl = createShareConfigModalController({
        state: { selectedVideoResolution: '1080p', selectedVideoFps: 60 },
        dom: { shareConfigModal },
        isDesktopApp: () => false,
        documentObj: doc,
        storage: createMockStorage()
    });
    ctrl.bindEvents();

    ctrl.openShareConfigModal();
    assert.equal(ctrl.isShareConfigModalOpen(), true);

    // Click inside modal content must NOT close
    shareConfigModal.dispatchEvent({ type: 'click', target: innerCard });
    assert.equal(ctrl.isShareConfigModalOpen(), true, 'Clicking inside modal card must keep modal open');

    // Click directly on backdrop closes modal
    shareConfigModal.dispatchEvent({ type: 'click', target: shareConfigModal });
    assert.equal(ctrl.isShareConfigModalOpen(), false, 'Backdrop click must close shareConfigModal');
});

test('Escape key closes open shareConfigModal via initApp keydown handler', async () => {
    const { initApp } = await loadModules();
    const winListeners = {};
    const shareConfigModal = createMockElement('div', { id: 'shareConfigModal' });
    const statsModal = createMockElement('div', { id: 'statsModal', style: { display: 'none' }, hidden: true });
    const roomModal = createMockElement('div', { id: 'roomModal', style: { display: 'none' }, hidden: true });
    const fakeDoc = createMockDocument({ shareConfigModal, statsModal, roomModal }, {
        createElement: (tag) => createMockElement(tag)
    });

    const app = initApp({
        windowObj: {
            location: { protocol: 'http:', origin: 'http://localhost:3000', pathname: '/', search: '', hash: '' },
            addEventListener(ev, fn) { winListeners[ev] = fn; },
            removeEventListener() {},
            matchMedia: () => ({ matches: false })
        },
        documentObj: fakeDoc,
        navigatorObj: { clipboard: { writeText: async () => {} } },
        storage: createMockStorage(),
        ioFactory: () => ({ id: 's1', connected: false, on() {}, emit() {}, disconnect() {} }),
        serverUrl: 'http://localhost:3000'
    });

    try {
        app.shareConfigCtrl.openShareConfigModal();
        assert.equal(app.shareConfigCtrl.isShareConfigModalOpen(), true);

        assert.equal(typeof winListeners.keydown, 'function', 'initApp must register Escape keydown listener');
        winListeners.keydown({ key: 'Escape' });

        assert.equal(app.shareConfigCtrl.isShareConfigModalOpen(), false, 'Escape key must close open shareConfigModal');
    } finally {
        app.teardownClientSession();
    }
});

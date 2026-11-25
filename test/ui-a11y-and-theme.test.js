'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');
const { ROOT_DIR, loadClientModules } = require('./helpers/client-env');

const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');

function createAudioCardHarness(createShareConfigModalController, { isDesktop = true, initialSelected = 'exclude_discord' } = {}) {
    const cards = {
        exclude_discord: createMockElement('label', { className: `audio-option-card${initialSelected === 'exclude_discord' ? ' is-selected' : ''}` }),
        app: createMockElement('label', { className: `audio-option-card${initialSelected === 'app' ? ' is-selected' : ''}` }),
        system: createMockElement('label', { className: `audio-option-card${initialSelected === 'system' ? ' is-selected' : ''}` }),
        none: createMockElement('label', { className: `audio-option-card${initialSelected === 'none' ? ' is-selected' : ''}` })
    };

    const radios = {};
    const defs = [
        { key: 'exclude_discord', id: 'audioSourceExcludeDiscord' },
        { key: 'app', id: 'audioSourceApp' },
        { key: 'system', id: 'audioSourceSystem' },
        { key: 'none', id: 'audioSourceNone' }
    ];

    for (const def of defs) {
        const radio = createMockElement('input', { id: def.id, name: 'audioSourceType', value: def.key });
        radio.checked = initialSelected === def.key;
        cards[def.key].appendChild(radio);
        radio.triggerChange = () => {
            for (const k of Object.keys(radios)) {
                radios[k].checked = k === def.key;
            }
            radio.dispatchEvent({ type: 'change' });
        };
        radios[def.key] = radio;
    }

    const appSelectorContainer = createMockElement('div', { id: 'appSelectorContainer', hidden: true });
    const appExcludeOptionContainer = createMockElement('div', { id: 'appExcludeOptionContainer', hidden: true });
    const chkExcludeSelectedApp = createMockElement('input', { id: 'chkExcludeSelectedApp', type: 'checkbox', checked: false });
    const btnConfirmStartShare = createMockElement('button', { id: 'btnConfirmStartShare' });
    const shareConfigModal = createMockElement('div', { id: 'shareConfigModal', hidden: true });
    const radioList = [radios.exclude_discord, radios.app, radios.system, radios.none];
    const startedArgs = [];

    const doc = createMockDocument({
        appSelectorContainer,
        appExcludeOptionContainer,
        chkExcludeSelectedApp,
        btnConfirmStartShare,
        shareConfigModal,
        audioSourceExcludeDiscord: radios.exclude_discord,
        audioSourceApp: radios.app,
        audioSourceSystem: radios.system,
        audioSourceNone: radios.none
    });
    doc.querySelector = (sel) => {
        if (sel === 'input[name="audioSourceType"]:checked') {
            return radioList.find((r) => r.checked) || null;
        }
        return null;
    };
    doc.querySelectorAll = (sel) => (sel === 'input[name="audioSourceType"]' ? radioList : []);

    const state = {
        selectedVideoFps: 60,
        selectedVideoResolution: '1080p',
        selectedAudioSource: null,
        excludeSelectedApp: false
    };

    const ctrl = createShareConfigModalController({
        state,
        dom: {
            audioSourceExcludeDiscord: radios.exclude_discord,
            audioSourceApp: radios.app,
            audioSourceSystem: radios.system,
            audioSourceNone: radios.none,
            appSelectorContainer,
            appExcludeOptionContainer,
            chkExcludeSelectedApp,
            btnConfirmStartShare,
            shareConfigModal
        },
        isDesktopApp: () => Boolean(isDesktop),
        updateEchoWarningVisibility: () => {},
        checkDiscordStatus: () => {},
        fetchWindowList: () => {},
        onStartScreenShare: async (...args) => { startedArgs.push(args); },
        documentObj: doc,
        storage: createMockStorage()
    });
    ctrl.bindEvents();

    return {
        ctrl,
        state,
        cards,
        radios,
        appSelectorContainer,
        appExcludeOptionContainer,
        chkExcludeSelectedApp,
        btnConfirmStartShare,
        startedArgs
    };
}

test('openShareConfigModal and change listener toggle .is-selected across cards in Web and Desktop', async () => {
    const { createShareConfigModalController } = await loadClientModules(['share-config-modal']);

    const hWeb = createAudioCardHarness(createShareConfigModalController, { isDesktop: false, initialSelected: 'exclude_discord' });
    hWeb.ctrl.openShareConfigModal();

    assert.equal(hWeb.radios.system.checked, true);
    assert.equal(hWeb.radios.exclude_discord.checked, false);
    assert.equal(hWeb.cards.system.classList.contains('is-selected'), true);
    assert.equal(hWeb.cards.exclude_discord.classList.contains('is-selected'), false);
    assert.equal(hWeb.cards.app.classList.contains('is-selected'), false);
    assert.equal(hWeb.cards.none.classList.contains('is-selected'), false);
    assert.equal(hWeb.appExcludeOptionContainer.hidden, true);

    hWeb.radios.none.triggerChange();
    assert.equal(hWeb.cards.none.classList.contains('is-selected'), true);
    assert.equal(hWeb.cards.system.classList.contains('is-selected'), false);

    hWeb.radios.system.triggerChange();
    await hWeb.btnConfirmStartShare.dispatchEvent({ type: 'click' });
    assert.deepEqual(hWeb.startedArgs[0][4], { excludeApp: false });

    const hDesktop = createAudioCardHarness(createShareConfigModalController, { isDesktop: true, initialSelected: 'app' });
    hDesktop.ctrl.openShareConfigModal();
    assert.equal(hDesktop.cards.app.classList.contains('is-selected'), true);
    assert.equal(hDesktop.cards.exclude_discord.classList.contains('is-selected'), false);
    assert.equal(hDesktop.appSelectorContainer.hidden, false);
    assert.equal(hDesktop.appExcludeOptionContainer.hidden, false);
    assert.equal(hDesktop.chkExcludeSelectedApp.checked, false);

    hDesktop.chkExcludeSelectedApp.checked = true;
    hDesktop.chkExcludeSelectedApp.dispatchEvent({ type: 'change' });
    await hDesktop.btnConfirmStartShare.dispatchEvent({ type: 'click' });
    assert.equal(hDesktop.state.excludeSelectedApp, true);
    assert.deepEqual(hDesktop.startedArgs[0][4], { excludeApp: true });

    hDesktop.radios.exclude_discord.triggerChange();
    assert.equal(hDesktop.cards.exclude_discord.classList.contains('is-selected'), true);
    assert.equal(hDesktop.cards.app.classList.contains('is-selected'), false);
    assert.equal(hDesktop.appSelectorContainer.hidden, true);
    assert.equal(hDesktop.appExcludeOptionContainer.hidden, true);

    hDesktop.radios.system.triggerChange();
    assert.equal(hDesktop.appExcludeOptionContainer.hidden, true);
});

test('initTheme defaults to dark-first even on light OS preference, and respects saved light preference', async () => {
    const { initTheme, toggleTheme, THEME_KEY } = await loadClientModules(['ui-feedback']);
    const btnThemeToggle = createMockElement('button', { id: 'btnThemeToggle' });
    const doc = createMockDocument({ btnThemeToggle });
    const storage = createMockStorage();
    const lightOsWin = { matchMedia: () => ({ matches: false }) };

    initTheme({ windowObj: lightOsWin, documentObj: doc, storage });
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(storage.getItem(THEME_KEY), 'dark');

    toggleTheme({ documentObj: doc, storage });
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(storage.getItem(THEME_KEY), 'light');

    const freshDoc = createMockDocument({ btnThemeToggle });
    initTheme({ windowObj: lightOsWin, documentObj: freshDoc, storage });
    assert.equal(freshDoc.documentElement.getAttribute('data-theme'), 'light');
});

test('index.html has .btn-text wrappers, type="button", role="dialog" aria-modal="true", and aria-label', () => {
    assert.match(indexHtml, /<button[^>]*id="btnCopyLink"[^>]*>[\s\S]*?<span class="btn-text">Copiar Link<\/span>[\s\S]*?<\/button>/);
    assert.match(indexHtml, /<button[^>]*id="btnChangeRoom"[^>]*>[\s\S]*?<span class="btn-text">Trocar Sala<\/span>[\s\S]*?<\/button>/);

    const buttonIdsRequiringType = [
        'btnCopyLink',
        'btnChangeRoom',
        'btnThemeToggle',
        'btnStartShareBig',
        'btnStartShare',
        'btnStopShare',
        'btnCloseShareConfig',
        'btnConfirmStartShare',
        'btnCloseStatsModal'
    ];
    assert.ok(!indexHtml.includes('id="btnQualityToggle"'), 'Legacy #btnQualityToggle must not be present');
    for (const id of buttonIdsRequiringType) {
        const tagMatch = indexHtml.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
        assert(tagMatch, `Button #${id} not found`);
        assert(tagMatch[0].includes('type="button"'), `Button #${id} must have type="button"`);
    }

    for (const modalId of ['roomModal', 'shareConfigModal', 'statsModal']) {
        const modalMatch = indexHtml.match(new RegExp(`<div[^>]*id="${modalId}"[^>]*>`));
        assert(modalMatch, `Modal #${modalId} not found`);
        assert(modalMatch[0].includes('role="dialog"'), `Modal #${modalId} must have role="dialog"`);
        assert(modalMatch[0].includes('aria-modal="true"'), `Modal #${modalId} must have aria-modal="true"`);
    }

    const iconButtonsRequiringAriaLabel = [
        'btnThemeToggle',
        'btnRandomRoom',
        'btnToggleCreatePass',
        'btnToggleJoinPass',
        'btnCloseRoomModal',
        'btnCloseShareConfig',
        'btnRefreshAudioApps',
        'btnCloseStatsModal'
    ];
    for (const id of iconButtonsRequiringAriaLabel) {
        const tagMatch = indexHtml.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
        assert(tagMatch, `Icon button #${id} not found`);
        assert(/aria-label="[^"]+"/.test(tagMatch[0]), `Icon button #${id} must have non-empty aria-label`);
    }
});

test('Generated controls expose type="button", title/aria-label, and Copy Link wraps text in .btn-text', async () => {
    const { createStreamGridController, enterPseudoFullscreen } = await loadClientModules(['stream-grid', 'tile-dom']);

    const btnCopyLink = createMockElement('button', { id: 'btnCopyLink', innerHTML: '<i class="fa-solid fa-link"></i> <span class="btn-text">Copiar Link</span>' });
    const doc = createMockDocument({ btnCopyLink }, { createElement: (tag) => createMockElement(tag) });
    const origSetTimeout = global.setTimeout;
    const pendingTimers = [];
    global.setTimeout = (fn) => { pendingTimers.push(fn); return pendingTimers.length; };

    try {
        const grid = createStreamGridController({
            state: { roomId: 'sala-a11y', currentRoomPassword: 'secret' },
            dom: { btnCopyLink },
            isDesktopApp: () => false,
            getServerUrl: () => 'https://example.com',
            showToast: () => {},
            documentObj: doc,
            windowObj: { location: { origin: 'https://example.com', pathname: '/' } },
            navigatorObj: { userAgent: 'Mozilla/5.0', clipboard: { writeText: async () => {} } }
        });
        grid.bindCopyInviteLink();

        const tile = grid.createStreamTile('peer-1', { id: 'stream-1' }, 'Alice', false);
        const muteBtn = tile.querySelector('.tile-controls-overlay .btn-mute-toggle');
        const pipBtn = tile.querySelector('.tile-controls-overlay .btn-tile-pip');
        const spotlightBtn = tile.querySelector('.tile-controls-overlay .btn-tile-spotlight');
        const overlayButtons = tile.children
            .find((c) => c.className.includes('tile-controls-overlay'))
            .children.filter((c) => c.tagName === 'BUTTON');
        const fsBtn = overlayButtons[overlayButtons.length - 1];

        assert.equal(muteBtn.type, 'button');
        assert.equal(muteBtn.title, 'Silenciar / Ativar Som');
        assert.equal(pipBtn.type, 'button');
        assert.equal(pipBtn.getAttribute('aria-label'), 'Janela Flutuante (PiP)');
        assert.equal(spotlightBtn.type, 'button');
        assert.equal(spotlightBtn.getAttribute('aria-pressed'), 'false');
        assert.equal(fsBtn.type, 'button');

        enterPseudoFullscreen(tile, doc);
        const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
        assert(exitBtn, 'exitBtn must be appended in pseudo-fullscreen');
        assert.equal(exitBtn.type, 'button');

        btnCopyLink.dispatchEvent({ type: 'click' });
        await Promise.resolve();
        assert.ok(btnCopyLink.innerHTML.includes('<span class="btn-text">Link Copiado!</span>'));
    } finally {
        global.setTimeout = origSetTimeout;
    }
});

test('Viewport allows zoom, modals have aria-labelledby, and modal-a11y traps Tab & restores focus', async () => {
    // 1. Viewport without user-scalable=no / maximum-scale=1.0
    const viewportMatch = indexHtml.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);
    assert(viewportMatch, 'viewport meta tag not found');
    assert.equal(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?/i.test(viewportMatch[1]), false);

    // 2. All 3 modals define aria-labelledby pointing to existing title IDs
    const modalTitlePairs = [
        ['roomModal', 'roomModalTitle'],
        ['shareConfigModal', 'shareConfigModalTitle'],
        ['statsModal', 'statsModalTitle']
    ];
    for (const [modalId, titleId] of modalTitlePairs) {
        const modalTag = indexHtml.match(new RegExp(`<div[^>]*id="${modalId}"[^>]*>`));
        assert(modalTag, `Modal #${modalId} not found`);
        assert.ok(modalTag[0].includes(`aria-labelledby="${titleId}"`), `Modal #${modalId} must have aria-labelledby="${titleId}"`);
        assert.ok(indexHtml.includes(`id="${titleId}"`), `Title #${titleId} not found in index.html`);
    }

    // 3. modal-a11y: initial focus, Tab/Shift+Tab wrap, and focus restoration
    const { activateModalFocus, restoreModalFocus, trapModalTabKey } = await loadClientModules(['modal-a11y']);
    const doc = createMockDocument();
    let focusedEl = null;
    const makeFocusable = (tag, props = {}) => {
        const el = createMockElement(tag, props);
        el.focus = () => {
            focusedEl = el;
            doc.activeElement = el;
        };
        return el;
    };

    const triggerBtn = makeFocusable('button', { id: 'triggerBtn' });
    triggerBtn.isConnected = true;
    doc.body.appendChild(triggerBtn);
    triggerBtn.focus();

    const modal = makeFocusable('div', { id: 'testModal' });
    const firstBtn = makeFocusable('button', { id: 'firstBtn' });
    const hiddenBtn = makeFocusable('button', { id: 'hiddenBtn', hidden: true });
    const lastBtn = makeFocusable('button', { id: 'lastBtn' });
    modal.appendChild(firstBtn);
    modal.appendChild(hiddenBtn);
    modal.appendChild(lastBtn);
    modal.contains = (target) => target === modal || target === firstBtn || target === hiddenBtn || target === lastBtn;
    doc.body.appendChild(modal);

    const prev = activateModalFocus(modal, doc);
    assert.equal(prev, triggerBtn);
    assert.equal(focusedEl, firstBtn);

    // Shift+Tab from first wraps to last (skipping hiddenBtn)
    let prevented = false;
    assert.equal(trapModalTabKey(modal, { key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; } }, doc), true);
    assert.equal(prevented, true);
    assert.equal(focusedEl, lastBtn);

    // Tab from last wraps to first
    prevented = false;
    assert.equal(trapModalTabKey(modal, { key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } }, doc), true);
    assert.equal(prevented, true);
    assert.equal(focusedEl, firstBtn);

    // Restore focus on close
    assert.equal(restoreModalFocus(prev, doc), true);
    assert.equal(focusedEl, triggerBtn);
});

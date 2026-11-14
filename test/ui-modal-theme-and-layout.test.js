'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMockElement, createMockDocument, createMockStorage } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'public/style.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');

async function loadShareConfigMod() {
    const url = pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/share-config-modal.js')).href;
    return import(url);
}

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

    const appSelectorContainer = createMockElement('div', { id: 'appSelectorContainer', style: { display: 'none' } });
    const appExcludeOptionContainer = createMockElement('div', { id: 'appExcludeOptionContainer', style: { display: 'none' } });
    const chkExcludeSelectedApp = createMockElement('input', { id: 'chkExcludeSelectedApp', type: 'checkbox', checked: false });
    const vbCableOptionContainer = createMockElement('div', { id: 'vbCableOptionContainer', style: { display: 'none' } });
    const chkUseVbCable = createMockElement('input', { id: 'chkUseVbCable', type: 'checkbox', checked: false });
    const btnConfirmStartShare = createMockElement('button', { id: 'btnConfirmStartShare' });
    const shareConfigModal = createMockElement('div', { id: 'shareConfigModal', style: { display: 'none' }, hidden: true });
    const radioList = [radios.exclude_discord, radios.app, radios.system, radios.none];
    const startedArgs = [];

    const doc = createMockDocument({
        appSelectorContainer,
        appExcludeOptionContainer,
        chkExcludeSelectedApp,
        vbCableOptionContainer,
        chkUseVbCable,
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
        useVbCableAudio: false,
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
            vbCableOptionContainer,
            chkUseVbCable,
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
        vbCableOptionContainer,
        chkUseVbCable,
        btnConfirmStartShare,
        startedArgs
    };
}

test('style.css defines theme vars, fadeIn keyframes, .form-input, scrollable modals, and .audio-option-card', () => {
    const darkBlockMatch = styleCss.match(/:root,\s*\[data-theme="dark"\]\s*\{[\s\S]*?\}/);
    const lightBlockMatch = styleCss.match(/\[data-theme="light"\]\s*\{[\s\S]*?\}/);
    assert(darkBlockMatch && darkBlockMatch[0].includes('--bg-surface-hover:'), 'Dark theme must define --bg-surface-hover');
    assert(lightBlockMatch && lightBlockMatch[0].includes('--bg-surface-hover:'), 'Light theme must define --bg-surface-hover');

    assert.match(styleCss, /@keyframes\s+fadeIn\s*\{[\s\S]*?opacity:\s*0[\s\S]*?opacity:\s*1/);

    const overlayMatch = styleCss.match(/\.modal-overlay\s*\{[\s\S]*?\}/);
    assert(overlayMatch && overlayMatch[0].includes('overflow-y: auto') && overlayMatch[0].includes('overscroll-behavior: contain'));

    const roomCardMatch = styleCss.match(/\.room-card\s*\{[\s\S]*?\}/);
    assert(
        roomCardMatch &&
        roomCardMatch[0].includes('margin: auto') &&
        roomCardMatch[0].includes('max-height: calc(100dvh - 32px)') &&
        roomCardMatch[0].includes('overflow-y: auto')
    );

    const modalSmMatch = styleCss.match(/\.modal-sm\s*\{[\s\S]*?\}/);
    assert(
        modalSmMatch &&
        modalSmMatch[0].includes('margin: auto') &&
        modalSmMatch[0].includes('max-height: calc(100dvh - 32px)') &&
        modalSmMatch[0].includes('overflow-y: auto')
    );

    assert.match(styleCss, /\.form-input\s*\{[\s\S]*?background:\s*var\(--bg-card\)/);
    assert.match(styleCss, /\.form-input:focus[\s\S]*?border-color:\s*var\(--primary\)/);
    assert.match(styleCss, /\.form-input\s+option\s*\{[\s\S]*?color:\s*var\(--text-main\)/);

    assert.match(styleCss, /\.audio-option-card\s*\{[\s\S]*?var\(--border\)/);
    assert.match(styleCss, /\.audio-option-card:hover\s*\{[\s\S]*?var\(--border-hover\)/);
    assert.match(styleCss, /\.audio-option-card\.is-selected[\s\S]*?var\(--primary\)[\s\S]*?var\(--bg-surface-hover\)/);
});

test('index.html delegates border/background of .audio-option-card to CSS', () => {
    const cardLabels = indexHtml.match(/<label\s+class="audio-option-card[^"]*"[^>]*>/g) || [];
    assert.equal(cardLabels.length, 4);
    assert(cardLabels[0].includes('is-selected'), 'First .audio-option-card must have is-selected by default');

    for (const tag of cardLabels) {
        assert(!tag.includes('var(--bg-surface-hover)'), `Inline var(--bg-surface-hover) must be removed: ${tag}`);
        assert(!tag.includes('var(--bg-surface)'), `Inline var(--bg-surface) must be removed: ${tag}`);
        assert(!/border:\s*1px\s+solid/i.test(tag), `Inline fixed border must be removed: ${tag}`);
    }

    for (const requiredId of ['audioSourceExcludeDiscord', 'audioSourceApp', 'audioSourceSystem', 'audioSourceNone', 'appExcludeOptionContainer', 'chkExcludeSelectedApp', 'vbCableOptionContainer', 'chkUseVbCable']) {
        assert(indexHtml.includes(`id="${requiredId}"`));
    }
});

test('openShareConfigModal and change listener toggle .is-selected across cards in Web and Desktop', async () => {
    const { createShareConfigModalController } = await loadShareConfigMod();

    const hWeb = createAudioCardHarness(createShareConfigModalController, { isDesktop: false, initialSelected: 'exclude_discord' });
    hWeb.cards.exclude_discord.style.border = '1px solid var(--primary)';
    hWeb.ctrl.openShareConfigModal();

    assert.equal(hWeb.radios.system.checked, true);
    assert.equal(hWeb.radios.exclude_discord.checked, false);
    assert.equal(hWeb.cards.system.classList.contains('is-selected'), true);
    assert.equal(hWeb.cards.exclude_discord.classList.contains('is-selected'), false);
    assert.equal(hWeb.cards.app.classList.contains('is-selected'), false);
    assert.equal(hWeb.cards.none.classList.contains('is-selected'), false);
    assert.equal(hWeb.cards.exclude_discord.style.border, '');
    assert.equal(hWeb.vbCableOptionContainer.style.display, 'block');
    assert.equal(hWeb.appExcludeOptionContainer.style.display, 'none');
    assert.equal(hWeb.chkUseVbCable.checked, false);

    hWeb.radios.none.triggerChange();
    assert.equal(hWeb.cards.none.classList.contains('is-selected'), true);
    assert.equal(hWeb.cards.system.classList.contains('is-selected'), false);
    assert.equal(hWeb.cards.system.style.border, '');
    assert.equal(hWeb.vbCableOptionContainer.style.display, 'none');

    hWeb.radios.system.triggerChange();
    assert.equal(hWeb.vbCableOptionContainer.style.display, 'block');
    hWeb.chkUseVbCable.checked = true;
    hWeb.chkUseVbCable.dispatchEvent({ type: 'change' });
    await hWeb.btnConfirmStartShare.dispatchEvent({ type: 'click' });
    assert.equal(hWeb.state.useVbCableAudio, true);
    assert.deepEqual(hWeb.startedArgs[0][4], { useVbCable: true, excludeApp: false });

    const hDesktop = createAudioCardHarness(createShareConfigModalController, { isDesktop: true, initialSelected: 'app' });
    hDesktop.ctrl.openShareConfigModal();
    assert.equal(hDesktop.cards.app.classList.contains('is-selected'), true);
    assert.equal(hDesktop.cards.exclude_discord.classList.contains('is-selected'), false);
    assert.equal(hDesktop.appSelectorContainer.style.display, 'flex');
    assert.equal(hDesktop.appExcludeOptionContainer.style.display, 'flex');
    assert.equal(hDesktop.vbCableOptionContainer.style.display, 'none');
    assert.equal(hDesktop.chkExcludeSelectedApp.checked, false);

    hDesktop.chkExcludeSelectedApp.checked = true;
    hDesktop.chkExcludeSelectedApp.dispatchEvent({ type: 'change' });
    await hDesktop.btnConfirmStartShare.dispatchEvent({ type: 'click' });
    assert.equal(hDesktop.state.excludeSelectedApp, true);
    assert.deepEqual(hDesktop.startedArgs[0][4], { useVbCable: false, excludeApp: true });

    hDesktop.radios.exclude_discord.triggerChange();
    assert.equal(hDesktop.cards.exclude_discord.classList.contains('is-selected'), true);
    assert.equal(hDesktop.cards.app.classList.contains('is-selected'), false);
    assert.equal(hDesktop.appSelectorContainer.style.display, 'none');
    assert.equal(hDesktop.appExcludeOptionContainer.style.display, 'none');
    assert.equal(hDesktop.vbCableOptionContainer.style.display, 'none');

    hDesktop.radios.system.triggerChange();
    assert.equal(hDesktop.vbCableOptionContainer.style.display, 'block');
    assert.equal(hDesktop.appExcludeOptionContainer.style.display, 'none');
});

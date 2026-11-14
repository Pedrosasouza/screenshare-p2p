'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createMockElement, createMockDocument } = require('./helpers/mock-dom');

const ROOT_DIR = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'public/style.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');

async function loadGridMod() {
    return import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/stream-grid.js')).href);
}

test('style.css fixes 3-stream mobile grid, truncation, toast positioning, and :focus-visible rules', () => {
    const media768Start = styleCss.indexOf('@media (max-width: 768px)');
    assert(media768Start !== -1, '@media (max-width: 768px) not found');
    const media480Start = styleCss.indexOf('@media (max-width: 480px)', media768Start);
    assert(media480Start !== -1, '@media (max-width: 480px) not found');

    const media768Block = styleCss.slice(media768Start, media480Start);
    assert.match(media768Block, /\.stream-grid\[data-count="3"\]\s+\.stream-tile:nth-child\(3\)\s*\{[\s\S]*?grid-column:\s*auto[\s\S]*?max-width:\s*none/);
    assert.match(media768Block, /\.room-code-pill\s*\{[\s\S]*?max-width:\s*150px/);

    assert.match(styleCss, /\.room-code-pill\s*\{[\s\S]*?max-width:\s*240px[\s\S]*?min-width:\s*0/);
    assert.match(styleCss, /\.room-code-pill\s+strong\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?white-space:\s*nowrap/);
    assert.match(styleCss, /\.tile-header-badge\s*\{[\s\S]*?max-width:\s*calc\(100% - 110px\)/);
    assert.match(styleCss, /\.tile-header-badge\s+\.user-name\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?white-space:\s*nowrap/);

    const media480Matches = styleCss.match(/@media\s*\(max-width:\s*480px\)\s*\{[\s\S]*?\n\}/g) || [];
    const all480 = media480Matches.join('\n');
    assert.match(all480, /\.toolbar-right\s+\.btn-text[\s\S]*?display:\s*none/);
    assert.match(all480, /\.toast-container\s*\{[\s\S]*?bottom:\s*76px/);

    for (const selector of [
        '.btn:focus-visible',
        '.btn-icon:focus-visible',
        '.btn-close:focus-visible',
        '.btn-text-action:focus-visible',
        '.room-choice-card:focus-visible',
        '.room-card-close:focus-visible',
        '.toast-close:focus-visible',
        '.btn-exit-pseudo-fs:focus-visible'
    ]) {
        assert(styleCss.includes(selector), `Missing :focus-visible selector for ${selector}`);
    }
    assert.match(styleCss, /\.audio-option-card:focus-within\s*\{[\s\S]*?border-color:\s*var\(--primary\)/);
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
        'btnQualityToggle',
        'btnCloseShareConfig',
        'btnConfirmStartShare',
        'btnCloseStatsModal'
    ];
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
    const { createStreamGridController } = await loadGridMod();
    const { enterPseudoFullscreen } = await import(pathToFileURL(path.join(ROOT_DIR, 'public/js/modules/tile-dom.js')).href);

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
        const fsBtn = tile.children
            .find((c) => c.className.includes('tile-controls-overlay'))
            .children.filter((c) => c.tagName === 'BUTTON')[1];

        assert.equal(muteBtn.type, 'button');
        assert.equal(muteBtn.title, 'Silenciar / Ativar Som');
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

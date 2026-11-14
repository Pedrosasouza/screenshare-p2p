const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const stylePath = path.resolve(__dirname, '../public/style.css');
const indexPath = path.resolve(__dirname, '../public/index.html');
const appPath = path.resolve(__dirname, '../public/app.js');

const styleCss = fs.readFileSync(stylePath, 'utf8');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const { loadClientBundleSource } = require('./helpers/client-source');
const appJs = loadClientBundleSource();
function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Function ${name} not found in public/app.js`);
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
        dataset: {},
        style: {},
        children: [],
        parentNode: null,
        classList: {
            add: (...cls) => cls.forEach((c) => classes.add(c)),
            remove: (...cls) => cls.forEach((c) => classes.delete(c)),
            contains: (c) => classes.has(c)
        },
        setAttribute(k, v) { attrs.set(String(k), String(v)); },
        removeAttribute(k) { attrs.delete(String(k)); },
        hasAttribute(k) { return attrs.has(String(k)); },
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
        removeEventListener(type, fn) {
            if (!listeners[type]) return;
            listeners[type] = listeners[type].filter((f) => f !== fn);
        },
        dispatchEvent(evt) {
            const event = typeof evt === 'string' ? { type: evt } : { ...evt };
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

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: RESPONSIVIDADE MOBILE & ACESSIBILIDADE');
    console.log('===============================================================\n');

    // T1: style.css responsive fixes, truncation, and :focus-visible rules
    process.stdout.write('  [Teste] T1: style.css corrige grid 3 streams mobile, truncamento, toasts e :focus-visible ... ');
    {
        const media768Start = styleCss.indexOf('@media (max-width: 768px)');
        assert(media768Start !== -1, '@media (max-width: 768px) not found');
        const media480Start = styleCss.indexOf('@media (max-width: 480px)', media768Start);
        assert(media480Start !== -1, '@media (max-width: 480px) not found');

        const media768Block = styleCss.slice(media768Start, media480Start);
        assert(
            /\.stream-grid\[data-count="3"\]\s+\.stream-tile:nth-child\(3\)\s*\{[\s\S]*?grid-column:\s*auto[\s\S]*?max-width:\s*none/.test(media768Block),
            'Mobile 768px must reset 3rd tile grid-column and max-width'
        );
        assert(
            /\.room-code-pill\s*\{[\s\S]*?max-width:\s*150px/.test(media768Block),
            'Mobile 768px must constrain .room-code-pill max-width to 150px'
        );

        assert(
            /\.room-code-pill\s*\{[\s\S]*?max-width:\s*240px[\s\S]*?min-width:\s*0/.test(styleCss),
            '.room-code-pill must set max-width: 240px and min-width: 0'
        );
        assert(
            /\.room-code-pill\s+strong\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?white-space:\s*nowrap/.test(styleCss),
            '.room-code-pill strong must truncate overflowing room IDs'
        );

        assert(
            /\.tile-header-badge\s*\{[\s\S]*?max-width:\s*calc\(100% - 110px\)/.test(styleCss),
            '.tile-header-badge must limit max-width to avoid overlapping quality badge'
        );
        assert(
            /\.tile-header-badge\s+\.user-name\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?white-space:\s*nowrap/.test(styleCss),
            '.tile-header-badge .user-name must truncate long user names'
        );

        const media480Matches = styleCss.match(/@media\s*\(max-width:\s*480px\)\s*\{[\s\S]*?\n\}/g) || [];
        const all480 = media480Matches.join('\n');
        assert(
            /\.toolbar-right\s+\.btn-text[\s\S]*?display:\s*none/.test(all480),
            '@media (max-width: 480px) must hide .toolbar-right .btn-text'
        );
        assert(
            /\.toast-container\s*\{[\s\S]*?bottom:\s*76px/.test(all480),
            '@media (max-width: 480px) must position .toast-container at bottom: 76px'
        );

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
        assert(
            /\.audio-option-card:focus-within\s*\{[\s\S]*?border-color:\s*var\(--primary\)/.test(styleCss),
            'Missing .audio-option-card:focus-within focus styling'
        );
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: index.html has .btn-text wrappers, type="button", role="dialog" aria-modal="true", and aria-label
    process.stdout.write('  [Teste] T2: index.html possui .btn-text, type="button", role="dialog" e aria-label ... ');
    {
        assert(
            /<button[^>]*id="btnCopyLink"[^>]*>[\s\S]*?<span class="btn-text">Copiar Link<\/span>[\s\S]*?<\/button>/.test(indexHtml),
            '#btnCopyLink must wrap text in <span class="btn-text">'
        );
        assert(
            /<button[^>]*id="btnChangeRoom"[^>]*>[\s\S]*?<span class="btn-text">Trocar Sala<\/span>[\s\S]*?<\/button>/.test(indexHtml),
            '#btnChangeRoom must wrap text in <span class="btn-text">'
        );

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
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: createStreamTile and enterPseudoFullscreen assign type="button" (and muteBtn.title)
    process.stdout.write('  [Teste] T3: createStreamTile e enterPseudoFullscreen definem type="button" nos controles dinâmicos ... ');
    {
        const btnCopyLink = createMockElement('button');
        btnCopyLink.innerHTML = '<i class="fa-regular fa-copy"></i> <span class="btn-text">Copiar Link</span>';

        const copyLinkMatch = appJs.match(/\/\/ Copy Invite Link\r?\nconst defaultCopyLinkHtml[\s\S]*?\n\}/);
        assert(copyLinkMatch, 'Copy Invite Link block not found in public/app.js');

        const sandbox = {
            Promise,
            roomId: 'sala-teste',
            currentRoomPassword: '',
            btnCopyLink,
            updateBackgroundTracksOptimization() {},
            toggleTileFullscreen() {},
            showToast() {},
            navigator: {
                clipboard: {
                    writeText: () => Promise.resolve()
                }
            },
            window: {
                location: { origin: 'https://example.com', pathname: '/' }
            },
            setTimeout: () => 1,
            clearTimeout() {},
            document: {
                createElement: (tag) => createMockElement(tag)
            }
        };

        vm.createContext(sandbox);
        const code = [
            extractFn(appJs, 'createStreamTile'),
            extractFn(appJs, 'enterPseudoFullscreen'),
            copyLinkMatch[0]
        ].join('\n\n');
        vm.runInContext(code, sandbox, { filename: 'public/app.js' });

        const tile = sandbox.createStreamTile('peer-a11y', { id: 'stream-a11y' }, 'Usuario Com Nome Muito Longo', false);
        const overlay = tile.querySelector('.tile-controls-overlay');
        assert(overlay, 'Controls overlay must be created');
        const buttons = overlay.children.filter((c) => c.tagName === 'BUTTON');
        assert.strictEqual(buttons.length, 2, 'Expected muteBtn and fsBtn inside tile controls');

        const [muteBtn, fsBtn] = buttons;
        assert.strictEqual(muteBtn.type, 'button', 'muteBtn must have type="button"');
        assert.strictEqual(muteBtn.title, 'Silenciar / Ativar Som', 'muteBtn must have descriptive title');
        assert.strictEqual(fsBtn.type, 'button', 'fsBtn must have type="button"');

        sandbox.enterPseudoFullscreen(tile);
        const exitBtn = tile.querySelector('.btn-exit-pseudo-fs');
        assert(exitBtn, 'exitBtn must be appended in pseudo-fullscreen');
        assert.strictEqual(exitBtn.type, 'button', 'exitBtn must have type="button"');

        btnCopyLink.dispatchEvent({ type: 'click' });
        return Promise.resolve().then(() => {
            assert(
                btnCopyLink.innerHTML.includes('<span class="btn-text">Link Copiado!</span>'),
                'btnCopyLink click must wrap Link Copiado! in <span class="btn-text">'
            );
            console.log('\x1b[32mPASSOU\x1b[0m');
            console.log('\n===============================================================');
            console.log('  ✅ Resultado: Todos os testes de responsividade e a11y passaram.');
            console.log('===============================================================\n');
        });
    }
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});

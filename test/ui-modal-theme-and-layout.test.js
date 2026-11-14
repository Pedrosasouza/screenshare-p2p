const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const stylePath = path.resolve(__dirname, '../public/style.css');
const indexPath = path.resolve(__dirname, '../public/index.html');
const appPath = path.resolve(__dirname, '../public/app.js');

const styleCss = fs.readFileSync(stylePath, 'utf8');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const appJs = fs.readFileSync(appPath, 'utf8');

function extractFn(source, name) {
    const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`);
    const match = source.match(regex);
    assert(match, `Function ${name} not found in public/app.js`);
    return match[0];
}

function extractRadioChangeBlock(source) {
    const marker = '// Toggle app selector visibility based on radio choice';
    const start = source.indexOf(marker);
    assert(start !== -1, 'Radio change listener block marker not found in public/app.js');
    const end = source.indexOf('\n});', start);
    assert(end !== -1, 'Radio change listener block end not found in public/app.js');
    return source.slice(start, end + 4);
}

function createClassList(initial = []) {
    const classes = new Set(initial);
    return {
        contains: (cls) => classes.has(cls),
        add: (...items) => items.forEach((c) => classes.add(c)),
        remove: (...items) => items.forEach((c) => classes.delete(c)),
        toggle: (cls, force) => {
            if (force === undefined) {
                if (classes.has(cls)) {
                    classes.delete(cls);
                    return false;
                }
                classes.add(cls);
                return true;
            }
            if (force) {
                classes.add(cls);
                return true;
            }
            classes.delete(cls);
            return false;
        }
    };
}

function createAudioCardHarness({ isDesktop = true, initialSelected = 'exclude_discord' } = {}) {
    const cards = {
        exclude_discord: { style: { display: '' }, classList: createClassList(['audio-option-card', ...(initialSelected === 'exclude_discord' ? ['is-selected'] : [])]) },
        app: { style: { display: '' }, classList: createClassList(['audio-option-card', ...(initialSelected === 'app' ? ['is-selected'] : [])]) },
        system: { style: { display: '' }, classList: createClassList(['audio-option-card', ...(initialSelected === 'system' ? ['is-selected'] : [])]) },
        none: { style: { display: '' }, classList: createClassList(['audio-option-card', ...(initialSelected === 'none' ? ['is-selected'] : [])]) }
    };

    const radios = {};
    const radioDefs = [
        { key: 'exclude_discord', id: 'audioSourceExcludeDiscord' },
        { key: 'app', id: 'audioSourceApp' },
        { key: 'system', id: 'audioSourceSystem' },
        { key: 'none', id: 'audioSourceNone' }
    ];

    for (const def of radioDefs) {
        const listeners = {};
        radios[def.key] = {
            id: def.id,
            name: 'audioSourceType',
            value: def.key,
            checked: initialSelected === def.key,
            closest: (sel) => (sel === '.audio-option-card' ? cards[def.key] : null),
            addEventListener: (ev, fn) => {
                listeners[ev] = listeners[ev] || [];
                listeners[ev].push(fn);
            },
            triggerChange: () => {
                for (const key of Object.keys(radios)) {
                    radios[key].checked = key === def.key;
                }
                (listeners.change || []).forEach((fn) => fn());
            }
        };
    }

    const appSelectorContainer = { style: { display: 'none' } };
    const shareConfigModal = {
        style: { display: 'none' },
        attributes: { hidden: '' },
        removeAttribute(k) { delete this.attributes[k]; },
        setAttribute(k, v) { this.attributes[k] = v; }
    };

    const radioList = [radios.exclude_discord, radios.app, radios.system, radios.none];

    const sandbox = {
        Boolean,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        selectedVideoFps: 60,
        selectedVideoResolution: '1080p',
        isDesktopApp: () => Boolean(isDesktop),
        updateEchoWarningVisibility() {},
        checkDiscordStatus() {},
        fetchWindowList() {},
        audioSourceExcludeDiscord: radios.exclude_discord,
        audioSourceApp: radios.app,
        audioSourceSystem: radios.system,
        audioSourceNone: radios.none,
        appSelectorContainer,
        shareConfigModal,
        document: {
            querySelector: (sel) => {
                if (sel === 'input[name="audioSourceType"]:checked') {
                    return radioList.find((r) => r.checked) || null;
                }
                return null;
            },
            querySelectorAll: (sel) => {
                if (sel === 'input[name="audioSourceType"]') {
                    return radioList;
                }
                return [];
            }
        }
    };

    vm.createContext(sandbox);
    const code = [
        extractRadioChangeBlock(appJs),
        extractFn(appJs, 'openShareConfigModal')
    ].join('\n\n');
    vm.runInContext(code, sandbox, { filename: 'public/app.js' });

    return { sandbox, cards, radios, appSelectorContainer };
}

function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: TEMA, SCROLL DE MODAIS & CARDS DE ÁUDIO');
    console.log('===============================================================\n');

    // T1: public/style.css defines --bg-surface-hover in dark/light, @keyframes fadeIn, .form-input, scroll/max-height, and .audio-option-card.is-selected
    process.stdout.write('  [Teste] T1: public/style.css define variáveis, fadeIn, .form-input, scroll de modais e .audio-option-card ... ');
    {
        const darkBlockMatch = styleCss.match(/:root,\s*\[data-theme="dark"\]\s*\{[\s\S]*?\}/);
        const lightBlockMatch = styleCss.match(/\[data-theme="light"\]\s*\{[\s\S]*?\}/);
        assert(darkBlockMatch && darkBlockMatch[0].includes('--bg-surface-hover:'), 'Dark theme must define --bg-surface-hover');
        assert(lightBlockMatch && lightBlockMatch[0].includes('--bg-surface-hover:'), 'Light theme must define --bg-surface-hover');

        assert(/@keyframes\s+fadeIn\s*\{[\s\S]*?opacity:\s*0[\s\S]*?opacity:\s*1/.test(styleCss), '@keyframes fadeIn must be defined');

        const overlayMatch = styleCss.match(/\.modal-overlay\s*\{[\s\S]*?\}/);
        assert(overlayMatch && overlayMatch[0].includes('overflow-y: auto') && overlayMatch[0].includes('overscroll-behavior: contain'), '.modal-overlay must allow vertical scroll and contain overscroll');

        const roomCardMatch = styleCss.match(/\.room-card\s*\{[\s\S]*?\}/);
        assert(
            roomCardMatch &&
            roomCardMatch[0].includes('margin: auto') &&
            roomCardMatch[0].includes('max-height: calc(100dvh - 32px)') &&
            roomCardMatch[0].includes('overflow-y: auto'),
            '.room-card must have margin: auto, max-height, and overflow-y: auto'
        );

        const modalSmMatch = styleCss.match(/\.modal-sm\s*\{[\s\S]*?\}/);
        assert(
            modalSmMatch &&
            modalSmMatch[0].includes('margin: auto') &&
            modalSmMatch[0].includes('max-height: calc(100dvh - 32px)') &&
            modalSmMatch[0].includes('overflow-y: auto'),
            '.modal-sm must have margin: auto, max-height, and overflow-y: auto'
        );

        assert(/\.form-input\s*\{[\s\S]*?background:\s*var\(--bg-card\)/.test(styleCss), '.form-input must style background with var(--bg-card)');
        assert(/\.form-input:focus[\s\S]*?border-color:\s*var\(--primary\)/.test(styleCss), '.form-input:focus must highlight border-color');
        assert(/\.form-input\s+option\s*\{[\s\S]*?color:\s*var\(--text-main\)/.test(styleCss), '.form-input option must style background/color');

        assert(/\.audio-option-card\s*\{[\s\S]*?var\(--border\)/.test(styleCss), '.audio-option-card must use var(--border)');
        assert(/\.audio-option-card:hover\s*\{[\s\S]*?var\(--border-hover\)/.test(styleCss), '.audio-option-card:hover must use var(--border-hover)');
        assert(/\.audio-option-card\.is-selected[\s\S]*?var\(--primary\)[\s\S]*?var\(--bg-surface-hover\)/.test(styleCss), '.audio-option-card.is-selected must use var(--primary) and var(--bg-surface-hover)');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T2: public/index.html delegates border/background of .audio-option-card to CSS
    process.stdout.write('  [Teste] T2: public/index.html delega borda e fundo de .audio-option-card ao CSS ... ');
    {
        const cardLabels = indexHtml.match(/<label\s+class="audio-option-card[^"]*"[^>]*>/g) || [];
        assert.strictEqual(cardLabels.length, 4, 'Expected 4 .audio-option-card labels in public/index.html');
        assert(cardLabels[0].includes('is-selected'), 'First .audio-option-card must have is-selected by default');

        for (const tag of cardLabels) {
            assert(!tag.includes('var(--bg-surface-hover)'), `Inline var(--bg-surface-hover) must be removed: ${tag}`);
            assert(!tag.includes('var(--bg-surface)'), `Inline var(--bg-surface) must be removed: ${tag}`);
            assert(!/border:\s*1px\s+solid/i.test(tag), `Inline fixed border must be removed: ${tag}`);
        }

        for (const requiredId of ['audioSourceExcludeDiscord', 'audioSourceApp', 'audioSourceSystem', 'audioSourceNone']) {
            assert(indexHtml.includes(`id="${requiredId}"`), `Missing expected radio id ${requiredId}`);
        }
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    // T3: openShareConfigModal & change listener toggle .is-selected across cards in Web and Desktop
    process.stdout.write('  [Teste] T3: openShareConfigModal e evento change alternam .is-selected entre cards em Web e Desktop ... ');
    {
        // Web mode: forces audioSourceSystem and marks only system card as is-selected
        const hWeb = createAudioCardHarness({ isDesktop: false, initialSelected: 'exclude_discord' });
        hWeb.cards.exclude_discord.style.border = '1px solid var(--primary)';
        hWeb.sandbox.openShareConfigModal();

        assert.strictEqual(hWeb.radios.system.checked, true);
        assert.strictEqual(hWeb.radios.exclude_discord.checked, false);
        assert.strictEqual(hWeb.cards.system.classList.contains('is-selected'), true, 'Web mode selects system card');
        assert.strictEqual(hWeb.cards.exclude_discord.classList.contains('is-selected'), false);
        assert.strictEqual(hWeb.cards.app.classList.contains('is-selected'), false);
        assert.strictEqual(hWeb.cards.none.classList.contains('is-selected'), false);
        assert.strictEqual(hWeb.cards.exclude_discord.style.border, '', 'Stale inline border cleared on unselected card');

        // Switching to none in Web mode updates .is-selected and clears inline border
        hWeb.radios.none.triggerChange();
        assert.strictEqual(hWeb.cards.none.classList.contains('is-selected'), true, 'Change to none selects none card');
        assert.strictEqual(hWeb.cards.system.classList.contains('is-selected'), false, 'Change to none unselects system card');
        assert.strictEqual(hWeb.cards.system.style.border, '', 'Change clears inline border on system card');

        // Desktop mode: opening with 'app' checked marks app card and shows appSelectorContainer
        const hDesktop = createAudioCardHarness({ isDesktop: true, initialSelected: 'app' });
        hDesktop.sandbox.openShareConfigModal();
        assert.strictEqual(hDesktop.cards.app.classList.contains('is-selected'), true, 'Desktop open marks checked app card');
        assert.strictEqual(hDesktop.cards.exclude_discord.classList.contains('is-selected'), false);
        assert.strictEqual(hDesktop.appSelectorContainer.style.display, 'flex');

        // Switching to exclude_discord updates .is-selected and hides appSelectorContainer
        hDesktop.radios.exclude_discord.triggerChange();
        assert.strictEqual(hDesktop.cards.exclude_discord.classList.contains('is-selected'), true);
        assert.strictEqual(hDesktop.cards.app.classList.contains('is-selected'), false);
        assert.strictEqual(hDesktop.appSelectorContainer.style.display, 'none');
    }
    console.log('\x1b[32mPASSOU\x1b[0m');

    console.log('\n===============================================================');
    console.log('  ✅ Resultado: Todos os testes de tema, modal e cards passaram.');
    console.log('===============================================================\n');
}

runTests();

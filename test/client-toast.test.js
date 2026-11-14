const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockDocument } = require('./helpers/mock-dom');

function readAllClientSources() {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
    const modulesDir = path.resolve(__dirname, '../public/js/modules');
    const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.js')).sort();
    return [
        { name: 'public/app.js', content: appJs },
        ...files.map((f) => ({
            name: `public/js/modules/${f}`,
            content: fs.readFileSync(path.join(modulesDir, f), 'utf8')
        }))
    ];
}

describe('Eliminação de alert/prompt e sistema Toast', () => {
    it('T1: cliente não contém chamadas ativas a alert() ou prompt()', () => {
        const forbiddenMatches = [];
        for (const file of readAllClientSources()) {
            file.content.split('\n').forEach((line, index) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
                if (/\balert\(/.test(line)) {
                    forbiddenMatches.push(`${file.name}:${index + 1}: alert() encontrado: "${trimmed}"`);
                }
                if (/\bprompt\(/.test(line)) {
                    forbiddenMatches.push(`${file.name}:${index + 1}: prompt() encontrado: "${trimmed}"`);
                }
            });
        }

        assert.strictEqual(
            forbiddenMatches.length,
            0,
            `Chamadas bloqueantes encontradas:\n${forbiddenMatches.join('\n')}`
        );
    });

    it('T2: showToast renderiza mensagem usando textContent seguro (Anti-XSS)', async () => {
        const { showToast } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/ui-feedback.js')).href
        );
        const mockDoc = createMockDocument();
        const prevDoc = global.document;
        global.document = mockDoc;
        try {
            const payload = '<img src=x onerror=alert(1)>';
            showToast(payload, 'error', 0);

            const container = mockDoc.getElementById('toastContainer');
            assert.ok(container, 'toastContainer deve ser criado');
            assert.strictEqual(container.children.length, 1);

            const toastEl = container.children[0];
            assert.ok(toastEl.className.includes('toast-error'));

            const messageEl = toastEl.children.find((c) => c.className === 'toast-message');
            assert.ok(messageEl, 'span.toast-message deve existir');
            assert.strictEqual(messageEl.textContent, payload);
            assert.strictEqual(messageEl.innerHTML, '');
        } finally {
            if (prevDoc === undefined) delete global.document;
            else global.document = prevDoc;
        }
    });

    it('T3: public/style.css define estilos para toast-container e toast', () => {
        const cssContent = fs.readFileSync(path.resolve(__dirname, '../public/style.css'), 'utf8');
        assert.ok(cssContent.includes('.toast-container'), 'style.css deve definir .toast-container');
        assert.ok(cssContent.includes('.toast'), 'style.css deve definir .toast');
        assert.ok(
            cssContent.includes('.toast-error') || cssContent.includes('.toast.error'),
            'style.css deve definir .toast-error'
        );
    });
});

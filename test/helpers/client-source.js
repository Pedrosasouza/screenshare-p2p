const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const MODULES_DIR = path.join(PUBLIC_DIR, 'js', 'modules');

const MODULE_ORDER = [
    'ice-config.js',
    'room-utils.js',
    'signaling-url.js',
    'desktop-audio.js',
    'ui-feedback.js',
    'sdp.js',
    'qos.js',
    'tile-dom.js'
];

function stripModuleSyntax(code) {
    return code
        .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\r?\n?/gm, '')
        .replace(/^\s*import\s+['"][^'"]+['"];?\r?\n?/gm, '')
        .replace(/^export\s+default\s+/gm, '')
        .replace(/^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm, '')
        .replace(/^\s*export\s*\{[^}]*\};?\r?\n?/gm, '');
}

function loadClientBundleSource() {
    const parts = [];
    for (const fileName of MODULE_ORDER) {
        const fullPath = path.join(MODULES_DIR, fileName);
        if (fs.existsSync(fullPath)) {
            parts.push(stripModuleSyntax(fs.readFileSync(fullPath, 'utf8')));
        }
    }
    const appPath = path.join(PUBLIC_DIR, 'app.js');
    parts.push(stripModuleSyntax(fs.readFileSync(appPath, 'utf8')));
    return parts.join('\n\n');
}

module.exports = {
    MODULE_ORDER,
    stripModuleSyntax,
    loadClientBundleSource
};

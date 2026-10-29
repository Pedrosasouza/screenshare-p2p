const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function loadAppHelpers() {
    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    const getVideoConstraintsMatch = appJs.match(/function\s+getVideoConstraints\s*\([\s\S]*?\n\}/);
    const getMaxBitrateMatch = appJs.match(/function\s+getMaxBitrateForPeerCount\s*\([\s\S]*?\n\}/);

    const helpers = {};
    const sandbox = {
        selectedVideoResolution: '1080p',
        selectedVideoFps: 60,
        peers: new Map()
    };
    vm.createContext(sandbox);

    if (getVideoConstraintsMatch) {
        try {
            helpers.getVideoConstraints = vm.runInContext(`(${getVideoConstraintsMatch[0]})`, sandbox);
        } catch (_) {}
    }
    if (getMaxBitrateMatch) {
        try {
            helpers.getMaxBitrateForPeerCount = vm.runInContext(`(${getMaxBitrateMatch[0]})`, sandbox);
        } catch (_) {}
    }

    return helpers;
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: SELEÇÃO DE RESOLUÇÃO (720p/1080p) E FPS (30/60)');
    console.log('===============================================================\n');

    let failures = 0;
    const helpers = loadAppHelpers();

    // Teste 1: getVideoConstraints deve mapear 1080p/720p e 30/60fps
    process.stdout.write('  [Teste] T1: getVideoConstraints mapeia resoluções e framerates corretamente ... ');
    if (typeof helpers.getVideoConstraints !== 'function') {
        console.log('\x1b[31mFALHOU (getVideoConstraints não está definida em public/app.js)\x1b[0m');
        failures++;
    } else {
        try {
            const c1080_60 = helpers.getVideoConstraints('1080p', 60);
            assert.strictEqual(c1080_60.width.ideal, 1920);
            assert.strictEqual(c1080_60.width.max, 1920);
            assert.strictEqual(c1080_60.height.ideal, 1080);
            assert.strictEqual(c1080_60.height.max, 1080);
            assert.strictEqual(c1080_60.frameRate.ideal, 60);
            assert.strictEqual(c1080_60.frameRate.max, 60);

            const c720_30 = helpers.getVideoConstraints('720p', 30);
            assert.strictEqual(c720_30.width.ideal, 1280);
            assert.strictEqual(c720_30.width.max, 1280);
            assert.strictEqual(c720_30.height.ideal, 720);
            assert.strictEqual(c720_30.height.max, 720);
            assert.strictEqual(c720_30.frameRate.ideal, 30);
            assert.strictEqual(c720_30.frameRate.max, 30);

            const c1080_30 = helpers.getVideoConstraints('1080p', 30);
            assert.strictEqual(c1080_30.height.ideal, 1080);
            assert.strictEqual(c1080_30.frameRate.ideal, 30);

            const c720_60 = helpers.getVideoConstraints('720p', 60);
            assert.strictEqual(c720_60.height.ideal, 720);
            assert.strictEqual(c720_60.frameRate.ideal, 60);

            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            failures++;
        }
    }

    // Teste 2: getMaxBitrateForPeerCount escala conforme resolução e fps
    process.stdout.write('  [Teste] T2: getMaxBitrateForPeerCount adequa teto de bitrate por perfil ... ');
    if (typeof helpers.getMaxBitrateForPeerCount !== 'function') {
        console.log('\x1b[31mFALHOU (getMaxBitrateForPeerCount não encontrada)\x1b[0m');
        failures++;
    } else {
        try {
            const b1080_60 = helpers.getMaxBitrateForPeerCount(1, '1080p', 60);
            const b1080_30 = helpers.getMaxBitrateForPeerCount(1, '1080p', 30);
            const b720_60 = helpers.getMaxBitrateForPeerCount(1, '720p', 60);
            const b720_30 = helpers.getMaxBitrateForPeerCount(1, '720p', 30);

            assert.strictEqual(b1080_60, 6000000, '1080p60 para 1 peer deve ser 6.0 Mbps');
            assert.strictEqual(b1080_30, 4000000, '1080p30 para 1 peer deve ser 4.0 Mbps');
            assert.strictEqual(b720_60, 2800000, '720p60 para 1 peer deve ser 2.8 Mbps');
            assert.strictEqual(b720_30, 1800000, '720p30 para 1 peer deve ser 1.8 Mbps');

            // 720p30 deve ser menor que 1080p60
            assert(b720_30 < b1080_60, 'Perfil 720p30 deve alocar menos bitrate que 1080p60');

            console.log('\x1b[32mPASSOU\x1b[0m');
        } catch (err) {
            console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
            failures++;
        }
    }

    // Teste 3: Presença de seletores no DOM (public/index.html)
    process.stdout.write('  [Teste] T3: public/index.html contém seletores de 1080p/720p e 60fps/30fps ... ');
    const htmlPath = path.resolve(__dirname, '../public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const hasRes1080 = html.includes('name="videoResolution"') && html.includes('value="1080p"');
    const hasRes720 = html.includes('name="videoResolution"') && html.includes('value="720p"');
    const hasFps60 = html.includes('name="videoFps"') && html.includes('value="60"');
    const hasFps30 = html.includes('name="videoFps"') && html.includes('value="30"');

    if (hasRes1080 && hasRes720 && hasFps60 && hasFps30) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (seletores de resolução ou FPS ausentes no index.html)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} validação(ões) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Erro na execução:', err);
    process.exit(1);
});

const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: UTILITÁRIOS DA BARRA INFERIOR (PiP E STATS)');
    console.log('===============================================================\n');

    let failures = 0;

    // Teste 1: public/index.html contém os botões na toolbar-right e o modal de estatísticas
    process.stdout.write('  [Teste] T1: public/index.html define btnTogglePip, btnToggleStats e statsModal ... ');
    const htmlPath = path.resolve(__dirname, '../public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const hasPipBtn = html.includes('id="btnTogglePip"');
    const hasStatsBtn = html.includes('id="btnToggleStats"');
    const hasStatsModal = html.includes('id="statsModal"');

    if (hasPipBtn && hasStatsBtn && hasStatsModal) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (botões na toolbar-right ou statsModal ausentes no HTML)\x1b[0m');
        failures++;
    }

    // Teste 2: public/app.js implementa togglePictureInPicture
    process.stdout.write('  [Teste] T2: public/app.js implementa togglePictureInPicture ... ');
    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    const hasPipFunc = appJs.includes('function togglePictureInPicture(') || appJs.includes('async function togglePictureInPicture(');
    const usesPipApi = appJs.includes('requestPictureInPicture') || appJs.includes('exitPictureInPicture');

    if (hasPipFunc && usesPipApi) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (função togglePictureInPicture ausente ou sem API PiP)\x1b[0m');
        failures++;
    }

    // Teste 3: public/app.js implementa openStatsModal e closeStatsModal com ESC e backdrop
    process.stdout.write('  [Teste] T3: public/app.js implementa modal de estatísticas com ESC e backdrop ... ');
    const hasStatsOpen = appJs.includes('function openStatsModal(');
    const hasStatsClose = appJs.includes('function closeStatsModal(');
    const hasStatsEsc = appJs.includes('statsModal') && appJs.includes('closeStatsModal()');
    const hasStatsBackdrop = appJs.includes('e.target === statsModal');

    if (hasStatsOpen && hasStatsClose && hasStatsEsc && hasStatsBackdrop) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (funções de stats modal ou listeners de ESC/backdrop ausentes)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes de utilitários da barra passaram.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} validação(ões) falharam conforme esperado no código antigo.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Erro inesperado no teste:', err);
    process.exit(1);
});

const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: FECHAMENTO DE MODAL VIA ESC E BACKDROP');
    console.log('===============================================================\n');

    let failures = 0;

    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    // Teste 1: shareConfigModal possui ouvinte de clique no backdrop
    process.stdout.write('  [Teste] T1: shareConfigModal fecha ao clicar no backdrop (e.target === shareConfigModal) ... ');
    const hasBackdropListener = appJs.includes("shareConfigModal.addEventListener('click'") || appJs.includes('shareConfigModal.addEventListener("click"');
    const checksBackdropTarget = appJs.includes('e.target === shareConfigModal') && appJs.includes('closeShareConfigModal()');

    if (hasBackdropListener && checksBackdropTarget) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (ouvinte de clique no backdrop ausente para shareConfigModal)\x1b[0m');
        failures++;
    }

    // Teste 2: Tecla Escape fecha shareConfigModal quando aberto
    process.stdout.write('  [Teste] T2: Handler keydown (Escape) fecha shareConfigModal ... ');
    const escIndex = appJs.indexOf("e.key === 'Escape'");
    let escClosesShareConfig = false;

    if (escIndex !== -1) {
        const handlerBlock = appJs.substring(escIndex, escIndex + 500);
        escClosesShareConfig = handlerBlock.includes('shareConfigModal') && handlerBlock.includes('closeShareConfigModal()');
    }

    if (escClosesShareConfig) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (Escape não verifica nem fecha shareConfigModal)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes de fechamento de modais passaram.');
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

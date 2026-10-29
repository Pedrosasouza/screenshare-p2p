const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: MELHORIAS RECOMENDADAS (PACOTES 2, 3 E 4)');
    console.log('===============================================================\n');

    let failures = 0;

    // Teste 1 (Pacote 2): package.json deve unificar os testes do audio helper
    process.stdout.write('  [Teste] T1: package.json script "test:helper" unifica token e origin ... ');
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const testHelperScript = pkg.scripts && pkg.scripts['test:helper'];

    if (
        testHelperScript &&
        testHelperScript.includes('audio-helper-token.test.js') &&
        testHelperScript.includes('audio-helper-origin.test.js')
    ) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (test:helper não executa ambos os testes)\x1b[0m');
        failures++;
    }

    // Carrega o conteúdo de public/app.js para análise estática de lógica
    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    // Teste 2 (Pacote 3): public/app.js deve implementar diagnóstico e feedback de falha P2P
    process.stdout.write('  [Teste] T2: public/app.js possui setPeerConnectionStatus e telemetria ... ');
    const hasStatusHelper = appJs.includes('setPeerConnectionStatus');
    const hasTelemetry = appJs.includes('logPeerConnectionTelemetry');
    const hasP2PWarning = appJs.includes('peer-connection-warning');

    if (hasStatusHelper && hasTelemetry && hasP2PWarning) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (funções de diagnóstico P2P ausentes em public/app.js)\x1b[0m');
        failures++;
    }

    // Teste 3 (Pacote 4): public/app.js deve escutar visibilitychange e pausar vídeo para salvar GPU
    process.stdout.write('  [Teste] T3: public/app.js gerencia visibilitychange e otimização de GPU ... ');
    const hasVisibility = appJs.includes("visibilitychange");
    const hasGpuOpt = appJs.includes("updateBackgroundTracksOptimization");

    if (hasVisibility && hasGpuOpt) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (otimização de GPU em segundo plano ausente em public/app.js)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todas as melhorias recomendadas validadas.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} validação(ões) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Erro inesperado:', err);
    process.exit(1);
});

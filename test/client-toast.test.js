const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: ELIMINAÇÃO DE ALERT/PROMPT E SISTEMA TOAST');
    console.log('===============================================================\n');

    let failures = 0;

    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    // Teste 1: Ausência de chamadas ativas de alert() e prompt()
    process.stdout.write('  [Teste] T1: public/app.js não contém chamadas ativas a alert() ou prompt() ... ');
    
    // Procura por chamadas ativas fora de comentários
    const lines = appJs.split('\n');
    const forbiddenMatches = [];
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        if (/\balert\(/.test(line)) {
            forbiddenMatches.push(`Linha ${index + 1}: alert() encontrado: "${trimmed}"`);
        }
        if (/\bprompt\(/.test(line)) {
            forbiddenMatches.push(`Linha ${index + 1}: prompt() encontrado: "${trimmed}"`);
        }
    });

    if (forbiddenMatches.length === 0) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log(`\x1b[31mFALHOU (${forbiddenMatches.length} chamada(s) síncrona(s) encontrada(s))\x1b[0m`);
        forbiddenMatches.forEach(m => console.log(`    - ${m}`));
        failures++;
    }

    // Teste 2: Presença e proteção XSS da função showToast
    process.stdout.write('  [Teste] T2: public/app.js implementa showToast usando textContent seguro ... ');
    const hasShowToast = appJs.includes('function showToast(');
    const usesTextContent = appJs.includes('textContent = message') || appJs.includes('.textContent =');

    if (hasShowToast && usesTextContent) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (showToast ausente ou não utiliza textContent)\x1b[0m');
        failures++;
    }

    // Teste 3: Presença das classes CSS de toast
    process.stdout.write('  [Teste] T3: public/style.css define estilos para toast-container e toast ... ');
    const cssPath = path.resolve(__dirname, '../public/style.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    const hasToastContainer = cssContent.includes('.toast-container');
    const hasToast = cssContent.includes('.toast');
    const hasToastError = cssContent.includes('.toast-error') || cssContent.includes('.toast.error');

    if (hasToastContainer && hasToast && hasToastError) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (estilos de toast ausentes em style.css)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes de Toast passaram.');
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

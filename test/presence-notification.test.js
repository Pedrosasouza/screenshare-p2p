const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: NOTIFICAÇÃO E CHIME DE PRESENÇA (JOIN/LEAVE)');
    console.log('===============================================================\n');

    let failures = 0;

    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    // Teste 1: Presença da função playPresenceChime com Web Audio API
    process.stdout.write('  [Teste] T1: public/app.js implementa playPresenceChime com AudioContext ... ');
    const hasChimeFunc = appJs.includes('function playPresenceChime(');
    const usesAudioContext = appJs.includes('AudioContext') && appJs.includes('createOscillator');

    if (hasChimeFunc && usesAudioContext) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (playPresenceChime ausente ou não utiliza AudioContext)\x1b[0m');
        failures++;
    }

    // Teste 2: socket.on('user-joined') dispara showToast e chime de entrada
    process.stdout.write('  [Teste] T2: socket.on(\'user-joined\') emite toast e chime de entrada ... ');
    const userJoinedIndex = appJs.indexOf("socket.on('user-joined'");
    let joinedHasToast = false;
    let joinedHasChime = false;

    if (userJoinedIndex !== -1) {
        const handlerBlock = appJs.substring(userJoinedIndex, userJoinedIndex + 500);
        joinedHasToast = handlerBlock.includes('showToast(') && handlerBlock.includes('entrou na sala');
        joinedHasChime = handlerBlock.includes("playPresenceChime('join')") || handlerBlock.includes('playPresenceChime("join")');
    }

    if (joinedHasToast && joinedHasChime) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (user-joined não aciona showToast ou playPresenceChime)\x1b[0m');
        failures++;
    }

    // Teste 3: socket.on('user-left') dispara showToast e chime de saída
    process.stdout.write('  [Teste] T3: socket.on(\'user-left\') emite toast e chime de saída ... ');
    const userLeftIndex = appJs.indexOf("socket.on('user-left'");
    let leftHasToast = false;
    let leftHasChime = false;

    if (userLeftIndex !== -1) {
        const handlerBlock = appJs.substring(userLeftIndex, userLeftIndex + 500);
        leftHasToast = handlerBlock.includes('showToast(') && handlerBlock.includes('saiu da sala');
        leftHasChime = handlerBlock.includes("playPresenceChime('leave')") || handlerBlock.includes('playPresenceChime("leave")');
    }

    if (leftHasToast && leftHasChime) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (user-left não aciona showToast ou playPresenceChime)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes de notificação de presença passaram.');
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

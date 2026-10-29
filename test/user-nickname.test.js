const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');
const assert = require('assert');

// Utilitário para cliente de teste
function createClient(url) {
    return Client(url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: IDENTIFICAÇÃO DE USUÁRIOS E APELIDOS');
    console.log('===============================================================\n');

    let failures = 0;

    // Teste 1: Propagação de apelidos (userName) no servidor (server.js)
    process.stdout.write('  [Teste] T1: server.js propaga userName em room-users e user-joined ... ');
    try {
        const { server } = require('../server');
        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;
        const url = `http://127.0.0.1:${port}`;

        const socketAlice = createClient(url);
        const socketBob = createClient(url);

        await new Promise(r => socketAlice.on('connect', r));
        await new Promise(r => socketBob.on('connect', r));

        let bobJoinedEvent = null;
        socketAlice.on('user-joined', data => {
            bobJoinedEvent = data;
        });

        let bobRoomUsersEvent = null;
        socketBob.on('room-users', data => {
            bobRoomUsersEvent = data;
        });

        socketAlice.emit('join-room', { roomId: 'sala-apelidos', userName: 'Alice' });
        await sleep(150);

        socketBob.emit('join-room', { roomId: 'sala-apelidos', userName: 'Bob' });
        await sleep(250);

        socketAlice.disconnect();
        socketBob.disconnect();
        await new Promise(r => server.close(r));

        const aliceSawBobName = bobJoinedEvent && bobJoinedEvent.userName === 'Bob';
        const bobGotUserNamesMap = bobRoomUsersEvent && bobRoomUsersEvent.userNames && typeof bobRoomUsersEvent.userNames === 'object';
        const bobSawAliceInMap = bobGotUserNamesMap && Object.values(bobRoomUsersEvent.userNames).includes('Alice');

        if (aliceSawBobName && bobSawAliceInMap) {
            console.log('\x1b[32mPASSOU\x1b[0m');
        } else {
            console.log('\x1b[31mFALHOU (userName não foi propagado em room-users ou user-joined)\x1b[0m');
            failures++;
        }
    } catch (err) {
        console.log('\x1b[31mFALHOU com erro: ' + err.message + '\x1b[0m');
        failures++;
    }

    // Teste 2: public/app.js renderiza crachá com textContent seguro (Anti-XSS)
    process.stdout.write('  [Teste] T2: public/app.js renderiza user-name com textContent seguro ... ');
    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    const usesInnerHtmlTemplate = appJs.includes('${labelText}');
    const usesTextContentForName = appJs.includes('.user-name') && (appJs.includes('textContent = labelText') || appJs.includes('.textContent = '));

    if (!usesInnerHtmlTemplate && usesTextContentForName) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (labelText interpolado em innerHTML ou ausência de textContent seguro)\x1b[0m');
        failures++;
    }

    // Teste 3: public/index.html contém campos para nome de usuário
    process.stdout.write('  [Teste] T3: public/index.html possui campos inputCreateUserName e inputJoinUserName ... ');
    const htmlPath = path.resolve(__dirname, '../public/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    const hasCreateInput = htmlContent.includes('id="inputCreateUserName"');
    const hasJoinInput = htmlContent.includes('id="inputJoinUserName"');

    if (hasCreateInput && hasJoinInput) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (campos de input para apelido ausentes no formulário de sala)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todos os testes de identificação de usuários passaram.');
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

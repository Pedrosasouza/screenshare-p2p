const fs = require('fs');
const path = require('path');

async function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: POLÍTICA DE PRIVACIDADE E PROVENIÊNCIA CI');
    console.log('===============================================================\n');

    let failures = 0;

    // Teste 1: PRIVACY.md detalha logs reais (app vs Render) e visibilidade de IP P2P entre peers
    process.stdout.write('  [Teste] T1: PRIVACY.md alinha logs de IP (volátil vs Render) e visibilidade mútua de IP ... ');
    const privacyPath = path.resolve(__dirname, '../PRIVACY.md');
    const privacy = fs.readFileSync(privacyPath, 'utf8');

    const mentionsPeerIpExposure = (privacy.includes('Peer IP Visibility') || privacy.includes('visibilidade mútua de IP') || privacy.includes('sharing your IP address')) && privacy.includes('ICE');
    const mentionsRenderEdge = privacy.includes('Render') && (privacy.includes('infrastructure') || privacy.includes('proxy') || privacy.includes('edge'));
    const mentionsVolatileRateLimit = privacy.includes('rate limiting') || privacy.includes('rate-limit') || privacy.includes('rate limit');

    if (mentionsPeerIpExposure && mentionsRenderEdge && mentionsVolatileRateLimit) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (PRIVACY.md não detalha visibilidade mútua de IP entre peers ou distinção infra Render)\x1b[0m');
        failures++;
    }

    // Teste 2: PRIVACY.md e README.md esclarecem modelo DTLS/SRTP e confiança na sinalização
    process.stdout.write('  [Teste] T2: PRIVACY.md e README.md detalham modelo DTLS/SRTP e confiança na sinalização ... ');
    const readmePath = path.resolve(__dirname, '../README.md');
    const readme = fs.readFileSync(readmePath, 'utf8');

    const privacySignalingTrust = privacy.includes('DTLS') && (privacy.includes('signaling channel') || privacy.includes('canal de sinalização')) && (privacy.includes('MitM') || privacy.includes('intermediário') || privacy.includes('fingerprint') || privacy.includes('out-of-band'));
    const readmeSignalingTrust = readme.includes('DTLS') && (readme.includes('sinalização') || readme.includes('signaling'));

    if (privacySignalingTrust && readmeSignalingTrust) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (esclarecimento do modelo de confiança na sinalização DTLS ausente em PRIVACY/README)\x1b[0m');
        failures++;
    }

    // Teste 3: README.md aborda SHA-256, SmartScreen/Authenticode e integridade
    process.stdout.write('  [Teste] T3: README.md documenta integridade SHA-256 e SmartScreen/assinatura ... ');
    const readmeSmartScreen = readme.includes('SmartScreen') || readme.includes('Authenticode');
    const readmeShaIntegrity = readme.includes('SHA-256') && (readme.includes('integridade') || readme.includes('integridade dos binários'));

    if (readmeSmartScreen && readmeShaIntegrity) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (explicação sobre SmartScreen/Authenticode ou SHA-256 ausente no README)\x1b[0m');
        failures++;
    }

    // Teste 4: build-and-release.yml configura atestação de proveniência de artefatos
    process.stdout.write('  [Teste] T4: build-and-release.yml inclui permissões id-token/attestations e attest-build-provenance ... ');
    const workflowPath = path.resolve(__dirname, '../.github/workflows/build-and-release.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    const hasAttestAction = workflow.includes('actions/attest-build-provenance');
    const hasIdTokenPerm = workflow.includes('id-token: write');
    const hasAttestPerm = workflow.includes('attestations: write');

    if (hasAttestAction && hasIdTokenPerm && hasAttestPerm) {
        console.log('\x1b[32mPASSOU\x1b[0m');
    } else {
        console.log('\x1b[31mFALHOU (workflow não possui attest-build-provenance ou permissões necessárias)\x1b[0m');
        failures++;
    }

    console.log('\n===============================================================');
    if (failures === 0) {
        console.log('  ✅ Resultado: Todas as verificações de privacidade e proveniência passaram.');
        console.log('===============================================================\n');
        process.exit(0);
    } else {
        console.log(`  ❌ Resultado: ${failures} validação(ões) falharam conforme esperado antes das alterações.`);
        console.log('===============================================================\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Erro inesperado no teste:', err);
    process.exit(1);
});

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Extrai prioritizeH264 e optimizeSDP diretamente de public/app.js
function loadSDPHelpers() {
    const appJsPath = path.resolve(__dirname, '../public/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    const fnRegex = /function prioritizeH264[\s\S]*?function optimizeSDP[\s\S]*?\n\}/;
    const match = appJs.match(fnRegex);
    if (!match) {
        throw new Error('Não foi possível localizar prioritizeH264 ou optimizeSDP em public/app.js');
    }

    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(match[0] + '\n;this.helpers = { prioritizeH264, optimizeSDP };', sandbox);
    return sandbox.helpers;
}

const SAMPLE_SDP_CHROME = [
    'v=0',
    'o=- 1234567890 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 98 100',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:98 VP8/90000',
    'a=rtpmap:100 VP9/90000',
    'a=fmtp:100 profile-id=0'
].join('\r\n');

const SAMPLE_SDP_NO_FMTP = [
    'v=0',
    'o=- 9876543210 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:111 opus/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 98',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:98 VP8/90000'
].join('\r\n');

function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: OTIMIZAÇÃO E PARSING DE SDP WEBRTC');
    console.log('===============================================================\n');

    const { optimizeSDP } = loadSDPHelpers();
    let failures = 0;

    // Teste 1: Opus Stereo e Bitrate em a=fmtp com a=rtpmap:111 opus/48000/2
    try {
        process.stdout.write('  [Teste] T1: Parâmetros Opus (stereo=1, 128kbps) aplicados no payload correto ... ');
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const opusFmtp = lines.find(l => l.startsWith('a=fmtp:111'));
        assert.ok(opusFmtp, 'Deveria existir uma linha a=fmtp:111');
        assert.ok(opusFmtp.includes('stereo=1'), 'Linha Opus deveria conter stereo=1');
        assert.ok(opusFmtp.includes('sprop-stereo=1'), 'Linha Opus deveria conter sprop-stereo=1');
        assert.ok(opusFmtp.includes('maxaveragebitrate=128000'), 'Linha Opus deveria conter maxaveragebitrate=128000');
        assert.ok(opusFmtp.includes('minptime=10'), 'Parâmetros originais do Opus deveriam ser preservados');
        console.log('PASSOU');
    } catch (err) {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe:', err.message);
    }

    // Teste 2: Video Bitrate Tuning para H264 (payload 96) preservando profile-level-id
    try {
        process.stdout.write('  [Teste] T2: Parâmetros de Bitrate Google aplicados em H264 preservando profile ... ');
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const h264Fmtp = lines.find(l => l.startsWith('a=fmtp:96'));
        assert.ok(h264Fmtp, 'Deveria existir uma linha a=fmtp:96');
        assert.ok(h264Fmtp.includes('x-google-min-bitrate=1800'), 'Deveria conter x-google-min-bitrate=1800');
        assert.ok(h264Fmtp.includes('x-google-start-bitrate=3500'), 'Deveria conter x-google-start-bitrate=3500');
        assert.ok(h264Fmtp.includes('x-google-max-bitrate=6000'), 'Deveria conter x-google-max-bitrate=6000');
        assert.ok(h264Fmtp.includes('profile-level-id=42e01f'), 'profile-level-id original deveria ser preservado');
        console.log('PASSOU');
    } catch (err) {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe:', err.message);
    }

    // Teste 3: Criação de a=fmtp quando codec (VP8 / Opus) não tem fmtp original
    try {
        process.stdout.write('  [Teste] T3: Injeção de a=fmtp para Opus e VP8 quando ausentes originalmente ... ');
        const optimized = optimizeSDP(SAMPLE_SDP_NO_FMTP);
        const lines = optimized.split('\r\n');

        const opusFmtp = lines.find(l => l.startsWith('a=fmtp:111'));
        assert.ok(opusFmtp, 'Deveria injetar a=fmtp:111 para Opus');
        assert.ok(opusFmtp.includes('stereo=1'), 'Linha Opus injetada deve ter stereo=1');

        const vp8Fmtp = lines.find(l => l.startsWith('a=fmtp:98'));
        assert.ok(vp8Fmtp, 'Deveria injetar a=fmtp:98 para VP8');
        assert.ok(vp8Fmtp.includes('x-google-max-bitrate=6000'), 'Linha VP8 injetada deve ter x-google-max-bitrate=6000');
        console.log('PASSOU');
    } catch (err) {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe:', err.message);
    }

    // Teste 4: Limites de largura de banda na seção de vídeo (b=AS e b=TIAS) sem duplicação
    try {
        process.stdout.write('  [Teste] T4: Limites b=AS:6000 e b=TIAS:6000000 presentes sem duplicações ... ');
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const asCount = lines.filter(l => l === 'b=AS:6000').length;
        const tiasCount = lines.filter(l => l === 'b=TIAS:6000000').length;

        assert.strictEqual(asCount, 1, 'Deveria existir exatamente 1 linha b=AS:6000');
        assert.strictEqual(tiasCount, 1, 'Deveria existir exatamente 1 linha b=TIAS:6000000');
        console.log('PASSOU');
    } catch (err) {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe:', err.message);
    }

    // Teste 5: Idempotência (executar optimizeSDP duas vezes seguidas)
    try {
        process.stdout.write('  [Teste] T5: Idempotência de optimizeSDP(optimizeSDP(sdp)) ... ');
        const pass1 = optimizeSDP(SAMPLE_SDP_CHROME);
        const pass2 = optimizeSDP(pass1);

        assert.strictEqual(pass1, pass2, 'Segunda execução deve produzir saída idêntica à primeira');
        console.log('PASSOU');
    } catch (err) {
        failures++;
        console.log('FALHOU');
        console.error('    Detalhe:', err.message);
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ Resultado: ${failures} falhas encontradas.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests();

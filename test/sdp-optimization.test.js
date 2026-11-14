const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSdpModule() {
    return import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/sdp.js')).href);
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

describe('Otimização e parsing de SDP WebRTC (sdp.js)', () => {
    it('T1: aplica parâmetros Opus (stereo=1, 128kbps) no payload correto preservando originais', async () => {
        const { optimizeSDP } = await loadSdpModule();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const opusFmtp = lines.find((l) => l.startsWith('a=fmtp:111'));
        assert.ok(opusFmtp, 'Deveria existir uma linha a=fmtp:111');
        assert.ok(opusFmtp.includes('stereo=1'), 'Linha Opus deveria conter stereo=1');
        assert.ok(opusFmtp.includes('sprop-stereo=1'), 'Linha Opus deveria conter sprop-stereo=1');
        assert.ok(opusFmtp.includes('maxaveragebitrate=128000'), 'Linha Opus deveria conter maxaveragebitrate=128000');
        assert.ok(opusFmtp.includes('minptime=10'), 'Parâmetros originais do Opus deveriam ser preservados');
    });

    it('T2: aplica parâmetros de bitrate Google em H264 preservando profile-level-id', async () => {
        const { optimizeSDP } = await loadSdpModule();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const h264Fmtp = lines.find((l) => l.startsWith('a=fmtp:96'));
        assert.ok(h264Fmtp, 'Deveria existir uma linha a=fmtp:96');
        assert.ok(h264Fmtp.includes('x-google-min-bitrate=400'), 'Deveria conter x-google-min-bitrate=400');
        assert.ok(h264Fmtp.includes('x-google-start-bitrate=1500'), 'Deveria conter x-google-start-bitrate=1500');
        assert.ok(h264Fmtp.includes('x-google-max-bitrate=6000'), 'Deveria conter x-google-max-bitrate=6000');
        assert.ok(h264Fmtp.includes('profile-level-id=42e01f'), 'profile-level-id original deveria ser preservado');
    });

    it('T3: injeta a=fmtp para Opus e VP8 quando ausentes originalmente', async () => {
        const { optimizeSDP } = await loadSdpModule();
        const optimized = optimizeSDP(SAMPLE_SDP_NO_FMTP);
        const lines = optimized.split('\r\n');

        const opusFmtp = lines.find((l) => l.startsWith('a=fmtp:111'));
        assert.ok(opusFmtp, 'Deveria injetar a=fmtp:111 para Opus');
        assert.ok(opusFmtp.includes('stereo=1'), 'Linha Opus injetada deve ter stereo=1');

        const vp8Fmtp = lines.find((l) => l.startsWith('a=fmtp:98'));
        assert.ok(vp8Fmtp, 'Deveria injetar a=fmtp:98 para VP8');
        assert.ok(vp8Fmtp.includes('x-google-max-bitrate=6000'), 'Linha VP8 injetada deve ter x-google-max-bitrate=6000');
    });

    it('T4: inclui limites b=AS:6000 e b=TIAS:6000000 sem duplicações e após c= conforme RFC 4566', async () => {
        const { optimizeSDP } = await loadSdpModule();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const lines = optimized.split('\r\n');

        const asCount = lines.filter((l) => l === 'b=AS:6000').length;
        const tiasCount = lines.filter((l) => l === 'b=TIAS:6000000').length;

        assert.strictEqual(asCount, 1, 'Deveria existir exatamente 1 linha b=AS:6000');
        assert.strictEqual(tiasCount, 1, 'Deveria existir exatamente 1 linha b=TIAS:6000000');

        const mVideoIdx = lines.findIndex((l) => l.startsWith('m=video'));
        const cVideoIdx = lines.findIndex((l, idx) => idx > mVideoIdx && l.startsWith('c='));
        const asIdx = lines.indexOf('b=AS:6000');
        const tiasIdx = lines.indexOf('b=TIAS:6000000');
        assert.ok(cVideoIdx > mVideoIdx, 'c= deve existir após m=video');
        assert.ok(asIdx > cVideoIdx, 'b=AS deve aparecer após c= conforme RFC 4566');
        assert.ok(tiasIdx > cVideoIdx, 'b=TIAS deve aparecer após c= conforme RFC 4566');
    });

    it('T5: garante idempotência ao executar optimizeSDP duas vezes seguidas', async () => {
        const { optimizeSDP } = await loadSdpModule();
        const pass1 = optimizeSDP(SAMPLE_SDP_CHROME);
        const pass2 = optimizeSDP(pass1);

        assert.strictEqual(pass1, pass2, 'Segunda execução deve produzir saída idêntica à primeira');
    });

    it('T6: prioriza VP8 e VP9 antes de H264 na linha m=video', async () => {
        const { optimizeSDP } = await loadSdpModule();
        const optimized = optimizeSDP(SAMPLE_SDP_CHROME);
        const mVideoLine = optimized.split('\r\n').find((l) => l.startsWith('m=video'));
        assert.ok(mVideoLine, 'Deveria existir linha m=video');
        const payloads = mVideoLine.split(' ').slice(3);
        assert.deepStrictEqual(payloads, ['98', '100', '96'], 'Ordem esperada em m=video: VP8 (98), VP9 (100), H264 (96)');
    });
});

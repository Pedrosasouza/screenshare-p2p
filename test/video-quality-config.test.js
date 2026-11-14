const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModules() {
    const qos = await import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/qos.js')).href);
    const qosMonitorMod = await import(pathToFileURL(path.resolve(__dirname, '../public/js/modules/qos-monitor.js')).href);
    return { qos, qosMonitorMod };
}

describe('Seleção de resolução (720p/1080p) e FPS (30/60)', () => {
    it('T1: getVideoConstraints mapeia resoluções e framerates corretamente', async () => {
        const { qos } = await loadModules();

        const c1080_60 = qos.getVideoConstraints('1080p', 60);
        assert.strictEqual(c1080_60.width.ideal, 1920);
        assert.strictEqual(c1080_60.width.max, 1920);
        assert.strictEqual(c1080_60.height.ideal, 1080);
        assert.strictEqual(c1080_60.height.max, 1080);
        assert.strictEqual(c1080_60.frameRate.ideal, 60);
        assert.strictEqual(c1080_60.frameRate.max, 60);

        const c720_30 = qos.getVideoConstraints('720p', 30);
        assert.strictEqual(c720_30.width.ideal, 1280);
        assert.strictEqual(c720_30.width.max, 1280);
        assert.strictEqual(c720_30.height.ideal, 720);
        assert.strictEqual(c720_30.height.max, 720);
        assert.strictEqual(c720_30.frameRate.ideal, 30);
        assert.strictEqual(c720_30.frameRate.max, 30);

        const c1080_30 = qos.getVideoConstraints('1080p', 30);
        assert.strictEqual(c1080_30.height.ideal, 1080);
        assert.strictEqual(c1080_30.frameRate.ideal, 30);

        const c720_60 = qos.getVideoConstraints('720p', 60);
        assert.strictEqual(c720_60.height.ideal, 720);
        assert.strictEqual(c720_60.frameRate.ideal, 60);
    });

    it('T2: getMaxBitrateForPeerCount adequa teto de bitrate por perfil', async () => {
        const { qos } = await loadModules();

        const b1080_60 = qos.getMaxBitrateForPeerCount(1, '1080p', 60);
        const b1080_30 = qos.getMaxBitrateForPeerCount(1, '1080p', 30);
        const b720_60 = qos.getMaxBitrateForPeerCount(1, '720p', 60);
        const b720_30 = qos.getMaxBitrateForPeerCount(1, '720p', 30);

        assert.strictEqual(b1080_60, 6000000, '1080p60 para 1 peer deve ser 6.0 Mbps');
        assert.strictEqual(b1080_30, 4000000, '1080p30 para 1 peer deve ser 4.0 Mbps');
        assert.strictEqual(b720_60, 2800000, '720p60 para 1 peer deve ser 2.8 Mbps');
        assert.strictEqual(b720_30, 1800000, '720p30 para 1 peer deve ser 1.8 Mbps');
        assert.ok(b720_30 < b1080_60, 'Perfil 720p30 deve alocar menos bitrate que 1080p60');
    });

    it('T3: public/index.html contém seletores de 1080p/720p e 60fps/30fps', () => {
        const htmlPath = path.resolve(__dirname, '../public/index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        assert.ok(html.includes('name="videoResolution"') && html.includes('value="1080p"'));
        assert.ok(html.includes('name="videoResolution"') && html.includes('value="720p"'));
        assert.ok(html.includes('name="videoFps"') && html.includes('value="60"'));
        assert.ok(html.includes('name="videoFps"') && html.includes('value="30"'));
    });

    it('T4: alocação multi-peer e degradationPreference=maintain-framerate no modo fluent', async () => {
        const { qos, qosMonitorMod } = await loadModules();

        const b2Peers = qos.getMaxBitrateForPeerCount(2, '1080p', 60);
        const b3Peers = qos.getMaxBitrateForPeerCount(3, '1080p', 60);

        assert.ok(b2Peers <= 2500000, `Bitrate para 2 peers (${b2Peers}) deve ser <= 2.5 Mbps para não saturar upload`);
        assert.ok(b3Peers <= 1800000, `Bitrate para 3 peers (${b3Peers}) deve ser <= 1.8 Mbps`);
        assert.ok(2 * b2Peers <= 5500000, 'Total upload para 2 peers deve ser <= 5.5 Mbps');
        assert.ok(3 * b3Peers <= 5500000, 'Total upload para 3 peers deve ser <= 5.5 Mbps');

        const state = {
            selectedVideoResolution: '1080p',
            selectedVideoFps: 60,
            qualityMode: 'fluent',
            contentHintMode: 'motion'
        };
        const monitor = qosMonitorMod.createQosMonitor({
            state,
            dom: {},
            getPeers: () => new Map()
        });

        const mockSender = {
            getParameters: () => ({ encodings: [{}] }),
            setParameters: async (p) => { mockSender.appliedParams = p; }
        };
        monitor.configureSenderParams(mockSender, 'video');
        assert.strictEqual(
            mockSender.appliedParams.degradationPreference,
            'maintain-framerate',
            'degradationPreference no modo Fluido deve preservar FPS (maintain-framerate)'
        );
    });
});

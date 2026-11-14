const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Política de privacidade e proveniência CI', () => {
    it('T1: PRIVACY.md alinha logs de IP (volátil vs Render) e visibilidade mútua de IP', () => {
        const privacy = fs.readFileSync(path.resolve(__dirname, '../PRIVACY.md'), 'utf8');

        const mentionsPeerIpExposure = (
            privacy.includes('Peer IP Visibility') ||
            privacy.includes('visibilidade mútua de IP') ||
            privacy.includes('sharing your IP address')
        ) && privacy.includes('ICE');
        const mentionsRenderEdge = privacy.includes('Render') && (
            privacy.includes('infrastructure') ||
            privacy.includes('proxy') ||
            privacy.includes('edge')
        );
        const mentionsVolatileRateLimit = (
            privacy.includes('rate limiting') ||
            privacy.includes('rate-limit') ||
            privacy.includes('rate limit')
        );

        assert.ok(mentionsPeerIpExposure, 'PRIVACY.md deve detalhar visibilidade mútua de IP entre peers via ICE');
        assert.ok(mentionsRenderEdge, 'PRIVACY.md deve distinguir infraestrutura Render');
        assert.ok(mentionsVolatileRateLimit, 'PRIVACY.md deve documentar logs voláteis de rate limit');
    });

    it('T2: PRIVACY.md e README.md detalham modelo DTLS/SRTP e confiança na sinalização', () => {
        const privacy = fs.readFileSync(path.resolve(__dirname, '../PRIVACY.md'), 'utf8');
        const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');

        const privacySignalingTrust = privacy.includes('DTLS') &&
            (privacy.includes('signaling channel') || privacy.includes('canal de sinalização')) &&
            (privacy.includes('MitM') || privacy.includes('intermediário') || privacy.includes('fingerprint') || privacy.includes('out-of-band'));
        const readmeSignalingTrust = readme.includes('DTLS') &&
            (readme.includes('sinalização') || readme.includes('signaling'));

        assert.ok(privacySignalingTrust, 'PRIVACY.md deve explicar confiança na sinalização DTLS');
        assert.ok(readmeSignalingTrust, 'README.md deve explicar confiança na sinalização DTLS');
    });

    it('T3: README.md documenta integridade SHA-256 e SmartScreen/Authenticode', () => {
        const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');

        const readmeSmartScreen = readme.includes('SmartScreen') || readme.includes('Authenticode');
        const readmeShaIntegrity = readme.includes('SHA-256') &&
            (readme.includes('integridade') || readme.includes('integridade dos binários'));

        assert.ok(readmeSmartScreen, 'README.md deve explicar SmartScreen/Authenticode');
        assert.ok(readmeShaIntegrity, 'README.md deve documentar integridade SHA-256');
    });

    it('T4: build-and-release.yml inclui permissões id-token/attestations e attest-build-provenance', () => {
        const workflow = fs.readFileSync(
            path.resolve(__dirname, '../.github/workflows/build-and-release.yml'),
            'utf8'
        );

        assert.ok(workflow.includes('actions/attest-build-provenance'), 'workflow deve incluir attest-build-provenance');
        assert.ok(workflow.includes('id-token: write'), 'workflow deve ter id-token: write');
        assert.ok(workflow.includes('attestations: write'), 'workflow deve ter attestations: write');
    });
});

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
        assert.ok(workflow.includes('npm run lint'), 'workflow deve executar npm run lint');
        assert.ok(workflow.includes('npm run typecheck'), 'workflow deve executar npm run typecheck');
    });

    it('T5: formato ESM/CJS explícito elimina warnings MODULE_TYPELESS_PACKAGE_JSON e scripts lint/typecheck existem', async () => {
        const { spawnSync } = require('node:child_process');
        const rootDir = path.resolve(__dirname, '..');

        const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
        assert.strictEqual(rootPkg.type, 'commonjs');
        assert.strictEqual(typeof rootPkg.scripts.lint, 'string');
        assert.strictEqual(typeof rootPkg.scripts.typecheck, 'string');

        const publicPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'public/package.json'), 'utf8'));
        const jsPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'public/js/package.json'), 'utf8'));
        const modulesPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'public/js/modules/package.json'), 'utf8'));
        assert.strictEqual(publicPkg.type, 'module');
        assert.strictEqual(jsPkg.type, 'commonjs');
        assert.strictEqual(modulesPkg.type, 'module');

        const modulesDir = path.join(rootDir, 'public/js/modules');
        const moduleFiles = fs.readdirSync(modulesDir)
            .filter((name) => name.endsWith('.js'))
            .map((name) => path.join(modulesDir, name));
        const targets = [path.join(rootDir, 'public/app.js'), ...moduleFiles];

        const script = [
            "const { pathToFileURL } = require('node:url');",
            '(async () => {',
            '  for (const filePath of JSON.parse(process.argv[1])) {',
            '    await import(pathToFileURL(filePath).href);',
            '  }',
            '})().catch((err) => { console.error(err); process.exit(1); });'
        ].join('\n');

        const result = spawnSync(process.execPath, ['-e', script, JSON.stringify(targets)], {
            cwd: rootDir,
            encoding: 'utf8'
        });
        assert.strictEqual(result.status, 0, `Import de módulos ES falhou: ${result.stderr}`);
        assert.strictEqual(
            result.stderr.includes('MODULE_TYPELESS_PACKAGE_JSON'),
            false,
            `Stderr não deve conter MODULE_TYPELESS_PACKAGE_JSON: ${result.stderr}`
        );
    });

    it('T6: README.md e PRIVACY.md refletem recursos v1.1.0, STUN/TURN atualizados e sessionStorage', () => {
        const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
        const privacy = fs.readFileSync(path.resolve(__dirname, '../PRIVACY.md'), 'utf8');

        assert.ok(readme.includes('v1.1.0'), 'README.md deve atualizar badge para v1.1.0');
        assert.ok(readme.includes('Spotlight'), 'README.md deve documentar Modo Spotlight');
        assert.ok(readme.includes('Picture-in-Picture'), 'README.md deve documentar PiP');
        assert.ok(readme.includes("style-src 'self'"), 'README.md deve documentar CSP style-src self');
        assert.ok(readme.includes('npm run lint'), 'README.md deve documentar npm run lint');
        assert.ok(readme.includes('npm run typecheck'), 'README.md deve documentar npm run typecheck');

        assert.ok(privacy.includes('stun.cloudflare.com:3478'), 'PRIVACY.md deve alinhar STUN com src/server/ice.js');
        assert.ok(privacy.includes('check-room'), 'PRIVACY.md deve mencionar rate limit em check-room');
        assert.ok(privacy.includes('streamgrid_room_pass'), 'PRIVACY.md deve documentar uso de sessionStorage');
    });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockDocument, createMockElement } = require('./helpers/mock-dom');

describe('Utilitários da barra inferior (PiP e Stats)', () => {
    it('T1: public/index.html define btnTogglePip, btnToggleStats, statsModal e formulario de servidor customizado', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
        assert.ok(html.includes('id="btnTogglePip"'));
        assert.ok(html.includes('id="btnToggleStats"'));
        assert.ok(html.includes('id="statsModal"'));
        assert.ok(html.includes('id="customServerFormContainer"'));
        assert.ok(html.includes('id="inputCustomServerUrl"'));
        assert.ok(html.includes('id="btnSaveServerUrl"'));
    });

    it('T2: stats-modal togglePictureInPicture ativa e sai de PiP corretamente', async () => {
        const { createStatsModalController } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/stats-modal.js')).href
        );

        const doc = createMockDocument();
        let pipRequested = 0;
        let pipExited = 0;
        doc.pictureInPictureEnabled = true;
        doc.pictureInPictureElement = null;
        doc.exitPictureInPicture = async () => {
            pipExited += 1;
            doc.pictureInPictureElement = null;
        };

        const streamGrid = createMockElement('div', { id: 'streamGrid' });
        const remoteTile = createMockElement('div', { id: 'tile-peer-1', className: 'stream-tile' });
        const remoteVideo = createMockElement('video');
        remoteVideo.requestPictureInPicture = async () => {
            pipRequested += 1;
            doc.pictureInPictureElement = remoteVideo;
        };
        remoteTile.appendChild(remoteVideo);
        streamGrid.appendChild(remoteTile);
        doc.body.appendChild(streamGrid);

        const toasts = [];
        const ctrl = createStatsModalController({
            state: { selectedVideoResolution: '1080p' },
            dom: { streamGrid },
            getPeers: () => new Map(),
            getServerUrl: () => 'http://127.0.0.1',
            showToast: (msg, type) => toasts.push({ msg, type }),
            documentObj: doc,
            windowObj: { location: { reload: () => {} } }
        });

        await ctrl.togglePictureInPicture();
        assert.strictEqual(pipRequested, 1);
        assert.strictEqual(doc.pictureInPictureElement, remoteVideo);

        await ctrl.togglePictureInPicture();
        assert.strictEqual(pipExited, 1);
        assert.strictEqual(doc.pictureInPictureElement, null);
        assert.strictEqual(toasts.length, 0);
    });

    it('T3: openStatsModal/closeStatsModal respondem a clique de backdrop e API pública', async () => {
        const { createStatsModalController } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/stats-modal.js')).href
        );

        const doc = createMockDocument();
        const statsModal = createMockElement('div', { id: 'statsModal' });
        statsModal.hidden = true;
        statsModal.style.display = 'none';
        const btnToggleStats = createMockElement('button', { id: 'btnToggleStats' });
        const btnCloseStatsModal = createMockElement('button', { id: 'btnCloseStatsModal' });
        doc.body.appendChild(statsModal);

        const ctrl = createStatsModalController({
            state: { selectedVideoResolution: '1080p' },
            dom: { statsModal, btnToggleStats, btnCloseStatsModal },
            getPeers: () => new Map(),
            getServerUrl: () => 'http://127.0.0.1',
            showToast: () => {},
            documentObj: doc,
            windowObj: { location: { reload: () => {} } }
        });
        ctrl.bindEvents();

        try {
            ctrl.openStatsModal();
            assert.strictEqual(ctrl.isStatsModalOpen(), true);

            // Backdrop click fecha
            statsModal.dispatchEvent({ type: 'click', target: statsModal });
            assert.strictEqual(ctrl.isStatsModalOpen(), false);
            assert.strictEqual(statsModal.style.display, 'none');

            // Reabre e fecha via botão
            btnToggleStats.click();
            assert.strictEqual(ctrl.isStatsModalOpen(), true);
            btnCloseStatsModal.click();
            assert.strictEqual(ctrl.isStatsModalOpen(), false);
        } finally {
            ctrl.closeStatsModal();
        }
    });

    it('T4: toggleVideoPictureInPicture alterna PiP entre dois vídeos distintos e trata saída no mesmo vídeo', async () => {
        const { toggleVideoPictureInPicture } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/tile-dom.js')).href
        );

        const doc = createMockDocument();
        let exitCount = 0;
        doc.pictureInPictureEnabled = true;
        doc.pictureInPictureElement = null;
        doc.exitPictureInPicture = async () => {
            exitCount += 1;
            doc.pictureInPictureElement = null;
        };

        const videoA = createMockElement('video');
        const videoB = createMockElement('video');
        let reqA = 0;
        let reqB = 0;
        videoA.requestPictureInPicture = async () => {
            reqA += 1;
            doc.pictureInPictureElement = videoA;
        };
        videoB.requestPictureInPicture = async () => {
            reqB += 1;
            doc.pictureInPictureElement = videoB;
        };

        await toggleVideoPictureInPicture(videoA, { documentObj: doc });
        assert.strictEqual(reqA, 1);
        assert.strictEqual(doc.pictureInPictureElement, videoA);

        // Ativar PiP em B enquanto A está em PiP troca direto para B
        await toggleVideoPictureInPicture(videoB, { documentObj: doc });
        assert.strictEqual(reqB, 1);
        assert.strictEqual(exitCount, 0);
        assert.strictEqual(doc.pictureInPictureElement, videoB);

        // Clicar novamente em B sai do PiP
        await toggleVideoPictureInPicture(videoB, { documentObj: doc });
        assert.strictEqual(exitCount, 1);
        assert.strictEqual(doc.pictureInPictureElement, null);
    });
});

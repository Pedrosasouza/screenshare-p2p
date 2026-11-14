const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockDocument, createMockElement } = require('./helpers/mock-dom');
const { MockMediaStream, createMockTrack } = require('./helpers/mock-webrtc');
const { startTestServer } = require('./helpers/test-server');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Identificação de usuários e apelidos', () => {
    it('T1: server.js propaga userName em room-users e user-joined', async () => {
        const ts = await startTestServer();
        try {
            const socketAlice = await ts.connectClient();
            const socketBob = await ts.connectClient();

            let bobJoinedEvent = null;
            socketAlice.on('user-joined', (data) => {
                bobJoinedEvent = data;
            });

            let bobRoomUsersEvent = null;
            socketBob.on('room-users', (data) => {
                bobRoomUsersEvent = data;
            });

            socketAlice.emit('join-room', { roomId: 'sala-apelidos', userName: 'Alice' });
            await sleep(100);
            socketBob.emit('join-room', { roomId: 'sala-apelidos', userName: 'Bob' });
            await sleep(150);

            socketAlice.disconnect();
            socketBob.disconnect();

            assert.ok(bobJoinedEvent && bobJoinedEvent.userName === 'Bob');
            assert.ok(
                bobRoomUsersEvent &&
                bobRoomUsersEvent.userNames &&
                Object.values(bobRoomUsersEvent.userNames).includes('Alice')
            );
        } finally {
            await ts.close();
        }
    });

    it('T2: stream-grid renderiza crachá .user-name com textContent seguro (Anti-XSS)', async () => {
        const gridSource = fs.readFileSync(
            path.resolve(__dirname, '../public/js/modules/stream-grid.js'),
            'utf8'
        );
        assert.ok(!gridSource.includes('${labelText}'), 'labelText não pode ser interpolado em innerHTML');
        assert.ok(gridSource.includes('.user-name'), 'stream-grid.js deve criar elemento .user-name');

        const { createStreamGridController } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/stream-grid.js')).href
        );
        const doc = createMockDocument();
        const streamGrid = createMockElement('div', { id: 'streamGrid' });
        doc.body.appendChild(streamGrid);

        const ctrl = createStreamGridController({
            state: { isSharing: false, localStream: null, currentRoomId: 'sala-xss' },
            dom: { streamGrid },
            getPeers: () => new Map(),
            getRemoteActiveStreams: () => new Set(),
            getQualityMonitor: () => null,
            isDesktopApp: () => false,
            getServerUrl: () => 'http://127.0.0.1',
            showToast: () => {},
            documentObj: doc,
            windowObj: {},
            navigatorObj: {},
            onToggleTileFullscreen: () => {},
            onShowTapToUnmuteBadge: () => {}
        });

        const xssName = '<img src=x onerror=alert(1)>';
        const tile = ctrl.createStreamTile('peer-xss', new MockMediaStream([createMockTrack('video')]), xssName, true);
        const nameEl = tile.querySelector('.user-name');
        assert.ok(nameEl, 'elemento .user-name deve existir no tile');
        assert.strictEqual(nameEl.textContent, xssName);
        assert.strictEqual(nameEl.innerHTML, '');
    });

    it('T3: public/index.html possui campos inputCreateUserName e inputJoinUserName', () => {
        const htmlContent = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
        assert.ok(htmlContent.includes('id="inputCreateUserName"'));
        assert.ok(htmlContent.includes('id="inputJoinUserName"'));
    });
});

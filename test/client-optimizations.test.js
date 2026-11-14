const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockDocument, createMockElement } = require('./helpers/mock-dom');
const { MockMediaStream, createMockTrack, createMockPeerConnection } = require('./helpers/mock-webrtc');

describe('Melhorias recomendadas (Pacotes 2, 3 e 4)', () => {
    it('T1: package.json integra testes Rust (test:rust) e suíte Desktop Bridge', () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
        const testScript = pkg.scripts && pkg.scripts.test;
        const testRustScript = pkg.scripts && pkg.scripts['test:rust'];

        assert.ok(
            testScript && (testScript.includes('desktop-bridge.test.js') || testScript.includes('node --test')),
            'scripts.test deve executar desktop-bridge.test.js'
        );
        assert.ok(
            testRustScript && testRustScript.includes('src-tauri/Cargo.toml'),
            'scripts.test:rust deve apontar para src-tauri/Cargo.toml'
        );
    });

    it('T2 & T3: webrtc-mesh implementa setPeerConnectionStatus, telemetria, warning badge e visibilitychange', async () => {
        const { createWebRtcMesh } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/webrtc-mesh.js')).href
        );

        const doc = createMockDocument();
        const streamGrid = createMockElement('div', { id: 'streamGrid' });
        const tile = createMockElement('div', { id: 'stream-peer-1' });
        const overlay = createMockElement('div', { className: 'stream-overlay-info' });
        tile.appendChild(overlay);
        streamGrid.appendChild(tile);
        doc.body.appendChild(streamGrid);

        const win = { addEventListener: () => {} };
        const state = {
            currentUserName: 'Host',
            isSharing: true,
            localStream: null,
            activeShareGeneration: 0,
            currentRoomId: 'sala-opt'
        };

        class MockPC {
            constructor() {
                const pc = createMockPeerConnection();
                pc.iceConnectionState = 'failed';
                pc.connectionState = 'failed';
                pc.getStats = async () => new Map([
                    ['pair-1', { type: 'candidate-pair', state: 'failed', nominated: true, localCandidateId: 'lc', remoteCandidateId: 'rc' }],
                    ['lc', { type: 'local-candidate', candidateType: 'host' }],
                    ['rc', { type: 'remote-candidate', candidateType: 'srflx' }]
                ]);
                return pc;
            }
        }

        const mesh = createWebRtcMesh({
            state,
            dom: { streamGrid },
            getSocket: () => ({ id: 'self', emit: () => {} }),
            getQosMonitor: () => ({ configureSenderParams: () => {}, updateSendersForActivePeers: () => {} }),
            getGrid: () => ({
                updateMemberCount: () => {},
                updateGridState: () => {},
                updateEchoWarningVisibility: () => {},
                updatePeerUserName: () => {},
                createStreamTile: () => {},
                startTilePlayback: () => {}
            }),
            getScreenShare: () => ({ invalidateGeneration: () => {}, stopScreenShare: () => {} }),
            getRoomModal: () => ({}),
            getServerUrl: () => 'http://127.0.0.1:0',
            rtcConfig: { iceServers: [] },
            refreshIceServers: async () => {},
            scheduleIceRefreshTimer: () => {},
            registerFullscreenChangeHandler: () => {},
            saveSessionRoomPassword: () => {},
            clearSessionRoomPassword: () => {},
            showToast: () => {},
            playPresenceChime: () => {},
            RTCPeerConnectionCtor: MockPC,
            documentObj: doc,
            windowObj: win
        });

        try {
            const pc = new MockPC();
            const transceiver = {
                sender: { track: { kind: 'video' } },
                receiver: { track: { kind: 'video', enabled: true } }
            };
            pc.getTransceivers = () => [transceiver];
            const remoteTrack = createMockTrack('video', 'remote-v1');
            const remoteStream = new MockMediaStream([remoteTrack]);
            mesh.peers.set('peer-1', { pc, stream: remoteStream, tileEl: tile, userName: 'Peer 1' });

            mesh.setPeerConnectionStatus('peer-1', 'failed', 'Sem rota P2P');
            const badge = tile.querySelector('.peer-connection-warning');
            assert.ok(badge, 'Badge .peer-connection-warning deve ser criado em falha P2P');
            const badgeText = badge.querySelector('span');
            assert.ok(badgeText, 'Badge deve conter span de mensagem');
            assert.strictEqual(badgeText.textContent, 'Sem rota P2P');

            await mesh.logPeerConnectionTelemetry('peer-1', pc);

            mesh.bindLifecycleListeners();
            doc.hidden = true;
            doc.dispatchEvent({ type: 'visibilitychange' });
            assert.strictEqual(remoteTrack.enabled, false, 'Deve pausar trilha de vídeo em segundo plano');

            doc.hidden = false;
            doc.dispatchEvent({ type: 'visibilitychange' });
            assert.strictEqual(remoteTrack.enabled, true, 'Deve reativar trilha de vídeo ao retornar ao foco');
        } finally {
            mesh.cleanupRoomState({ keepPassword: true });
        }
    });
});

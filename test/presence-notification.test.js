const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockDocument, createMockElement } = require('./helpers/mock-dom');
const { createMockPeerConnection } = require('./helpers/mock-webrtc');

describe('Notificação e chime de presença (join/leave)', () => {
    it('T1: playPresenceChime utiliza AudioContext e oscilador para join/leave', async () => {
        const { playPresenceChime } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/ui-feedback.js')).href
        );

        const oscCalls = [];
        const gainCalls = [];
        let createdCtx = 0;

        class FakeAudioContext {
            constructor() {
                createdCtx += 1;
                this.state = 'running';
                this.currentTime = 1.0;
                this.destination = {};
            }
            createOscillator() {
                return {
                    type: '',
                    frequency: {
                        setValueAtTime: (freq, t) => oscCalls.push({ op: 'set', freq, t }),
                        exponentialRampToValueAtTime: (freq, t) => oscCalls.push({ op: 'ramp', freq, t })
                    },
                    connect: () => {},
                    start: () => oscCalls.push({ op: 'start' }),
                    stop: () => oscCalls.push({ op: 'stop' })
                };
            }
            createGain() {
                return {
                    gain: {
                        setValueAtTime: (val, t) => gainCalls.push({ op: 'set', val, t }),
                        exponentialRampToValueAtTime: (val, t) => gainCalls.push({ op: 'ramp', val, t })
                    },
                    connect: () => {}
                };
            }
        }

        const prevWin = global.window;
        global.window = { AudioContext: FakeAudioContext };
        try {
            playPresenceChime('join');
            playPresenceChime('leave');

            assert.strictEqual(createdCtx, 1, 'Deve reutilizar _presenceAudioCtx');
            assert.strictEqual(oscCalls.filter((c) => c.op === 'start').length, 2);
            assert.strictEqual(oscCalls.filter((c) => c.op === 'stop').length, 2);
            assert.strictEqual(oscCalls[0].freq, 440);
            assert.strictEqual(oscCalls[1].freq, 587.33);
            assert.ok(gainCalls.length >= 4);
        } finally {
            if (prevWin === undefined) delete global.window;
            else global.window = prevWin;
        }
    });

    it('T2 & T3: webrtc-mesh handleUserJoined e handleUserLeft disparam showToast e playPresenceChime', async () => {
        const { createWebRtcMesh } = await import(
            pathToFileURL(path.resolve(__dirname, '../public/js/modules/webrtc-mesh.js')).href
        );

        const toasts = [];
        const chimes = [];
        const doc = createMockDocument();
        const win = { addEventListener: () => {} };
        const state = {
            currentUserName: 'Host',
            isSharing: false,
            localStream: null,
            activeShareGeneration: 0,
            currentRoomId: 'sala-teste'
        };
        const dom = {
            streamGrid: createMockElement('div', { id: 'streamGrid' }),
            memberCountEl: createMockElement('span', { id: 'memberCount' })
        };

        class MockPC {
            constructor() {
                return createMockPeerConnection();
            }
        }

        let mesh;
        mesh = createWebRtcMesh({
            state,
            dom,
            getSocket: () => ({ id: 'self-id', emit: () => {} }),
            getQosMonitor: () => ({ configureSenderParams: () => {}, updateSendersForActivePeers: () => {} }),
            getGrid: () => ({
                updateMemberCount: () => {},
                updateGridState: () => {},
                updateEchoWarningVisibility: () => {},
                updatePeerUserName: (id, name) => {
                    const p = mesh && mesh.peers.get(id);
                    if (p) p.userName = name;
                },
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
            showToast: (msg, type) => toasts.push({ msg, type }),
            playPresenceChime: (kind) => chimes.push(kind),
            RTCPeerConnectionCtor: MockPC,
            documentObj: doc,
            windowObj: win
        });

        try {
            mesh.handleUserJoined({ socketId: 'peer-1', userName: 'Alice', memberCount: 2 });
            assert.ok(toasts.some((t) => t.msg.includes('Alice') && t.msg.includes('entrou na sala')));
            assert.deepStrictEqual(chimes, ['join']);

            mesh.handleUserLeft({ socketId: 'peer-1', memberCount: 1 });
            assert.ok(toasts.some((t) => t.msg.includes('Alice') && t.msg.includes('saiu da sala')));
            assert.deepStrictEqual(chimes, ['join', 'leave']);
        } finally {
            mesh.cleanupRoomState({ keepPassword: true });
        }
    });
});

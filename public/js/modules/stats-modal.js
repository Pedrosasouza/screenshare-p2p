import { collectPeerTelemetry } from './qos.js';
import { getActiveIceProvider, getIceProviderDisplayLabel } from './ice-config.js';
import { SERVER_URL_STORAGE_KEY } from './signaling-url.js';

export function createStatsModalController({
    state,
    dom = {},
    getPeers = () => new Map(),
    getServerUrl = () => '',
    showToast = () => {},
    documentObj = (typeof document !== 'undefined' ? document : null),
    windowObj = (typeof window !== 'undefined' ? window : null),
    storage = (typeof localStorage !== 'undefined' ? localStorage : null)
} = {}) {
    let statsUpdateInterval = null;
    let isStatsUpdateRunning = false;
    let statsUpdateGeneration = 0;

    async function updateStatsDisplay() {
        if (isStatsUpdateRunning) return;
        const runId = ++statsUpdateGeneration;
        isStatsUpdateRunning = true;

        try {
            const getEl = (id) => (documentObj && typeof documentObj.getElementById === 'function' ? documentObj.getElementById(id) : null);
            const elConnectionState = getEl('statsConnectionState');
            const elRtt = getEl('statsRtt');
            const elPacketLoss = getEl('statsPacketLoss');
            const elLocalStream = getEl('statsLocalStream');
            const elContentHint = getEl('statsContentHint');
            const elVideoTelemetry = getEl('statsVideoTelemetry');
            const elCodecEncoder = getEl('statsCodecEncoder');
            const elQualityLimitation = getEl('statsQualityLimitation');
            const elIceRoute = getEl('statsIceRoute');

            const peers = getPeers();
            const peerCount = peers ? peers.size : 0;
            if (elConnectionState) {
                if (peerCount === 0) {
                    elConnectionState.textContent = 'Aguardando participantes...';
                } else {
                    let connectedCount = 0;
                    peers.forEach((p) => {
                        if (p.pc && (p.pc.connectionState === 'connected' || p.pc.iceConnectionState === 'connected')) {
                            connectedCount++;
                        }
                    });
                    elConnectionState.textContent = connectedCount > 0
                        ? `Conectado (${connectedCount}/${peerCount} pares)`
                        : `Negociando (${peerCount} pares)`;
                }
            }

            if (elLocalStream) {
                const localStream = state.localStream;
                if (localStream && localStream.active) {
                    const vTrack = typeof localStream.getVideoTracks === 'function' ? localStream.getVideoTracks()[0] : null;
                    const vSettings = vTrack && typeof vTrack.getSettings === 'function' ? vTrack.getSettings() : null;
                    if (vSettings && vSettings.width && vSettings.height) {
                        const capFps = vSettings.frameRate ? Math.round(vSettings.frameRate) : state.selectedVideoFps;
                        elLocalStream.textContent = `Ativa (${vSettings.height}p @ ${capFps} FPS captura)`;
                    } else {
                        elLocalStream.textContent = `Ativa (${state.selectedVideoResolution} @ ${state.selectedVideoFps} FPS)`;
                    }
                } else {
                    elLocalStream.textContent = 'Inativa';
                }
            }

            if (elContentHint) {
                elContentHint.textContent = state.contentHintMode === 'motion'
                    ? `Fluido (Priorizar ${state.selectedVideoFps} FPS)`
                    : 'Detalhado (Nitidez / Texto)';
            }

            let minRtt = null;
            let totalLost = 0;
            let totalReceived = 0;
            let primaryOutbound = null;
            let primaryInbound = null;
            let primaryBweKbps = null;
            const iceRoutes = [];

            if (peers && peers.size > 0) {
                for (const [, peerObj] of peers.entries()) {
                    if (!peerObj.pc || peerObj.pc.connectionState === 'closed') continue;
                    try {
                        const stats = await peerObj.pc.getStats();
                        if (statsUpdateGeneration !== runId) return;
                        const telemetry = collectPeerTelemetry(stats, peerObj._modalStatsState);
                        peerObj._modalStatsState = telemetry.nextState;

                        if (telemetry.currentRoundTripTime != null) {
                            const rttMs = Math.round(telemetry.currentRoundTripTime * 1000);
                            if (minRtt === null || rttMs < minRtt) minRtt = rttMs;
                        }
                        if (telemetry.availableOutgoingBitrate != null && primaryBweKbps === null) {
                            primaryBweKbps = Math.round(telemetry.availableOutgoingBitrate / 1000);
                        }
                        if (telemetry.iceRoute && !iceRoutes.includes(telemetry.iceRoute)) {
                            iceRoutes.push(telemetry.iceRoute);
                        }
                        if (telemetry.outbound && !primaryOutbound) {
                            primaryOutbound = telemetry.outbound;
                        }
                        if (telemetry.inbound) {
                            totalLost += Math.max(0, Number(telemetry.inbound.packetsLost) || 0);
                            totalReceived += Math.max(0, Number(telemetry.inbound.packetsReceived) || 0);
                            if (!primaryInbound) primaryInbound = telemetry.inbound;
                        }
                    } catch (_) {}
                }
            }

            if (statsUpdateGeneration !== runId) return;

            if (elRtt) {
                elRtt.textContent = minRtt !== null ? `${minRtt} ms` : '-- ms';
            }

            if (elPacketLoss) {
                if (totalReceived + totalLost > 0) {
                    const lossPct = ((totalLost / (totalReceived + totalLost)) * 100).toFixed(1);
                    elPacketLoss.textContent = `${lossPct}%`;
                } else {
                    elPacketLoss.textContent = '0%';
                }
            }

            if (elVideoTelemetry) {
                const activeVideo = primaryOutbound || primaryInbound;
                if (activeVideo) {
                    const prefix = primaryOutbound ? 'TX' : 'RX';
                    const resText = activeVideo.width && activeVideo.height
                        ? `${activeVideo.width}x${activeVideo.height}`
                        : state.selectedVideoResolution;
                    const rateText = activeVideo.kbps != null
                        ? `${activeVideo.kbps} kbps`
                        : (primaryOutbound && primaryBweKbps != null ? `BWE ${primaryBweKbps} kbps` : '-- kbps');
                    elVideoTelemetry.textContent = `${prefix} ${resText} @ ${activeVideo.fps} FPS (${rateText})`;
                } else {
                    elVideoTelemetry.textContent = '--';
                }
            }

            if (elCodecEncoder) {
                const codecInfo = primaryOutbound || primaryInbound;
                if (codecInfo && (codecInfo.codec || codecInfo.encoder || codecInfo.decoder)) {
                    const impl = codecInfo.encoder || codecInfo.decoder || 'padrão';
                    elCodecEncoder.textContent = `${codecInfo.codec || 'Video'} (${impl})`;
                } else {
                    elCodecEncoder.textContent = '--';
                }
            }

            if (elQualityLimitation) {
                const reason = primaryOutbound ? primaryOutbound.qualityLimitationReason : 'none';
                const reasonLabels = {
                    none: 'Nenhuma (none)',
                    cpu: 'CPU sobrecarregada (cpu)',
                    bandwidth: 'Banda / Rede (bandwidth)',
                    other: 'Outro recurso (other)'
                };
                elQualityLimitation.textContent = reasonLabels[reason] || reason;
            }

            if (elIceRoute) {
                elIceRoute.textContent = iceRoutes.length > 0 ? iceRoutes.join(', ') : '--';
            }

            const elIceProvider = getEl('statsIceProvider');
            if (elIceProvider) {
                elIceProvider.textContent = getIceProviderDisplayLabel(getActiveIceProvider());
            }

            const elServerUrl = getEl('statsServerUrl');
            const btnResetServer = getEl('btnResetServerUrl');
            let hasSavedServerOverride = false;
            try {
                if (storage) {
                    hasSavedServerOverride = Boolean(storage.getItem(SERVER_URL_STORAGE_KEY));
                }
            } catch (_) {}
            if (elServerUrl) {
                const activeServer = getServerUrl();
                elServerUrl.textContent = activeServer
                    ? (hasSavedServerOverride ? `${activeServer} (override local)` : activeServer)
                    : '--';
            }
            if (btnResetServer) {
                btnResetServer.hidden = !hasSavedServerOverride;
            }
        } finally {
            if (statsUpdateGeneration === runId) {
                isStatsUpdateRunning = false;
            }
        }
    }

    function openStatsModal() {
        const { statsModal } = dom;
        if (statsModal) {
            statsModal.removeAttribute('hidden');
            statsModal.style.display = 'flex';
            updateStatsDisplay();
            if (statsUpdateInterval) clearInterval(statsUpdateInterval);
            statsUpdateInterval = setInterval(updateStatsDisplay, 1000);
        }
    }

    function closeStatsModal() {
        const { statsModal } = dom;
        if (statsModal) {
            statsModal.setAttribute('hidden', '');
            statsModal.style.display = 'none';
            stop();
            statsUpdateGeneration += 1;
            isStatsUpdateRunning = false;
        }
    }

    function isStatsModalOpen() {
        const { statsModal } = dom;
        return Boolean(statsModal && !statsModal.hidden && statsModal.style.display !== 'none');
    }

    function stop() {
        if (statsUpdateInterval) {
            clearInterval(statsUpdateInterval);
            statsUpdateInterval = null;
        }
    }

    async function togglePictureInPicture() {
        if (!documentObj || !documentObj.pictureInPictureEnabled) {
            showToast('Janela Flutuante (Picture-in-Picture) não é suportada neste navegador.', 'warning');
            return;
        }

        try {
            if (documentObj.pictureInPictureElement) {
                await documentObj.exitPictureInPicture();
                return;
            }

            const streamGrid = dom.streamGrid;
            const remoteVideo = streamGrid ? streamGrid.querySelector('.stream-tile:not(#localStreamTile) video') : null;
            const localVideo = streamGrid ? streamGrid.querySelector('#localStreamTile video') : null;
            const targetVideo = remoteVideo || localVideo || (streamGrid ? streamGrid.querySelector('video') : null);

            if (!targetVideo) {
                showToast('Nenhuma transmissão ativa para abrir em janela flutuante.', 'info');
                return;
            }

            await targetVideo.requestPictureInPicture();
        } catch (err) {
            console.error('[PiP] Falha ao alternar Picture-in-Picture:', err);
            showToast('Não foi possível ativar a janela flutuante: ' + (err.message || 'Erro desconhecido'), 'error');
        }
    }

    function resetSavedSignalingServerUrl() {
        let hadOverride = false;
        try {
            if (storage) {
                hadOverride = Boolean(storage.getItem(SERVER_URL_STORAGE_KEY));
                storage.removeItem(SERVER_URL_STORAGE_KEY);
            }
        } catch (_) {}

        if (hadOverride) {
            showToast('Servidor salvo removido. Recarregando para a instância padrão...', 'info', 2500);
            if (windowObj && windowObj.location && typeof windowObj.location.reload === 'function') {
                windowObj.location.reload();
            }
        } else {
            showToast('Já está usando o servidor padrão.', 'info', 2500);
        }
    }

    function bindEvents() {
        const { btnTogglePip, btnResetServerUrl, btnToggleStats, btnCloseStatsModal, statsModal } = dom;
        if (btnTogglePip) btnTogglePip.addEventListener('click', togglePictureInPicture);
        if (btnResetServerUrl) btnResetServerUrl.addEventListener('click', resetSavedSignalingServerUrl);
        if (btnToggleStats) btnToggleStats.addEventListener('click', openStatsModal);
        if (btnCloseStatsModal) btnCloseStatsModal.addEventListener('click', closeStatsModal);
        if (statsModal) {
            statsModal.addEventListener('click', (e) => {
                if (e.target === statsModal) {
                    closeStatsModal();
                }
            });
        }
    }

    return {
        updateStatsDisplay,
        openStatsModal,
        closeStatsModal,
        isStatsModalOpen,
        stop,
        togglePictureInPicture,
        resetSavedSignalingServerUrl,
        bindEvents
    };
}

import { collectPeerTelemetry } from './qos.js';
import { getActiveIceProvider, getIceProviderDisplayLabel } from './ice-config.js';
import { SERVER_URL_STORAGE_KEY, saveCustomSignalingServerUrl } from './signaling-url.js';
import { toggleVideoPictureInPicture } from './tile-dom.js';
import { activateModalFocus, restoreModalFocus } from './modal-a11y.js';

/**
 * @param {{
 *   state?: import('./types.js').AppState,
 *   dom?: import('./types.js').DomRefs,
 *   getPeers?: () => Map<string, any>,
 *   getServerUrl?: () => string,
 *   showToast?: import('./types.js').ShowToastFn,
 *   documentObj?: import('./types.js').AnyDocument | null,
 *   windowObj?: import('./types.js').AnyWindow | null,
 *   storage?: Storage | null
 * }} [options]
 */
export function createStatsModalController({
    state = /** @type {import('./types.js').AppState} */ ({}),
    dom = /** @type {import('./types.js').DomRefs} */ ({}),
    getPeers = () => new Map(),
    getServerUrl = () => '',
    showToast = /** @type {import('./types.js').ShowToastFn} */ (() => {}),
    documentObj = /** @type {import('./types.js').AnyDocument | null} */ (typeof document !== 'undefined' ? document : null),
    windowObj = /** @type {import('./types.js').AnyWindow | null} */ (typeof window !== 'undefined' ? window : null),
    storage = (typeof localStorage !== 'undefined' ? localStorage : null)
} = {}) {
    let statsUpdateInterval = null;
    let isStatsUpdateRunning = false;
    let statsUpdateGeneration = 0;
    let previousFocusEl = null;

    const getEl = (id) => (documentObj && typeof documentObj.getElementById === 'function' ? documentObj.getElementById(id) : null);

    async function updateStatsDisplay() {
        if (isStatsUpdateRunning) return;
        const runId = ++statsUpdateGeneration;
        isStatsUpdateRunning = true;

        try {
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
                const modeLabels = {
                    balanced: 'Equilibrado (Automático)',
                    motion: 'Fluido (Priorizar FPS)',
                    detail: 'Nítido (Nitidez / Texto)'
                };
                if (state.localStream && state.localStream.active && peers && peers.size > 0) {
                    const outboundModes = new Set();
                    peers.forEach((p) => {
                        outboundModes.add((p && p.viewerOptimizationMode) || 'balanced');
                    });
                    const summary = Array.from(outboundModes).map((m) => (
                        m === 'motion' ? 'Fluido' : (m === 'detail' ? 'Nítido' : 'Equilibrado')
                    )).join(', ');
                    elContentHint.textContent = `Por espectador (${summary})`;
                } else if (peers && peers.size > 0) {
                    let activeViewerMode = 'balanced';
                    for (const [, p] of peers.entries()) {
                        if (p && p.tileEl && p.selectedReceiveMode) {
                            activeViewerMode = p.selectedReceiveMode;
                            break;
                        }
                    }
                    elContentHint.textContent = modeLabels[activeViewerMode] || modeLabels.balanced;
                } else {
                    elContentHint.textContent = 'Equilibrado (Escolha por espectador)';
                }
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
            const wasOpen = isStatsModalOpen();
            statsModal.removeAttribute('hidden');
            statsModal.hidden = false;
            const inputCustom = dom.inputCustomServerUrl || getEl('inputCustomServerUrl');
            if (inputCustom) {
                let savedOverride = '';
                try {
                    if (storage && typeof storage.getItem === 'function') {
                        savedOverride = storage.getItem(SERVER_URL_STORAGE_KEY) || '';
                    }
                } catch (_) {}
                inputCustom.value = savedOverride || getServerUrl() || '';
            }
            updateStatsDisplay();
            if (statsUpdateInterval) clearInterval(statsUpdateInterval);
            statsUpdateInterval = setInterval(updateStatsDisplay, 1000);
            if (!wasOpen) {
                previousFocusEl = activateModalFocus(statsModal, documentObj);
            }
        }
    }

    function closeStatsModal() {
        const { statsModal } = dom;
        if (statsModal) {
            statsModal.setAttribute('hidden', '');
            statsModal.hidden = true;
            stop();
            statsUpdateGeneration += 1;
            isStatsUpdateRunning = false;
            restoreModalFocus(previousFocusEl, documentObj);
            previousFocusEl = null;
        }
    }

    function isStatsModalOpen() {
        const { statsModal } = dom;
        return Boolean(statsModal && !statsModal.hidden);
    }

    function stop() {
        if (statsUpdateInterval) {
            clearInterval(statsUpdateInterval);
            statsUpdateInterval = null;
        }
    }

    async function togglePictureInPicture() {
        const activePipEl = documentObj ? documentObj.pictureInPictureElement : null;
        const streamGrid = dom.streamGrid;
        const remoteVideo = streamGrid ? streamGrid.querySelector('.stream-tile:not(#localStreamTile) video') : null;
        const localVideo = streamGrid ? streamGrid.querySelector('#localStreamTile video') : null;
        const targetVideo = activePipEl || remoteVideo || localVideo || (streamGrid ? streamGrid.querySelector('video') : null);
        return toggleVideoPictureInPicture(targetVideo, { documentObj, showToast });
    }

    function saveCustomServerUrl() {
        const inputCustom = dom.inputCustomServerUrl || getEl('inputCustomServerUrl');
        const rawUrl = inputCustom ? inputCustom.value : '';
        const result = saveCustomSignalingServerUrl(rawUrl, { windowObj, storage });
        if (!result.ok) {
            showToast(result.error, 'error', 4000);
            return result;
        }
        showToast(`Servidor atualizado para ${result.url}. Recarregando...`, 'info', 2500);
        if (windowObj && windowObj.location && typeof windowObj.location.reload === 'function') {
            windowObj.location.reload();
        }
        return result;
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
        const inputCustomServerUrl = dom.inputCustomServerUrl || getEl('inputCustomServerUrl');
        const btnSaveServerUrl = dom.btnSaveServerUrl || getEl('btnSaveServerUrl');
        if (btnTogglePip) btnTogglePip.addEventListener('click', togglePictureInPicture);
        if (btnSaveServerUrl) btnSaveServerUrl.addEventListener('click', saveCustomServerUrl);
        if (inputCustomServerUrl) {
            inputCustomServerUrl.addEventListener('keydown', (e) => {
                if (e && e.key === 'Enter') {
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    saveCustomServerUrl();
                }
            });
        }
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
        saveCustomServerUrl,
        resetSavedSignalingServerUrl,
        bindEvents
    };
}

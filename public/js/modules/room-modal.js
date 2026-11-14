import { sanitizeRoomId, generateRandomRoomId } from './room-utils.js';
import { STORAGE_KEY, saveUserName } from './preferences.js';
import {
    getSessionRoomPassword as defaultGetSessionPass,
    clearSessionRoomPassword as defaultClearSessionPass
} from './signaling-url.js';

export function createRoomModalController({
    state,
    dom = {},
    getSocket = () => null,
    onCleanupRoomState = () => {},
    getMembership = () => ({ isRoomMembershipConfirmed: true }),
    showToast = () => {},
    getSessionRoomPassword = defaultGetSessionPass,
    clearSessionRoomPassword = defaultClearSessionPass,
    onThemeInit = () => {},
    onLoadPreferences = () => {},
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    windowObj = (typeof window !== 'undefined' ? window : null)
} = {}) {
    let checkCreateTimeout = null;
    let checkJoinTimeout = null;

    function showRoomError(msg) {
        const { roomErrorBanner } = dom;
        if (!roomErrorBanner) return;
        roomErrorBanner.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> <span></span>';
        const span = roomErrorBanner.querySelector('span');
        if (span) span.textContent = msg || '';
        roomErrorBanner.style.display = 'flex';
        roomErrorBanner.hidden = false;
    }

    function clearRoomError() {
        const { roomErrorBanner } = dom;
        if (!roomErrorBanner) return;
        roomErrorBanner.innerHTML = '';
        roomErrorBanner.style.display = 'none';
        roomErrorBanner.hidden = true;
    }

    function updateRoomModalCloseButton() {
        const canClose = Boolean(state.roomId);
        if (dom.btnCloseRoomModal) {
            dom.btnCloseRoomModal.style.display = canClose ? 'flex' : 'none';
        }
        if (dom.btnCancelRoomModal) {
            dom.btnCancelRoomModal.style.display = canClose ? 'inline-flex' : 'none';
        }
        if (dom.roomChoiceCancelContainer) {
            dom.roomChoiceCancelContainer.style.display = canClose ? 'block' : 'none';
        }
    }

    function checkCreateRoomStatus(roomIdToCheck) {
        const indicator = dom.createRoomStatusIndicator;
        if (!indicator) return;
        const cleanId = sanitizeRoomId(roomIdToCheck);
        if (!cleanId || cleanId.length < 3) {
            indicator.textContent = '';
            indicator.className = 'room-status-indicator';
            return;
        }

        const socket = getSocket();
        if (socket && socket.connected) {
            socket.emit('check-room', { roomId: cleanId }, (res) => {
                if (!res) return;
                if (res.exists) {
                    indicator.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Sala já existe (${res.memberCount} online)`;
                    indicator.className = 'room-status-indicator active';
                } else {
                    indicator.innerHTML = `<i class="fa-solid fa-sparkles"></i> Código disponível!`;
                    indicator.className = 'room-status-indicator new';
                }
            });
        }
    }

    function checkJoinRoomStatus(roomIdToCheck) {
        const indicator = dom.joinRoomStatusIndicator;
        const hint = dom.joinPasswordHint;
        if (!indicator) return;
        const cleanId = sanitizeRoomId(roomIdToCheck);
        if (!cleanId || cleanId.length < 3) {
            indicator.textContent = '';
            indicator.className = 'room-status-indicator';
            if (hint) {
                hint.textContent = '';
                hint.className = 'password-hint';
            }
            return;
        }

        const socket = getSocket();
        if (socket && socket.connected) {
            socket.emit('check-room', { roomId: cleanId }, (res) => {
                if (!res) return;
                if (res.exists) {
                    const count = res.memberCount;
                    const lockBadge = res.hasPassword ? ' &bull; <i class="fa-solid fa-lock" title="Protegida por senha"></i> Com senha' : '';
                    indicator.innerHTML = `<i class="fa-solid fa-circle-check"></i> Sala ativa (${count} ${count === 1 ? 'pessoa' : 'pessoas'})${lockBadge}`;
                    indicator.className = 'room-status-indicator active';
                    if (hint) {
                        if (res.hasPassword) {
                            hint.innerHTML = '<i class="fa-solid fa-lock"></i> Requer senha';
                            hint.className = 'password-hint required';
                        } else {
                            hint.innerHTML = 'Sem senha (Pública)';
                            hint.className = 'password-hint optional';
                        }
                    }
                } else {
                    indicator.innerHTML = `<i class="fa-solid fa-circle-info"></i> Sala vazia (será criada ao entrar)`;
                    indicator.className = 'room-status-indicator new';
                    if (hint) {
                        hint.innerHTML = 'Opcional (Deixe em branco p/ pública)';
                        hint.className = 'password-hint optional';
                    }
                }
            });
        }
    }

    function rollRandomCreateRoom() {
        clearRoomError();
        const uniqueId = generateRandomRoomId();
        if (dom.inputCreateRoomId) {
            dom.inputCreateRoomId.value = uniqueId;
            checkCreateRoomStatus(uniqueId);
        }
    }

    function switchRoomView(viewName) {
        clearRoomError();
        if (dom.roomViewChoice) {
            dom.roomViewChoice.style.display = (viewName === 'choice') ? 'block' : 'none';
            dom.roomViewChoice.hidden = (viewName !== 'choice');
        }
        if (dom.roomViewCreate) {
            dom.roomViewCreate.style.display = (viewName === 'create') ? 'block' : 'none';
            dom.roomViewCreate.hidden = (viewName !== 'create');
        }
        if (dom.roomViewJoin) {
            dom.roomViewJoin.style.display = (viewName === 'join') ? 'block' : 'none';
            dom.roomViewJoin.hidden = (viewName !== 'join');
        }

        if (viewName === 'choice') {
            updateRoomModalCloseButton();
        } else if (viewName === 'create') {
            if (dom.inputCreateUserName && state.currentUserName) dom.inputCreateUserName.value = state.currentUserName;
            if (dom.inputCreateRoomId && !dom.inputCreateRoomId.value.trim()) {
                rollRandomCreateRoom();
            } else if (dom.inputCreateRoomId) {
                checkCreateRoomStatus(dom.inputCreateRoomId.value);
            }
            setTimeout(() => {
                if (dom.inputCreateRoomId) {
                    dom.inputCreateRoomId.focus();
                    dom.inputCreateRoomId.select();
                }
            }, 50);
        } else if (viewName === 'join') {
            if (dom.inputJoinUserName && state.currentUserName) dom.inputJoinUserName.value = state.currentUserName;
            if (dom.inputJoinRoomId) checkJoinRoomStatus(dom.inputJoinRoomId.value);
            setTimeout(() => {
                if (dom.inputJoinRoomId) {
                    dom.inputJoinRoomId.focus();
                    if (dom.inputJoinRoomId.value) dom.inputJoinRoomId.select();
                }
            }, 50);
        }
    }

    function openRoomModal(initialView = 'choice') {
        clearRoomError();
        updateRoomModalCloseButton();
        switchRoomView(initialView);
        if (dom.roomModal) {
            dom.roomModal.style.removeProperty('display');
            dom.roomModal.style.display = 'flex';
            dom.roomModal.classList.remove('hidden');
            dom.roomModal.hidden = false;
        }
    }

    function closeRoomModal() {
        if (!state.roomId) return;
        if (state.pendingRoomJoin && !state.pendingRoomJoin.inFlight) {
            state.pendingRoomJoin = null;
        }
        clearRoomError();
        if (dom.roomModal) {
            dom.roomModal.style.display = 'none';
            dom.roomModal.classList.add('hidden');
            dom.roomModal.hidden = true;
        }
    }

    function isRoomModalOpen() {
        return Boolean(dom.roomModal && !dom.roomModal.hidden && dom.roomModal.style.display !== 'none');
    }

    function joinRoom(targetRoomId, targetPass = '', targetUserName = '') {
        clearRoomError();
        const cleanId = sanitizeRoomId(targetRoomId) || generateRandomRoomId();
        if (cleanId.length < 3) {
            openRoomModal('join');
            showRoomError('O código da sala deve ter pelo menos 3 caracteres alfanuméricos.');
            return;
        }
        const newRoomId = cleanId;
        const pendingPassword = (targetPass || '').trim();
        if (targetUserName) {
            state.currentUserName = saveUserName(targetUserName, storage);
        }

        state.pendingRoomJoin = {
            roomId: newRoomId,
            password: pendingPassword,
            userName: state.currentUserName,
            inFlight: false
        };

        const socket = getSocket();
        if (socket && socket.connected) {
            state.pendingRoomJoin.inFlight = true;
            socket.emit('join-room', {
                roomId: state.pendingRoomJoin.roomId,
                clientId: state.clientId,
                password: state.pendingRoomJoin.password,
                userName: state.pendingRoomJoin.userName
            });
        } else {
            showToast('Conectando ao servidor... Você entrará na sala automaticamente.', 'info', 3500);
        }
    }

    function handleConfirmCreate() {
        clearRoomError();
        const rawName = dom.inputCreateUserName ? dom.inputCreateUserName.value.trim().slice(0, 24) : '';
        if (rawName) {
            state.currentUserName = saveUserName(rawName, storage);
        }
        const raw = dom.inputCreateRoomId ? dom.inputCreateRoomId.value : '';
        let newRoomId;
        if (!raw.trim()) {
            newRoomId = generateRandomRoomId();
        } else {
            newRoomId = sanitizeRoomId(raw);
            if (newRoomId.length < 3) {
                showRoomError('Nome de sala inválido. Use pelo menos 3 caracteres alfanuméricos.');
                if (dom.inputCreateRoomId) dom.inputCreateRoomId.focus();
                return;
            }
        }
        if (dom.inputCreateRoomId) dom.inputCreateRoomId.value = newRoomId;
        const pass = dom.inputCreateRoomPassword ? dom.inputCreateRoomPassword.value.trim() : '';
        joinRoom(newRoomId, pass, state.currentUserName);
    }

    function handleConfirmJoin() {
        clearRoomError();
        const rawName = dom.inputJoinUserName ? dom.inputJoinUserName.value.trim().slice(0, 24) : '';
        if (rawName) {
            state.currentUserName = saveUserName(rawName, storage);
        }
        const rawRoom = dom.inputJoinRoomId ? dom.inputJoinRoomId.value : '';
        const newRoomId = sanitizeRoomId(rawRoom);
        if (!newRoomId || newRoomId.length < 3) {
            showRoomError('Por favor, informe um código de sala válido (mínimo de 3 caracteres alfanuméricos).');
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.focus();
            return;
        }
        const pass = dom.inputJoinRoomPassword ? dom.inputJoinRoomPassword.value.trim() : '';
        joinRoom(newRoomId, pass, state.currentUserName);
    }

    function handleJoinError({ error, message }) {
        console.warn('[Auth] Join error:', error, message);
        const failedRoomId = (state.pendingRoomJoin && state.pendingRoomJoin.roomId) || state.roomId || '';
        state.pendingRoomJoin = null;

        const membership = getMembership();
        if (membership && !membership.isRoomMembershipConfirmed && state.roomId) {
            onCleanupRoomState({ silent: true });
            state.roomId = '';
            state.currentRoomPassword = '';
            updateRoomModalCloseButton();
        }

        openRoomModal('join');
        if (error === 'invalid_password') {
            clearSessionRoomPassword();
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = failedRoomId;
            showRoomError(message || 'Senha incorreta para esta sala.');
            if (dom.inputJoinRoomPassword) {
                dom.inputJoinRoomPassword.focus();
                dom.inputJoinRoomPassword.select();
            }
        } else if (error === 'invalid_room' || error === 'invalid_password_format') {
            clearSessionRoomPassword();
            if (!state.roomId || failedRoomId === state.roomId) {
                state.roomId = '';
                state.currentRoomPassword = '';
                if (storage) {
                    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
                }
                if (windowObj && windowObj.history && windowObj.history.replaceState) {
                    try { windowObj.history.replaceState({}, '', windowObj.location.pathname); } catch (_) {}
                }
                updateRoomModalCloseButton();
            }
            showRoomError(message || 'Código de sala ou formato inválido.');
        } else if (error === 'rate_limited') {
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = failedRoomId;
            showRoomError(message || 'Muitas tentativas incorretas. Aguarde antes de tentar novamente.');
        } else {
            showRoomError(message || 'Erro ao entrar na sala.');
        }
    }

    function setupPasswordToggle(btn, input) {
        if (!btn || !input) return;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            btn.innerHTML = isPassword
                ? '<i class="fa-solid fa-eye-slash"></i>'
                : '<i class="fa-solid fa-eye"></i>';
        });
    }

    function applyInitialUrlAndRestore() {
        onThemeInit();
        onLoadPreferences();

        const loc = windowObj && windowObj.location ? windowObj.location : { search: '', hash: '', pathname: '/' };
        const urlParams = new URLSearchParams(loc.search || '');
        const roomParam = urlParams.get('room');
        const rawHash = (loc.hash || '').replace(/^#/, '');
        const hashParams = new URLSearchParams(rawHash);
        const hashPass = hashParams.get('pass');
        const queryPass = urlParams.get('pass');
        const passParam = hashPass !== null ? hashPass : queryPass;

        if ((hashPass !== null || queryPass !== null) && windowObj && windowObj.history && windowObj.history.replaceState) {
            try {
                urlParams.delete('pass');
                hashParams.delete('pass');
                const remainingQuery = urlParams.toString();
                const remainingHash = hashParams.toString();
                const cleanUrl = `${loc.pathname}${remainingQuery ? '?' + remainingQuery : ''}${remainingHash ? '#' + remainingHash : ''}`;
                windowObj.history.replaceState(windowObj.history.state || {}, '', cleanUrl);
            } catch (_) {}
        }

        if (passParam) {
            if (dom.inputCreateRoomPassword) dom.inputCreateRoomPassword.value = passParam;
            if (dom.inputJoinRoomPassword) dom.inputJoinRoomPassword.value = passParam;
        }

        let savedRoom = null;
        if (storage) {
            try { savedRoom = storage.getItem(STORAGE_KEY); } catch (_) {}
        }

        if (roomParam) {
            const clean = sanitizeRoomId(roomParam);
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = clean;
            if (clean.length >= 3) {
                const restoredPass = passParam || getSessionRoomPassword(clean);
                joinRoom(clean, restoredPass);
            } else {
                openRoomModal('join');
                showRoomError('Código de sala na URL inválido.');
            }
        } else if (savedRoom) {
            const clean = sanitizeRoomId(savedRoom);
            if (dom.inputJoinRoomId) dom.inputJoinRoomId.value = clean;
            if (clean.length >= 3) {
                const restoredPass = getSessionRoomPassword(clean);
                joinRoom(clean, restoredPass);
            } else {
                if (storage) {
                    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
                }
                openRoomModal('choice');
            }
        } else {
            openRoomModal('choice');
        }
    }

    function bindEvents() {
        setupPasswordToggle(dom.btnToggleCreatePass, dom.inputCreateRoomPassword);
        setupPasswordToggle(dom.btnToggleJoinPass, dom.inputJoinRoomPassword);

        if (dom.btnChooseCreate) dom.btnChooseCreate.addEventListener('click', () => switchRoomView('create'));
        if (dom.btnChooseJoin) dom.btnChooseJoin.addEventListener('click', () => switchRoomView('join'));

        if (dom.inputCreateUserName) {
            if (state.currentUserName) dom.inputCreateUserName.value = state.currentUserName;
            dom.inputCreateUserName.addEventListener('input', (e) => {
                state.currentUserName = saveUserName(e.target.value, storage);
                if (dom.inputJoinUserName) dom.inputJoinUserName.value = e.target.value;
            });
        }
        if (dom.btnRandomRoom) dom.btnRandomRoom.addEventListener('click', rollRandomCreateRoom);
        if (dom.btnGenerateRandomQuick) dom.btnGenerateRandomQuick.addEventListener('click', rollRandomCreateRoom);

        if (dom.inputCreateRoomId) {
            dom.inputCreateRoomId.addEventListener('input', () => {
                clearRoomError();
                clearTimeout(checkCreateTimeout);
                checkCreateTimeout = setTimeout(() => {
                    checkCreateRoomStatus(dom.inputCreateRoomId.value);
                }, 250);
            });
            dom.inputCreateRoomId.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmCreate();
            });
        }
        if (dom.inputCreateRoomPassword) {
            dom.inputCreateRoomPassword.addEventListener('input', clearRoomError);
            dom.inputCreateRoomPassword.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmCreate();
            });
        }
        if (dom.btnConfirmCreate) dom.btnConfirmCreate.addEventListener('click', handleConfirmCreate);
        if (dom.btnBackFromCreate) dom.btnBackFromCreate.addEventListener('click', () => switchRoomView('choice'));

        if (dom.inputJoinUserName) {
            if (state.currentUserName) dom.inputJoinUserName.value = state.currentUserName;
            dom.inputJoinUserName.addEventListener('input', (e) => {
                state.currentUserName = saveUserName(e.target.value, storage);
                if (dom.inputCreateUserName) dom.inputCreateUserName.value = e.target.value;
            });
        }
        if (dom.inputJoinRoomId) {
            dom.inputJoinRoomId.addEventListener('input', () => {
                clearRoomError();
                clearTimeout(checkJoinTimeout);
                checkJoinTimeout = setTimeout(() => {
                    checkJoinRoomStatus(dom.inputJoinRoomId.value);
                }, 250);
            });
            dom.inputJoinRoomId.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmJoin();
            });
        }
        if (dom.inputJoinRoomPassword) {
            dom.inputJoinRoomPassword.addEventListener('input', clearRoomError);
            dom.inputJoinRoomPassword.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleConfirmJoin();
            });
        }
        if (dom.btnConfirmJoin) dom.btnConfirmJoin.addEventListener('click', handleConfirmJoin);
        if (dom.btnBackFromJoin) dom.btnBackFromJoin.addEventListener('click', () => switchRoomView('choice'));

        if (dom.btnCloseRoomModal) dom.btnCloseRoomModal.addEventListener('click', closeRoomModal);
        if (dom.btnCancelRoomModal) dom.btnCancelRoomModal.addEventListener('click', closeRoomModal);
        if (dom.roomModal) {
            dom.roomModal.addEventListener('click', (e) => {
                if (e.target === dom.roomModal && state.roomId) {
                    closeRoomModal();
                }
            });
        }
        if (dom.btnChangeRoom) dom.btnChangeRoom.addEventListener('click', () => openRoomModal('choice'));
    }

    return {
        showRoomError,
        clearRoomError,
        updateRoomModalCloseButton,
        checkCreateRoomStatus,
        checkJoinRoomStatus,
        rollRandomCreateRoom,
        switchRoomView,
        openRoomModal,
        closeRoomModal,
        isRoomModalOpen,
        joinRoom,
        handleConfirmCreate,
        handleConfirmJoin,
        handleJoinError,
        applyInitialUrlAndRestore,
        bindEvents
    };
}

class MockMediaStream {
    constructor(tracks = []) {
        this._tracks = [...tracks];
        this.active = true;
    }

    getTracks() {
        return [...this._tracks];
    }

    getVideoTracks() {
        return this._tracks.filter((t) => t.kind === 'video');
    }

    getAudioTracks() {
        return this._tracks.filter((t) => t.kind === 'audio');
    }

    addTrack(track) {
        if (track && !this._tracks.some((t) => t.id === track.id)) {
            this._tracks.push(track);
        }
    }

    removeTrack(track) {
        this._tracks = this._tracks.filter((t) => t !== track && t.id !== (track && track.id));
    }
}

function createMockTrack(kind = 'video', id = `track-${Math.random().toString(36).slice(2, 8)}`, extra = {}) {
    const track = {
        id,
        kind,
        readyState: 'live',
        enabled: true,
        muted: false,
        contentHint: '',
        stopped: false,
        onended: null,
        onunmute: null,
        getSettings: extra.getSettings || (() => (kind === 'video' ? { width: 1920, height: 1080, frameRate: 60 } : {})),
        stop() {
            this.stopped = true;
            this.readyState = 'ended';
        },
        clone() {
            return createMockTrack(this.kind, `${this.id}-clone-${Math.random().toString(36).slice(2, 6)}`, {
                contentHint: this.contentHint,
                getSettings: this.getSettings
            });
        },
        ...extra
    };
    return track;
}

function createMockSender(track = null, options = {}) {
    const params = options.params || {
        encodings: [{}],
        degradationPreference: ''
    };
    return {
        track,
        _kind: options._kind !== undefined ? options._kind : (track ? track.kind : undefined),
        dtlsTransport: options.dtlsTransport !== undefined ? options.dtlsTransport : {},
        replaceHistory: [],
        appliedParams: [],
        getParameters() {
            return params;
        },
        setParameters(nextParams) {
            Object.assign(params, nextParams);
            this.appliedParams.push(JSON.parse(JSON.stringify(params)));
            return Promise.resolve();
        },
        replaceTrack(nextTrack) {
            this.track = nextTrack;
            this.replaceHistory.push(nextTrack);
            return Promise.resolve();
        }
    };
}

class MockRTCSessionDescription {
    constructor(init = {}) {
        this.type = init.type;
        this.sdp = init.sdp;
    }
}

class MockRTCIceCandidate {
    constructor(init = {}) {
        Object.assign(this, init);
    }
}

function createMockPeerConnection(options = {}) {
    const senders = [...(options.senders || [])];
    const receivers = [...(options.receivers || [])];
    const transceivers = [...(options.transceivers || [])];

    const pc = {
        signalingState: options.signalingState || 'stable',
        iceConnectionState: options.iceConnectionState || 'new',
        connectionState: options.connectionState || 'new',
        localDescription: null,
        remoteDescription: null,
        addedCandidates: [],
        appliedConfigurations: [],
        iceRestarts: 0,
        closed: false,
        onicecandidate: null,
        ontrack: null,
        oniceconnectionstatechange: null,
        onconnectionstatechange: null,
        getSenders: () => senders,
        getReceivers: () => receivers,
        getTransceivers: () => transceivers,
        addTrack(track) {
            const sender = createMockSender(track);
            senders.push(sender);
            transceivers.push({
                sender,
                receiver: { track: { kind: track.kind } },
                direction: 'sendrecv'
            });
            return sender;
        },
        addTransceiver(kindOrTrack, init = {}) {
            const kind = typeof kindOrTrack === 'string' ? kindOrTrack : kindOrTrack.kind;
            const sender = createMockSender(typeof kindOrTrack === 'string' ? null : kindOrTrack, { _kind: kind });
            const transceiver = {
                sender,
                receiver: { track: { kind } },
                direction: init.direction || 'sendrecv'
            };
            senders.push(sender);
            transceivers.push(transceiver);
            return transceiver;
        },
        async createOffer() {
            return options.offer || { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
        },
        async createAnswer() {
            return options.answer || { type: 'answer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
        },
        async setLocalDescription(desc) {
            this.localDescription = desc;
        },
        async setRemoteDescription(desc) {
            if (options.setRemoteDescriptionImpl) {
                return options.setRemoteDescriptionImpl(desc, this);
            }
            this.remoteDescription = desc;
        },
        async addIceCandidate(cand) {
            this.addedCandidates.push(cand);
        },
        restartIce() {
            this.iceRestarts += 1;
        },
        setConfiguration(cfg) {
            this.appliedConfigurations.push(cfg);
        },
        async getStats() {
            if (options.getStatsImpl) return options.getStatsImpl();
            return new Map();
        },
        close() {
            this.closed = true;
            this.signalingState = 'closed';
            this.connectionState = 'closed';
            this.iceConnectionState = 'closed';
        }
    };
    return pc;
}

module.exports = {
    MockMediaStream,
    MockRTCSessionDescription,
    MockRTCIceCandidate,
    createMockTrack,
    createMockSender,
    createMockPeerConnection
};

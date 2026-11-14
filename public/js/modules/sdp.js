export function prioritizeH264(sdp) {
    return prioritizePreferredVideoCodecs(sdp, ['h264']);
}

export function prioritizePreferredVideoCodecs(sdp, priorityList = ['vp8', 'vp9', 'h264']) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    const lines = sdp.split('\r\n');
    const mVideoIndex = lines.findIndex(l => l.startsWith('m=video'));
    if (mVideoIndex === -1) return sdp;

    const payloadProfiles = new Map();
    const codecByPayload = new Map();
    for (const line of lines) {
        if (line.startsWith('a=fmtp:')) {
            const match = line.match(/^a=fmtp:(\d+)\s+.*profile-level-id=([0-9a-fA-F]+)/i);
            if (match) {
                payloadProfiles.set(match[1], match[2].toLowerCase());
            }
        } else if (line.startsWith('a=rtpmap:')) {
            const match = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)\/90000/i);
            if (match) {
                codecByPayload.set(match[1], match[2].toLowerCase());
            }
        }
    }

    const mVideoParts = lines[mVideoIndex].split(' ');
    const header = mVideoParts.slice(0, 3);
    const currentPayloads = mVideoParts.slice(3);

    const ordered = [];
    const seen = new Set();

    for (const codecName of priorityList) {
        const matched = currentPayloads.filter(pt => codecByPayload.get(pt) === codecName);
        if (codecName === 'h264' && matched.length > 1) {
            matched.sort((a, b) => {
                const isBaselineA = (payloadProfiles.get(a) || '').includes('42e0');
                const isBaselineB = (payloadProfiles.get(b) || '').includes('42e0');
                if (isBaselineA && !isBaselineB) return -1;
                if (!isBaselineA && isBaselineB) return 1;
                return 0;
            });
        }
        for (const pt of matched) {
            if (!seen.has(pt)) {
                ordered.push(pt);
                seen.add(pt);
            }
        }
    }

    for (const pt of currentPayloads) {
        if (!seen.has(pt)) {
            ordered.push(pt);
            seen.add(pt);
        }
    }

    if (ordered.length === 0) return sdp;
    lines[mVideoIndex] = [...header, ...ordered].join(' ');
    return lines.join('\r\n');
}

export function optimizeSDP(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    sdp = prioritizePreferredVideoCodecs(sdp);
    const lines = sdp.split('\r\n');

    // 1. Mapear payloads para Opus e Codecs de Vídeo via linhas a=rtpmap
    const opusPayloads = new Set();
    const videoPayloads = new Set();
    const existingFmtpPayloads = new Set();

    for (const line of lines) {
        if (line.startsWith('a=rtpmap:')) {
            const match = line.match(/^a=rtpmap:(\d+)\s+([^/]+)/i);
            if (match) {
                const pt = match[1];
                const codec = match[2].toLowerCase();
                if (codec === 'opus') {
                    opusPayloads.add(pt);
                } else if (codec === 'h264' || codec === 'vp8' || codec === 'vp9') {
                    videoPayloads.add(pt);
                }
            }
        } else if (line.startsWith('a=fmtp:')) {
            const match = line.match(/^a=fmtp:(\d+)/i);
            if (match) {
                existingFmtpPayloads.add(match[1]);
            }
        }
    }

    const opusParams = [
        'stereo=1',
        'sprop-stereo=1',
        'maxaveragebitrate=128000',
        'useinbandfec=1',
        'usedtx=0'
    ];
    const newLines = [];
    let inVideoSection = false;
    let pendingVideoBandwidth = false;

    const pushVideoBandwidth = () => {
        if (!pendingVideoBandwidth) return;
        newLines.push('b=AS:6000');
        newLines.push('b=TIAS:6000000');
        pendingVideoBandwidth = false;
    };

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        if (line.startsWith('m=video')) {
            pushVideoBandwidth();
            inVideoSection = true;
            pendingVideoBandwidth = true;
            newLines.push(line);
            continue;
        } else if (line.startsWith('m=')) {
            pushVideoBandwidth();
            inVideoSection = false;
        }

        // Evitar linhas duplicadas de banda na seção de vídeo
        if (inVideoSection && (line.startsWith('b=AS:') || line.startsWith('b=TIAS:'))) {
            continue;
        }

        // RFC 4566/8866: dentro da seção m=video, c= deve preceder b=
        if (inVideoSection && pendingVideoBandwidth) {
            if (line.startsWith('c=')) {
                newLines.push(line);
                pushVideoBandwidth();
                continue;
            }
            if (!line.startsWith('i=')) {
                pushVideoBandwidth();
            }
        }

        // Atualizar linhas a=fmtp existentes
        if (line.startsWith('a=fmtp:')) {
            const match = line.match(/^a=fmtp:(\d+)/i);
            if (match) {
                const pt = match[1];
                if (opusPayloads.has(pt)) {
                    for (const param of opusParams) {
                        const key = param.split('=')[0];
                        const keyPattern = new RegExp(`(?:^|[\\s;])${key}=`);
                        if (!keyPattern.test(line)) {
                            const sep = /\s$/.test(line) || line.indexOf(' ') === -1 ? ' ' : ';';
                            line += `${sep}${param}`;
                        }
                    }
                } else if (videoPayloads.has(pt)) {
                    if (!line.includes('x-google-max-bitrate')) {
                        line += ';x-google-min-bitrate=400;x-google-start-bitrate=1500;x-google-max-bitrate=6000';
                    }
                }
            }
            newLines.push(line);
            continue;
        }

        newLines.push(line);

        // Se o rtpmap não tinha a=fmtp associado originalmente, injetar logo após a=rtpmap
        if (line.startsWith('a=rtpmap:')) {
            const match = line.match(/^a=rtpmap:(\d+)/i);
            if (match) {
                const pt = match[1];
                if (!existingFmtpPayloads.has(pt)) {
                    if (opusPayloads.has(pt)) {
                        newLines.push(`a=fmtp:${pt} ${opusParams.join(';')}`);
                        existingFmtpPayloads.add(pt);
                    } else if (videoPayloads.has(pt)) {
                        newLines.push(`a=fmtp:${pt} x-google-min-bitrate=400;x-google-start-bitrate=1500;x-google-max-bitrate=6000`);
                        existingFmtpPayloads.add(pt);
                    }
                }
            }
        }
    }

    pushVideoBandwidth();

    return newLines.join('\r\n');
}

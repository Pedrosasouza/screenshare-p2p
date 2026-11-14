/**
 * AudioWorkletProcessor with low-latency Ring Buffer for streaming raw PCM from WASAPI Loopback
 */
class PCMRingBufferProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // 48000Hz * 2 channels * 0.2s = 19200 samples capacity
        this.capacity = 19200;
        this.bufferL = new Float32Array(this.capacity);
        this.bufferR = new Float32Array(this.capacity);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.availableFrames = 0;

        // Target jitter buffer: ~30ms = 1440 frames @ 48kHz
        this.targetBufferFrames = 1440;
        this.maxBufferFrames = 4800; // 100ms max before skipping to preserve realtime sync
        this.hasStartedPlayback = false;
        this.needsResumeFadeIn = false;
        this.fadeInIndex = 0;
        this.fadeInFrames = 128;
        this.stopped = false;

        this.port.onmessage = (event) => {
            const data = event.data;
            if (data instanceof Float32Array) {
                this.pushInterleaved(data);
            } else if (data && data.type === 'flush') {
                this.flush();
            } else if (data && data.type === 'stop') {
                this.stopped = true;
                this.flush();
            }
        };
    }

    pushInterleaved(interleavedFloat32) {
        if (!interleavedFloat32 || interleavedFloat32.length < 2) return;
        const totalFrames = Math.floor(interleavedFloat32.length / 2);
        if (totalFrames <= 0) return;

        let startFrame = 0;

        // If buffer is falling behind too much (> 100ms), drop older frames to maintain real-time low latency
        if (this.availableFrames + totalFrames > this.maxBufferFrames) {
            const desiredDrop = (this.availableFrames + totalFrames) - this.targetBufferFrames;
            const dropExisting = Math.min(this.availableFrames, Math.max(0, desiredDrop));
            this.readIndex = (this.readIndex + dropExisting) % this.capacity;
            this.availableFrames -= dropExisting;

            const remainingDrop = desiredDrop - dropExisting;
            if (remainingDrop > 0) {
                startFrame = Math.min(totalFrames, remainingDrop);
            }
        }

        let framesToWrite = totalFrames - startFrame;
        if (this.availableFrames + framesToWrite > this.capacity) {
            const excess = (this.availableFrames + framesToWrite) - this.capacity;
            startFrame = Math.min(totalFrames, startFrame + excess);
            framesToWrite = totalFrames - startFrame;
        }

        for (let i = startFrame; i < totalFrames; i++) {
            const rawL = interleavedFloat32[i * 2];
            const rawR = interleavedFloat32[i * 2 + 1];
            const l = Math.abs(rawL) < Infinity ? rawL : 0;
            const r = Math.abs(rawR) < Infinity ? rawR : 0;

            this.bufferL[this.writeIndex] = l;
            this.bufferR[this.writeIndex] = r;

            this.writeIndex = (this.writeIndex + 1) % this.capacity;
        }

        this.availableFrames += framesToWrite;
    }

    flush() {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.availableFrames = 0;
        this.hasStartedPlayback = false;
        this.needsResumeFadeIn = false;
        this.fadeInIndex = 0;
    }

    process(inputs, outputs, parameters) {
        if (this.stopped) return false;
        if (!outputs || outputs.length === 0) return true;
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const outL = output[0];
        if (!outL || outL.length === 0) return true;
        const outR = output[1] || output[0];
        const quantum = outL.length; // Standard Web Audio quantum is 128 samples

        // Pre-buffering: wait until targetBufferFrames is reached before starting playback
        if (!this.hasStartedPlayback) {
            if (this.availableFrames >= this.targetBufferFrames) {
                this.hasStartedPlayback = true;
            } else {
                outL.fill(0);
                if (outR !== outL) outR.fill(0);
                return true;
            }
        }

        if (this.availableFrames >= quantum) {
            for (let i = 0; i < quantum; i++) {
                let gain = 1;
                if (this.needsResumeFadeIn) {
                    gain = (this.fadeInIndex + 1) / this.fadeInFrames;
                    this.fadeInIndex += 1;
                    if (this.fadeInIndex >= this.fadeInFrames) {
                        this.needsResumeFadeIn = false;
                    }
                }
                const sampleL = this.bufferL[this.readIndex] * gain;
                const sampleR = this.bufferR[this.readIndex] * gain;
                if (outR === outL) {
                    outL[i] = (sampleL + sampleR) * 0.5;
                } else {
                    outL[i] = sampleL;
                    outR[i] = sampleR;
                }
                this.readIndex = (this.readIndex + 1) % this.capacity;
            }
            this.availableFrames -= quantum;
        } else {
            if (this.availableFrames > 0) {
                // Partial underrun: drain remaining frames with smooth linear fade-out to zero
                const remaining = this.availableFrames;
                const fadeDenom = remaining === 1 ? 2 : remaining;
                for (let i = 0; i < remaining; i++) {
                    const gain = 1 - ((i + 1) / fadeDenom);
                    const sampleL = this.bufferL[this.readIndex] * gain;
                    const sampleR = this.bufferR[this.readIndex] * gain;
                    if (outR === outL) {
                        outL[i] = (sampleL + sampleR) * 0.5;
                    } else {
                        outL[i] = sampleL;
                        outR[i] = sampleR;
                    }
                    this.readIndex = (this.readIndex + 1) % this.capacity;
                }
                for (let i = remaining; i < quantum; i++) {
                    outL[i] = 0;
                    if (outR !== outL) outR[i] = 0;
                }
                this.availableFrames = 0;
            } else {
                // Buffer underrun: fill with silence until more data arrives
                outL.fill(0);
                if (outR !== outL) outR.fill(0);
            }
            this.hasStartedPlayback = false; // re-enter pre-buffering
            this.needsResumeFadeIn = true;
            this.fadeInIndex = 0;
        }

        return true;
    }
}

registerProcessor('pcm-ring-buffer-processor', PCMRingBufferProcessor);

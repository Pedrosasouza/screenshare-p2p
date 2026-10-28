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

        this.port.onmessage = (event) => {
            const data = event.data;
            if (data instanceof Float32Array) {
                this.pushInterleaved(data);
            } else if (data && data.type === 'flush') {
                this.flush();
            }
        };
    }

    pushInterleaved(interleavedFloat32) {
        const frameCount = interleavedFloat32.length / 2;

        // If buffer is falling behind too much (> 100ms), drop older frames to maintain real-time low latency
        if (this.availableFrames + frameCount > this.maxBufferFrames) {
            const overflow = (this.availableFrames + frameCount) - this.targetBufferFrames;
            this.readIndex = (this.readIndex + overflow) % this.capacity;
            this.availableFrames -= overflow;
        }

        for (let i = 0; i < frameCount; i++) {
            const l = interleavedFloat32[i * 2];
            const r = interleavedFloat32[i * 2 + 1];

            this.bufferL[this.writeIndex] = l;
            this.bufferR[this.writeIndex] = r;

            this.writeIndex = (this.writeIndex + 1) % this.capacity;
        }

        this.availableFrames += frameCount;
    }

    flush() {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.availableFrames = 0;
        this.hasStartedPlayback = false;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const outL = output[0];
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
                outL[i] = this.bufferL[this.readIndex];
                outR[i] = this.bufferR[this.readIndex];
                this.readIndex = (this.readIndex + 1) % this.capacity;
            }
            this.availableFrames -= quantum;
        } else {
            // Buffer underrun: fill with silence until more data arrives
            outL.fill(0);
            if (outR !== outL) outR.fill(0);
            this.hasStartedPlayback = false; // re-enter pre-buffering
        }

        return true;
    }
}

registerProcessor('pcm-ring-buffer-processor', PCMRingBufferProcessor);

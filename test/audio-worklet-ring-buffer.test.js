const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function loadProcessorClass() {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../public/js/audio-worklet-processor.js'),
        'utf8'
    );
    const registered = {};
    class MockAudioWorkletProcessor {
        constructor() {
            this.port = {
                onmessage: null,
                postMessage() {}
            };
        }
    }
    const registerProcessor = (name, cls) => {
        registered[name] = cls;
    };
    const factory = new Function('AudioWorkletProcessor', 'registerProcessor', src);
    factory(MockAudioWorkletProcessor, registerProcessor);

    const ProcessorClass = registered['pcm-ring-buffer-processor'];
    assert.ok(ProcessorClass, 'PCMRingBufferProcessor deve ser registrado via registerProcessor');
    return ProcessorClass;
}

let desktopAudioImportSeq = 0;
async function loadForwardPcmWithNode(mockWorkletNode) {
    const prevWindow = global.window;
    const prevWorkletNode = global.AudioWorkletNode;

    class StubAudioContext {
        constructor() {
            this.state = 'running';
            this.audioWorklet = { addModule: async () => {} };
        }
        createMediaStreamDestination() {
            return { stream: { getAudioTracks: () => [] } };
        }
    }
    class StubAudioWorkletNode {
        constructor() {
            return mockWorkletNode;
        }
    }

    global.window = { AudioContext: StubAudioContext };
    global.AudioWorkletNode = StubAudioWorkletNode;
    try {
        const modUrl = `${pathToFileURL(path.resolve(__dirname, '../public/js/modules/desktop-audio.js')).href}?ringbuf=${++desktopAudioImportSeq}`;
        const mod = await import(modUrl);
        await mod.prepareHelperAudioWorklet();
        return mod.forwardPcmBufferToWorklet;
    } finally {
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
        if (prevWorkletNode === undefined) delete global.AudioWorkletNode;
        else global.AudioWorkletNode = prevWorkletNode;
    }
}

function makeInterleavedFrames(frameCount, startValue = 1) {
    const arr = new Float32Array(frameCount * 2);
    for (let i = 0; i < frameCount; i++) {
        const v = startValue + i;
        arr[i * 2] = v;
        arr[i * 2 + 1] = -v;
    }
    return arr;
}

function makeOutputQuantum(size = 128) {
    return [[new Float32Array(size), new Float32Array(size)]];
}

describe('AudioWorklet Ring Buffer & PCM Bridge', () => {
    const ProcessorClass = loadProcessorClass();

    it('T1: pre-buffering, saída L/R correta e retorno para silêncio no underrun', () => {
        const proc = new ProcessorClass();
        proc.pushInterleaved(makeInterleavedFrames(512, 1));
        assert.strictEqual(proc.availableFrames, 512);

        const outPre = makeOutputQuantum(128);
        outPre[0][0].fill(99);
        outPre[0][1].fill(99);
        proc.process([], outPre, {});
        assert.strictEqual(proc.hasStartedPlayback, false);
        assert.ok(outPre[0][0].every((v) => v === 0));
        assert.ok(outPre[0][1].every((v) => v === 0));

        proc.pushInterleaved(makeInterleavedFrames(1024, 513));
        assert.strictEqual(proc.availableFrames, 1536);

        for (let q = 0; q < 12; q++) {
            const out = makeOutputQuantum(128);
            proc.process([], out, {});
            assert.strictEqual(proc.hasStartedPlayback, true);
            for (let i = 0; i < 128; i++) {
                const expected = q * 128 + i + 1;
                assert.strictEqual(out[0][0][i], expected);
                assert.strictEqual(out[0][1][i], -expected);
            }
        }
        assert.strictEqual(proc.availableFrames, 0);

        const outUnderrun = makeOutputQuantum(128);
        outUnderrun[0][0].fill(42);
        outUnderrun[0][1].fill(-42);
        proc.process([], outUnderrun, {});
        assert.strictEqual(proc.hasStartedPlayback, false);
        assert.ok(outUnderrun[0][0].every((v) => v === 0));
        assert.ok(outUnderrun[0][1].every((v) => v === 0));
    });

    it('T2: overflow normal e chunk gigante (> maxBufferFrames e > capacity) sem corrupção', () => {
        const procNormal = new ProcessorClass();
        procNormal.pushInterleaved(makeInterleavedFrames(3000, 1));
        procNormal.pushInterleaved(makeInterleavedFrames(2000, 3001));
        assert.strictEqual(procNormal.availableFrames, procNormal.targetBufferFrames);
        assert.ok(procNormal.availableFrames >= 0 && procNormal.availableFrames <= procNormal.capacity);

        const outNormal = makeOutputQuantum(128);
        procNormal.process([], outNormal, {});
        assert.strictEqual(outNormal[0][0][0], 3561);
        assert.strictEqual(outNormal[0][1][0], -3561);

        const procGiant = new ProcessorClass();
        procGiant.pushInterleaved(makeInterleavedFrames(1000, 1));
        procGiant.pushInterleaved(makeInterleavedFrames(25000, 10001));
        assert.ok(procGiant.availableFrames >= 0);
        assert.ok(procGiant.availableFrames <= procGiant.capacity);
        assert.strictEqual(procGiant.availableFrames, procGiant.targetBufferFrames);

        const expectedFirst = 10001 + (25000 - procGiant.targetBufferFrames);
        const outGiant = makeOutputQuantum(128);
        procGiant.process([], outGiant, {});
        assert.strictEqual(outGiant[0][0][0], expectedFirst);
        assert.strictEqual(outGiant[0][1][0], -expectedFirst);

        const procCap = new ProcessorClass();
        procCap.maxBufferFrames = 100000;
        procCap.pushInterleaved(makeInterleavedFrames(22000, 1));
        assert.strictEqual(procCap.availableFrames, procCap.capacity);
        const outCap = makeOutputQuantum(128);
        procCap.process([], outCap, {});
        assert.strictEqual(outCap[0][0][0], 2801);
    });

    it('T3: entrada com tamanho ímpar e flush()', () => {
        const proc = new ProcessorClass();
        proc.pushInterleaved(new Float32Array([0.5]));
        assert.strictEqual(proc.availableFrames, 0);

        proc.pushInterleaved(new Float32Array([0.1, -0.1, 0.2, -0.2, 0.999]));
        assert.strictEqual(proc.availableFrames, 2);
        assert.strictEqual(Number.isInteger(proc.availableFrames), true);
        assert.strictEqual(proc.writeIndex, 2);

        proc.pushInterleaved(makeInterleavedFrames(1438, 10));
        assert.strictEqual(proc.availableFrames, 1440);
        const out = makeOutputQuantum(128);
        proc.process([], out, {});
        assert.strictEqual(proc.hasStartedPlayback, true);
        assert.ok(Math.abs(out[0][0][0] - 0.1) < 1e-6);
        assert.ok(Math.abs(out[0][1][0] - (-0.1)) < 1e-6);
        assert.ok(Math.abs(out[0][0][1] - 0.2) < 1e-6);
        assert.ok(Math.abs(out[0][1][1] - (-0.2)) < 1e-6);
        assert.strictEqual(out[0][0][2], 10);

        proc.flush();
        assert.strictEqual(proc.readIndex, 0);
        assert.strictEqual(proc.writeIndex, 0);
        assert.strictEqual(proc.availableFrames, 0);
        assert.strictEqual(proc.hasStartedPlayback, false);
    });

    it('T4: forwardPcmBufferToWorklet alinha bytes a múltiplos de 8 sem lançar RangeError', async () => {
        const posted = [];
        const mockNode = {
            connect() {},
            disconnect() {},
            port: {
                postMessage(data, transfer) {
                    posted.push({ data, transfer });
                }
            }
        };
        const forwardPcmBufferToWorklet = await loadForwardPcmWithNode(mockNode);

        const buf3 = new ArrayBuffer(3);
        forwardPcmBufferToWorklet(buf3);
        assert.strictEqual(posted.length, 0);

        const buf10 = new ArrayBuffer(10);
        const view10 = new DataView(buf10);
        view10.setFloat32(0, 0.25, true);
        view10.setFloat32(4, -0.25, true);
        forwardPcmBufferToWorklet(buf10);
        assert.strictEqual(posted.length, 1);
        assert.ok(posted[0].data instanceof Float32Array);
        assert.strictEqual(posted[0].data.byteLength, 8);
        assert.strictEqual(posted[0].data.length, 2);
        assert.strictEqual(posted[0].data[0], 0.25);
        assert.strictEqual(posted[0].data[1], -0.25);
        assert.strictEqual(posted[0].transfer[0], posted[0].data.buffer);
        assert.notStrictEqual(posted[0].data.buffer, buf10);

        const buf16 = new Float32Array([1, -1, 2, -2]).buffer;
        forwardPcmBufferToWorklet(buf16);
        assert.strictEqual(posted.length, 2);
        assert.strictEqual(posted[1].data.byteLength, 16);
        assert.strictEqual(posted[1].data.buffer, buf16);
    });

    it('T5: pushInterleaved sanitiza NaN/Infinity para 0 preservando amostras finitas', () => {
        const proc = new ProcessorClass();
        proc.pushInterleaved(new Float32Array([
            NaN, 0.5,
            Infinity, -Infinity,
            -0.25, 0.75
        ]));
        proc.pushInterleaved(makeInterleavedFrames(1437, 10));
        assert.strictEqual(proc.availableFrames, 1440);

        const out = makeOutputQuantum(128);
        proc.process([], out, {});
        assert.strictEqual(proc.hasStartedPlayback, true);

        assert.strictEqual(out[0][0][0], 0);
        assert.strictEqual(out[0][1][0], 0.5);
        assert.strictEqual(out[0][0][1], 0);
        assert.strictEqual(out[0][1][1], 0);
        assert.strictEqual(out[0][0][2], -0.25);
        assert.strictEqual(out[0][1][2], 0.75);
        assert.strictEqual(out[0][0][3], 10);
        assert.strictEqual(out[0][1][3], -10);
    });

    it('T6: underrun parcial aplica fade-out monotônico até 0 e drena buffer restante', () => {
        const proc = new ProcessorClass();
        assert.strictEqual(proc.process([], [], {}), true);
        assert.strictEqual(proc.process([], [[]], {}), true);

        const total = 1552;
        const interleaved = new Float32Array(total * 2);
        for (let i = 0; i < total; i++) {
            interleaved[i * 2] = 0.8;
            interleaved[i * 2 + 1] = -0.8;
        }
        proc.pushInterleaved(interleaved);

        for (let q = 0; q < 12; q++) {
            proc.process([], makeOutputQuantum(128), {});
        }
        assert.strictEqual(proc.availableFrames, 16);
        assert.strictEqual(proc.hasStartedPlayback, true);

        const outTail = makeOutputQuantum(128);
        outTail[0][0].fill(99);
        outTail[0][1].fill(-99);
        proc.process([], outTail, {});

        assert.strictEqual(proc.availableFrames, 0);
        assert.strictEqual(proc.hasStartedPlayback, false);

        for (let i = 0; i < 16; i++) {
            assert.ok(outTail[0][0][i] >= 0 && outTail[0][0][i] < 0.8);
            assert.ok(outTail[0][1][i] <= 0 && outTail[0][1][i] > -0.8);
            if (i > 0) {
                assert.ok(outTail[0][0][i] < outTail[0][0][i - 1]);
                assert.ok(outTail[0][1][i] > outTail[0][1][i - 1]);
            }
        }
        assert.ok(outTail[0][0][15] === 0);
        assert.ok(outTail[0][1][15] === 0);

        for (let i = 16; i < 128; i++) {
            assert.strictEqual(outTail[0][0][i], 0);
            assert.strictEqual(outTail[0][1][i], 0);
        }
    });

    it('T7: underrun de 1 amostra não zera bruscamente e retomada aplica fade-in', () => {
        const proc = new ProcessorClass();
        const total = 1537;
        const interleaved = new Float32Array(total * 2);
        for (let i = 0; i < total; i++) {
            interleaved[i * 2] = 1.0;
            interleaved[i * 2 + 1] = -1.0;
        }
        proc.pushInterleaved(interleaved);

        for (let q = 0; q < 12; q++) {
            proc.process([], makeOutputQuantum(128), {});
        }
        assert.strictEqual(proc.availableFrames, 1);

        const outOne = makeOutputQuantum(128);
        proc.process([], outOne, {});
        assert.strictEqual(proc.availableFrames, 0);
        assert.strictEqual(proc.hasStartedPlayback, false);
        assert.ok(Math.abs(outOne[0][0][0] - 0.5) < 1e-6);
        assert.ok(Math.abs(outOne[0][1][0] + 0.5) < 1e-6);
        assert.strictEqual(outOne[0][0][1], 0);

        const resumeSamples = new Float32Array(1536 * 2);
        for (let i = 0; i < 1536; i++) {
            resumeSamples[i * 2] = 1.0;
            resumeSamples[i * 2 + 1] = -1.0;
        }
        proc.pushInterleaved(resumeSamples);
        const outResume = makeOutputQuantum(128);
        proc.process([], outResume, {});
        assert.strictEqual(proc.hasStartedPlayback, true);
        assert.ok(outResume[0][0][0] > 0 && outResume[0][0][0] < 0.2);
        assert.ok(outResume[0][0][127] > 0.99);
    });

    it('T8: saída mono faz downmix (L+R)*0.5 sem sobrescrever canal e mensagem stop encerra process()', () => {
        const proc = new ProcessorClass();
        const total = 1536;
        const interleaved = new Float32Array(total * 2);
        for (let i = 0; i < total; i++) {
            interleaved[i * 2] = 0.8;
            interleaved[i * 2 + 1] = 0.2;
        }
        proc.pushInterleaved(interleaved);

        const monoOut = [[new Float32Array(128)]];
        assert.strictEqual(proc.process([], monoOut, {}), true);
        assert.strictEqual(proc.hasStartedPlayback, true);
        assert.ok(
            Math.abs(monoOut[0][0][0] - 0.5) < 1e-6,
            `Saída mono deve misturar (0.8 + 0.2) * 0.5 = 0.5, veio ${monoOut[0][0][0]}`
        );

        proc.port.onmessage({ data: { type: 'stop' } });
        assert.strictEqual(
            proc.process([], makeOutputQuantum(128), {}),
            false,
            'Após mensagem stop, process() deve retornar false para encerrar AudioWorklet'
        );
    });
});

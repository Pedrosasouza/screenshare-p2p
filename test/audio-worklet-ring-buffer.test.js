const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

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

    const sandbox = {
        AudioWorkletProcessor: MockAudioWorkletProcessor,
        registerProcessor: (name, cls) => {
            registered[name] = cls;
        },
        Float32Array,
        Math
    };

    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    const ProcessorClass = registered['pcm-ring-buffer-processor'];
    assert(ProcessorClass, 'PCMRingBufferProcessor deve ser registrado via registerProcessor');
    return ProcessorClass;
}

function loadForwardPcmFn(mockWorkletNode) {
    const { loadClientBundleSource } = require('./helpers/client-source');
    const appJs = loadClientBundleSource();
    const match = appJs.match(/function\s+forwardPcmBufferToWorklet\s*\([\s\S]*?\n\}/);
    assert(match, 'Função forwardPcmBufferToWorklet não encontrada em public/app.js');

    const sandbox = {
        activeAudioWorkletNode: mockWorkletNode,
        ArrayBuffer,
        Float32Array
    };
    vm.createContext(sandbox);
    vm.runInContext(match[0], sandbox);
    return {
        fn: sandbox.forwardPcmBufferToWorklet,
        sandbox
    };
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

function runTests() {
    console.log('\n===============================================================');
    console.log('  🧪 SUÍTE DE TESTES: AUDIO WORKLET RING BUFFER & PCM BRIDGE');
    console.log('===============================================================\n');

    let failures = 0;
    const ProcessorClass = loadProcessorClass();

    // T1: Fluxo normal push + process (pre-buffering, saída L/R correta e underrun -> silêncio)
    process.stdout.write('  [Teste] T1: Pre-buffering, saída L/R correta e retorno para silêncio no underrun ... ');
    try {
        const proc = new ProcessorClass();
        // Empurra menos que targetBufferFrames (1440): deve manter saída em silêncio
        proc.pushInterleaved(makeInterleavedFrames(512, 1));
        assert.strictEqual(proc.availableFrames, 512);

        const outPre = makeOutputQuantum(128);
        outPre[0][0].fill(99);
        outPre[0][1].fill(99);
        proc.process([], outPre, {});
        assert.strictEqual(proc.hasStartedPlayback, false, 'Não deve iniciar reprodução antes de atingir targetBufferFrames');
        assert(outPre[0][0].every((v) => v === 0), 'Canal L deve ficar em silêncio durante pre-buffering');
        assert(outPre[0][1].every((v) => v === 0), 'Canal R deve ficar em silêncio durante pre-buffering');

        // Completa até >= 1440 frames (512 + 1024 = 1536 frames)
        proc.pushInterleaved(makeInterleavedFrames(1024, 513));
        assert.strictEqual(proc.availableFrames, 1536);

        // Consome 12 quântums (12 * 128 = 1536 frames) e verifica valores L/R
        for (let q = 0; q < 12; q++) {
            const out = makeOutputQuantum(128);
            proc.process([], out, {});
            assert.strictEqual(proc.hasStartedPlayback, true);
            for (let i = 0; i < 128; i++) {
                const expected = q * 128 + i + 1;
                assert.strictEqual(out[0][0][i], expected, `L mismatch no frame ${expected}`);
                assert.strictEqual(out[0][1][i], -expected, `R mismatch no frame ${expected}`);
            }
        }
        assert.strictEqual(proc.availableFrames, 0);

        // Próximo process sem dados suficientes -> underrun volta para silêncio e reativa pre-buffering
        const outUnderrun = makeOutputQuantum(128);
        outUnderrun[0][0].fill(42);
        outUnderrun[0][1].fill(-42);
        proc.process([], outUnderrun, {});
        assert.strictEqual(proc.hasStartedPlayback, false, 'Underrun deve reativar pre-buffering');
        assert(outUnderrun[0][0].every((v) => v === 0), 'Underrun deve preencher L com silêncio');
        assert(outUnderrun[0][1].every((v) => v === 0), 'Underrun deve preencher R com silêncio');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T2: Overflow normal e overflow com chunk gigante (> maxBufferFrames e > capacity)
    process.stdout.write('  [Teste] T2: Overflow normal e chunk gigante (> maxBufferFrames e > capacity) sem corrupção ... ');
    try {
        // 2a. Overflow normal: 3000 + 2000 = 5000 > 4800 (maxBufferFrames) -> descarta excesso até 1440
        const procNormal = new ProcessorClass();
        procNormal.pushInterleaved(makeInterleavedFrames(3000, 1));
        procNormal.pushInterleaved(makeInterleavedFrames(2000, 3001));
        assert.strictEqual(procNormal.availableFrames, procNormal.targetBufferFrames);
        assert(procNormal.availableFrames >= 0 && procNormal.availableFrames <= procNormal.capacity);

        // Os frames restantes devem ser os 1440 mais recentes (3561..5000)
        const outNormal = makeOutputQuantum(128);
        procNormal.process([], outNormal, {});
        assert.strictEqual(outNormal[0][0][0], 3561, 'Overflow normal deve preservar frames mais recentes');
        assert.strictEqual(outNormal[0][1][0], -3561);

        // 2b. Overflow com chunk gigante (> maxBufferFrames e > capacity)
        const procGiant = new ProcessorClass();
        procGiant.pushInterleaved(makeInterleavedFrames(1000, 1));
        // Chunk de 25000 frames (> capacity 19200 e > maxBufferFrames 4800)
        procGiant.pushInterleaved(makeInterleavedFrames(25000, 10001));

        assert(procGiant.availableFrames >= 0, 'availableFrames nunca pode ficar negativo');
        assert(procGiant.availableFrames <= procGiant.capacity, 'availableFrames nunca pode exceder capacity');
        assert.strictEqual(procGiant.availableFrames, procGiant.targetBufferFrames);

        // Verifica que os frames mantidos são os últimos 1440 do chunk gigante (35000 - 1440 + 1 = 33561)
        const expectedFirst = 10001 + (25000 - procGiant.targetBufferFrames);
        const outGiant = makeOutputQuantum(128);
        procGiant.process([], outGiant, {});
        assert.strictEqual(outGiant[0][0][0], expectedFirst, 'Chunk gigante deve reter apenas os frames mais recentes');
        assert.strictEqual(outGiant[0][1][0], -expectedFirst);

        // 2c. Caso em que maxBufferFrames é alto e apenas capacity limita a gravação
        const procCap = new ProcessorClass();
        procCap.maxBufferFrames = 100000;
        procCap.pushInterleaved(makeInterleavedFrames(22000, 1));
        assert.strictEqual(procCap.availableFrames, procCap.capacity, 'Nunca deve gravar além de capacity');
        const outCap = makeOutputQuantum(128);
        procCap.process([], outCap, {});
        // Deve começar em 22000 - 19200 + 1 = 2801
        assert.strictEqual(outCap[0][0][0], 2801, 'Guarda de capacity deve preservar os frames mais recentes');

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T3: Entrada com tamanho ímpar e flush()
    process.stdout.write('  [Teste] T3: Entrada com tamanho ímpar (ex.: 5 floats) e flush() ... ');
    try {
        const proc = new ProcessorClass();
        // Tamanho 1 (< 2): ignorado
        proc.pushInterleaved(new Float32Array([0.5]));
        assert.strictEqual(proc.availableFrames, 0);

        // Tamanho 5 floats: apenas 2 frames completos (4 floats) devem ser gravados
        proc.pushInterleaved(new Float32Array([0.1, -0.1, 0.2, -0.2, 0.999]));
        assert.strictEqual(proc.availableFrames, 2, '5 floats devem resultar em exatamente 2 frames inteiros');
        assert.strictEqual(Number.isInteger(proc.availableFrames), true);
        assert.strictEqual(proc.writeIndex, 2);

        // Preenche até iniciar playback e lê os 2 primeiros frames para validar ausência de NaN
        proc.pushInterleaved(makeInterleavedFrames(1438, 10));
        assert.strictEqual(proc.availableFrames, 1440);
        const out = makeOutputQuantum(128);
        proc.process([], out, {});
        assert.strictEqual(proc.hasStartedPlayback, true);
        assert(Math.abs(out[0][0][0] - 0.1) < 1e-6);
        assert(Math.abs(out[0][1][0] - (-0.1)) < 1e-6);
        assert(Math.abs(out[0][0][1] - 0.2) < 1e-6);
        assert(Math.abs(out[0][1][1] - (-0.2)) < 1e-6);
        assert.strictEqual(out[0][0][2], 10);

        // flush() limpa todo estado
        proc.flush();
        assert.strictEqual(proc.readIndex, 0);
        assert.strictEqual(proc.writeIndex, 0);
        assert.strictEqual(proc.availableFrames, 0);
        assert.strictEqual(proc.hasStartedPlayback, false);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T4: forwardPcmBufferToWorklet com ArrayBuffer desalinhado (10 bytes, 3 bytes, 16 bytes)
    process.stdout.write('  [Teste] T4: forwardPcmBufferToWorklet alinha bytes a múltiplos de 8 sem lançar RangeError ... ');
    try {
        const posted = [];
        const mockNode = {
            port: {
                postMessage(data, transfer) {
                    posted.push({ data, transfer });
                }
            }
        };
        const { fn: forwardPcmBufferToWorklet } = loadForwardPcmFn(mockNode);

        // 3 bytes (< 8): não lança e não posta nada
        const buf3 = new ArrayBuffer(3);
        forwardPcmBufferToWorklet(buf3);
        assert.strictEqual(posted.length, 0, 'Buffer de 3 bytes (< 1 frame estéreo f32) não deve ser enviado');

        // 10 bytes (não múltiplo de 4 nem 8): trunca para 8 bytes (2 floats = 1 frame estéreo)
        const buf10 = new ArrayBuffer(10);
        const view10 = new DataView(buf10);
        view10.setFloat32(0, 0.25, true);
        view10.setFloat32(4, -0.25, true);
        forwardPcmBufferToWorklet(buf10);
        assert.strictEqual(posted.length, 1, 'Buffer de 10 bytes deve enviar 1 frame alinhado');
        assert(posted[0].data instanceof Float32Array);
        assert.strictEqual(posted[0].data.byteLength, 8);
        assert.strictEqual(posted[0].data.length, 2);
        assert.strictEqual(posted[0].data[0], 0.25);
        assert.strictEqual(posted[0].data[1], -0.25);
        assert.strictEqual(posted[0].transfer[0], posted[0].data.buffer);
        assert.notStrictEqual(posted[0].data.buffer, buf10, 'Buffer desalinhado deve usar slice alinhado');

        // 16 bytes (múltiplo de 8): reutiliza buffer diretamente
        const buf16 = new Float32Array([1, -1, 2, -2]).buffer;
        forwardPcmBufferToWorklet(buf16);
        assert.strictEqual(posted.length, 2);
        assert.strictEqual(posted[1].data.byteLength, 16);
        assert.strictEqual(posted[1].data.buffer, buf16);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T5: pushInterleaved sanitiza NaN / ±Infinity para 0 preservando amostras finitas adjacentes
    process.stdout.write('  [Teste] T5: pushInterleaved sanitiza NaN/Infinity para 0 preservando amostras finitas ... ');
    try {
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

        // Frame 0: [NaN, 0.5] -> [0, 0.5]
        assert.strictEqual(out[0][0][0], 0, 'NaN em L deve virar 0');
        assert.strictEqual(out[0][1][0], 0.5, 'Amostra finita adjacente em R deve ser preservada');
        // Frame 1: [Infinity, -Infinity] -> [0, 0]
        assert.strictEqual(out[0][0][1], 0, 'Infinity em L deve virar 0');
        assert.strictEqual(out[0][1][1], 0, '-Infinity em R deve virar 0');
        // Frame 2: [-0.25, 0.75] preservado
        assert.strictEqual(out[0][0][2], -0.25);
        assert.strictEqual(out[0][1][2], 0.75);
        // Frame 3: início da sequência finita (10, -10)
        assert.strictEqual(out[0][0][3], 10);
        assert.strictEqual(out[0][1][3], -10);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T6: Underrun parcial (0 < availableFrames < 128) aplica fade-out suave e drena resto sem reter áudio velho
    process.stdout.write('  [Teste] T6: Underrun parcial aplica fade-out monotônico até 0 e drena buffer restante ... ');
    try {
        const proc = new ProcessorClass();
        // Guards defensivos em outputs ausente/vazio
        assert.strictEqual(proc.process([], [], {}), true);
        assert.strictEqual(proc.process([], [[]], {}), true);

        // 12 * 128 + 16 = 1552 frames constantes (0.8, -0.8)
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
        assert.strictEqual(proc.availableFrames, 16, 'Devem restar exatamente 16 frames antes do underrun parcial');
        assert.strictEqual(proc.hasStartedPlayback, true);

        const outTail = makeOutputQuantum(128);
        outTail[0][0].fill(99);
        outTail[0][1].fill(-99);
        proc.process([], outTail, {});

        assert.strictEqual(proc.availableFrames, 0, 'Frames restantes devem ser completamente drenados no underrun parcial');
        assert.strictEqual(proc.hasStartedPlayback, false, 'Underrun parcial deve reativar pre-buffering');

        // Fade-out monotônico nos 16 primeiros frames até 0
        for (let i = 0; i < 16; i++) {
            assert(outTail[0][0][i] >= 0 && outTail[0][0][i] < 0.8, `L[${i}] deve estar atenuado`);
            assert(outTail[0][1][i] <= 0 && outTail[0][1][i] > -0.8, `R[${i}] deve estar atenuado`);
            if (i > 0) {
                assert(outTail[0][0][i] < outTail[0][0][i - 1], `Fade-out em L deve ser estritamente decrescente no índice ${i}`);
                assert(outTail[0][1][i] > outTail[0][1][i - 1], `Fade-out em R deve se aproximar de 0 no índice ${i}`);
            }
        }
        assert.ok(outTail[0][0][15] === 0, 'Último frame do fade-out em L deve atingir 0');
        assert.ok(outTail[0][1][15] === 0, 'Último frame do fade-out em R deve atingir 0');

        // Restante do quantum [16..127] preenchido com 0
        for (let i = 16; i < 128; i++) {
            assert.strictEqual(outTail[0][0][i], 0, `L[${i}] após fade-out deve ser 0`);
            assert.strictEqual(outTail[0][1][i], 0, `R[${i}] após fade-out deve ser 0`);
        }

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    // T7: Underrun parcial com remaining === 1 atenua suavemente (sem snap imediato para 0) e retomada faz fade-in
    process.stdout.write('  [Teste] T7: Underrun de 1 amostra não zera bruscamente e retomada aplica fade-in ... ');
    try {
        const proc = new ProcessorClass();
        // 12 * 128 + 1 = 1537 frames constantes (1.0, -1.0)
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
        assert(Math.abs(outOne[0][0][0] - 0.5) < 1e-6, `Underrun de 1 amostra deve atenuar para 0.5, obtido ${outOne[0][0][0]}`);
        assert(Math.abs(outOne[0][1][0] + 0.5) < 1e-6, `Canal R deve atenuar para -0.5, obtido ${outOne[0][1][0]}`);
        assert.strictEqual(outOne[0][0][1], 0);

        // Retomada após underrun -> pre-bufferiza novamente e faz fade-in suave
        const resumeSamples = new Float32Array(1536 * 2);
        for (let i = 0; i < 1536; i++) {
            resumeSamples[i * 2] = 1.0;
            resumeSamples[i * 2 + 1] = -1.0;
        }
        proc.pushInterleaved(resumeSamples);
        const outResume = makeOutputQuantum(128);
        proc.process([], outResume, {});
        assert.strictEqual(proc.hasStartedPlayback, true);
        assert(outResume[0][0][0] > 0 && outResume[0][0][0] < 0.2, `Retomada pós-underrun deve iniciar com fade-in suave, obtido ${outResume[0][0][0]}`);
        assert(outResume[0][0][127] > 0.99, `Ao fim do quantum de retomada ganho deve convergir para 1.0, obtido ${outResume[0][0][127]}`);

        console.log('\x1b[32mPASSOU\x1b[0m');
    } catch (err) {
        failures++;
        console.log(`\x1b[31mFALHOU (${err.message})\x1b[0m`);
    }

    console.log('\n===============================================================');
    if (failures > 0) {
        console.log(`  ❌ Resultado: ${failures} teste(s) falharam.`);
        console.log('===============================================================\n');
        process.exit(1);
    } else {
        console.log('  ✅ Resultado: Todos os testes passaram com sucesso.');
        console.log('===============================================================\n');
        process.exit(0);
    }
}

runTests();

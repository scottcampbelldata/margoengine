import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

// This is a browser Wasm correctness check. It never requests a GPU device.
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free', compat: false });
try {
  const result = await browser.page.evaluate(async () => {
    const { loadOnnx, OnnxTensor } = await import('/packages/compute/dist/onnx.js');
    const p = await import('/packages/compute/tests/onnx-fixtures.js');
    const read = async (name) =>
      new Uint8Array(await (await fetch(`/packages/compute/tests/fixtures/onnx/${name}`)).arrayBuffer());
    using model = await loadOnnx(new URL('/packages/compute/tests/fixtures/onnx/mnist-12.onnx', location.href));
    const input = p.referenceTensor(await read('input_0.pb'));
    const expected = p.referenceTensor(await read('output_0.pb'));
    const output = await model.run({ [model.inputs[0].name]: new OnnxTensor('float32', input.data, input.shape) });
    const actual = output[model.outputs[0].name];
    let error = 0;
    for (let i = 0; i < expected.data.length; i++) {
      const difference = Math.abs(actual.data[i] - expected.data[i]);
      if (difference > 2e-5 + Math.abs(expected.data[i]) * 1e-5) throw new Error(`MNIST reference mismatch at ${i}`);
      error = Math.max(error, difference);
    }
    const bytes = p.model(
      p.graph(
        [p.node('Add', ['x', 'b'], ['y'])],
        [p.valueInfo('x', 7, [5])],
        [p.valueInfo('y', 7, [5])],
        [p.tensor('b', 7, [], BigInt64Array.of(1n))],
      ),
    );
    using exact = await loadOnnx(bytes);
    const result = await exact.run({
      x: new OnnxTensor('int64', BigInt64Array.of(9007199254740993n, 1n, 2n, 3n, 4n), [5]),
    });
    if (result.y.data[0] !== 9007199254740994n || exact.work.simdGroups !== 2n)
      throw new Error('browser int64/SIMD mismatch');
    const controller = new AbortController();
    controller.abort(new Error('browser cancel'));
    let cancelled = false;
    try {
      await exact.run({}, { signal: controller.signal });
    } catch (error) {
      cancelled = error.message === 'browser cancel';
    }
    if (!cancelled) throw new Error('browser abort reason was not preserved');
    const { checkOnnxReference } = await import('/packages/compute/tests/onnx-reference-cases.js');
    const reference = await (await fetch('/packages/compute/tests/fixtures/onnx/operators-reference.json')).json();
    let referenceMaxError = 0;
    for (const c of reference.cases) referenceMaxError = Math.max(referenceMaxError, await checkOnnxReference(c));
    return {
      logits: actual.data.length,
      error,
      simdGroups: Number(exact.work.simdGroups),
      retained: result.y.data[0].toString(),
      references: reference.cases.length,
      referenceMaxError,
    };
  });
  assert.equal(result.logits, 10);
  assert.equal(result.retained, '9007199254740994');
  assert.equal(result.simdGroups, 2);
  console.log(JSON.stringify({ onnxBrowser: result }));
} finally {
  await browser.close();
}

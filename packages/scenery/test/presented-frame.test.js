import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
for (const compat of [false, true]) {
  test(`scene capture preserves the ${compat ? 'compatibility completion barrier' : 'native submit task'}`, async () => {
    const html = readFileSync(new URL('./scenes-check.html', import.meta.url), 'utf8').replaceAll('\r', '');
    const method = html.match(/async function frame\(\)\{[\s\S]*?\n\}/);
    assert.ok(method, 'the real frame fixture must exist');
    const calls = [],
      canvas = { width: 4, height: 3 };
    let finished = false;
    const engine = {
      render() {
        calls.push('submit');
      },
    };
    const device = {
      queue: {
        async onSubmittedWorkDone() {
          calls.push('finish');
          finished = true;
        },
      },
    };
    class Canvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage(source) {
            assert.equal(source, canvas);
            assert.equal(finished, compat);
            calls.push('capture');
          },
          getImageData: () => ({ data: new Uint8Array(48).fill(255) }),
        };
      }
    }
    const frame = new Function(
      'engine',
      'device',
      'canvas',
      'OffscreenCanvas',
      'isCompatDevice',
      `${method[0]};return frame`,
    )(engine, device, canvas, Canvas, () => compat);
    assert.deepEqual((await frame())(0, 0), [255, 255, 255]);
    assert.deepEqual(calls, compat ? ['submit', 'finish', 'capture'] : ['submit', 'capture']);
  });
}

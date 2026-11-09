import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('the real LOD correctness page keeps every frame and reads no timing clock', async () => {
  const html = readFileSync(new URL('./browser-check.html', import.meta.url), 'utf8'),
    body = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
  let frames = 0,
    bakes = 0;
  const device = {
    addEventListener() {},
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: { onSubmittedWorkDone: async () => {} },
  };
  const engine = {
    gpu: device,
    camera: {},
    stats: { drawCalls: 1, visible: 2500 },
    render() {
      frames++;
    },
    removePlugin() {},
    use() {},
    createMesh() {
      return {
        setPosition() {
          return this;
        },
        setRotation() {
          return this;
        },
        setMaterial() {
          return this;
        },
        setGeometry() {
          return this;
        },
      };
    },
  };
  class LODSystem {
    handles = [];
    add() {
      this.handles.push({ level: 3 });
    }
  }
  const window = {};
  await vm.runInNewContext(`(async()=>{${body}})()`, {
    window,
    document: { querySelector: () => ({}) },
    location: { search: '' },
    URLSearchParams,
    performance: {
      now() {
        throw new Error('correctness must not measure time');
      },
    },
    Engine: { create: async () => engine },
    PbrMaterial: class {},
    LODSystem,
    torusKnotGeometry: (a, b, c, d) => ({ indices: { length: c * d * 6 } }),
    toGeometry: (x) => x,
    Imposter: {
      bake() {
        bakes++;
        return {};
      },
    },
  });
  for (const mode of ['empty', 'lod', 'full']) {
    await window.check.mode(mode);
    const result = await (window.check.correctness ?? window.check.measure).call(window.check, 120);
    assert.equal('cpu' in result || 'gpu' in result, false);
    assert.equal(frames, (['empty', 'lod', 'full'].indexOf(mode) + 1) * 142);
    if (mode === 'lod') assert.equal(result.levels[3], 2500);
  }
  assert.equal(bakes, 1);
});

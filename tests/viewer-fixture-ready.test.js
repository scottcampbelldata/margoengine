import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { transformWithOxc } from 'vite';

test('the actual viewer fixture waits for submitted GPU work before reporting an opened frame', async () => {
  const names = [
    'window',
    'viewerPage',
    'requestAnimationFrame',
    'GPUDevice',
    '__margoPipelines',
    '__viewerFixtureMock',
  ];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const fence = Promise.withResolvers();
  const engine = {
    camera: { position: [0, 0, 4], target: [0, 0, 0] },
    gpu: { addEventListener() {}, queue: { onSubmittedWorkDone: () => fence.promise } },
    render() {},
    hasPlugin: () => false,
  };
  const mocks = {
    createStage: async () => ({ engine }),
    engineRuntime: (e) => e,
    addViewer: async () => ({}),
    addScene: () => assert.fail('not used by open'),
  };
  const entry = resolve('test-results', `viewer-fixture-${process.pid}.mjs`);
  mkdirSync(resolve('test-results'), { recursive: true });
  let opening;
  try {
    Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (callback) => queueMicrotask(() => callback(0)),
      configurable: true,
    });
    Object.defineProperty(globalThis, 'GPUDevice', {
      value: class {
        createRenderPipelineAsync() {
          return Promise.resolve({});
        }
        createComputePipelineAsync() {
          return Promise.resolve({});
        }
      },
      configurable: true,
    });
    delete globalThis.__margoPipelines;
    globalThis.__viewerFixtureMock = mocks;
    const source = readFileSync('tests/stage-viewer.ts', 'utf8');
    const { code } = await transformWithOxc(source, 'stage-viewer.ts');
    let outputText = code;
    const exportsByModule = {
      '@margoengine/stage': ['createStage'],
      '@margoengine/core/extension': ['engineRuntime'],
      '@margoengine/stage/scene': ['addScene'],
      '@margoengine/stage/viewer': ['addViewer'],
    };
    for (const [module, names] of Object.entries(exportsByModule)) {
      const stub = names
        .map((name) => `export const ${name}=(...args)=>globalThis.__viewerFixtureMock.${name}(...args);`)
        .join('\n');
      const url = 'data:text/javascript,' + encodeURIComponent(stub);
      outputText = outputText.replace(
        new RegExp('from [\\\"\\\']' + module + '[\\\"\\\']'),
        'from ' + JSON.stringify(url),
      );
    }
    writeFileSync(entry, outputText);
    await import(pathToFileURL(entry).href);
    let opened = false;
    opening = window.viewerPage.open({ turntable: false }).then((value) => {
      opened = true;
      return value;
    });
    // Drain already queued frame callbacks; the GPU fence stays explicitly held.
    await new Promise(setImmediate);
    assert.equal(opened, false, 'a fixed number of animation callbacks cannot establish GPU completion');
    fence.resolve();
    await opening;
    assert.equal(opened, true);
  } finally {
    fence.resolve();
    await opening;
    if (existsSync(entry)) unlinkSync(entry);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

test('optional packages stay isolated and an accessor-only import discards rendering', async () => {
  const external = [
    '@margoengine/core',
    '@margoengine/core/extension',
    '@margoengine/animation',
    '@margoengine/animation/sampling',
    '@margoengine/gltf-pro',
    '@margoengine/gltf-pro/model',
    '@margoengine/blender',
    // gltf-pro loads these on demand: a dynamic import is the one link allowed, which the check below holds.
    '@margoengine/splats',
    '@margoengine/splats/data',
  ];
  const optional = [
    'gltf-pro',
    'blender',
    'animation',
    'post',
    'shadows',
    'clustered',
    'vfx',
    'animator',
    'taa',
    'splats',
    'terrain',
  ];
  for (const pack of optional) {
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: {
        write: false,
        lib: { entry: 'packages/' + pack + '/dist/index.js', formats: ['es'] },
        rollupOptions: { external },
      },
    });
    const chunks = result[0].output.filter((c) => c.type === 'chunk'),
      modules = chunks.flatMap((c) => Object.keys(c.modules));
    assert.ok(
      chunks.every((c) => !c.imports.some((id) => id.startsWith('@margoengine/splats'))),
      'splats is a static import of ' + pack,
    );
    if (pack === 'gltf-pro')
      assert.ok(
        chunks.some((c) => c.dynamicImports.includes('@margoengine/splats')),
        'gltf-pro loads splats on demand',
      );
    for (const other of optional.filter((p) => p !== pack))
      assert.ok(
        modules.every((m) => !m.includes('/packages/' + other + '/')),
        other + ' leaked into ' + pack,
      );
  }
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'tests/modern-gltf-asset-consumer.js', formats: ['es'] },
      rollupOptions: { external },
    },
  });
  const code = result[0].output
    .filter((c) => c.type === 'chunk')
    .map((c) => c.code)
    .join('\n');
  assert.ok(
    !code.includes('PBRModel') && !code.includes('@fragment') && !code.includes('Animation') && !code.includes('SSAO'),
    'Unused extensions leaked into accessor consumer',
  );
});

test('Blender decoding discards PBR and never enters core + stage', async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, lib: { entry: 'tests/modern-blender-consumer.js', formats: ['es'] } },
  });
  const code = result[0].output
    .filter((c) => c.type === 'chunk')
    .map((c) => c.code)
    .join('\n');
  assert.ok(
    !code.includes('@fragment') && !code.includes('createBuffer') && !code.includes('WebSocket'),
    'Decode-only imports retained rendering/live-link code',
  );
  const decodeModules = result[0].output
    .filter((chunk) => chunk.type === 'chunk')
    .flatMap((chunk) => Object.entries(chunk.modules))
    .filter(([, module]) => module.renderedLength > 0)
    .map(([id]) => id);
  assert.ok(
    decodeModules.every((id) => !/\/packages\/(gltf-pro|decoders)\//.test(id)),
    'Decode-only imports retained PBR or codec modules',
  );
  const { measureCoreStage } = await import('../scripts/measure-size.js');
  const { modules } = await measureCoreStage();
  assert.ok(
    modules.every((m) => !m.includes('/packages/blender/') && !m.includes('/packages/gltf-pro/')),
    'Blender/PBR entered core + stage',
  );
  const core = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, lib: { entry: 'packages/core/dist/index.js', formats: ['es'] } },
  });
  const coreModules = core[0].output.filter((c) => c.type === 'chunk').flatMap((c) => Object.keys(c.modules));
  assert.ok(
    coreModules.every((m) => !m.includes('/packages/blender/') && !m.includes('/packages/gltf-pro/')),
    'Blender/PBR entered core-only application',
  );
});

test('game math helpers discard GPU renderers and shaders', async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, lib: { entry: 'tests/modern-game-helper-consumer.js', formats: ['es'] } },
  });
  const code = result[0].output
    .filter((c) => c.type === 'chunk')
    .map((c) => c.code)
    .join('\n');
  assert.ok(
    !code.includes('@fragment') &&
      !code.includes('@compute') &&
      !code.includes('createBuffer') &&
      !code.includes('@margoengine/animation'),
    'Unused GPU/gameplay code leaked into math-only imports',
  );
});

test('scene fade subpath does not load SSAO or Bloom', async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'packages/post/dist/scene-fade.js', formats: ['es'] },
      rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
    },
  });
  const code = result[0].output
    .filter((chunk) => chunk.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
  assert.ok(
    !code.includes('ssao:capture') && !code.includes('bloom:capture') && !code.includes('@compute'),
    'Scene fade retained the effects it defers',
  );
});

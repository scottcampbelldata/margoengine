// Pay only for what you import: environment.ts once took shaders.ts as a namespace and picked a compute shader by key,
// so a bundler kept every shader in it: an app that only lights a scene downloaded ImageBackground's WGSL too (313 B
// gzip in the create-margo web starter). The second case imports ImageBackground and checks the marker finds it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

// A function only ImageBackground's shader declares.
const IMAGE_SHADER = 'fn cylinderUv(';

async function bundled(code) {
  const out = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, target: 'es2022', minify: true, rollupOptions: { input: 'app' } },
    plugins: [
      { name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) },
    ],
  });
  // Every chunk counts, lazy ones included: the cost is what the app downloads at all.
  return out.output
    .filter((file) => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
}

const lighting = `import { Environment, EnvironmentBackground, EnvironmentLighting } from '@margoengine/environment';
console.log(Environment, EnvironmentBackground, EnvironmentLighting);`;

test('lighting a scene and drawing its sky bundles no ImageBackground shader', { timeout: 180000 }, async () => {
  const code = await bundled(lighting);
  assert.ok(code.includes('fn faceDirection('), 'the lighting shaders are in the build');
  assert.ok(!code.includes(IMAGE_SHADER), 'the ImageBackground shader was bundled');
});

test('importing ImageBackground bundles its shader, so the marker above is live', { timeout: 180000 }, async () => {
  const code = await bundled(
    `${lighting}\nimport { ImageBackground } from '@margoengine/environment';\nconsole.log(ImageBackground);`,
  );
  assert.ok(code.includes(IMAGE_SHADER), 'the ImageBackground shader is in the build');
});

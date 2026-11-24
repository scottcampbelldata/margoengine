// EnvironmentLighting.load is the only part of an Environment and EnvironmentLighting app that reads image files. Its
// EXR, Radiance HDR and UltraHDR decoders (and the inflate EXR needs) came along statically, so a page that builds its
// environment from pixels, as the gallery's model cabinet does, loaded about 8.9 KB gzip it never ran and went over
// its first-frame budget (scripts/test-gallery-browser.mjs). They now load on the first load() of a URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const results = fileURLToPath(new URL('../../../test-results/', import.meta.url));

test('Environment and EnvironmentLighting leave the image decoders to a chunk load() imports', async (t) => {
  const { build } = await import('vite');
  // Imported by name from inside the repository, as an app does: the package's "sideEffects": false applies.
  await mkdir(results, { recursive: true });
  const folder = await mkdtemp(join(results, 'environment-lazy-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'app.js');
  await writeFile(
    file,
    "import { Environment, EnvironmentLighting } from '@margoengine/environment';\nconsole.log(Environment, EnvironmentLighting);\n",
  );
  const out = await build({
    root: folder,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      modulePreload: false,
      rollupOptions: {
        input: file,
        external: (id) => id.startsWith('@margoengine/') && !id.startsWith('@margoengine/environment'),
      },
    },
  });
  const chunks = (Array.isArray(out) ? out[0] : out).output.filter((o) => o.type === 'chunk'),
    app = chunks.find((c) => c.isEntry),
    lazy = chunks.filter((c) => !c.isEntry).map((c) => c.code).join('\n');
  for (const text of ['Invalid EXR', 'Invalid HDR', '#\\?(RADIANCE|RGBE)']) {
    assert.ok(!app.code.includes(text), `the app's own chunk carries ${text}`);
    assert.ok(lazy.includes(text), `no lazy chunk holds ${text}`);
  }
});

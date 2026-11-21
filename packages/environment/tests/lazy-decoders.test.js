// KB-ENVDECODERS2: loadEnvironmentImage used to import the HDR, EXR and UltraHDR decoders statically, so an app that
// loaded one format shipped all three. It now imports the decoder its file signature names, on first use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironmentImage } from '@margoengine/environment/load';
import { parseEnvironmentImage, parseEXR, loadEnvironmentImage as fromLoaders } from '@margoengine/environment/loaders';

const results = fileURLToPath(new URL('../../../test-results/', import.meta.url));
const hdr = fileURLToPath(new URL('./fixtures/sun_sky.hdr', import.meta.url));

async function bundle(t, source) {
  const { build } = await import('vite');
  await mkdir(results, { recursive: true });
  const folder = await mkdtemp(join(results, 'environment-decoders-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'app.js');
  await writeFile(file, source);
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
  const chunks = (Array.isArray(out) ? out[0] : out).output.filter((o) => o.type === 'chunk');
  return { app: chunks.find((c) => c.isEntry), lazy: chunks.filter((c) => !c.isEntry) };
}

// One string only its decoder holds.
const markers = { hdr: '#\\?(RADIANCE|RGBE)', exr: 'Invalid EXR', ultrahdr: 'no hdrgm gain-map metadata' };

test('an app that loads environment files keeps every decoder in its own lazy chunk', async (t) => {
  const { app, lazy } = await bundle(
    t,
    "import { loadEnvironmentImage } from '@margoengine/environment/load';\nloadEnvironmentImage('a.hdr').then(console.log);\n",
  );
  for (const [name, text] of Object.entries(markers)) {
    assert.ok(!app.code.includes(text), `the app's own chunk carries the ${name} decoder`);
    assert.ok(
      lazy.some((c) => c.code.includes(text)),
      `no lazy chunk holds the ${name} decoder`,
    );
  }
  // No chunk holds two decoders, so a .hdr file requests the HDR chunk alone.
  for (const chunk of lazy) {
    const held = Object.entries(markers).filter(([, text]) => chunk.code.includes(text));
    assert.ok(held.length <= 1, `a lazy chunk holds ${held.map(([n]) => n).join(' and ')} together`);
  }
});

test('loadEnvironmentImage decodes by signature and keeps its errors', async () => {
  const bytes = await readFile(hdr);
  const serve = (body, status = 200) => async () => new Response(body, { status });
  const loaded = await loadEnvironmentImage('x.hdr', { fetch: serve(bytes) });
  assert.deepEqual(loaded.data, parseEnvironmentImage(bytes).data);
  await assert.rejects(loadEnvironmentImage('x', { fetch: serve(new Uint8Array([1, 2, 3, 4])) }), {
    name: 'TypeError',
    message: /Unrecognized environment image/,
  });
  await assert.rejects(loadEnvironmentImage('x', { fetch: serve('', 404) }), { code: 'failed' });
  assert.throws(
    () => parseEnvironmentImage(new Uint8Array([0xff, 0xd8, 0xff, 0])),
    /UltraHDR JPEGs decode asynchronously/,
  );
  assert.equal(typeof parseEXR, 'function');
  assert.equal(fromLoaders, loadEnvironmentImage, '/loaders re-exports the /load function');
});

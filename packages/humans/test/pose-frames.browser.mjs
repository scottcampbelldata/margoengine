// Renders pose-frames.html: a skinned person walking, reaching with IK and sitting, from the front, the three-quarter
// and the side, on its fitted body and with limits off, and checks the fitted body's elbows and knees never bend past
// straight. With no model the person is the code-built body of rigged-body.js through addBody; `--model=<file.glb>`
// draws a loaded person instead (textures are stripped, and `--bare` leaves out the meshes whose material matches
// `--strip`, default garments and boots, so the joints show). Writes test-results/humans/pose-frames-<name>-<backend>.png.
//   node scripts/run-with-timeout.mjs --max=8 -- node packages/humans/test/pose-frames.browser.mjs [--model=x.glb --bare]
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const modelFile = arg('model'),
  bare = process.argv.includes('--bare'),
  strip = new RegExp(arg('strip') ?? '^TR_|Fauld|Boots|Frieze|Wool|Tweed|Coat|Shirt|Trousers', 'i');

/** A GLB's bytes with its images and textures removed and, when `bare`, the meshes made only of `strip` materials. */
function prepare(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = view.getUint32(12, true),
    doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))),
    binLength = view.getUint32(20 + jsonLength, true),
    bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength);
  delete doc.images;
  delete doc.textures;
  delete doc.samplers;
  const drop = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const key of Object.keys(o))
      if (/Texture$/.test(key)) delete o[key];
      else drop(o[key]);
  };
  drop(doc.materials);
  for (const key of ['extensionsUsed', 'extensionsRequired'])
    if (doc[key]) doc[key] = doc[key].filter((e) => !/texture|KHR_materials/.test(e));
  if (bare)
    for (const node of doc.nodes)
      if (
        node.mesh !== undefined &&
        doc.meshes[node.mesh].primitives.every((p) => strip.test(doc.materials?.[p.material]?.name ?? ''))
      ) {
        delete node.mesh;
        delete node.skin;
      }
  // A clip's morph weights on a mesh left out have nothing to drive.
  for (const clip of doc.animations ?? [])
    clip.channels = clip.channels.filter(
      (c) => c.target.path !== 'weights' || doc.nodes[c.target.node]?.mesh !== undefined,
    );
  const raw = new TextEncoder().encode(JSON.stringify(doc)),
    json = new Uint8Array((raw.length + 3) & ~3).fill(0x20);
  json.set(raw);
  const out = new Uint8Array(28 + json.length + bin.length),
    dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  dv.setUint32(20 + json.length, bin.length, true);
  dv.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}

mkdirSync('test-results/humans', { recursive: true });
let url = null,
  name = 'addbody';
if (modelFile) {
  name = basename(modelFile, '.glb') + (bare ? '-bare' : '');
  writeFileSync('test-results/humans/pose-frames-model.glb', prepare(new Uint8Array(readFileSync(modelFile))));
  url = '/test-results/humans/pose-frames-model.glb';
}
const { page, close, hardware } = await openBrowser({
  startPath: '/packages/humans/test/pose-frames.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const backend = hardware.compat ? 'webgl2' : 'webgpu',
    result = await page.evaluate((model) => window.renderFrames({ model }), url),
    file = `test-results/humans/pose-frames-${name}-${backend}.png`,
    png = Buffer.from(result.png, 'base64');
  writeFileSync(file, png);
  console.log(`${backend}: ${file}, ${png.length} bytes`);
  for (const row of result.report)
    console.log(
      ' ',
      row.variant,
      '|',
      row.pose,
      '|',
      JSON.stringify(row.hinges),
      '| outside',
      row.outside,
      'structural',
      row.structural,
      row.stops.join('; '),
    );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  // The fitted body holds every pose inside the stops no body passes, and its reach never bends an elbow past
  // straight; free, the pole behind turns the arm past a stop (the fault this guards against).
  const fitted = result.report.filter((row) => row.variant === 'fitted body'),
    reach = (variant) => result.report.find((row) => row.variant === variant && /reach/.test(row.pose)).hinges;
  for (const row of fitted) assert.equal(row.structural, 0, `${row.pose}: ${row.structural} motions past a stop`);
  assert.ok(
    Math.min(reach('fitted body').l_elbow, reach('fitted body').r_elbow) > -1,
    JSON.stringify(reach('fitted body')),
  );
  assert.ok(
    result.report.find((row) => row.variant === 'limits: false' && /reach/.test(row.pose)).structural > 0,
    'the free reach no longer shows the fault',
  );
} finally {
  await close();
}

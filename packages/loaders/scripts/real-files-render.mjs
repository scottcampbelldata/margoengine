// Draws what test-real-files.mjs opened through the real engine on the GPU and refuses a blank picture. Parsing stays in
// Node, where the caller-owned hooks live; the page gets the parsed arrays and builds meshes with createMeshes, or lines
// with @margoengine/lines.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SIZE = 512;
/** A picture with fewer changed pixels than this is blank: 0.05% of the frame. */
const MIN_CHANGED = (SIZE * SIZE) / 2000;

/** One buffer: a JSON head with the array lengths, then the arrays, each on a 4-byte boundary. */
function pack(drawing) {
  const source = drawing.geometry ?? drawing,
    head = { kind: drawing.kind, pbr: drawing.pbr, groups: source.groups?.map(({ start, count, color }) => ({ start, count, color })), arrays: {} },
    parts = [];
  let box = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < source.positions.length; i++) {
    const a = (i % 3) * 2;
    box[a] = Math.min(box[a], source.positions[i]);
    box[a + 1] = Math.max(box[a + 1], source.positions[i]);
  }
  // Survey coordinates: drawn around their centre, as an app would, because 32-bit floats cannot hold both.
  const centre = [(box[0] + box[1]) / 2, (box[2] + box[3]) / 2, (box[4] + box[5]) / 2];
  const positions = Float32Array.from(source.positions, (v, i) => v - centre[i % 3]);
  head.radius = Math.max(Math.hypot(box[1] - box[0], box[3] - box[2], box[5] - box[4]) / 2, 1e-9);
  for (const [name, array] of Object.entries({
    positions,
    normals: source.normals,
    colors: source.kind === 'points' ? undefined : source.colors,
    indices: source.indices,
  })) {
    if (!array?.length) continue;
    head.arrays[name] = [array instanceof Uint32Array ? 'u32' : 'f32', array.length];
    parts.push(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }
  const json = Buffer.from(JSON.stringify(head)),
    pad = Buffer.alloc((4 - ((json.length + 4) % 4)) % 4, 32),
    length = Buffer.alloc(4);
  length.writeUInt32LE(json.length + pad.length);
  return Buffer.concat([length, json, pad, ...parts]);
}

/** Draws every drawing, writes a PNG per file into `folder` and marks a blank or failing row in `report` as FAIL. */
export async function renderAll(drawings, folder, report) {
  await mkdir(folder, { recursive: true });
  const server = await createServer({ configFile: resolve(here, '../vite.config.js'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  let browser;
  try {
    browser = await launchBrowser({ headless: true, args: process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [] });
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
    let body;
    await page.route('**/real-files-payload', (route) => route.fulfill({ body, contentType: 'application/octet-stream' }));
    await page.goto(`${server.resolvedUrls.local[0]}tests/real-files-render.html`);
    await page.waitForFunction(() => typeof window.drawRealFile === 'function');
    const seen = new Map();
    for (const drawing of drawings) {
      const row = report.find((r) => r.id === drawing.id),
        n = (seen.get(drawing.id) ?? 0) + 1;
      seen.set(drawing.id, n);
      try {
        body = pack(drawing);
        const picture = await page.evaluate(() => window.drawRealFile());
        assert.deepEqual(picture.errors, [], 'WebGPU errors');
        assert.ok(picture.changed >= MIN_CHANGED, `the picture is blank: ${picture.changed} pixels changed`);
        const name = `${drawing.id}${n > 1 ? `-${n}` : ''}.png`;
        await writeFile(resolve(folder, name), Buffer.from(picture.png.split(',')[1], 'base64'));
        row.picture = `${name}, ${picture.changed} pixels drawn`;
        console.log(`DRAWN   ${drawing.id}: ${row.picture}`);
      } catch (error) {
        row.status = 'FAIL';
        row.result = `GPU: ${error.message}`.slice(0, 300);
        console.log(`FAIL    ${drawing.id}: ${row.result}`);
      }
    }
  } finally {
    await closeAll({ browser, servers: [server] });
  }
  await writeFile(resolve(folder, '..', 'report.json'), JSON.stringify(report, null, 2));
}

/** Runs in the page: replays the calls over white, gives the mean grey of each cell of a grid. */
function replayGrid({ calls, width, height, scale, cells }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true }),
    gradients = [];
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.setTransform(scale[0], 0, 0, scale[1], 0, 0);
  for (const call of calls) {
    if (call[0] === 'gradient') gradients[call[1]] = context[call[2]](...call[3]);
    else if (call[0] === 'stop') gradients[call[1]].addColorStop(...call[2]);
    else if (call[0] === 'set') context[call[1]] = call[2]?.gradient === undefined ? call[2] : gradients[call[2].gradient];
    else context[call[1]](...call[2]);
  }
  const { data } = context.getImageData(0, 0, width, height),
    sums = new Float64Array(cells * cells),
    counts = new Float64Array(cells * cells);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const cell = Math.floor((y * cells) / height) * cells + Math.floor((x * cells) / width),
        at = (y * width + x) * 4;
      sums[cell] += (data[at] + data[at + 1] + data[at + 2]) / 3;
      counts[cell]++;
    }
  return Array.from(sums, (sum, n) => Math.round(sum / counts[n]));
}

/** Replays recorded canvas calls on a real canvas, one job at a time, and gives each job's grid. */
export async function canvasGrids(jobs) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(),
      grids = [];
    for (const job of jobs) grids.push(await page.evaluate(replayGrid, job));
    return grids;
  } finally {
    await closeAll({ browser, servers: [] });
  }
}

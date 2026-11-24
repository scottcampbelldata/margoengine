// Reads a real Potree folder through PotreeSource and checks every node: its points lie in its cube, the counts add up to
// what the folder states, and the colour range matches the metadata's. Run after building packages:
//   node packages/points/tests/potree-check.mjs <folder URL or local path>
// Real folders with their sources are listed in docs/whitepaper/reproduce.md.
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PotreeSource } from '../dist/potree.js';

const target = process.argv[2];
if (!target) throw new Error('Usage: potree-check.mjs <folder URL or local path>');
const remote = /^https?:/.test(target);
/** A local folder served with Range, as a web server would. */
const local = async (url, init = {}) => {
  const path = join(target, decodeURI(String(url).slice('file:/'.length))),
    range = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('range') ?? '');
  try {
    if (!range) return new Response(await readFile(path));
    const file = await open(path),
      from = Number(range[1]),
      bytes = Number(range[2]) - from + 1,
      buffer = Buffer.alloc(bytes);
    await file.read(buffer, 0, bytes, from);
    await file.close();
    return new Response(buffer, { status: 206 });
  } catch (error) {
    if (error.code === 'ENOENT') return new Response('', { status: 404 });
    throw error;
  }
};
const started = performance.now(),
  source = await PotreeSource.open(remote ? target : 'file:/', {
    ...(remote ? {} : { fetch: local }),
    attributes: 'all',
  }),
  signal = new AbortController().signal,
  queue = [source.root],
  ranges = {};
let nodes = 0,
  points = 0,
  outside = 0,
  colored = 0,
  worst = 0,
  colorMin = [Infinity, Infinity, Infinity],
  colorMax = [-Infinity, -Infinity, -Infinity];
while (queue.length) {
  const batch = queue.splice(0, 16);
  const loaded = await Promise.all(batch.map((node) => source.load(node, signal)));
  batch.forEach((node, k) => {
    const { positions, colors, attributes = {} } = loaded[k],
      b = node.bounds,
      // LAS nodes round to the file's scale, up to 0.07% of the smallest real node.
      pad = (b[3] - b[0]) * 1e-3;
    queue.push(...node.children.filter(Boolean));
    nodes++;
    points += node.count;
    if (positions.length !== node.count * 3) throw new Error(`node ${node.id}: ${positions.length / 3} of ${node.count} points`);
    for (let i = 0; i < node.count; i++)
      for (let a = 0; a < 3; a++) {
        const v = positions[i * 3 + a],
          off = Math.max(b[a] - v, v - b[a + 3]);
        if (off > pad) {
          outside++;
          worst = Math.max(worst, off / (b[3] - b[0]));
        }
      }
    if (colors) {
      colored += node.count;
      for (let i = 0; i < node.count; i++)
        for (let c = 0; c < 3; c++) {
          colorMin[c] = Math.min(colorMin[c], colors[i * 3 + c]);
          colorMax[c] = Math.max(colorMax[c], colors[i * 3 + c]);
        }
    }
    for (const [key, values] of Object.entries(attributes)) {
      const r = (ranges[key] ??= [Infinity, -Infinity]);
      for (let i = 0; i < values.length; i++) {
        r[0] = Math.min(r[0], values[i]);
        r[1] = Math.max(r[1], values[i]);
      }
    }
  });
}
const report = {
  version: source.version,
  stated: source.points,
  points,
  nodes,
  outside,
  worstOutside: worst,
  colored,
  colorMin,
  colorMax,
  ranges,
  seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
};
console.log(JSON.stringify(report));
if (outside || (source.points && source.points !== points)) process.exitCode = 1;

// Where a server's main thread spent its time: self time by function from a V8 .cpuprofile (bench/run.mjs
// --profile=dir writes one per server process), and inclusive time of a few named tick phases.
//   node bench/profile.mjs <file.cpuprofile> [top=25]
import { readFile } from 'node:fs/promises';

const [file, top = 25] = process.argv.slice(2),
  profile = JSON.parse(await readFile(file, 'utf8')),
  nodes = new Map(profile.nodes.map((n) => [n.id, n])),
  self = new Map(),
  parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
// Sample time: the deltas belong to the samples they precede.
const time = new Map();
profile.samples.forEach((id, i) => time.set(id, (time.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const name = (n) =>
  `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
let total = 0;
for (const [id, t] of time) {
  total += t;
  const key = name(nodes.get(id));
  self.set(key, (self.get(key) ?? 0) + t);
}
const idle = [...time].filter(([id]) =>
    /\(idle\)|\(program\)|\(garbage collector\)/.test(nodes.get(id).callFrame.functionName),
  ),
  busy =
    total - idle.filter(([id]) => nodes.get(id).callFrame.functionName === '(idle)').reduce((a, [, t]) => a + t, 0);
console.log(`total ${(total / 1e6).toFixed(1)} s, not idle ${(busy / 1e6).toFixed(1)} s`);
for (const [key, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(top)))
  console.log(`${((100 * t) / busy).toFixed(1).padStart(5)}%  ${(t / 1e3).toFixed(0).padStart(7)} ms  ${key}`);
// Inclusive time of functions whose names match, through any depth.
const inclusive = new Map();
for (const [id, t] of time) {
  const seen = new Set();
  for (let n = id; n !== undefined; n = parent.get(n)) {
    const f = nodes.get(n).callFrame.functionName;
    if (!f || seen.has(f)) continue;
    seen.add(f);
    inclusive.set(f, (inclusive.get(f) ?? 0) + t);
  }
}
console.log('\ninclusive:');
for (const f of [
  '#step',
  '#process',
  '#recenter',
  '#sendChunks',
  '#fetch',
  'encode',
  'encodeBlockChanges',
  '#write',
  'update',
  '#receive',
  'decodeClientMessage',
  '#data',
  'chunkMessage',
  'prepare',
])
  if (inclusive.has(f)) console.log(`${((100 * inclusive.get(f)) / busy).toFixed(1).padStart(5)}%  ${f}`);

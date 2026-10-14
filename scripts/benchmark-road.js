import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {cpus} from 'node:os';
import {build} from 'vite';
import {Spline} from '../packages/splines/dist/index.js';

// Build Road first; --direct-writes recreates the rejected allocation experiment without mutating the package.
const baselineRef = process.argv[2];
if (!baselineRef) throw new Error('Usage: node scripts/benchmark-road.js <baseline Git ref> [--direct-writes]');
const temporaryDirectWrites = process.argv.includes('--direct-writes');
const root = resolve('packages/road'), sourcePath = 'packages/road/src/index.ts', baselineSource = execFileSync('git',['show',`${baselineRef}:${sourcePath}`],{encoding: 'utf8'}).replace(/\r\n/g,'\n');
const arrayWrites = `        const index = sample * row + strip * 2 + side, p = section[strip + side];
        positions.set([center[0] + rx * p[0], center[1] + p[1], center[2] + rz * p[0]], index * 3);
        normals.set([nx / normalLength, ny / normalLength, nz / normalLength], index * 3); uvs.set([offsets[strip + side] / uvMeters, distance / uvMeters], index * 2);`;
const directWrites = `        const index = sample * row + strip * 2 + side, p = section[strip + side], v = index * 3, uv = index * 2;
        positions[v] = center[0] + rx * p[0]; positions[v + 1] = center[1] + p[1]; positions[v + 2] = center[2] + rz * p[0];
        normals[v] = nx / normalLength; normals[v + 1] = ny / normalLength; normals[v + 2] = nz / normalLength;
        uvs[uv] = offsets[strip + side] / uvMeters; uvs[uv + 1] = distance / uvMeters;`;
if (temporaryDirectWrites) assert.ok(baselineSource.includes(arrayWrites),'Choose the original Road source as the explicit baseline ref');
const experimentSource = temporaryDirectWrites ? baselineSource.replace(arrayWrites,directWrites) : undefined;
const manifest = JSON.parse(await readFile(resolve(root,'package.json'),'utf8')), peers = Object.keys({...manifest.dependencies,...manifest.peerDependencies});
async function bundle(baseline) {
  const replacement = baseline ? baselineSource : experimentSource;
  const result = await build({root,configFile: false,publicDir: false,logLevel: 'silent',plugins: replacement ? [{name: 'road-measurement-source',enforce: 'pre',transform(code,id) {if (id.replaceAll('\\','/').endsWith('/packages/road/src/index.ts')) return replacement;}}] : [],
    build: {write: false,target: 'es2022',lib: {entry: resolve(root,'src/index.ts'),formats: ['es'],fileName: 'index'},rollupOptions: {external: id => peers.some(peer => id === peer || id.startsWith(peer+'/'))}}});
  return (Array.isArray(result) ? result : [result]).flatMap(output => output.output).filter(output => output.type === 'chunk').map(output => output.code).join('\n');
}
const baselineCode = await bundle(true), candidateCode = await bundle(false);
if (!temporaryDirectWrites) assert.equal(candidateCode,await readFile(resolve(root,'dist/index.js'),'utf8'),'Rebuild Road before benchmarking');
const load = async code => (await import(`data:text/javascript;base64,${Buffer.from(code.replace(/from\s+(['"])@margoengine\/core\1/g,(_,quote) => `from ${quote}${pathToFileURL(resolve('packages/core/dist/index.js')).href}${quote}`)).toString('base64')}`)).road;
const original = await load(baselineCode), candidate = await load(candidateCode);
const straight = new Spline([[0,0,0],[3,4,20]]), curved = new Spline([[-2,0,-8],[2,0.2,-3],[-2,0.3,3],[2,0,8]],{divisions: 256});
const custom = Array.from({length: 32},(_,i) => [-3+i*0.2,0.2*Math.sin(i*0.7)]);
const cases = [
  {name: 'visible demo16',curve: curved,options: {segments: 16,width: 2.4,curbWidth: 0.3,curbHeight: 0.35,uvMeters: 2},batch: 128},
  {name: 'default128',curve: curved,options: {},batch: 32},
  {name: 'wide profile256',curve: straight,options: {segments: 256,crossSection: custom,uvMeters: 3.7},batch: 8},
  {name: 'large1024',curve: curved,options: {segments: 1024},batch: 4},
  {name: 'maximum4096',curve: straight,options: {segments: 4096},batch: 1},
  {name: 'minimum1',curve: straight,options: {segments: 1,crossSection: [[-1,0],[1,0]]},batch: 256}
];
const bytes = value => new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
function allocations(fn,work) {
  const prototype = Float32Array.prototype, previous = Object.getOwnPropertyDescriptor(prototype,'set'), set = prototype.set; let literalSets = 0;
  Object.defineProperty(prototype,'set',{configurable: true,writable: true,value(source,offset) {if (Array.isArray(source)) literalSets++; return set.call(this,source,offset);}});
  try {fn(work.curve,work.options);} finally {if (previous) Object.defineProperty(prototype,'set',previous); else delete prototype.set;}
  return literalSets;
}
let sink = 0;
function batch(fn,work) {
  const start = performance.now();
  for (let i = 0; i < work.batch; i++) {const result = fn(work.curve,work.options); sink += result.geometry.bounds[3]+result.uvs.at(-1)+result.geometry.indices.at(-1);}
  return performance.now()-start;
}
const median = values => {const sorted = values.slice().sort((a,b) => a-b), middle = sorted.length/2; return (sorted[middle-1]+sorted[middle])/2;};
const reports = [];
for (const work of cases) {
  const before = original(work.curve,work.options), after = candidate(work.curve,work.options);
  for (const key of ['vertices','indices','bounds']) assert.deepEqual(bytes(after.geometry[key]),bytes(before.geometry[key]),`${work.name}: ${key} changed`);
  assert.deepEqual(bytes(after.uvs),bytes(before.uvs),`${work.name}: UVs changed`); assert.deepEqual(after.section,before.section,`${work.name}: section changed`);
  const originalArrayLiteralSets = allocations(original,work), candidateArrayLiteralSets = allocations(candidate,work);
  for (let i = 0; i < 8; i++) {batch(original,work); batch(candidate,work);}
  const pairs = [];
  for (let i = 0; i < 12; i++) {
    const order = i%2 ? [candidate,original,original,candidate] : [original,candidate,candidate,original], samples = order.map(fn => ({fn,milliseconds: batch(fn,work)}));
    const a = samples.filter(sample => sample.fn === original).reduce((sum,sample) => sum+sample.milliseconds,0)/2, b = samples.filter(sample => sample.fn === candidate).reduce((sum,sample) => sum+sample.milliseconds,0)/2;
    pairs.push({order: i%2 ? 'BAAB' : 'ABBA',originalMs: a,candidateMs: b,ratio: a/b,samples: samples.map(sample => sample.milliseconds)});
  }
  reports.push({name: work.name,roadsPerBatch: work.batch,vertices: before.geometry.vertices.length/6,triangles: before.geometry.indices.length/3,outputsByteExact: true,originalArrayLiteralSets,candidateArrayLiteralSets,
    originalMedianMs: median(pairs.map(pair => pair.originalMs)),candidateMedianMs: median(pairs.map(pair => pair.candidateMs)),
    originalRoadMedianMs: median(pairs.map(pair => pair.originalMs))/work.batch,candidateRoadMedianMs: median(pairs.map(pair => pair.candidateMs))/work.batch,
    medianRatio: median(pairs.map(pair => pair.ratio)),wins: pairs.filter(pair => pair.candidateMs < pair.originalMs).length,pairs});
}
const size = code => ({raw: Buffer.byteLength(code),gzip: gzipSync(code).length}), baselineSize = size(baselineCode), candidateSize = size(candidateCode);
const report = {baselineRef,candidate: temporaryDirectWrites ? 'isolated direct-write experiment; production package unchanged' : 'built production package',nodeVersion: process.version,platform: process.platform,architecture: process.arch,cpu: cpus()[0]?.model,measurement: 'CPU-only Node paired ABBA/BAAB; no GPU, browser FPS or hosted startup claim',reports,baselineSize,candidateSize,
  delta: {raw: candidateSize.raw-baselineSize.raw,gzip: candidateSize.gzip-baselineSize.gzip},sink};
await mkdir('test-results',{recursive: true}); await writeFile('test-results/road-generation-benchmark.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,reports: reports.map(({pairs,...summary}) => summary)}));

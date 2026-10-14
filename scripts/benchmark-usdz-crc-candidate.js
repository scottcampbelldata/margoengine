import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {parseOFF, parseUSDZ} from '../packages/loaders/dist/index.js';
import {displayGeometry, geometryData} from '../examples/package-benchmarks/asset-scene.js';
import {usdzCRCSources, importUSDZCRCSource} from './support/usdz-crc-candidate.js';
import {serializerNumberSources} from './support/serializer-number-candidate.js';

const iterations = Number(process.env.USDZ_CANDIDATE_ITERATIONS ?? 32);
assert.ok(Number.isSafeInteger(iterations) && iterations >= 8 && iterations <= 512);
const variant=process.env.USDZ_CANDIDATE_VARIANT??'crc';
const sceneSources=process.env.USDZ_CANDIDATE_NUM==='1'?await serializerNumberSources():undefined;
const sources = await usdzCRCSources(variant), implementations = {A: await importUSDZCRCSource(sources.original,sceneSources?.original), B: await importUSDZCRCSource(sources.candidate,sceneSources?.candidate)};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {recordedAt: new Date().toISOString(), iterations, productionChanged: false, variant:variant+(sceneSources?'-num':''),
  interpretation: 'Private actual USDZ serializer CPU/size comparison. No format, asset, scene-validation, output-byte, Core or renderer changes. Parse checks use the actual loader. CPU-only evidence does not establish app FPS/startup.',
  sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)])), correctness: [], runs: [], errors: []};
if(sceneSources)report.sceneSourceHashes=Object.fromEntries(Object.entries(sceneSources).map(([name,source])=>[name,sha(source)]));
await mkdir('test-results', {recursive: true});
const save = () => writeFile(`test-results/usdz-${report.variant}-private-candidate.json`, JSON.stringify(report, null, 2) + '\n');
try {
  assert.equal(implementations.A.crc32(new TextEncoder().encode('123456789')), 0xcbf43926); assert.equal(implementations.B.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(implementations.A.crc32(new Uint8Array()), 0); assert.equal(implementations.B.crc32(new Uint8Array()), 0);
  let seed = 45637;
  for (const length of [1, 2, 7, 31, 64, 129, 1024, 16384, 65535]) {
    const data = Uint8Array.from({length}, () => {seed = Math.imul(seed, 1664525) + 1013904223 | 0; return seed >>> 24;});
    assert.equal(implementations.B.crc32(data), implementations.A.crc32(data)); report.correctness.push({kind: 'crc', length, crc: implementations.A.crc32(data)});
  }
  const bytes = new Uint8Array(await readFile('packages/loaders/tests/fixtures/decimated-knight.off')), geometry = geometryData(displayGeometry(parseOFF(bytes)));
  const material = {color: [0.3, 0.6, 0.45, 1], roughness: 0.65, doubleSided: true}, defaultScene = {nodes: [{name: 'Fixture knight', geometry, material}]};
  const scenes = [defaultScene, {nodes: [{name: 'Parent "name"\nUnicode Ω', translation: [1.3, -0.2, 0.7], children: [
    {name: 'Mirrored mesh', geometry, material, scale: [-1, 2, 0.5], rotation: [0.2, -0.1, 0.3, 0.9]},
    {name: 'Blend mesh', geometry, material: {...material, alphaMode: 'BLEND', color: [0.25, 0.6, 0.9, 0.4], emissive: [0.3, 0.2, 0.1], metalness: 0.3}, translation: [0.1, 1.7, 0.3]}
  ]}]}, {nodes: [{geometry, visible: false}, {geometry, scale: [0.3, 0.3, 0.3]}]}];
  let crcPayload;
  for (const [index, scene] of scenes.entries()) {
    const a = implementations.A.exportUSDZ(scene), b = implementations.B.exportUSDZ(scene); assert.deepEqual(b, a);
    const original = await parseUSDZ(a), candidate = await parseUSDZ(b); assert.deepEqual(candidate, original);
    const header = new DataView(a.buffer, a.byteOffset, a.byteLength), start = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    assert.equal(start % 64, 0); crcPayload ??= a.subarray(start, start + header.getUint32(18, true));
    report.correctness.push({kind: 'archive-parse', scene: index, bytes: a.length, sha256: sha(a), vertices: original.positions.length / 3, triangles: original.indices.length / 3});
    if(process.env.USDZ_CANDIDATE_PYTHON) {
      const paths=[`test-results/usdz-${variant}-scene-${index}-original.usdz`,`test-results/usdz-${variant}-scene-${index}-candidate.usdz`];
      await writeFile(paths[0],a);await writeFile(paths[1],b);
      const checked=spawnSync(process.env.USDZ_CANDIDATE_PYTHON,['scripts/verify-usdz-archives.py',...paths],{encoding:'utf8'});
      assert.equal(checked.status,0,checked.error?.message??checked.stderr);
      const archives=JSON.parse(checked.stdout);assert.equal(archives.length,2);assert.equal(archives[0].contentSHA256,archives[1].contentSHA256);
      report.correctness.push({kind:'independent-python-zip',scene:index,archives});
    }
  }
  const outcome = operation => {try {operation(); return null;} catch (error) {return {type: error.constructor.name, message: error.message};}};
  for (const scene of [{nodes: []}, {nodes: [{geometry, material: {...material, alphaMode: 'MASK'}}]}, {nodes: [{geometry: {...geometry, positions: new Float32Array([NaN])}}]}]) {
    const expected = outcome(() => implementations.A.exportUSDZ(scene)); assert.ok(expected); assert.deepEqual(outcome(() => implementations.B.exportUSDZ(scene)), expected);
    report.correctness.push({kind: 'error-parity', ...expected});
  }
  for (const name of ['A', 'B']) for (let i = 0; i < 12; i++) implementations[name].exportUSDZ(defaultScene);
  for (const name of ['A', 'B', 'B', 'A', 'B', 'A', 'A', 'B']) {
    let started = performance.now(); for (let i = 0; i < iterations; i++) implementations[name].exportUSDZ(defaultScene); const serializerMilliseconds = performance.now() - started;
    started = performance.now(); for (let i = 0; i < iterations; i++) implementations[name].crc32(crcPayload); const crcMilliseconds = performance.now() - started;
    report.runs.push({implementation: name, serializerMilliseconds, crcMilliseconds, millisecondsPerExport: serializerMilliseconds / iterations, crcMillisecondsPerPayload: crcMilliseconds / iterations});
  }
  const median = (name, key) => report.runs.filter(run => run.implementation === name).map(run => run[key]).sort((a, b) => a - b).slice(1, 3).reduce((sum, value) => sum + value, 0) / 2;
  report.medians = {A: {export: median('A', 'millisecondsPerExport'), crc: median('A', 'crcMillisecondsPerPayload')}, B: {export: median('B', 'millisecondsPerExport'), crc: median('B', 'crcMillisecondsPerPayload')}};
  report.speedRatio = {export: report.medians.A.export / report.medians.B.export, crc: report.medians.A.crc / report.medians.B.crc};
  if (process.env.USDZ_CANDIDATE_SIZE === '1') {
    const {build} = await import('vite'), {compactOutput} = await import('./measure-size.js'); report.bundles = {};
    for (const [name, source] of Object.entries(sources)) for (const package_ of ['exporters', 'usdz-export']) {
      const output = await build({configFile: false, publicDir: false, logLevel: 'silent',
        resolve: {alias: {'@margoengine/exporters/usdz': resolve('packages/exporters/src/usdz.ts')}},
        plugins: [{name: 'private-crc32-source', enforce: 'pre', transform(_code, id) {
          const normalized=id.replaceAll('\\','/');
          if(normalized===resolve('packages/exporters/src/usdz.ts').replaceAll('\\','/'))return {code:source,map:null};
          if(sceneSources&&normalized===resolve('packages/exporters/src/scene.ts').replaceAll('\\','/'))return {code:sceneSources[name],map:null};
        }}],
        build: {write: false, target: 'es2022', lib: {entry: `packages/${package_}/src/index.ts`, formats: ['es']},
          rollupOptions: {external: ['@margoengine/core', '@margoengine/core/extension'], output: compactOutput}}});
      const code = (Array.isArray(output) ? output[0] : output).output.filter(chunk => chunk.type === 'chunk').map(chunk => chunk.code).join('\n');
      (report.bundles[package_] ??= {})[name] = {raw: Buffer.byteLength(code), gzip: gzipSync(code).length, sha256: sha(code)};
    }
    for (const package_ of Object.keys(report.bundles)) {const pair = report.bundles[package_]; pair.delta = {raw: pair.candidate.raw - pair.original.raw, gzip: pair.candidate.gzip - pair.original.gzip};}
  }
  report.completedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({correctness: report.correctness.length, speedRatio: report.speedRatio, medians: report.medians, bundles: report.bundles, productionChanged: false}));
} catch (error) {report.errors.push(error.stack); await save(); throw error;}

import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {usdzCRCSources,importUSDZCRCSource} from './support/usdz-crc-candidate.js';

// Explicitly run only after the CPU slot is granted. Uses the packages' published build configurations.
const repository=resolve('.');
for(const package_ of ['exporters','usdz-export']){
  const dist=resolve(repository,'packages',package_,'dist'),inside=relative(repository,dist);
  assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Build output escaped the intended repository');
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozenPaths=['packages/core/dist/index.js','packages/margoengine/dist/index.js'];
const frozen=async()=>Object.fromEntries(await Promise.all(frozenPaths.map(async path=>[path,sha(await readFile(path))])));
const before=await frozen(),sources=await usdzCRCSources();
assert.equal((await readFile('packages/exporters/src/usdz.ts','utf8')).replace(/\r\n/g,'\n'),sources.candidate,'Production has not adopted exactly the proven branchless CRC substitution');
execFileSync(process.execPath,[resolve('packages/exporters/scripts/build.js')],{cwd:repository,stdio:'inherit'});
execFileSync(process.execPath,[resolve('scripts/build-optional.js'),'usdz-export'],{cwd:repository,stdio:'inherit'});
assert.deepEqual(await frozen(),before,'Core or stage published output changed during the targeted build');
const dist=await readFile('packages/exporters/dist/usdz.js','utf8');
assert.match(dist,/crc = \(crc >>> 1\) \^ \(-\(crc & 1\) & 0xedb88320\)/,'Published USDZ module does not contain the retained CRC arithmetic');
const baseline=await importUSDZCRCSource(sources.original),exporters=await import(pathToFileURL(resolve('packages/exporters/dist/index.js')).href),facade=await import(pathToFileURL(resolve('packages/usdz-export/dist/index.js')).href);
const geometry={positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2])};
const scene={nodes:[{name:'Published entry proof Ω',geometry,scale:[-1,0.5,2],translation:[0.1,-0.4,0.7]}]},expected=baseline.exportUSDZ(scene);
const report={recordedAt:new Date().toISOString(),baselineGit:'5fc55a0',builds:['packages/exporters/scripts/build.js','scripts/build-optional.js usdz-export'],
  frozenHashes:before,sourceSHA256:sha(await readFile('packages/exporters/src/usdz.ts')),entryHashes:{},checks:[]};
await mkdir('test-results',{recursive:true});
for(const [name,implementation]of [['exporters',exporters],['usdz-export',facade]]){
  const actual=implementation.exportUSDZ(scene);assert.deepEqual(actual,expected);
  assert.notEqual(implementation.exportUSDZ(scene).buffer,actual.buffer);
  const path=`test-results/usdz-published-${name}-proof.usdz`;await writeFile(path,actual);
  report.checks.push({entry:name,archiveBytes:actual.length,archiveSHA256:sha(actual),exactBaselineBytes:true,freshOutput:true});
  if(process.env.USDZ_CANDIDATE_PYTHON){
    const proof=spawnSync(process.env.USDZ_CANDIDATE_PYTHON,['scripts/verify-usdz-archives.py',path],{encoding:'utf8'});
    assert.equal(proof.status,0,proof.error?.message??proof.stderr);report.checks.push({entry:name,independentPythonZip:JSON.parse(proof.stdout)[0]});
  }
}
for(const path of ['packages/exporters/dist/index.js','packages/exporters/dist/usdz.js','packages/exporters/dist/usdz.d.ts','packages/usdz-export/dist/index.js','packages/usdz-export/dist/index.d.ts'])report.entryHashes[path]=sha(await readFile(path));
report.completedAt=new Date().toISOString();await writeFile('test-results/usdz-production-build-verification.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));

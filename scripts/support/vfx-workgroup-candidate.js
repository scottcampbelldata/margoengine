import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const replace=(source,before,after)=>{assert.equal(source.split(before).length,2,`Expected one VFX source anchor: ${before}`);return source.replace(before,after);};
const sha=text=>createHash('sha256').update(text).digest('hex');

/** Private WGSL only: per-particle simulation arithmetic is preserved verbatim. */
export async function vfxWorkgroupCandidate(){
  const originalSource=(await readFile('packages/vfx/src/shader.ts','utf8')).replace(/\r\n/g,'\n');
  const originalIndexSource=(await readFile('packages/vfx/src/index.ts','utf8')).replace(/\r\n/g,'\n');
  const {simulationShader:originalShader,billboardShader}=await import('data:text/javascript;base64,'+Buffer.from(originalSource).toString('base64'));
  const main='@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){';
  const compact='  let instance=atomicAdd(&indirect.instanceCount,1u);alive[instance]=id.x;\n}';
  assert.equal(originalShader.split('return;').length,4,'Simulation early-return paths changed');
  let candidateShader=replace(originalShader,main,'fn simulateParticle(id:vec3u)->bool {');
  candidateShader=candidateShader.replaceAll('return;','return false;');
  candidateShader=replace(candidateShader,compact,'  return true;\n}');
  candidateShader+=`
var<workgroup> groupCount:atomic<u32>;
var<workgroup> groupBase:u32;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32){
  if(lane==0u){atomicStore(&groupCount,0u);}
  workgroupBarrier();
  let live=simulateParticle(id);var ticket=0u;
  if(live){ticket=atomicAdd(&groupCount,1u);}
  workgroupBarrier();
  if(lane==0u){groupBase=atomicAdd(&indirect.instanceCount,atomicLoad(&groupCount));}
  workgroupBarrier();
  if(live){alive[groupBase+ticket]=id.x;}
}`;
  // Reverse only the necessary helper/control changes to prove unchanged simulation tokens.
  const helper=candidateShader.slice(0,candidateShader.indexOf('\nvar<workgroup>'));
  const reconstructed=helper.replace('fn simulateParticle(id:vec3u)->bool {',main).replaceAll('return false;','return;').replace('  return true;\n}',compact);
  assert.equal(reconstructed,originalShader,'Simulation arithmetic or respawn body changed');
  const candidateIndexSource=replace(originalIndexSource,'pass.dispatchWorkgroups(Math.ceil(this.capacity/256));','pass.dispatchWorkgroups(Math.ceil(this.capacity/64));');
  const fields='struct Particle {positionLife:vec4f,velocitySize:vec4f,color:vec4f,rotation:vec4f}';
  assert.ok(candidateShader.includes(fields));assert.equal(candidateShader.split('workgroupBarrier();').length,4);
  return {originalSource,originalIndexSource,candidateIndexSource,originalShader,candidateShader,billboardShader,
    report:{preparedAt:new Date().toISOString(),productionEdited:false,gpuExecuted:false,shaderCompiled:false,packageBuilt:false,
      originalWorkgroup:256,candidateWorkgroup:64,particleABIBytes:64,workgroupScratchBytes:8,extraGPUBufferBytes:0,
      capacityLimit:1000000,globalLiveReservations:{originalMaximum:1000000,candidateMaximum:15625},
      sourceHashes:{shader:sha(originalSource),index:sha(originalIndexSource)},shaderHashes:{original:sha(originalShader),candidate:sha(candidateShader)},
      shaderOnlyBytes:{original:{raw:Buffer.byteLength(originalShader),gzip:gzipSync(originalShader).length},candidate:{raw:Buffer.byteLength(candidateShader),gzip:gzipSync(candidateShader).length}},
      simulationBodyReconstructionExact:true,billboardChanged:false,
      limitations:['Shader-only gzip is not the package or consumer byte gate.','Global respawn ticket and random-seed assignment is scheduling-dependent; workgroup width changes can alter state during respawn.','Grouped live-ID reservation changes ordering; alpha-blended output cannot be declared exact from occupancy or canonical-order images.','All barriers are unconditional in main, including padded final-group invocations; helper early returns never bypass them.']}};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const prepared=await vfxWorkgroupCandidate();await mkdir('test-results',{recursive:true});
  await writeFile('test-results/vfx-workgroup64-original.wgsl',prepared.originalShader);
  await writeFile('test-results/vfx-workgroup64-candidate.wgsl',prepared.candidateShader);
  await writeFile('test-results/vfx-workgroup64-index-candidate.ts',prepared.candidateIndexSource);
  const delta={raw:prepared.report.shaderOnlyBytes.candidate.raw-prepared.report.shaderOnlyBytes.original.raw,gzip:prepared.report.shaderOnlyBytes.candidate.gzip-prepared.report.shaderOnlyBytes.original.gzip};
  prepared.report.shaderOnlyBytes.delta=delta;
  await writeFile('test-results/vfx-workgroup64-preparation.json',JSON.stringify(prepared.report,null,2)+'\n');
  console.log(JSON.stringify(prepared.report));
}

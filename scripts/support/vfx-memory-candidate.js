import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const replace = (source, before, after) => {
  assert.ok(source.includes(before), `Missing source anchor: ${before.slice(0, 100)}`);
  return source.replace(before, after);
};
export async function prepareSources(baselineRef) {
  if (!baselineRef) throw new Error('Pass the explicit Git ref before the VFX memory change');
  const originalIndex = execFileSync('git', ['show', `${baselineRef}:packages/vfx/src/index.ts`], {
    encoding: 'utf8',
  }).replace(/\r\n/g, '\n');
  const originalShaderSource = execFileSync('git', ['show', `${baselineRef}:packages/vfx/src/shader.ts`], {
    encoding: 'utf8',
  }).replace(/\r\n/g, '\n');
  const { simulationShader, billboardShader } = await import(
    `data:text/javascript;base64,${Buffer.from(originalShaderSource).toString('base64')}`
  );
  let index = originalIndex;
  index = replace(index, 'private states:GPUBuffer[]=[];', 'private particles?:GPUBuffer;');
  index = replace(index, 'private computeGroups:GPUBindGroup[]=[];', 'private computeGroup?:GPUBindGroup;');
  index = replace(index, 'new Map<GPURenderPipeline,GPUBindGroup[]>()', 'new Map<GPURenderPipeline,GPUBindGroup>()');
  index = replace(index, 'private front=0;', '');
  index = replace(
    index,
    'for(let i=0;i<2;i++)this.states.push(buffer(this.capacity*64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC));',
    'this.particles=buffer(this.capacity*64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);',
  );
  index = replace(
    index,
    'this.computeGroups=[0,1].map(i=>this.device!.createBindGroup({layout:this.simulation!.getBindGroupLayout(0),entries:[this.uniform!,this.states[i],this.states[1-i],this.alive!,this.indirect!,this.respawn!].map((buffer,binding)=>({binding,resource:{buffer}}))}));this.front=0;',
    'this.computeGroup=this.device.createBindGroup({layout:this.simulation.getBindGroupLayout(0),entries:[this.uniform!,this.particles!,this.alive!,this.indirect!,this.respawn!].map((buffer,binding)=>({binding:binding<2?binding:binding+1,resource:{buffer}}))});',
  );
  index = replace(
    index,
    'pass.setBindGroup(0,this.computeGroups[this.front]);',
    'pass.setBindGroup(0,this.computeGroup!);',
  );
  index = replace(index, 'this.front=1-this.front;', '');
  index = replace(
    index,
    'let groups=this.renderGroups.get(pipeline);if(!groups){groups=[0,1].map(i=>c.device.createBindGroup({layout:pipeline!.getBindGroupLayout(0),entries:[this.uniform!,this.states[i],this.alive!].map((buffer,binding)=>({binding,resource:{buffer}}))}));this.renderGroups.set(pipeline,groups);}const group=groups[this.front];',
    'let group=this.renderGroups.get(pipeline);if(!group){group=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[this.uniform!,this.particles!,this.alive!].map((buffer,binding)=>({binding,resource:{buffer}}))});this.renderGroups.set(pipeline,group);}',
  );
  index = replace(
    index,
    "if(!this.indirect||!this.states.length)throw new Error('VFX is not attached');return {particles:this.states[this.front],indirect:this.indirect};",
    "if(!this.indirect||!this.particles)throw new Error('VFX is not attached');return {particles:this.particles,indirect:this.indirect};",
  );
  index = replace(
    index,
    '[this.uniform,...this.states,this.alive,this.indirect,this.respawn,this.index]',
    '[this.uniform,this.particles,this.alive,this.indirect,this.respawn,this.index]',
  );
  index = replace(
    index,
    'this.uniform=this.alive=this.indirect=this.respawn=this.index=undefined;this.states=[];this.computeGroups=[];',
    'this.uniform=this.particles=this.alive=this.indirect=this.respawn=this.index=undefined;this.computeGroup=undefined;',
  );
  assert.ok(!index.includes('this.states') && !index.includes('this.front') && !index.includes('computeGroups'));
  const declarations =
    '@group(0) @binding(1) var<storage,read> source:array<Particle>;\n@group(0) @binding(2) var<storage,read_write> destination:array<Particle>;';
  const single = '@group(0) @binding(1) var<storage,read_write> particles:array<Particle>;';
  const fullShader = replace(simulationShader, declarations, single)
    .replaceAll('source[id.x]', 'particles[id.x]')
    .replaceAll('destination[id.x]', 'particles[id.x]');
  let partialShader = replace(
    fullShader,
    'var p=particles[id.x];let dt=f.gravityDelta.w;',
    'var p=particles[id.x];var born=false;let dt=f.gravityDelta.w;',
  );
  partialShader = replace(
    partialShader,
    'if(ticket>=f.control.y){p.positionLife.w=0;particles[id.x]=p;return;}',
    'if(ticket>=f.control.y){particles[id.x].positionLife.w=0;return;}',
  );
  partialShader = replace(
    partialShader,
    'let seed=hash(atomicAdd(&respawn.sequence,1u)+id.x);',
    'born=true;let seed=hash(atomicAdd(&respawn.sequence,1u)+id.x);',
  );
  partialShader = replace(
    partialShader,
    'p.rotation.x+=p.rotation.y*dt;particles[id.x]=p;',
    `p.rotation.x+=p.rotation.y*dt;
  if(born){particles[id.x]=p;}else{particles[id.x].positionLife=p.positionLife;particles[id.x].velocitySize=p.velocitySize;particles[id.x].rotation.x=p.rotation.x;}`,
  );
  const sourceBody = originalShaderSource.slice(
    originalShaderSource.indexOf('export const simulationShader'),
    originalShaderSource.indexOf('export const billboardShader'),
  );
  const fullBody = replace(sourceBody, declarations, single)
    .replaceAll('source[id.x]', 'particles[id.x]')
    .replaceAll('destination[id.x]', 'particles[id.x]');
  const partialBody = fullBody
    .replace(
      'var p=particles[id.x];let dt=f.gravityDelta.w;',
      'var p=particles[id.x];var born=false;let dt=f.gravityDelta.w;',
    )
    .replace(
      'if(ticket>=f.control.y){p.positionLife.w=0;particles[id.x]=p;return;}',
      'if(ticket>=f.control.y){particles[id.x].positionLife.w=0;return;}',
    )
    .replace(
      'let seed=hash(atomicAdd(&respawn.sequence,1u)+id.x);',
      'born=true;let seed=hash(atomicAdd(&respawn.sequence,1u)+id.x);',
    )
    .replace(
      'p.rotation.x+=p.rotation.y*dt;particles[id.x]=p;',
      `p.rotation.x+=p.rotation.y*dt;
  if(born){particles[id.x]=p;}else{particles[id.x].positionLife=p.positionLife;particles[id.x].velocitySize=p.velocitySize;particles[id.x].rotation.x=p.rotation.x;}`,
    );
  return {
    originalIndex,
    originalShaderSource,
    index,
    fullShaderSource: originalShaderSource.replace(sourceBody, fullBody),
    partialShaderSource: originalShaderSource.replace(sourceBody, partialBody),
    shaders: [simulationShader, fullShader, partialShader],
    billboardShader,
    rawSource: {
      original: originalIndex.length + originalShaderSource.length,
      full: index.length + originalShaderSource.replace(sourceBody, fullBody).length,
      partial: index.length + originalShaderSource.replace(sourceBody, partialBody).length,
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = await prepareSources(process.argv[2]);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/vfx-inplace-index.ts', source.index);
  await writeFile('test-results/vfx-inplace-full-shader.ts', source.fullShaderSource);
  await writeFile('test-results/vfx-inplace-partial-shader.ts', source.partialShaderSource);
  for (const [i, name] of ['original', 'full', 'partial'].entries())
    await writeFile(`test-results/vfx-${name}.wgsl`, source.shaders[i]);
  console.log(
    JSON.stringify({
      rawSource: source.rawSource,
      particleABI: '16f32/64bytes',
      oneMillionStateBytes: { original: 128000000, candidate: 64000000 },
      productionEdited: false,
    }),
  );
}

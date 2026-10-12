import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {openBrowser} from '../scripts/browser.js';
import {windShader} from '../packages/scatter/src/wind.ts';
import {cloudShader} from '../packages/sky/src/clouds.ts';
import {celestialShader} from '../packages/sky/src/celestial.ts';
import {atmosphere} from '../packages/sky/src/atmosphere.ts';
import {wgsl} from '../packages/core/src/shaders.ts';
import {ScatterInstances} from '../packages/scatter/dist/index.js';
import {PbrMaterial} from '../packages/core/dist/index.js';
import {optionalGPU} from './support/optional-gpu.js';

const fixture=optionalGPU();fixture.context.shader=wgsl;fixture.engine.lighting={direction:new Float32Array([0,0,1,1]),radiance:new Float32Array([1,1,1,0.1])};
const vertices=new Float32Array(60);for(let v=0;v<3;v++){vertices[v*20+3]=1;vertices[v*20+6]=1;vertices.fill(1,v*20+16,v*20+20);}
const fixed=new ScatterInstances(()=>[{name:'occlusion probe',vertices,indices:new Uint32Array([0,1,2]),transforms:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),material:new PbrMaterial()}]);fixture.engine.use(fixed);fixture.engine.frameGraph.execute(fixture.context);
const instanceShader=fixture.pipelines.find(p=>p.fragment).vertex.module.code;fixed.dispose();

const nightWeight=/let nightWeight =[^;]+;/.exec(await readFile(new URL('../packages/creative/src/shaders/planet_surface.wgsl',import.meta.url),'utf8'))[0];

const browser=await openBrowser({startPath:'/tests/modern-game.html',port:5196}),errors=[];
browser.page.on('pageerror',e=>errors.push(e.message));
try {
 const result=await browser.page.evaluate(async({windShader,cloudShader,celestialShader,atmosphere,wgsl,nightWeight,instanceShader})=>{
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),d=await adapter.requestDevice();d.pushErrorScope('validation');
  const probe=async(code,values,count)=>{
   const module=d.createShaderModule({code}),info=await module.getCompilationInfo();
   if(info.messages.some(m=>m.type==='error'))throw new Error(info.messages.map(m=>m.message).join('\n'));
   const pipeline=d.createComputePipeline({layout:'auto',compute:{module,entryPoint:'probe'}});
   const uniform=d.createBuffer({size:values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(uniform,0,values);
   const out=d.createBuffer({size:count*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=d.createBuffer({size:count*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:{buffer:out}}]});
   const encoder=d.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();encoder.copyBufferToBuffer(out,0,read,0,read.size);d.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
   const valuesOut=Array.from(new Float32Array(read.getMappedRange()));read.unmap();uniform.destroy();out.destroy();read.destroy();return valuesOut;
  };
  const wind=await probe(windShader+`
   @group(0) @binding(0) var<uniform> settings:vec4f;
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){
    if(id.x>=8u){return;}let height=select(0.0,4.0,id.x>0u);let time=select(0.0,1.0,id.x==2u);let root=select(vec2f(0),vec2f(11,7),id.x==3u);
    let wind=vec4f(settings.xyz,time);let bend=windBend(height,root,wind);var value=vec4f(bend,1);
    if(id.x==4u){let derivative=(windBend(4.001,vec2f(0),vec4f(settings.xyz,1)).xy-windBend(3.999,vec2f(0),vec4f(settings.xyz,1)).xy)/0.002;value=vec4f(derivative,0,1);}
    if(id.x==5u){let b=windBend(4.0,vec2f(0),vec4f(settings.xyz,1));let n=windNormal(vec3f(1,0,0),b,vec4f(settings.xyz,1));value=vec4f(n,1);}
    if(id.x==6u){value=vec4f(windBend(4.0,vec2f(0),vec4f(0,0,0,1)),1);}
    if(id.x==7u){value=vec4f(windBend(4.0,vec2f(0),vec4f(settings.xyz,1)),1);}
    result[id.x]=value;
   }`,new Float32Array([1,0.35,0.1,0]),8);
  const detail=await probe(windShader+`
   @group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   fn displaced(p:vec3f)->vec3f{let b=windDeformation(p,vec3f(0),settings,1.0);return p+vec3f(b.offset.x,0,b.offset.y);}
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=8u){return;}let p=vec3f(1,4,2);var b=windDeformation(p,vec3f(0),settings,1.0);var value=vec4f(b.offset,b.gradient.y,1);
    if(id.x==0u){b=windDeformation(vec3f(0),vec3f(0),settings,1.0);value=vec4f(b.offset,b.gradient.y,1);}
    if(id.x==2u){b=windDeformation(p,vec3f(0),settings,0.0);value=vec4f(b.offset,b.gradient.y,1);}
    if(id.x==3u){value=vec4f(windDetailNormal(vec3f(1,0,0),b,settings),1);}
    if(id.x==4u){value=vec4f((displaced(p+vec3f(0,0.001,0))-displaced(p-vec3f(0,0.001,0)))/0.002,1);}
    if(id.x==5u){value=vec4f((displaced(p+vec3f(0,0,0.001))-displaced(p-vec3f(0,0,0.001)))/0.002,1);}
    if(id.x==6u){b=windDeformation(p,vec3f(0),vec4f(0,0,0,settings.w),1.0);value=vec4f(b.offset,b.gradient.y,1);}
    if(id.x==7u){value=vec4f(b.gradient,1);}
    result[id.x]=value;}`,new Float32Array([1,0.35,0.1,1]),8);
  const bounds=await probe(windShader+`
   @group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=256u){return;}let angle=f32(id.x)*2.399963;let r=f32(id.x%16u)*0.3;let h=f32(id.x%9u);let wind=vec4f(settings.xyz,f32(id.x)*0.31);let b=windDeformation(vec3f(sin(angle)*r,h,cos(angle)*r),vec3f(0),wind,1.0);let direction=vec3f(wind.x,0,wind.y)/length(wind.xy);result[id.x]=vec4f(length(b.offset),h,1.0+dot(b.gradient,direction),1);}`,new Float32Array([1,0.35,1,0]),256);
  const instanceLighting=instanceShader.replace('@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f','fn lighting(i:Output,front:bool)->vec4f').replace('discard;','return vec4f(0);');
  const aoCode=instanceLighting+`@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=2u){return;}var i:Output;i.position=vec3f(0);i.normal=vec3f(0,0,1);i.color=vec3f(0.5);i.material=vec4f(0.8,0,1,1);i.occlusion=f32(id.x);result[id.x]=lighting(i,true);}`;
  const aoFrame=new Float32Array(32);aoFrame.set([0,0,1,0],16);aoFrame.set([0,0,1,1],20);aoFrame.set([1,1,1,0],24);
  const directAO=await probe(aoCode,aoFrame,2);aoFrame.set([0,0,0,0.2],24);const ambientAO=await probe(aoCode,aoFrame,2);
  const skyFrame=new Float32Array(40);skyFrame.set([0,0,0,0.01],16);skyFrame.set([0,1,0,0],20);skyFrame.set([0.25,0.45,0.75,0],32);skyFrame.set([0.45,0,1500,0],36);
  const skyCode=atmosphere+cloudShader+`
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=128u){return;}let angle=f32(id.x)*0.1;let ray=normalize(vec3f(cos(angle),0.3+f32(id.x%8u)*0.08,sin(angle)));result[id.x]=vec4f(cloudSky(vec3f(0.1,0.2,0.4),ray,0.001),1);}`;
  const clouds=await probe(skyCode,skyFrame,128);skyFrame[37]=80;const moved=await probe(skyCode,skyFrame,128);skyFrame[23]=1;const night=await probe(skyCode,skyFrame,128);skyFrame[36]=0;const clear=await probe(skyCode,skyFrame,128);
  skyFrame[36]=1;
  const horizon=await probe(atmosphere+cloudShader+`
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=128u){return;}let angle=f32(id.x)*0.1;let y=-0.05+f32(id.x%8u)*0.014;let ray=vec3f(cos(angle)*sqrt(1.0-y*y),y,sin(angle)*sqrt(1.0-y*y));result[id.x]=vec4f(cloudSky(vec3f(0.1,0.2,0.4),ray,0.001),1);}`,skyFrame,128);
  skyFrame[17]=2000;const aboveLayer=await probe(skyCode,skyFrame,128);
  const bodyCode=celestialShader+`
   @group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=8u){return;}let angle=array<f32,8>(0.0,0.01,0.014,0.016,0.018,0.04,0.1,3.14159265)[id.x];let ray=vec3f(sin(angle),cos(angle),0);let direction=vec3f(0,1,0);result[id.x]=vec4f(celestialProfile(ray,direction,SUN_RADIUS,settings.x),celestialProfile(ray,direction,MOON_RADIUS,settings.x));}`;
  const bodies=await probe(bodyCode,new Float32Array([0.001,0,0,0]),8),coarseBodies=await probe(bodyCode,new Float32Array([0.1,0,0,0]),8);
  const moon=await probe(celestialShader+`
   @group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=8u){return;}let angle=array<f32,8>(0.0,0.017,0.018,0.019,0.022,0.03,0.04,3.14159265)[id.x];let ray=vec3f(sin(angle),cos(angle),0);let direction=vec3f(0,1,0);result[id.x]=vec4f(moonRadiance(ray,direction,settings.x),moonRadiance(ray,direction,0.1),0,1);}`,new Float32Array([0.001,0,0,0]),8);
  const lighting=wgsl.replace('@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f','fn lighting(i:Output,front:bool)->vec4f').replace('discard;','return vec4f(0);').replace('dot(v,h)','1.00000012');
  const frame=new Float32Array(28);frame.set([0,0,1,0],16);frame.set([0,0,-1,1],20);frame.set([1,1,1,0.1],24);
  const pbr=await probe(lighting+`
   @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=8u){return;}var i:Output;i.position=vec3f(0);i.normal=normalize(vec3f(0.01*f32(id.x),0,1));i.color=vec3f(0.5);i.material=vec4f(0.045+f32(id.x)*0.1,0,1,1);result[id.x]=lighting(i,true);}`,frame,8);
  const planet=await probe(`@group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){if(id.x>=3u){return;}let geometricLight=f32(id.x)-1.0+settings.x;${nightWeight}result[id.x]=vec4f(nightWeight);}`,new Float32Array(4),3);
  const validation=await d.popErrorScope();if(validation)throw new Error(validation.message);d.destroy();return {wind,detail,bounds,directAO,ambientAO,clouds,moved,night,clear,horizon,aboveLayer,bodies,coarseBodies,moon,pbr,planet};
 },{windShader,cloudShader,celestialShader,atmosphere,wgsl,nightWeight,instanceShader});
 for(const values of Object.values(result))assert.ok(values.every(Number.isFinite),'GPU probe produced a non-finite value');
 assert.deepEqual(result.wind.slice(0,3),[0,0,0]);assert.notDeepEqual(result.wind.slice(4,7),result.wind.slice(8,11));assert.notDeepEqual(result.wind.slice(4,7),result.wind.slice(12,15));assert.deepEqual(result.wind.slice(24,27),[0,0,0]);
 const derivative=result.wind.slice(16,18),normal=result.wind.slice(20,23);assert.ok(Math.abs(normal[0]*derivative[0]+normal[1]+normal[2]*derivative[1])<0.0001,'Wind normals disagree with the deformed tangent');
 assert.deepEqual(result.detail.slice(0,3),[0,0,0]);assert.notDeepEqual(result.detail.slice(4,6),result.detail.slice(8,10));assert.deepEqual(result.detail.slice(24,27),[0,0,0]);
 for(const tangent of [16,20])assert.ok(Math.abs(result.detail.slice(12,15).reduce((sum,n,k)=>sum+n*result.detail[tangent+k],0))<0.0003,'Detail normals disagree with the deformed surface');
 for(let i=0;i<result.bounds.length;i+=4){assert.ok(result.bounds[i]<=result.bounds[i+1]+1e-6,'Wind exceeded its conservative bound');assert.ok(result.bounds[i+2]>0.15,'Detail deformation folded');}
 assert.deepEqual(result.directAO.slice(0,3),result.directAO.slice(4,7),'AO darkened direct lighting');assert.deepEqual(result.ambientAO.slice(0,3),[0,0,0]);assert.ok(result.ambientAO.slice(4,7).every(v=>v>0),'AO lost ambient lighting');
 assert.ok(result.clouds.some((v,i)=>Math.abs(v-result.moved[i])>0.01),'Clouds did not move');assert.ok(result.night.some((v,i)=>v<result.moved[i]-0.1),'Clouds did not darken at night');
 for(const values of [result.clear,result.horizon,result.aboveLayer])for(let i=0;i<values.length;i+=4)for(let j=0;j<3;j++)assert.ok(Math.abs(values[i+j]-[0.1,0.2,0.4][j])<1e-6);
 assert.equal(result.planet[0],1);assert.equal(result.planet[8],0);assert.ok(result.planet[4]>0&&result.planet[4]<1);
 assert.equal(result.bodies[4],1,'Sun disc is too small');assert.equal(result.bodies[14],1,'Moon disc is too small');assert.equal(result.bodies[12],0);
 assert.ok(result.bodies[8]>0.4&&result.bodies[8]<0.6,'Sun edge is not antialiased');assert.ok(result.bodies[20]===0&&result.bodies[21]>0&&result.bodies[22]===0&&result.bodies[23]>0,'Celestial halos are missing');
 assert.ok(result.coarseBodies[0]<0.1&&result.coarseBodies[2]<0.15,'Reflection filtering inflated disc radiance');assert.deepEqual(result.bodies.slice(28),[0,0,0,0]);
 assert.ok(result.moon[0]>4&&result.moon[0]<4.03,'Moon core lost prominence or became overexposed');assert.ok(result.moon[8]>1.9&&result.moon[8]<2.1,'Moon limb lost pixel antialiasing');
 assert.ok(result.moon[12]>0&&result.moon[12]<0.01,'Moon halo blurs the limb');assert.ok(result.moon[24]<0.0002,'Moon halo extends too far');assert.equal(result.moon[28],0);
 assert.ok(result.moon[1]>0&&result.moon[1]<0.5,'Coarse moon reflection inflated radiance');
 assert.deepEqual(errors,[]);const report={hardware:browser.hardware,checks:['Wind roots stay anchored','Spatial and temporal gust variation','Deformed normals match finite differences','Zero wind is static','Cloud motion and night tint','Disabled clouds preserve sky','PBR remains finite with roundoff and opposite light/view'],errors};
 report.checks.push('Planet terminator uses ordered smoothstep edges','Clouds preserve the clear horizon and cameras above the layer','Prominent sun/moon discs, antialiased edges, halos and filtered reflection coverage','Moon keeps a bright antialiased limb with bounded radiance and a tight halo','Branch/foliage detail with analytic normals, anchored roots and bounded nonfolding deformation','Vertex occlusion affects ambient light, preserving direct illumination');await writeFile('test-results/nature-'+browser.hardware.webgpu.vendor+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}

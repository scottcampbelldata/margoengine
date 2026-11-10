import test from 'node:test';
import assert from 'node:assert/strict';
import {ComposedVoxelPathTracer} from '../dist/compose.js';
import {meshPBR,traceSceneFromGLTF} from '../dist/mesh-pbr.js';
import {fakeEngine,simpleScene} from './support.js';
import {checkWGSL} from '@margoengine/webgl2-compat/wgsl';
import {runComputeOnCPU} from '@margoengine/webgl2-compat/compute';
import {iridescentFresnel} from '../../../tests/support/khr-brdf.js';
function scene(material={}){return {...simpleScene(),models:[],instances:[],meshes:[{id:'tri',material:1,positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2]),uvs:new Float32Array([0,0,1,0,0,1])}],pbrMaterials:[{id:1,metallicFactor:0,roughnessFactor:.5,baseColorFactor:[.3,.4,.5,1],...material}]};}
async function probe(material,body,countFresnel=false,countTextures=false,secondaryMaterial){
 const h=fakeEngine(),codes=[],make=h.device.createShaderModule.bind(h.device);h.device.createShaderModule=d=>{codes.push(d.code);return make(d);};
 const input=scene(material);
 if(secondaryMaterial){input.meshes.push({...structuredClone(input.meshes[0]),id:'emitter',material:2});input.pbrMaterials.push({id:2,metallicFactor:0,...secondaryMaterial});}
 const t=await ComposedVoxelPathTracer.create(h.engine,{scene:input,features:[meshPBR()],denoise:false});
 try{
  await t.ready;h.frame();const words=h.device.buffers.map(b=>new Uint32Array(b.data)).find(w=>w[2]>0&&w[w[2]+9]===0x4d494e53),code=codes.find(s=>s.includes('fn pbrMaterial'));checkWGSL(code);
  const out=new Float32Array(32);
  let source=countFresnel?code.replace('fn pbrFresnel(m:Mat,cosine:f32)->vec3f {','var<private> pbrFresnelCalls:u32;\nfn pbrFresnel(m:Mat,cosine:f32)->vec3f {pbrFresnelCalls++;'):code;
  if(countTextures)source=source.replace('fn pbrTexture(h:Hit,record:u32,slot:u32,srgb:bool)->vec4f {','var<private> pbrTextureCalls:u32;\nfn pbrTexture(h:Hit,record:u32,slot:u32,srgb:bool)->vec4f {pbrTextureCalls++;');
  runComputeOnCPU({source:source+`\n@group(3) @binding(0) var<storage,read_write> probe:array<vec4f>;
  @compute @workgroup_size(1) fn lobe_probe(){let g=scene[2];let p=g+scene[g+5u];let b=g+scene[p+24u];var h:Hit;h.inst=TRIANGLE;h.value=1u;h.mesh=p;h.meshHead=b;h.tri=b+scene[b+1u];h.sgn=1.0;h.bary=vec2f(.2,.3);let m=pbrMaterial(h,vec3f(0.0),material(1u));${body}}`,entryPoint:'lobe_probe',workgroups:[1],workBudget:50_000_000,
  buffers:new Map([['0:3',words],['0:1',new Float32Array(8192).fill(.5)],['0:4',new Float32Array(4)],['3:0',out]])});return out;
 }finally{t.dispose();}
}
const tex=rgba=>({width:1,height:1,data:new Uint8Array(rgba)});
const close=(a,b,epsilon=1e-5)=>assert.ok(Math.abs(a-b)<epsilon,`${a} vs ${b}`);
const ggx=(alpha,co,ci,nh)=>{const a2=alpha*alpha,k=1+(a2-1)*nh*nh,D=a2/(Math.PI*k*k),lambda=c=>(Math.sqrt(1+a2*(1-c*c)/(c*c))-1)/2;return D/(4*co*(1+lambda(co)+lambda(ci)));};
test('sampling another emitter preserves the receiver layer and its prepared Fresnel',async()=>{
 const a=await probe({clearcoatFactor:.7,sheenColorFactor:[.4,.2,.1],iridescenceFactor:.9,iridescenceThicknessMaximum:350},
  'let n=vec3f(0,0,1);pbrPrepareView(m,n,n);let wi=normalize(vec3f(.4,0,1));let before=pbrLayerEvalPrepared(m,n,n,wi,3u);let q=p+32u;let b2=g+scene[q+24u];var light:Hit;light.inst=TRIANGLE;light.value=1u;light.mesh=q;light.meshHead=b2;light.tri=b2+scene[b2+1u];light.sgn=1.0;light.bary=vec2f(.2,.3);let emitted=meshEmitterRadiance(light,vec3f(0),n);let after=pbrLayerEvalPrepared(m,n,n,wi,3u);probe[0]=vec4f(before.f,before.pdf);probe[1]=vec4f(after.f,after.pdf);probe[2]=vec4f(emitted,1);',false,false,{clearcoatFactor:.2,emissiveFactor:[2,4,8]});
 for(let i=0;i<4;i++)close(a[i],a[4+i]);
 for(let i=0;i<3;i++)close(a[8+i],[2,4,8][i]*(1-.2*.04));
});
test('emitter-only evaluation retains alpha and mapped coat attenuation with four texture evaluations',async()=>{
 const a=await probe({alphaMode:'MASK',baseColorTexture:tex([255,255,255,255]),emissiveFactor:[2,4,8],emissiveTexture:tex([128,255,64,255]),clearcoatFactor:.8,clearcoatTexture:tex([128,255,255,255]),clearcoatNormalTexture:tex([128,128,255,255]),sheenColorFactor:[.4,.2,.1],sheenColorTexture:tex([128,255,64,255]),specularColorFactor:[2,3,4],specularColorTexture:tex([64,128,255,255]),iridescenceFactor:.9,iridescenceTexture:tex([255,255,255,255])},
  'pbrTextureCalls=0u;let n=vec3f(0,0,1);let value=meshEmitterRadiance(h,vec3f(0),n);probe[0]=vec4f(value,f32(pbrTextureCalls));let reference=pbrEmitted(pbrMaterial(h,vec3f(0),material(1u)),n);probe[1]=vec4f(reference,1);',false,true);
 assert.equal(a[3],4,'alpha, emission, coat strength and coat normal retain their complete texture evaluation');
 for(let i=0;i<3;i++)close(a[i],a[4+i]);
});
test('view-Fresnel is evaluated once while sampling the complete layered mixture',async()=>{
 const a=await probe({iridescenceFactor:.9,iridescenceThicknessMaximum:350},
  'rng=1234u;let n=vec3f(0,0,1);let s=pbrLayerSample(m,n,n);probe[0]=vec4f(s.w,f32(pbrFresnelCalls));probe[1]=vec4f(s.pdf,select(0.0,1.0,s.ok),f32(s.lobe),0);',true);
 assert.equal(a[5],1,'the fixed sample produces a valid continuous bounce');
 assert.ok(a[4]>0,'the complete mixture PDF remains positive');
 assert.equal(a[3],2,'one view Fresnel and one half-vector Fresnel, without repeated view work');
 assert.ok(a.slice(0,3).every(Number.isFinite));
});
test('prepared-view shares one Fresnel across light evaluations and the sampled bounce',async()=>{
 const a=await probe({iridescenceFactor:.9,iridescenceThicknessMaximum:350},
  'let n=vec3f(0,0,1);pbrPrepareView(m,n,n);let v=m;let wi=normalize(vec3f(.4,0,1));let e0=pbrLayerEvalPrepared(v,n,n,n,3u);let e1=pbrLayerEvalPrepared(v,n,n,wi,3u);rng=1234u;let s=pbrLayerSamplePrepared(v,n,n);probe[0]=vec4f(s.w,f32(pbrFresnelCalls));probe[1]=vec4f(e1.f,e1.pdf);let reference=pbrLayerEval(m,n,n,wi,3u);probe[2]=vec4f(reference.f,reference.pdf);probe[3]=vec4f(select(0.0,1.0,s.ok),e0.pdf,s.pdf,0);',true);
 assert.equal(a[3],4,'one view Fresnel and one half-vector Fresnel per light or sampled direction');
 assert.equal(a[12],1);assert.ok(a[13]>0&&a[14]>0);
 for(let i=0;i<4;i++)close(a[4+i],a[8+i]);
});
test('glTF extension textures use independent coat normal and specified RGB/R/G/A channels',async()=>{
 const a=await probe({normalTexture:tex([255,128,255,255]),clearcoatFactor:.8,clearcoatTexture:tex([128,1,2,3]),clearcoatRoughnessFactor:.5,clearcoatRoughnessTexture:tex([255,128,255,255]),sheenColorFactor:[.8,.4,.2],sheenColorTexture:tex([128,255,0,255]),sheenRoughnessFactor:.6,sheenRoughnessTexture:tex([255,255,255,64]),specularFactor:.7,specularTexture:tex([255,255,255,128]),specularColorFactor:[2,3,4],specularColorTexture:tex([255,128,0,255]),iridescenceFactor:.9,iridescenceTexture:tex([64,255,255,255]),iridescenceThicknessTexture:tex([0,128,0,255])},
 'probe[0]=vec4f(pbrLayer.coat,pbrLayer.coatAlpha,pbrLayer.sheenR,pbrLayer.specWeight);probe[1]=vec4f(pbrLayer.sheen,pbrLayer.film.x);probe[2]=vec4f(pbrLayer.specRGB,pbrLayer.film.z);probe[3]=vec4f(pbrLayer.coatN,1);');
 close(a[0],.8*128/255);close(a[1],(.5*128/255)**2);close(a[2],.6*64/255);close(a[3],.7*128/255);
 const linear=((128/255+.055)/1.055)**2.4;close(a[4],.8*linear);close(a[5],.4);close(a[6],0);close(a[7],.9*64/255);
 close(a[8],2);close(a[9],3*linear);close(a[10],0);close(a[11],100+300*128/255);assert.deepEqual([...a.slice(12,15)],[0,0,1]);
});
test('specular RGB and clearcoat match independent glTF Fresnel and GGX equations',async()=>{
 const a=await probe({specularFactor:.6,specularColorFactor:[2,.5,1],clearcoatFactor:.8,clearcoatRoughnessFactor:.7},
 'let e=pbrLayerEval(m,vec3f(0,0,1),vec3f(0,0,1),vec3f(.6,0,.8),3u);probe[0]=vec4f(e.f,e.pdf);');
 const vh=Math.sqrt(.9),fr=[2,.5,1].map(c=>.6*(.04*c+(1-.04*c)*(1-vh)**5)),coat=.8*.04,baseSpec=ggx(.25,1,.8,vh),coatSpec=ggx(.49,1,.8,vh);
 for(let c=0;c<3;c++){const base=(1-Math.max(...fr))*[.3,.4,.5][c]*.8/Math.PI+fr[c]*baseSpec;close(a[c],(1-coat)*base+coat*coatSpec);}
 assert.ok(a[3]>0);
 const zero=await probe({specularFactor:0},'let e=pbrLayerEval(m,vec3f(0,0,1),vec3f(0,0,1),vec3f(.6,0,.8),3u);probe[0]=vec4f(e.f,e.pdf);');
 for(let c=0;c<3;c++)close(zero[c],[.3,.4,.5][c]*.8/Math.PI);close(zero[3],.8/Math.PI);
});
test('thin film uses the same independently validated Khronos spectral reference',async()=>{
 const a=await probe({iridescenceFactor:1,iridescenceIor:1.4,iridescenceThicknessMaximum:350},'probe[0]=vec4f(pbrFresnel(m,.7),1);');
 const reference=iridescentFresnel([.04,.04,.04],.7,350,1.4);for(let c=0;c<3;c++)close(a[c],Math.max(0,Math.min(1,reference[c])));
});
test('coat attenuates underlying emission and smooth sampling keeps delta mass out of continuous PDFs',async()=>{
 const a=await probe({clearcoatFactor:1,clearcoatRoughnessFactor:0,emissiveFactor:[2,4,8],roughnessFactor:0,specularFactor:0},
 'probe[0]=vec4f(pbrEmitted(m,vec3f(0,0,1)),pbrMixture(m,vec3f(0,0,1),vec3f(0,0,1)).z);let e=pbrLayerEval(m,vec3f(0,0,1),vec3f(0,0,1),vec3f(0,0,1),3u);probe[1]=vec4f(e.f,e.pdf);');
 for(let c=0;c<3;c++)close(a[c],[2,4,8][c]*.96);close(a[3],.04);close(a[7],.96/Math.PI);
});
test('sheen layering has finite bounded white-furnace energy under independent hemisphere quadrature',async()=>{
 const a=await probe({baseColorFactor:[1,1,1,1],clearcoatFactor:.8,clearcoatRoughnessFactor:.6,sheenColorFactor:[.8,.4,.2],sheenRoughnessFactor:.6},
 `var sum=vec3f(0);let steps=32u;for(var y=0u;y<steps;y++){let z=(f32(y)+.5)/f32(steps);for(var x=0u;x<steps;x++){let phi=TAU*(f32(x)+.5)/f32(steps);let r=sqrt(1-z*z);let wi=vec3f(r*cos(phi),r*sin(phi),z);sum+=pbrLayerEval(m,vec3f(0,0,1),vec3f(0,0,1),wi,3u).f;}}probe[0]=vec4f(sum*(2*PI/f32(steps*steps)),1);`);
 for(const value of a.slice(0,3))assert.ok(Number.isFinite(value)&&value>0&&value<=1.03,`hemisphere energy ${value}`);
});
test('loaded glTF retains all four extension records and their texture bindings',async()=>{
 const vertices=new Float32Array(60);for(let i=0;i<3;i++)vertices.set([i===1?1:0,i===2?1:0,0,1,0,0,1,0,1,0,0,1,0,0,0,0,1,1,1,1],20*i);
 const extension={KHR_materials_clearcoat:{clearcoatFactor:.7,clearcoatNormalTexture:{index:0,scale:.3}},KHR_materials_sheen:{sheenColorFactor:[.2,.4,.6],sheenRoughnessFactor:.8},KHR_materials_specular:{specularFactor:.5,specularColorFactor:[2,1,1]},KHR_materials_iridescence:{iridescenceFactor:.9,iridescenceThicknessMaximum:600,iridescenceThicknessTexture:{index:0}}};
 const doc={materials:[{extensions:extension}],textures:[{source:0}]},model={asset:{doc},primitives:[{definition:{material:0},material:{}}],image(){throw Error('decoder owns test pixels');},async readPickingGeometry(){return [{primitiveIndex:0,vertices,indices:new Uint32Array([0,1,2]),matrix:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])}];}};
 const s=await traceSceneFromGLTF(model,{imagePixels:async()=>({width:1,height:1,data:new Uint8Array([128,64,32,255])})});const m=s.pbrMaterials[0];assert.equal(m.clearcoatFactor,.7);assert.equal(m.clearcoatNormalScale,.3);assert.deepEqual(m.sheenColorFactor,[.2,.4,.6]);assert.equal(m.specularFactor,.5);assert.equal(m.iridescenceThicknessMaximum,600);assert.equal(m.clearcoatNormalTexture.data[0],128);assert.equal(m.iridescenceThicknessTexture.data[1],64);
});

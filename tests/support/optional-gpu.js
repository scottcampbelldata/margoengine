import {gpuHarness} from './postfx-gpu.js';
export function optionalGPU(){
 const h=gpuHarness(),{engine,context:c,counts,resources}=h;
 globalThis.GPUBufferUsage={MAP_READ:1,COPY_SRC:4,COPY_DST:8,INDEX:16,VERTEX:32,UNIFORM:64,STORAGE:128,INDIRECT:256};globalThis.GPUMapMode={READ:1};
 engine.gpu.limits={maxStorageBufferBindingSize:128*1024*1024,maxBufferSize:256*1024*1024,maxComputeWorkgroupsPerDimension:65535};engine.gpu.features=new Set();
 const create=engine.gpu.createBuffer;engine.gpu.createBuffer=descriptor=>{const b=create(descriptor);b.data=new ArrayBuffer(descriptor.size);b.mapState='unmapped';b.mapAsync=async()=>{b.mapState='mapped';};b.getMappedRange=()=>b.data;b.unmap=()=>{b.mapState='unmapped';};return b;};
 engine.gpu.queue.writeBuffer=(b,offset,value)=>{new Uint8Array(b.data).set(new Uint8Array(value.buffer,value.byteOffset,value.byteLength),offset);};
 engine.gpu.createSampler=()=>({});engine.gpu.importExternalTexture=descriptor=>descriptor;
 const pass={setPipeline(){},setBindGroup(){},setVertexBuffer(){},setIndexBuffer(){},draw(){counts.draws=(counts.draws??0)+1;},drawIndexed(){counts.indexed=(counts.indexed??0)+1;},drawIndexedIndirect(){counts.indirect=(counts.indirect??0)+1;},drawIndirect(){counts.indirect=(counts.indirect??0)+1;},dispatchWorkgroups(){},end(){}};
 c.encoder.beginRenderPass=()=>{counts.render++;return pass;};c.encoder.beginComputePass=()=>{counts.compute++;return pass;};
 c.encoder.clearBuffer=()=>{};c.encoder.copyTextureToTexture=()=>{counts.copies=(counts.copies??0)+1;};c.encoder.copyBufferToBuffer=(source,from,target,to,size)=>new Uint8Array(target.data,to,size).set(new Uint8Array(source.data,from,size));
 c.camera.matrix=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);c.camera.position=[0,1,4];c.camera.target=[0,0,0];c.camera.planes=new Float32Array(24);c.delta=0.1;
 engine.camera=c.camera;engine.backend='webgpu';engine.meshes=new Map();engine.store={capacity:16,matrices:new Float32Array(256),parents:new Int32Array(16).fill(-1),hidden:new Uint8Array(16)};
 return {...h,cleanup(){for(const r of resources)if(!r.destroyed)r.destroy();}};
}

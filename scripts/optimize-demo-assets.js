// Regenerate the checked-in desktop Earth and phone assets with installed sharp.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import validator from 'gltf-validator';
import {MeshoptSimplifier} from 'meshoptimizer';

const earth='packages/creative/examples/earth/assets/';
for(const [source,target,lossless,desktopTarget] of [
  ['earth-day.jpg','earth-day-mobile.webp',false,null],
  ['2k_earth_nightmap.jpg','earth-night-mobile.webp',false,'earth-night.webp'],
  ['2k_earth_clouds.jpg','earth-clouds-mobile.webp',false,'earth-clouds.webp'],
  ['earth-normal.png','earth-normal-mobile.webp',true,'earth-normal.webp'],
  ['earth-specular-roughness.png','earth-specular-mobile.webp',true,'earth-specular.webp'],
]) {
  await sharp(earth+source).resize(1024,512).webp({quality:85,lossless}).toFile(earth+target);
  const metadata=await sharp(earth+target).metadata();
  assert.equal(metadata.width,1024);assert.equal(metadata.height,512);
  if(desktopTarget) {
    // Data maps use raw channels; ICC conversion can alter them.
    const input=await readFile(earth+source),desktop=await sharp(input,{ignoreIcc:true}).webp({quality:95,lossless,effort:6}).toBuffer();
    const before=await sharp(input,{ignoreIcc:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true}),after=await sharp(desktop).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(before.info.width,2048);assert.equal(before.info.height,1024);
    assert.equal(after.info.width,before.info.width);assert.equal(after.info.height,before.info.height);
    assert.ok(desktop.length<input.length,'Desktop derivative must be smaller');
    if(lossless)assert.deepEqual(after.data,before.data,'Data-map pixels must be unchanged');
    else {
      let squaredError=0;for(let i=0;i<before.data.length;i++)if(i%4!==3)squaredError+=(before.data[i]-after.data[i])**2;
      const mse=squaredError/(before.info.width*before.info.height*3);
      assert.ok(mse===0||10*Math.log10(255**2/mse)>=40,'Color-map PSNR must remain at least 40 dB');
    }
    await writeFile(earth+desktopTarget,desktop);
  }
}

const source=await readFile('examples/assets/damaged-helmet.glb');
assert.equal(source.readUInt32LE(0),0x46546c67);assert.equal(source.readUInt32LE(4),2);
assert.equal(source.readUInt32LE(8),source.length);
const jsonLength=source.readUInt32LE(12),doc=JSON.parse(source.subarray(20,20+jsonLength).toString());
assert.equal(doc.buffers.length,1);assert.equal(source.readUInt32LE(24+jsonLength),0x004e4942);
const binary=source.subarray(28+jsonLength),chunks=[];
const replacements=new Map(),primitive=doc.meshes[0].primitives[0];
assert.equal(doc.meshes.length,1);assert.equal(doc.meshes[0].primitives.length,1);
const readAccessor=id=>{
  const accessor=doc.accessors[id],view=doc.bufferViews[accessor.bufferView];
  assert.ok(!view.byteStride&&!accessor.sparse);
  const bytes=binary.subarray((view.byteOffset??0)+(accessor.byteOffset??0),(view.byteOffset??0)+view.byteLength);
  return accessor.componentType===5123?new Uint32Array(new Uint16Array(bytes.buffer,bytes.byteOffset,accessor.count)):new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
};
await MeshoptSimplifier.ready;
const positions=readAccessor(primitive.attributes.POSITION),normals=readAccessor(primitive.attributes.NORMAL),uvs=readAccessor(primitive.attributes.TEXCOORD_0),indices=readAccessor(primitive.indices);
const attributes=new Float32Array(positions.length/3*5);
for(let i=0;i<positions.length/3;i++){attributes.set(normals.subarray(i*3,i*3+3),i*5);attributes.set(uvs.subarray(i*2,i*2+2),i*5+3);}
const [simplified,error]=MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,attributes,5,[0.1,0.1,0.1,1,1],null,Math.floor(indices.length*0.4/3)*3,0.005);
assert.ok(error<=0.005);
const [remap,vertexCount]=MeshoptSimplifier.compactMesh(simplified);
for(const [id,values,width] of [[primitive.attributes.POSITION,positions,3],[primitive.attributes.NORMAL,normals,3],[primitive.attributes.TEXCOORD_0,uvs,2]]){
  const accessor=doc.accessors[id],data=new Float32Array(vertexCount*width);
  for(let i=0;i<remap.length;i++)if(remap[i]!==0xffffffff)data.set(values.subarray(i*width,i*width+width),remap[i]*width);
  accessor.count=vertexCount;
  accessor.min=Array.from({length:width},(_,axis)=>data.filter((_,i)=>i%width===axis).reduce((a,b)=>Math.min(a,b),Infinity));
  accessor.max=Array.from({length:width},(_,axis)=>data.filter((_,i)=>i%width===axis).reduce((a,b)=>Math.max(a,b),-Infinity));
  replacements.set(accessor.bufferView,Buffer.from(data.buffer));
}
const indexAccessor=doc.accessors[primitive.indices];indexAccessor.count=simplified.length;indexAccessor.min=[0];indexAccessor.max=[vertexCount-1];
replacements.set(indexAccessor.bufferView,Buffer.from(new Uint16Array(simplified).buffer));
const images=new Map(doc.images.map(image=>[image.bufferView,image]));
const colorImages=new Set(doc.materials.flatMap(material=>[material.pbrMetallicRoughness?.baseColorTexture,material.emissiveTexture]).filter(Boolean).map(texture=>doc.textures[texture.index].source));
let offset=0;
for(const [index,view] of doc.bufferViews.entries()) {
  assert.equal(view.buffer,0);
  let bytes=replacements.get(index)??binary.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength);
  const image=images.get(index);
  if(image){
    const resized=sharp(bytes).resize(512,512,{fit:'inside',withoutEnlargement:true});
    const color=colorImages.has(doc.images.indexOf(image));
    bytes=await resized.jpeg({quality:color?85:90,chromaSubsampling:'4:4:4'}).toBuffer();
    image.mimeType='image/jpeg';
  }
  view.byteOffset=offset;view.byteLength=bytes.length;
  chunks.push(bytes,Buffer.alloc((4-bytes.length%4)%4));offset+=Math.ceil(bytes.length/4)*4;
}
doc.buffers[0].byteLength=offset;
const json=Buffer.from(JSON.stringify(doc)),padding=Buffer.alloc((4-json.length%4)%4,0x20);
const header=Buffer.alloc(20),binHeader=Buffer.alloc(8);
header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);
header.writeUInt32LE(28+json.length+padding.length+offset,8);
header.writeUInt32LE(json.length+padding.length,12);header.writeUInt32LE(0x4e4f534a,16);
binHeader.writeUInt32LE(offset,0);binHeader.writeUInt32LE(0x004e4942,4);
const mobile=Buffer.concat([header,json,padding,binHeader,...chunks]);
const report=await validator.validateBytes(new Uint8Array(mobile));
assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues.messages));
assert.ok(mobile.length<source.length/4,'Phone model must be at least 75% smaller');
await writeFile('examples/assets/damaged-helmet-mobile.glb',mobile);
console.log(JSON.stringify({helmetOriginal:source.length,helmetMobile:mobile.length,triangles:simplified.length/3,simplificationError:error,validationErrors:report.issues.numErrors}));

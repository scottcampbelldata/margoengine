export function animatedTriangle() {
  const buffers=[],bufferViews=[],accessors=[];
  const add=(data,type,componentType=5126)=>{const id=buffers.length;buffers.push(data);bufferViews.push({buffer:id,byteLength:data.byteLength});accessors.push({bufferView:id,componentType,count:data.length/({SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[type]),type});return id;};
  const position=add(new Float32Array([-0.6,-0.6,0,0.6,-0.6,0,0,0.6,0]),'VEC3');
  const normal=add(new Float32Array([0,0,1,0,0,1,0,0,1]),'VEC3');
  const joints=add(new Uint16Array(12),'VEC4',5123),weights=add(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),'VEC4');
  const delta=add(new Float32Array([0.3,0,0,0.3,0,0,0.3,0,0]),'VEC3');
  const times=add(new Float32Array([0,1]),'SCALAR'),translation=add(new Float32Array([0,0,0,0.4,0,0]),'VEC3');
  const doc={asset:{version:'2.0'},buffers:buffers.map(data=>({byteLength:data.byteLength})),bufferViews,accessors,
    meshes:[{primitives:[{attributes:{POSITION:position,NORMAL:normal,JOINTS_0:joints,WEIGHTS_0:weights},targets:[{POSITION:delta}],material:0}],weights:[0],extras:{targetNames:['Smile']}}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[0.8,0.15,0.1,1],metallicFactor:0,roughnessFactor:0.6},doubleSided:true}],
    nodes:[{mesh:0,skin:0,children:[1]},{name:'Joint'}],skins:[{joints:[1]}],
    animations:[{name:'Move',channels:[{sampler:0,target:{node:1,path:'translation'}}],samplers:[{input:times,output:translation}]}]};
  return {doc,buffers};
}

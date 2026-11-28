const magic=0x53495249;
export function encodeIris(meshes){
  const byteLength=8+meshes.reduce((total,{positions,indices})=>total+8+positions.length*8+indices.length*4,0);
  const data=new ArrayBuffer(byteLength), view=new DataView(data);
  view.setUint32(0,magic,true);
  view.setUint32(4,meshes.length,true);
  let cursor=8;
  for(const {positions,normals,indices} of meshes){
    view.setUint32(cursor,positions.length,true);
    view.setUint32(cursor+4,indices.length,true);
    cursor+=8;
    new Float32Array(data,cursor,positions.length).set(positions);
    cursor+=positions.length*4;
    new Float32Array(data,cursor,normals.length).set(normals);
    cursor+=normals.length*4;
    new Uint32Array(data,cursor,indices.length).set(indices);
    cursor+=indices.length*4;
  }
  return new Uint8Array(data);
}
export function decodeIris(data,count){
  if(data.byteLength<8)throw new Error('Incomplete aperture geometry.');
  const view=new DataView(data);
  if(view.getUint32(0,true)!==magic||view.getUint32(4,true)!==count)
    throw new Error('Invalid aperture geometry header.');
  const meshes=[];
  let cursor=8;
  for(let i=0;i<count;i++){
    if(data.byteLength<cursor+8)throw new Error('Missing aperture body.');
    const vertexSize=view.getUint32(cursor,true),indexSize=view.getUint32(cursor+4,true);
    cursor+=8;
    if(!vertexSize||!indexSize||vertexSize%3||indexSize%3||cursor+vertexSize*8+indexSize*4>data.byteLength)
      throw new Error('Invalid aperture body length.');
    const positions=new Float32Array(data,cursor,vertexSize);
    cursor+=vertexSize*4;
    const normals=new Float32Array(data,cursor,vertexSize);
    cursor+=vertexSize*4;
    const indices=new Uint32Array(data,cursor,indexSize);
    cursor+=indexSize*4;
    meshes.push({positions,normals,indices});
  }
  if(cursor!==data.byteLength)throw new Error('Unexpected aperture geometry bytes.');
  return meshes;
}

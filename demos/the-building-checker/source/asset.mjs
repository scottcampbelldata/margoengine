const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeArchive(metadata,meshes) {
  const bytes=[];
  function variable(value) {
    while(value>127){
      bytes.push((value & 127)|128);
      value>>>=7;
    }
    bytes.push(value);
  }
  function delta(diff) {
    variable(diff < 0 ? -2*diff-1 : 2*diff);
  }
  const json=encoder.encode(JSON.stringify(metadata));
  variable(json.length);
  for(const byte of json)bytes.push(byte);
  variable(meshes.length);
  for(const mesh of meshes){
    variable(mesh.id);
    variable(metadata.finishes.indexOf(mesh.finish));
    variable(mesh.positions.length/3);
    variable(mesh.indices.length);
    const previous=[0,0,0];
    for(let i=0;i<mesh.positions.length;i+=3){
      for(let j=0;j<3;j++){
        const current=mesh.positions[i+j];
        delta(current-previous[j]);
        previous[j]=current;
      }
      const normal=mesh.normals.slice(i,i+3);
      const axis=normal.findIndex(value=>Math.abs(value)===127);
      if(axis>=0&&normal.every((value,index)=>index===axis||value===0)){
        bytes.push(axis*2+(normal[axis]<0?1:0));
      }else{
        bytes.push(6,...normal.map(value=>value+127));
      }
    }
    let old=0;
    for(const index of mesh.indices){
      delta(index-old);
      old=index;
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeArchive(bytes) {
  let offset=0;
  function variable() {
    let value=0, shift=0;
    while(shift<=28&&offset<bytes.length){
      const byte=bytes[offset++];
      value|=(byte&127)<<shift;
      if(byte<128)return value>>>0;
      shift+=7;
    }
    throw new Error('Truncated archive mesh field.');
  }
  function delta() {
    const n=variable();
    return n&1?-(n+1)/2:n/2;
  }
  const length=variable();
  const metadata=JSON.parse(decoder.decode(bytes.subarray(offset,offset+length)));
  offset+=length;
  const meshes=Array.from({length:variable()},()=>{
    const id=variable(),finish=metadata.finishes[variable()];
    const vertexCount=variable(),indexCount=variable();
    const positions=new Float32Array(3*vertexCount), normals=new Float32Array(3*vertexCount), indices=new Uint32Array(indexCount);
    const previous=[0,0,0];
    for(let i=0;i<positions.length;i+=3){
      for(let j=0;j<3;j++){
        previous[j]+=delta();
        positions[i+j]=previous[j]/10000;
      }
      const n=bytes[offset++];
      if(n<6)normals[i+(n>>1)]=n&1?-1:1;
      else for(let j=0;j<3;j++)normals[i+j]=(bytes[offset++]-127)/127;
    }
    let index=0;
    for(let i=0;i<indices.length;i++){
      index+=delta();
      indices[i]=index;
    }
    return {id,finish,positions,normals,indices};
  });
  if(offset!==bytes.length)throw new Error('Archive mesh length mismatch.');
  return {...metadata,meshes};
}

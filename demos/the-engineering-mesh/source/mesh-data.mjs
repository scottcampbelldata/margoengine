export const bore=.067;
export const outside=.137;
export const halfLength=.238;
export const temperatures=[70,320];
export const frameBounds=[-halfLength,halfLength,-outside,outside,-outside,outside];
export const palette=['#296aa0','#39bccc','#88d4b0','#f7df8a','#f89a4c','#f95442'];
export const shellPalette=['#425e7c','#6a91a6','#abb4ab','#c99962'];
export const initialOffset=18;

export function temperature(radius) {
  const [cold,hot]=temperatures;
  return cold+(hot-cold)*Math.log(outside/radius)/Math.log(outside/bore);
}

export function makeGrid(){
  const length=[-.238,-.190,-.137,-.087,-.039,.011,.071,.123,.177,.238];
  const radial=[bore,.0785,.093,.113,outside];
  const sectors=26;
  const points=[],pointData=[],connectivity=[];
  const index=(i,j,k)=>(i*radial.length+j)*sectors+(k+sectors)%sectors;
  const addPoint=(x,y,z)=>{
    const id=points.length/3;
    points.push(x,y,z);
    pointData.push(temperature(Math.hypot(y,z)));
    return id;
  };

  for(const [i,x] of length.entries()){
    for(const [j,radius] of radial.entries()){
      for(let k=0;k<sectors;k++){
        const angle=(2*Math.PI*k)/sectors+.068+.026*Math.sin(1.83*k)+.028*Math.sin(1.2*i);
        const r=radius+(j>0&&j<radial.length-1?.00055*Math.sin(k*7.63+i*4.13+j):0);
        const axial=i>0&&i<length.length-1?x+.0011*Math.sin(k*1.92+j*2.07+i):x;
        addPoint(axial,r*Math.cos(angle),r*Math.sin(angle));
      }
    }
  }

  const signedVolume=(a,b,c,d)=>{
    const dx=(end,k)=>points[end*3+k]-points[a*3+k];
    const ab=[dx(b,0),dx(b,1),dx(b,2)];
    const ac=[dx(c,0),dx(c,1),dx(c,2)];
    const ad=[dx(d,0),dx(d,1),dx(d,2)];
    return ab[0]*(ac[1]*ad[2]-ac[2]*ad[1])+ab[1]*(ac[2]*ad[0]-ac[0]*ad[2])+ab[2]*(ac[0]*ad[1]-ac[1]*ad[0]);
  };
  const emit=(a,b,c,d)=>{
    if(signedVolume(a,b,c,d)<0)connectivity.push(a,c,b,d);
    else connectivity.push(a,b,c,d);
  };

  let tetra=0;
  const cell=(a,b,c,d)=>{
    // In selected cells a centroid adds resolution without splitting any shared face.
    if((Math.imul(tetra++,92821)>>>0)%17!==0){emit(a,b,c,d);return;}
    const xyz=[0,1,2].map(k=>(points[a*3+k]+points[b*3+k]+points[c*3+k]+points[d*3+k])/4);
    const middle=addPoint(...xyz);
    emit(a,b,c,middle);
    emit(a,d,b,middle);
    emit(a,c,d,middle);
    emit(b,d,c,middle);
  };

  const layerStride=radial.length*sectors;
  const prism=(triangle)=>{
    // Sorted lower indices choose the same diagonal for a shared prism side.
    const [a,b,c]=triangle.sort((u,v)=>u-v);
    const A=a+layerStride,B=b+layerStride,C=c+layerStride;
    cell(a,b,c,C);
    cell(a,b,B,C);
    cell(a,A,B,C);
  };

  for(let i=0;i<length.length-1;i++)for(let j=0;j<radial.length-1;j++)for(let k=0;k<sectors;k++){
    const a=index(i,j,k),b=index(i,j,k+1),c=index(i,j+1,k),d=index(i,j+1,k+1);
    // Keep the same annular face triangulation on both sides of each axial station.
    if((j+k)%2===0){prism([a,b,d]);prism([a,c,d]);}
    else{prism([a,b,c]);prism([b,c,d]);}
  }

  const count=connectivity.length/4;
  return {
    points:Float32Array.from(points),pointData:Float32Array.from(pointData),
    connectivity:Uint32Array.from(connectivity),
    offsets:Uint32Array.from({length:count},(_,i)=>(i+1)*4),
    types:new Uint8Array(count).fill(10),
  };
}

export function withoutCutFace(set,offset) {
  const positions=[],normals=[],values=[],cells=[];
  for(let t=0;t<set.cells.length;t++){
    const k=t*9;
    if([1,4,7].every(i=>Math.abs(set.positions[k+i]+offset)<2e-7))continue;
    positions.push(...set.positions.subarray(k,k+9));
    normals.push(...set.normals.subarray(k,k+9));
    values.push(...set.values.subarray(t*3,t*3+3));
    cells.push(set.cells[t]);
  }
  return {
    positions:Float32Array.from(positions),normals:Float32Array.from(normals),values:Float32Array.from(values),
    cells:Uint32Array.from(cells),bounds:set.bounds,
  };
}

export function sectionEdges(set,offset) {
  const spans=new Map();
  const key=([x, ,z])=>[Math.round(x*1e7),Math.round(z*1e7)].join('/');
  for(let t=0;t<set.cells.length;t++){
    const corners=[0,1,2].map(k=>set.positions.subarray(t*9+k*3,t*9+k*3+3));
    for(const [i,j] of [[0,1],[1,2],[2,0]]){
      const a=corners[i],b=corners[j],id=[key(a),key(b)].sort().join(':');
      const record=spans.get(id);
      if(record){if(record.cell===set.cells[t])record.diagonal=true;}
      else spans.set(id,{a,b,cell:set.cells[t],diagonal:false});
    }
  }

  const positions=[],normals=[],values=[],cells=[];
  for(const {a,b,diagonal,cell} of spans.values()){
    if(diagonal)continue;
    const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
    if(length<1e-7)continue;
    const width=.00042,nx=-dz/length*width,nz=dx/length*width;
    const y=-offset-.00022;
    for(const [vertex,sign] of [[a,1],[a,-1],[b,1],[b,1],[a,-1],[b,-1]]){
      positions.push(vertex[0]+sign*nx,y,vertex[2]+sign*nz);
      normals.push(0,-1,0);
      values.push(0);
    }
    cells.push(cell,cell);
  }
  return {
    positions:Float32Array.from(positions),normals:Float32Array.from(normals),values:Float32Array.from(values),
    cells:Uint32Array.from(cells),bounds:set.bounds,
  };
}

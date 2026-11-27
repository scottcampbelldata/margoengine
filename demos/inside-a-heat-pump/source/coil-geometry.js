import { boxGeometry, mergeGeometries, applyMatrix4 } from '@margoengine/geometry';

const translation=(x,y,z)=>[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1];

export function louvers(center, front, width, bottom, height, count) {
  const positions=[], normals=[], indices=[], colors=[];
  const rows=16, columns=9;
  for(let fin=0;fin<count;fin++){
    const finX=center+((fin+.5)/count-.5)*width;
    const phase=fin*1.39;
for(let j=0;j<=rows;j++){
      const y=bottom+j/rows*height;
      const corrugation=Math.cos(j*2.43+phase)*.0017;
      for(let i=0;i<=columns;i++){
        const t=i/columns, z=front-t*.375;
        const fold=Math.sin(t*8*Math.PI)*.0064;
        const louver=Math.sin(t*10*Math.PI+phase)*.0027*Math.sin(j*Math.PI*.54);
        positions.push(finX+fold+louver+corrugation,y,z);
        normals.push(1,0,.44*Math.cos(t*8*Math.PI));
        const gray=Math.min(1,.88+.12*Math.cos(fin*2.17)+.021*Math.sin(j*1.9+fin));
        colors.push(gray,gray,Math.min(1,gray*1.01));
        if(i&&j){
          const current=positions.length/3-1, step=columns+1;
          indices.push(current-step-1,current-step,current-1,current-step,current,current-1);
        }
      }
    }
}
  return {positions,normals,indices,colors};
}

export function stampedRibs(x,z,bottom,width,rows) {
  return mergeGeometries(Array.from({length:rows},(_,i)=>applyMatrix4(
    boxGeometry(width,.0036,.013),translation(x,bottom+i*.021,z+(i%3===0?.001:0)),
  )));
}

export function blade() {
  const positions=[], normals=[], indices=[];
  const spans=9, chords=7, stride=chords+1, shell=(spans+1)*stride;
  for(const side of [1,-1]){
    for(let j=0;j<=spans;j++){
      const t=j/spans;
      const r=.103+t*.354;
      const chord=.103+Math.sin(t*Math.PI*.98)*.084+t*.014;
      const lead=-.05-.105*t*t+.035*t;
      for(let i=0;i<=chords;i++){
        const u=i/chords;
        const x=lead+chord*u;
        const twist=(.14-.23*t)*(u-.5);
        const z=.016*Math.sin(u*Math.PI)+twist+side*(.005+.003*Math.sin(u*Math.PI))*Math.sin(.05+Math.PI*t*.92);
        positions.push(x,r,z);
        normals.push(-(.16-.26*t)*side,.1*side,side);
        if(i&&j){
          const v=positions.length/3-1;
          if(side===1)indices.push(v-stride-1,v-stride,v-1,v-stride,v,v-1);
          else indices.push(v-stride-1,v-1,v-stride,v-stride,v-1,v);
        }
      }
    }
  }
  function wrap(edge){
    for(let i=1;i<edge.length;i++){
      const a=edge[i-1],b=edge[i];
      indices.push(a,b,a+shell,b,b+shell,a+shell);
    }
  }
  wrap(Array.from({length:stride},(_,i)=>i));
  wrap(Array.from({length:stride},(_,i)=>spans*stride+stride-1-i));
  wrap(Array.from({length:spans+1},(_,i)=>(spans-i)*stride));
  wrap(Array.from({length:spans+1},(_,i)=>i*stride+chords));
  return {positions,normals,indices};
}




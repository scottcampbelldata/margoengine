// Float64 NTSC-style oracle: explicit matrix inversion and separable binomial kernels, independent of shader layout.
const matrix=[[0.299,0.587,0.114],[0.5959,-0.2746,-0.3213],[0.2115,-0.5227,0.3112]];
const det=matrix[0][0]*(matrix[1][1]*matrix[2][2]-matrix[1][2]*matrix[2][1])
  -matrix[0][1]*(matrix[1][0]*matrix[2][2]-matrix[1][2]*matrix[2][0])
  +matrix[0][2]*(matrix[1][0]*matrix[2][1]-matrix[1][1]*matrix[2][0]);
const inverse=matrix.map((_,i)=>matrix.map((_,j)=>
  (matrix[(j+1)%3][(i+1)%3]*matrix[(j+2)%3][(i+2)%3]-matrix[(j+1)%3][(i+2)%3]*matrix[(j+2)%3][(i+1)%3])/det));
const dot=(a,b)=>a.reduce((s,v,k)=>s+v*b[k],0);
const pair=v=>typeof v==='number'?[v,0]:v??[0,0];
export function crtSignal(texel,look={}) {
  const strength=look.colorBleed??0;
  const signal=(x,y)=>{
    const e=texel(x,y);if(!strength)return e;
    const yiq=matrix.map(row=>dot(row,e));
    for(const [index,weights] of [[1,[1,4,6,4,1]],[2,[1,8,28,56,70,56,28,8,1]]]) {
      const radius=Math.floor(weights.length/2),divisor=weights.reduce((a,b)=>a+b,0);
      const filtered=weights.reduce((sum,w,k)=>sum+w*dot(matrix[index],texel(x+k-radius,y))/divisor,0);
      yiq[index]+=strength*(filtered-yiq[index]);
    }
    return [...inverse.map(row=>Math.max(0,Math.min(e[3],dot(row,yiq)))),e[3]];
  };
  const shifted=(x,y,offset)=>{
    const p=[x+offset[0],y+offset[1]],lo=p.map(Math.floor),f=p.map((v,k)=>v-lo[k]);
    const result=[0,0,0,0];
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
      const sample=signal(lo[0]+dx,lo[1]+dy),weight=(dx?f[0]:1-f[0])*(dy?f[1]:1-f[1]);
      sample.forEach((v,k)=>result[k]+=v*weight);
    }
    return result;
  };
  return (x,y)=>{
    const shared=pair(look.chromaticOffset),red=pair(look.redOffset),green=pair(look.greenOffset),blue=pair(look.blueOffset);
    const r=shifted(x,y,red.map((v,k)=>v+shared[k])),g=shifted(x,y,green),b=shifted(x,y,blue.map((v,k)=>v-shared[k]));
    return [r[0],g[1],b[2],Math.max(r[3],g[3],b[3])];
  };
}

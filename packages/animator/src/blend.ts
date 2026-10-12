export function blend1D(samples:readonly number[],value:number):Float32Array {
  if(!samples.length||!Number.isFinite(value)||samples.some((v,i)=>!Number.isFinite(v)||i>0&&v<=samples[i-1]))throw new RangeError('Invalid 1D blend samples');
  const weights=new Float32Array(samples.length);if(value<=samples[0]){weights[0]=1;return weights;}if(value>=samples.at(-1)!){weights[weights.length-1]=1;return weights;}
  const high=samples.findIndex(v=>v>=value),low=high-1,t=(value-samples[low])/(samples[high]-samples[low]);weights[low]=1-t;weights[high]=t;return weights;
}
export function blend2D(samples:readonly (readonly [number,number])[],x:number,y:number):Float32Array {
  if(!samples.length||![x,y].every(Number.isFinite)||samples.some(v=>v.length!==2||v.some(n=>!Number.isFinite(n)))||new Set(samples.map(v=>v.join(','))).size!==samples.length)throw new RangeError('Invalid 2D blend samples');
  const weights=new Float32Array(samples.length),distances=samples.map(v=>Math.hypot(v[0]-x,v[1]-y)),nearest=Math.min(...distances),exact=distances.indexOf(0);
  if(exact!==-1){weights[exact]=1;return weights;}
  let sum=0;for(let i=0;i<weights.length;i++){weights[i]=(nearest/distances[i])**2;sum+=weights[i];}for(let i=0;i<weights.length;i++)weights[i]/=sum;return weights;
}
export function quaternionMultiply(a:ArrayLike<number>,b:ArrayLike<number>):number[] {return [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];}
export function quaternionBlend(a:ArrayLike<number>,b:ArrayLike<number>,weight:number):number[] {
  let dot=0;for(let i=0;i<4;i++)dot+=a[i]*b[i];const sign=dot<0?-1:1;dot=Math.min(1,Math.abs(dot));let x=1-weight,y=weight;
  if(dot<0.9995){const angle=Math.acos(dot),s=Math.sin(angle);x=Math.sin((1-weight)*angle)/s;y=Math.sin(weight*angle)/s;}
  const q=Array.from({length:4},(_,i)=>a[i]*x+b[i]*y*sign),length=Math.hypot(...q);if(!length)throw new RangeError('Zero blend quaternion');return q.map(v=>v/length);
}

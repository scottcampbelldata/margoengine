export function halton(index:number,base:number):number {
  if(!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(base)||base<2)throw new RangeError('Invalid Halton sequence');
  let value=0,scale=1;while(index){scale/=base;value+=(index%base)*scale;index=Math.floor(index/base);}return value;
}
export function jitterProjection(out:Float32Array,matrix:ArrayLike<number>,frame:number,width:number,height:number):Float32Array {
  if(out.length!==16||matrix.length!==16||!Number.isSafeInteger(frame)||frame<0||!Number.isSafeInteger(width)||width<=0||!Number.isSafeInteger(height)||height<=0)throw new RangeError('Invalid jitter projection');
  for(let i=0;i<16;i++)if(!Number.isFinite(matrix[i]))throw new RangeError('Invalid jitter projection');
  const x=2*(halton(frame%8+1,2)-0.5)/width,y=-2*(halton(frame%8+1,3)-0.5)/height;
  for(let i=0;i<16;i++)out[i]=matrix[i];
  for(let c=0;c<4;c++){out[c*4]+=x*out[c*4+3];out[c*4+1]+=y*out[c*4+3];}return out;
}

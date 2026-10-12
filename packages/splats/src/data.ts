export interface SplatData {positions:Float32Array;covariances:Float32Array;colors:Float32Array;sphericalHarmonics?:Float32Array}
export function validateSplats(data:SplatData):number {
  if(!data||!(data.positions instanceof Float32Array)||!(data.covariances instanceof Float32Array)||!(data.colors instanceof Float32Array))throw new TypeError('Splat data must use Float32 arrays');
  const count=data.positions.length/3,sh=data.sphericalHarmonics;
  if(!Number.isInteger(count)||count<1||count>3_000_000||data.covariances.length!==count*6||data.colors.length!==count*4||sh!==undefined&&(!(sh instanceof Float32Array)||![4,9,16].includes(sh.length/count/3)))throw new RangeError('Invalid splat count or attribute lengths');
  for(const array of [data.positions,data.covariances,data.colors,...(sh?[sh]:[])])for(const value of array)if(!Number.isFinite(value))throw new RangeError('Splat attributes must be finite');
  for(let i=0;i<count;i++){
    const at=i*6,a=data.covariances[at],b=data.covariances[at+1],c=data.covariances[at+2],d=data.covariances[at+3],e=data.covariances[at+4],f=data.covariances[at+5];
    if(a<=0||a*d-b*b<=0||a*(d*f-e*e)-b*(b*f-c*e)+c*(b*e-c*d)<=0)throw new RangeError('Splat covariance must be positive definite');
    for(let j=0;j<4;j++)if(data.colors[i*4+j]<0||data.colors[i*4+j]>1)throw new RangeError('Splat colors and opacity must be 0..1');
  }return count;
}
export function parseSplat(input:ArrayBuffer|ArrayBufferView):SplatData {
  if(!(input instanceof ArrayBuffer)&&!ArrayBuffer.isView(input))throw new TypeError('Expected .splat bytes');
  const bytes=input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength),count=bytes.length/32;
  if(!Number.isInteger(count)||count<1||count>3_000_000)throw new RangeError('Invalid .splat byte length');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),positions=new Float32Array(count*3),covariances=new Float32Array(count*6),colors=new Float32Array(count*4);
  const linear=(c:number)=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
  for(let i=0;i<count;i++){
    const at=i*32;for(let j=0;j<3;j++)positions[i*3+j]=view.getFloat32(at+j*4,true);
    const sx=view.getFloat32(at+12,true),sy=view.getFloat32(at+16,true),sz=view.getFloat32(at+20,true);
    if(![sx,sy,sz].every(v=>Number.isFinite(v)&&v>0))throw new RangeError('Invalid .splat scale');
    let w=(bytes[at+28]-128)/128,x=(bytes[at+29]-128)/128,y=(bytes[at+30]-128)/128,z=(bytes[at+31]-128)/128;
    const length=Math.hypot(w,x,y,z);if(!length)throw new RangeError('Invalid .splat quaternion');w/=length;x/=length;y/=length;z/=length;
    const r=[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)],scale=[sx*sx,sy*sy,sz*sz];
    let n=0;for(let row=0;row<3;row++)for(let col=row;col<3;col++)covariances[i*6+n++]=r[row*3]*r[col*3]*scale[0]+r[row*3+1]*r[col*3+1]*scale[1]+r[row*3+2]*r[col*3+2]*scale[2];
    for(let j=0;j<3;j++)colors[i*4+j]=linear(bytes[at+24+j]/255);colors[i*4+3]=bytes[at+27]/255;
  }const data={positions,covariances,colors};validateSplats(data);return data;
}

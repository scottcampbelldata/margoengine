export const bounds=[-15,-24,15,14];
export const area=[bounds[2]-bounds[0],bounds[3]-bounds[1]];
export const fieldCenter=[0,0,(bounds[1]+bounds[3])/2];
export const recoverSeconds=4.25;
export const footRadius=.70;
export const candidateClumps=17100;

export const mix=(a,b,t)=>a+(b-a)*t;
export const clamp=(a,lo=0,hi=1)=>Math.min(hi,Math.max(lo,a));
export function noise(x,z,s=0){
  const v=Math.sin(x*161.72+z*59.83+s*62.91)*43758.5453123;
  return v-Math.floor(v);
}
export function groundY(x,z){
  return .26*Math.sin(.35*x-.27*z)+.12*Math.sin(.89*x+.46*z)+.084*Math.cos(1.31*z+.34*x)+
    .047*Math.sin(x*1.49-z*.64)+.009*Math.sin(x*3.8+z*3.3)+.19*Math.cos(.15*z-.68)*Math.sin(.24*x);
}
export function trail(distance){
  const s=clamp(distance,0,16.8),x=.47+1.74*Math.sin(.244*s)-.087*s,z=8.5-.94*s;
  return [x,groundY(x,z),z];
}
export function cameraAt(distance,portrait){
  const p=trail(distance),q=trail(distance+8.9),yaw=portrait?.14:.39;
  return {position:[p[0]+yaw,p[1]+1.78,p[2]+.28],target:[q[0]-.95,q[1]+1.05,q[2]-5.0],
    fov:portrait?61:49,near:.077,far:215};
}
export function terrainData(){
  const width=128,height=128;
  const y=new Float32Array(width*height),tint=new Float32Array(width*height*4),density=new Uint8Array(y.length);
  for(let j=0;j<height;j++)for(let i=0;i<width;i++){
    const x=mix(bounds[0],bounds[2],(i+.5)/width),z=mix(bounds[1],bounds[3],(j+.5)/height),index=j*width+i;
    y[index]=groundY(x,z);
    const waves=.48+.23*Math.sin(x*.58+z*.15)*Math.sin(z*.31+x*.17)+.20*Math.cos(x*.27-z*.22);
    const shadow=.08*noise(x*.17,z*.17);
    const gold=.5+.5*Math.cos(.26*x+.40*z-.62*Math.sin(x*.19));
    tint.set([.66+.21*gold-shadow,.70+.24*waves-shadow,.52+.29*(1-gold)-shadow,1],index*4);
    const margin=clamp(Math.min((x-bounds[0])*.55,(bounds[2]-x)*.55,(z-bounds[1])*.40,(bounds[3]-z)*.65));
    density[index]=Math.round(255*margin*(.70+.30*waves));
  }
  return {width,height,y,tint,density};
}

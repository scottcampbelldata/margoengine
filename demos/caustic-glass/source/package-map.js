import {irradianceScale,table} from './optics.js';

export const MAP_SIZE=256;
const weights=[.01371,.21888,.53482,.21888,.01371];
const average=rgb=>(rgb[0]+rgb[1]+rgb[2])/3;
const code=linear=>{
  const value=Math.max(0,Math.min(1,linear));
  return Math.round(255*(value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055));
};
const sides=['deposited','escaped','absorbed','truncated','unrefracted','blocked','masked'];
const rect=[table.maxX-table.minX,table.maxZ-table.minZ];

export function packMap({atlas,irradiance,diagnostics:d}){
  const chart=atlas.charts[0],width=chart.height,height=chart.width;
  const src=(x,y,c)=>irradiance[((chart.y+x)*atlas.width+chart.x+y)*3+c];
  const horizontal=new Float32Array(width*height*3);
  const filtered=new Float32Array(horizontal.length);
  const off=(x,y,c)=>(y*width+x)*3+c;
  const cap=(v,n)=>Math.min(n-1,Math.max(v,0));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++){
    horizontal[off(x,y,c)]=weights.reduce((sum,w,i)=>sum+w*src(cap(x+i-2,width),y,c),0);
  }
  let energy=0,muX=0,muZ=0,peak=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let e=0;
    for(let c=0;c<3;c++){
      const value=weights.reduce((sum,w,i)=>sum+w*horizontal[off(x,cap(y+i-2,height),c)],0);
      filtered[off(x,y,c)]=value;
      peak=Math.max(peak,value);
      e+=value;
    }
    energy+=e;
    muX+=(x+.5)*e;
    muZ+=(y+.5)*e;
  }
  if(peak>irradianceScale)throw new RangeError('The caustic texture decode scale is below the reconstructed irradiance.');
  muX/=energy;
  muZ/=energy;
  let spread=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=off(x,y,0),e=filtered[i]+filtered[i+1]+filtered[i+2];
    spread+=e*(((x+.5-muX)*rect[0]/width)**2+((y+.5-muZ)*rect[1]/height)**2);
  }
  const scaleX=width/MAP_SIZE,scaleY=height/MAP_SIZE;
  const rgba=new Uint8Array(MAP_SIZE*MAP_SIZE*4);
  for(let y=0;y<MAP_SIZE;y++)for(let x=0;x<MAP_SIZE;x++){
    const xx=(x+.5)*scaleX-.5,yy=(y+.5)*scaleY-.5;
    const ix=Math.floor(xx),iy=Math.floor(yy),tx=xx-ix,ty=yy-iy;
    for(let c=0;c<3;c++){
      const at=(u,v)=>filtered[off(cap(u,width),cap(v,height),c)];
      const v=(at(ix,iy)*(1-tx)+at(ix+1,iy)*tx)*(1-ty)+(at(ix,iy+1)*(1-tx)+at(ix+1,iy+1)*tx)*ty;
      rgba[(y*MAP_SIZE+x)*4+c]=code(v/irradianceScale);
    }
    rgba[(y*MAP_SIZE+x)*4+3]=255;
  }
  const powerError=Math.max(...d.emitted.map((value,c)=>Math.abs(
    value+d.reflected[c]-sides.reduce((sum,name)=>sum+d[name][c],0))));
  return {rgba,stats:{collected:average(d.deposited)/average(d.emitted),spread:Math.sqrt(spread/energy),
    centroid:[table.minX+muX*rect[0]/width,table.minZ+muZ*rect[1]/height],
    photons:d.photons,peak,powerError,grid:[width,height]}};
}

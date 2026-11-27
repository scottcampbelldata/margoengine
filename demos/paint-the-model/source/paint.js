import {Texture} from '@margoengine/materials/texture';
import {atlasWidth as width,atlasHeight as height} from './model.js';

const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize=a=>{const length=Math.hypot(...a);return a.map(v=>v/length);};
const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));

export function paintTarget(kit){
  const stride=16, points=kit.vertices, elements=kit.indices;
  const triangles=new Float32Array(kit.helmetElements/3*stride);
  for(let i=0,j=0;i<kit.helmetElements;i+=3,j+=stride){
    const a=elements[i]*9,b=elements[i+1]*9,c=elements[i+2]*9;
    for(let k=0;k<3;k++){
      triangles[j+k]=points[a+k];
      triangles[j+3+k]=points[b+k]-points[a+k];
      triangles[j+6+k]=points[c+k]-points[a+k];
    }
    for(let k=0;k<2;k++){
      triangles[j+9+k]=points[a+6+k];
      triangles[j+11+k]=points[b+6+k]-points[a+6+k];
      triangles[j+13+k]=points[c+6+k]-points[a+6+k];
    }
    triangles[j+15]=points[a+8];
  }

  return function pick(camera,x,y,aspect){
    const p=camera.position, forward=normalize(camera.target.map((v,i)=>v-p[i]));
    const across=normalize(cross(forward,camera.up));
    const up=cross(across,forward), vfov=Math.tan(camera.fov*Math.PI/360);
    const sx=(x*2-1)*vfov*aspect,sy=(1-y*2)*vfov;
    const [dx,dy,dz]=forward.map((z,i)=>z+across[i]*sx+up[i]*sy);
    let distance=camera.far, uv=null;
    for(let j=0;j<triangles.length;j+=stride){
      const e1x=triangles[j+3],e1y=triangles[j+4],e1z=triangles[j+5];
      const e2x=triangles[j+6],e2y=triangles[j+7],e2z=triangles[j+8];
      const px=dy*e2z-dz*e2y,py=dz*e2x-dx*e2z,pz=dx*e2y-dy*e2x;
      const det=e1x*px+e1y*py+e1z*pz;
      if(Math.abs(det)<1e-10)continue;
      const inverse=1/det,tx=p[0]-triangles[j],ty=p[1]-triangles[j+1],tz=p[2]-triangles[j+2];
      const u=(tx*px+ty*py+tz*pz)*inverse;
      if(u<0||u>1)continue;
      const qx=ty*e1z-tz*e1y,qy=tz*e1x-tx*e1z,qz=tx*e1y-ty*e1x;
      const v=(dx*qx+dy*qy+dz*qz)*inverse;
      if(v<0||u+v>1)continue;
      const depth=(e2x*qx+e2y*qy+e2z*qz)*inverse;
      if(depth<camera.near||depth>=distance)continue;
      distance=depth;
      uv=triangles[j+15]===0?[
        triangles[j+9]+u*triangles[j+11]+v*triangles[j+13],
        triangles[j+10]+u*triangles[j+12]+v*triangles[j+14],
      ]:null;
    }
    return uv;
  };
}

const palettes={
  blue:[39,86,183],jade:[44,141,116],coral:[229,104,71],ivory:[229,199,154],graphite:[50,58,65],
};
const wrap=n=>(n%width+width)%width;
const historyLimit=12;
export function paintLayer(source){
  const pixels=source.slice();
  const texture=new Texture({data:pixels,width,height},
    {flipY:false,wrapS:'repeat',wrapT:'clamp',magFilter:'linear',minFilter:'linear',mipmaps:false});
  const undo=[];
  let before=null,previous=null,changed=false,different=0,lastRegion=null,revision=0;
  let x0=width,y0=height,x1=-1,y1=-1;
  function dirty(x,y){
    x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
  }
  function stroke(){
    before={pixels:pixels.slice(),different};
    changed=false;
    previous=null;
  }
  function stamp(u,v,r,ink){
    const x=u*width,y=v*height;
    const rx=r,ry=r*1.11;
    const left=Math.floor(x-rx),right=Math.ceil(x+rx);
    const top=clamp(Math.floor(y-ry),0,height-1),bottom=clamp(Math.ceil(y+ry),0,height-1);
    for(let row=top;row<=bottom;row++){
      const dy=(row+.5-y)/ry;
      for(let column=left;column<=right;column++){
        const dx=(column+.5-x)/rx;
        const distance=dx*dx+dy*dy;
        if(distance>=1)continue;
        const edge=clamp((1-distance)*3.65,0,1);
        const alpha=edge*edge*(3-2*edge)*(ink?.91:1);
        const tx=wrap(column),at=(row*width+tx)*4;
        let pixelChanged=false,wasDifferent=false,isDifferent=false;
        for(let c=0;c<3;c++){
          const base=source[at+c],pigment=ink?ink[c]:base;
          wasDifferent||=pixels[at+c]!==base;
          const value=Math.round(pixels[at+c]+(pigment-pixels[at+c])*alpha);
          isDifferent||=value!==base;
          if(value!==pixels[at+c]){
            pixels[at+c]=value;
            pixelChanged=true;
          }
        }
        if(pixelChanged){dirty(tx,row);changed=true;different+=Number(isDifferent)-Number(wasDifferent);}
      }
    }
  }
  function at(point,radius,key){
    if(!point){previous=null;return;}
    const ink=palettes[key];
    const [u,v]=point;
    if(previous){
      let delta=u-previous[0];
      delta-=Math.round(delta);
      const dy=v-previous[1],length=Math.hypot(delta*width,dy*height);
      // A fast pointer jump or a silhouette gap starts a new segment instead of painting through the air.
      if(length<=94){
        const count=Math.max(1,Math.ceil(length/Math.max(2,radius*.29)));
        for(let i=1;i<=count;i++){
          const t=i/count;
          stamp(previous[0]+delta*t,previous[1]+dy*t,radius,ink);
        }
      }else stamp(u,v,radius,ink);
    }else stamp(u,v,radius,ink);
    previous=point;
  }
  function append(step){
    undo.push(step);
    if(undo.length>historyLimit)undo.shift();
  }
  function finish(){
    if(changed&&before)append(before);
    before=null;
    previous=null;
    changed=false;
  }
  function upload(){
    if(x1<x0||y1<y0)return false;
    lastRegion={x:x0,y:y0,width:x1-x0+1,height:y1-y0+1};
    texture.update(lastRegion);
    x0=width;y0=height;x1=y1=-1;
    revision++;
    return true;
  }
  function restore(snapshot,count){
    pixels.set(snapshot);
    texture.update();
    x0=width;y0=height;x1=y1=-1;
    lastRegion=null;
    revision++;
    different=count;
  }
  return {texture,stroke,at,finish,upload,
    get revision(){return revision;},get hasUndo(){return undo.length>0;},get edited(){return different>0;},
    get region(){return lastRegion;},
    undo(){const step=undo.pop();if(step)restore(step.pixels,step.different);return !!step;},
    reset(){if(!different)return false;append({pixels:pixels.slice(),different});restore(source,0);return true;},
  };
}

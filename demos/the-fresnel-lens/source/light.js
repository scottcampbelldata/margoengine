import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { baseDepth, centerRadius, facets, lensRadius } from './optics.js';

const vertex=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
  @location(2) pos:vec3f,
  @location(3) norm:vec3f,
}
@vertex fn vertex(a:Attributes)->Varying {
  let p=mesh.world*vec4f(a.position,1.0);
  return Varying(camera.viewProjection*p,a.uv,a.mode,p.xyz,mesh.normal*a.direction);
}`;
const fragment=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
  @location(2) pos:vec3f,
  @location(3) norm:vec3f,
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let uv=i.uv;
  var color=vec3f(.92,.57,.23);
  var opacity=1.0;
  if(i.mode<1.5){
    let radial=uv.x*uv.x;
    color=mix(vec3f(.80,.34,.088),vec3f(1.0,.87,.54),exp(-27.0*radial));
    opacity=.84*exp(-31.0*radial)+.17*exp(-5.0*radial);
    if(i.mode>.5){opacity=opacity*.78;}
  } else if(i.mode<4.5) {
    let view=normalize(camera.position-i.pos);
    let N=normalize(i.norm);
    let reflected=reflect(-view,N);
    let fresnel=pow(max(0.0,1.0-abs(dot(view,N))),5.0);
    let ribbon=reflected.y+.46*reflected.z-.26;
    let glint=exp(-18.0*ribbon*ribbon);
    let opposite=exp(-12.0*abs(reflected.y+.78));
    if(i.mode<2.5){
      let land=1.0-smoothstep(.78,1.0,abs(uv.x));
      color=vec3f(.09,.35,.25)+glint*vec3f(.25,.45,.32)+opposite*vec3f(.30,.26,.09);
      opacity=.24+.51*fresnel+.18*glint+.05*land;
    } else if(i.mode<3.5) {
      color=vec3f(.07,.183,.134)+glint*vec3f(.51,.60,.36)+opposite*vec3f(.22,.23,.10);
      opacity=.66+.19*fresnel;
    } else {
      color=vec3f(.17,.42,.35)+opposite*.12;
      opacity=.08+.19*fresnel+.11*glint;
    }
  } else if(i.mode<5.5){
    let distance=dot(uv,uv);
    color=mix(vec3f(.97,.37,.07),vec3f(1.0,.94,.67),exp(-9.0*distance));
    opacity=1.0-smoothstep(.59,1.0,distance);
  } else if(i.mode<6.5) {
    let radius=dot(uv,uv);
    color=vec3f(1.0,.69,.27);
    opacity=.89*exp(-11.0*radius)+.13*exp(-2.8*radius);
  } else {
    let grid=abs(fract(uv*6.0+.5)-.5);
    let gridline=1.0-smoothstep(.012,.029,min(grid.x,grid.y));
    let edge=smoothstep(.88,1.0,max(abs(uv.x),abs(uv.y)));
    color=vec3f(.48,.61,.62);
    opacity=.075+.07*gridline+.12*edge;
  }
  let brightness=clamp(color,vec3f(0.0),vec3f(1.0));
  return vec4f(margoEncode(vec4f(brightness,1.0)).rgb,opacity);
}`;

export function installLight(engine){
  const material=new RawShaderMaterial({
    vertexShader:vertex,fragmentShader:fragment,blending:'normal',transparent:true,depthWrite:false,cull:'none',
  });
  const raw=RawShaders.attach(engine);
  function mount(parent,positions,uv,mode,index,normals=positions.map((_,i)=>i%3===0?1:0)){
    const usage=typeof mode==='number'?new Float32Array(positions.length/3).fill(mode):new Float32Array(mode);
    return raw.add(new RawMesh({
      mesh:parent,material,index,
      attributes:{
        position:{data:new Float32Array(positions),type:'vec3f'},
        uv:{data:new Float32Array(uv),type:'vec2f'},
        mode:{data:usage,type:'f32'},
        direction:{data:new Float32Array(normals),type:'vec3f'},
      },
    }));
  }
  function plate(parent,radius,mode){
    return mount(parent,[0,-radius,-radius,0,radius,-radius,0,radius,radius,0,-radius,radius],
      [-1,-1,1,-1,1,1,-1,1],mode,[0,1,2,0,2,3]);
  }
  function lens(parent){
    const positions=[],normals=[],uv=[],modes=[],indices=[];
    const n=100;
    const spin=Array.from({length:n},(_,i)=>[Math.cos(i*Math.PI*2/n),Math.sin(i*Math.PI*2/n)]);
    function ring(r1,x1,r2,x2,mode,axial,radial){
      const at=positions.length/3;
      for(const [cos,sin] of spin){
        positions.push(x1,r1*cos,r1*sin,x2,r2*cos,r2*sin);
        normals.push(axial,radial*cos,radial*sin,axial,radial*cos,radial*sin);
        uv.push(-1,cos,1,sin);
        modes.push(mode,mode);
      }
      for(let i=0;i<n;i++){
        const a=at+2*i,b=at+2*((i+1)%n);
        indices.push(a,a+1,b+1,a,b+1,b);
      }
    }
    function disc(radius,x,mode,normal){
      const at=positions.length/3;
      positions.push(x,0,0);
      normals.push(normal,0,0);
      uv.push(0,0);
      modes.push(mode);
      for(const [cos,sin] of spin){
        positions.push(x,radius*cos,radius*sin);
        normals.push(normal,0,0);
        uv.push(cos,sin);
        modes.push(mode);
      }
      for(let i=0;i<n;i++)indices.push(at,at+1+i,at+1+(i+1)%n);
    }
    disc(lensRadius,0,4,-1);
    disc(centerRadius,baseDepth,2,1);
    for(const facet of facets){
      ring(facet.inner,baseDepth,facet.inner,facet.innerDepth,3,0,-1);
      ring(facet.inner,facet.innerDepth,facet.outer,baseDepth,2,Math.cos(facet.normal),Math.sin(facet.normal));
    }
    ring(lensRadius,baseDepth,lensRadius,0,3,0,1);
    mount(parent,positions,uv,modes,indices,normals);
  }
  return {
    lens,plate,
    async ready(){await raw.ready();if(material.error)throw material.error;},
    beam(parent,inner){
      return mount(parent,[-1,0,0,1,0,0,1,0,1,-1,0,1,0,-1,0,0,1,0,0,1,1,0,-1,1],
        [-1,0,1,0,1,1,-1,1,-1,0,1,0,1,1,-1,1],Number(inner),[0,1,2,0,2,3,4,5,6,4,6,7]);
    },
  };
}

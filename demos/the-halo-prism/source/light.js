import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { bins, haloProfile, maxRadius, minRadius, prismHeight, prismRadius, prismVertices, rad, skyHalfAngle } from './optics.js';

const tangent=Math.tan(skyHalfAngle*rad).toFixed(8);
const vertex=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) kind:f32,
  @location(2) world:vec3f,
  @location(3) normal:vec3f,
}
@vertex fn vertex(a:Attributes)->Varying{
  let p=mesh.world*vec4f(a.position,1.0);
  return Varying(camera.viewProjection*p,a.uv,a.kind,p.xyz,mesh.normal*a.direction);
}`;
const fragment=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) kind:f32,
  @location(2) world:vec3f,
  @location(3) normal:vec3f,
}
@fragment fn fragment(i:Varying)->@location(0) vec4f{
  let uv=i.uv;
  let kind=round(i.kind);
  var color=vec3f(.88,.52,.19);
  var alpha=1.0;
  if(kind<1.5){
    let width=uv.x*uv.x;
    let line=exp(-29.0*width);
    color=mix(vec3f(.98,.48,.094),vec3f(1.0,.91,.61),line);
    alpha=.87*line+.13*exp(-3.9*width);
    if(kind>.5){color=vec3f(.52,.77,.97);alpha*=.62;}
  } else if(kind<2.5) {
    let unitView=normalize(camera.position-i.world);
    let N=normalize(i.normal);
    let reflected=reflect(-unitView,N);
    let fresnel=pow(max(0.0,1.0-abs(dot(unitView,N))),4.0);
    let ribbon=reflected.y+.39*reflected.z+.17;
    let gleam=exp(-12.0*ribbon*ribbon);
    let side=smoothstep(.67,1.0,max(abs(uv.x),abs(uv.y)));
    let frost=exp(-13.0*abs(uv.x+uv.y*.38));
    color=vec3f(.21,.55,.68)+gleam*vec3f(.21,.32,.26)+frost*.16;
    alpha=.15+.32*fresnel+.28*side+.15*gleam;
  } else if(kind<3.5) {
    let disk=length(uv);
    let theta=atan(disk*${tangent})*57.2957795131;
    let u=(theta-${minRadius.toFixed(1)})/${(maxRadius-minRadius).toFixed(1)};
    let address=(.5+clamp(u,0.0,1.0)*${(bins-1).toFixed(1)})/${bins.toFixed(1)};
    let intensity=textureSampleLevel(histogram,histogramSampler,vec2f(address,.5),0.0).rgb;
    let angleGate=smoothstep(0.0,.03,u)*(1.0-smoothstep(.92,1.0,u));
    let sky=mix(vec3f(.056,.173,.28),vec3f(.111,.37,.62),1.0-smoothstep(-.90,.80,uv.y));
    let wave1=uv.y-.07*sin(uv.x*5.6)+.40-uv.x*.29;
    let wave2=uv.y+.05*sin(uv.x*8.6)-.34+uv.x*.18;
    let cirrus=exp(-29.0*wave1*wave1)*.024+exp(-95.0*wave2*wave2)*.036;
    let sun=(1.0-smoothstep(.012,.025,disk))+.64*exp(-390.0*disk*disk)+.13*exp(-35.0*disk*disk);
    let shimmer=intensity*vec3f(1.02,.86,.88)*angleGate;
    let reticlePos=vec2f(.850,.5267827)*uniforms.marker;
    let d=length(uv-reticlePos);
    let reticle=(1.0-smoothstep(.004,.013,abs(d-.025)))+.40*(1.0-smoothstep(.005,.013,d));
    let marks=smoothstep(.865,.923,disk)*(1.0-smoothstep(.963,.990,disk));
    let sliver=1.0-smoothstep(.004,.016,min(abs(uv.x),abs(uv.y)));
    color=sky+cirrus+shimmer+sun*vec3f(1.0,.97,.79)+reticle*vec3f(.14,.64,.78)+marks*sliver*.16;
    if(disk>1.0){discard;}
  } else {
    let d=dot(uv,uv);
    color=mix(vec3f(.97,.48,.082),vec3f(1.0,.95,.70),exp(-8.0*d));
    alpha=1.0-smoothstep(.60,1.0,d);
  }
  let brightness=clamp(color,vec3f(0.0),vec3f(1.0));
  return vec4f(margoEncode(vec4f(brightness,1.0)).rgb,alpha);
}`;

export function installLight(engine){
  const pixels=haloProfile();
  let texture;
  const material=new RawShaderMaterial({
    name:'Ice, refracted ray and solar halo',
    vertexShader:vertex,fragmentShader:fragment,uniforms:{marker:{value:.63}},
    textures:{histogram:{texture:(device)=>{
      texture=device.createTexture({
        label:'Projected halo scattering density',size:[bins,1,1],format:'rgba8unorm',
        usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({texture},pixels,{bytesPerRow:bins*4},{width:bins,height:1,depthOrArrayLayers:1});
      return texture;
    },sampler:{magFilter:'linear',minFilter:'linear'}}},
    blending:'normal',transparent:true,depthWrite:false,cull:'none',
  });
  const raw=RawShaders.attach(engine);
  function mount(parent,pos,uv,kind,index,normals=pos.map((_,i)=>i%3===2?1:0)){
    return raw.add(new RawMesh({
      mesh:parent,material,index,
      attributes:{
        position:{data:new Float32Array(pos),type:'vec3f'},
        uv:{data:new Float32Array(uv),type:'vec2f'},
        kind:{data:new Float32Array(pos.length/3).fill(kind),type:'f32'},
        direction:{data:new Float32Array(normals),type:'vec3f'},
      },
    }));
  }
  const corners=[-1,-1,1,-1,1,1,-1,1];
  const quad=[0,1,2,0,2,3];
  function plate(parent,radius,kind){
    mount(parent,[-radius,-radius,0,radius,-radius,0,radius,radius,0,-radius,radius,0],corners,kind,quad);
  }
  function prism(parent){
    const p=[],uv=[],normal=[],index=[];
    const y=prismHeight/2;
    for(let i=0;i<6;i++){
      const [x1,z1]=prismVertices[i], [x2,z2]=prismVertices[(i+1)%6];
      const direction=(i+.5)*Math.PI/3;
      const n=[Math.cos(direction),0,Math.sin(direction)];
      const at=p.length/3;
      p.push(x1,-y,z1,x2,-y,z2,x2,y,z2,x1,y,z1);
      uv.push(...corners);
      normal.push(...n,...n,...n,...n);
      index.push(...quad.map((j)=>j+at));
    }
    for(const sign of [-1,1]){
      const at=p.length/3;
      for(const [x,z] of prismVertices){
        p.push(x,sign*y,z);
        uv.push(x/prismRadius,z/prismRadius);
        normal.push(0,sign,0);
      }
      for(let i=1;i<5;i++)index.push(at,at+i,at+i+1);
    }
    mount(parent,p,uv,2,index,normal);
  }
  return {
    plate,prism,
    async ready(){await raw.ready();if(material.error)throw material.error;},
    update(deviation){material.uniforms.marker.value=Math.tan(deviation*rad)/Math.tan(skyHalfAngle*rad);},
    dispose(){texture?.destroy();},
    beam(parent,kind){
      mount(parent,[-1,0,0,1,0,0,1,0,1,-1,0,1,0,-1,0,0,1,0,0,1,1,0,-1,1],
        [-1,0,1,0,1,1,-1,1,-1,0,1,0,1,1,-1,1],kind,[0,1,2,0,2,3,4,5,6,4,6,7]);
    },
  };
}

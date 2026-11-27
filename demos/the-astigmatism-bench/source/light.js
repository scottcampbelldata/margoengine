import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';

const vertex = `
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
}
@vertex fn vertex(a:Attributes)->Varying {
  return Varying(camera.viewProjection * mesh.world * vec4f(a.position,1.0),a.uv,a.mode);
}`;
const fragment = `
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let uv=i.uv;
  let sample=uv*vec2f(0.092,0.088);
  let radius=length(sample/uniforms.displayRadius);
  let soft=clamp(fwidth(radius),0.10,0.60);
  let aa=max(fwidth(sample)*80.0,vec2f(0.008,0.008));
  var color=vec3f(0.52,0.83,0.98);
  var opacity=1.0;
  if (i.mode < 2.5) {
    if (i.mode < 0.5) { color=vec3f(0.99,0.52,0.22); }
    if (i.mode > 1.5) { color=vec3f(0.88,0.83,0.72); }
    opacity=(0.84*exp(-21.0*uv.x*uv.x)+0.16*exp(-3.2*uv.x*uv.x))*(0.64+0.34*uv.y);
    if (i.mode > 1.5) { opacity=0.65*opacity; }
  } else if (i.mode < 3.5) {
    let edge=dot(uv,uv);
    let ribbon=uv.x+0.40*uv.y+0.22;
    let coating=exp(-49.0*ribbon*ribbon);
    color=mix(vec3f(0.12,0.049,0.30),vec3f(0.46,0.65,0.72),0.45*edge+0.38*coating);
    opacity=(0.20+0.58*edge*edge+0.18*coating)*(1.0-smoothstep(0.974,1.01,edge));
  } else {
    let spot=1.0-smoothstep(1.0-soft,1.0+soft,radius);
    let spill=exp(-1.17*radius*radius);
    let toned=mix(vec3f(0.050,0.037,0.064),vec3f(0.153,0.137,0.169),1.0-dot(uv*0.68,uv*0.68));
    let nearLine=abs(fract(sample*80.0+0.5)-0.5);
    let lines=1.0-smoothstep(vec2f(0.014,0.014),vec2f(0.014,0.014)+aa,nearLine);
    let ruled=max(lines.x,lines.y)*(1.0-smoothstep(0.83,1.01,max(abs(uv.x),abs(uv.y))));
    let axes=1.0-smoothstep(0.0,0.010,min(abs(uv.x),abs(uv.y)));
    let haze=fract(sin(dot(floor(sample*7500.0),vec2f(127.1,311.7)))*43758.5453)*0.018;
    let glass=toned+vec3f(0.046,0.038,0.048)*(ruled+axes*0.65)+haze;
    let halo=mix(vec3f(0.91,0.29,0.34),vec3f(0.33,0.62,0.92),uniforms.hueMix);
    color=glass+halo*0.52*spill+vec3f(0.93,0.87,0.74)*0.95*spot;
  }
  let brightness=clamp(color,vec3f(0.0),vec3f(1.0));
  return vec4f(margoEncode(vec4f(brightness,1.0)).rgb,opacity);
}`;

export function installOptics(engine) {
  const material = new RawShaderMaterial({
    vertexShader:vertex, fragmentShader:fragment,
    uniforms:{displayRadius:{value:[.020,.020]},hueMix:{value:.5}},
    blending:'normal', transparent:true, depthWrite:false, cull:'none',
  });
  const raw = RawShaders.attach(engine);

  function mount(parent, positions, uv, mode, index) {
    return raw.add(new RawMesh({
      mesh: parent, material, index,
      attributes:{
        position:{data:new Float32Array(positions),type:'vec3f'},
        uv:{data:new Float32Array(uv),type:'vec2f'},
        mode:{data:new Float32Array(positions.length/3).fill(mode),type:'f32'},
      },
    }));
  }

  return {
    async ready() { await raw.ready(); if (material.error) throw material.error; },
    update([horizontal, vertical]) {
      material.uniforms.displayRadius.value = [Math.max(.0012,horizontal), Math.max(.0012,vertical)];
      material.uniforms.hueMix.value = vertical / Math.max(.00001,horizontal+vertical);
    },
    beam(parent, mode) {
      return mount(parent,[-1,0,0,1,0,0,1,0,1,-1,0,1,0,-1,0,0,1,0,0,1,1,0,-1,1],
        [-1,0,1,0,1,1,-1,1,-1,0,1,0,1,1,-1,1],mode,[0,1,2,0,2,3,4,5,6,4,6,7]);
    },
    lens(parent, radius) {
      const space=[.012,0,0], uv=[0,0], index=[];
      const wedges=64, bands=10;
      for(let band=1;band<=bands;band++)for(let edge=0;edge<wedges;edge++){
        const angle=2*Math.PI*edge/wedges;
        const u=band/bands*Math.cos(angle);
        const v=band/bands*Math.sin(angle);
        // A decorative toric face. The two powers are represented analytically by the ray model.
        const crown=(1-u*u-v*v)*(.012-.0021*u*u+.004*v*v);
        space.push(crown,v*radius,u*radius);
        uv.push(u,v);
        const last=1+(band-1)*wedges+edge;
        const next=1+(band-1)*wedges+(edge+1)%wedges;
        if(band===1)index.push(0,last,next);
        else index.push(last-wedges,last,next,last-wedges,next,next-wedges);
      }
      mount(parent,space,uv,3,index);
    },
    screen(parent) {
      mount(parent,[0,-.088,-.092,0,-.088,.092,0,.088,.092,0,.088,-.092],
        [-1,-1,1,-1,1,1,-1,1],4,[0,1,2,0,2,3]);
    },
  };
}

import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { imagePosition, profileLength, profileRadius, target } from './optics.js';

const format = (v)=>v.toFixed(9);
const starCoordinates = target.map(imagePosition).map(([x,y])=>`vec2f(${format(x)},${format(y)})`);
const targetCoordinates = target.map(([x,y])=>`vec2f(${format(x/.0059)},${format(y/.0048)})`);
const vertex = `
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) channel:f32,
}
@vertex fn vertex(a:Attributes)->Varying {
  return Varying(camera.viewProjection*mesh.world*vec4f(a.position,1.0),a.uv,a.channel);
}`;
const fragment = `
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) channel:f32,
}
fn spread(point:vec2f,centre:vec2f,channel:u32)->f32{
  let norm=length(point-centre)/${profileRadius.toFixed(6)};
  let address=(0.5+clamp(norm,0.0,1.0)*${(profileLength-1).toFixed(1)})/${profileLength.toFixed(1)};
  let coeff=textureSampleLevel(density,densitySampler,vec2f(address,0.5),0.0)[channel];
  return coeff*coeff*(1.0-smoothstep(0.97,1.0,norm));
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let grid=i.uv;
  let channel=u32(clamp(round(i.channel),0.0,2.0));
  var color=vec3f(0.010,0.027,0.020);
  if(i.channel<2.5){
    let point=grid*vec2f(0.00290,0.00190);
    let sum=${starCoordinates.map((v)=>`spread(point,${v},channel)`).join('+')};
    let light=1.0-exp(-1.8*sum);
    let vignette=1.0-0.40*length(grid*0.51);
    let hair=1.0-smoothstep(vec2f(0.004),vec2f(0.018),abs(grid));
    let ticks=1.0-smoothstep(vec2f(0.014),vec2f(0.039),abs(fract((grid+0.05)*10.0)-0.5));
    let trace=max(hair.x*(0.010+0.013*ticks.y),hair.y*(0.010+0.013*ticks.x));
    let face=vignette*vec3f(0.010+trace,0.030+trace,0.023+trace);
    color=face+light*mix(vec3f(0.13,0.85,0.52),vec3f(0.96,1.00,0.82),pow(light,2.1));
  } else if (i.channel<3.5) {
    var lamps=0.0;
    ${targetCoordinates.map((v)=>`lamps=max(lamps,exp(-330.0*dot(grid-${v},grid-${v})));`).join('\n    ')}
    color=vec3f(0.113,0.074,0.027)+lamps*vec3f(.88,.54,.21);
  } else {
    let waist=uniforms.apertureRadius[u32(round(i.channel)-4.0)];
    let distance=length(i.uv);
    let at=smoothstep(waist*0.81,waist*1.35,distance);
    let ring=smoothstep(.28,.90,distance);
    color=mix(vec3f(0.16,0.27,0.20),vec3f(.023+.038*ring,.030+.041*ring,.027+.033*ring),at);
  }
  return margoEncode(vec4f(clamp(color,vec3f(0.0),vec3f(1.0)),1.0));
}`;

// Both Margo backends sample the same compact 1D optical calculation.
export function installDisplays(engine) {
  let picture=new Uint8Array(profileLength*4);
  let texture,textureDevice;
  function upload(device) {
    device.queue.writeTexture({texture},picture,{bytesPerRow:profileLength*4},
      {width:profileLength,height:1,depthOrArrayLayers:1});
  }
  const display=new RawShaderMaterial({
    vertexShader:vertex,fragmentShader:fragment,cull:'none',
    uniforms:{apertureRadius:{value:[.020,.036,.061]}},
    textures:{density:{
      texture:(device)=>{
        textureDevice=device;
        texture=device.createTexture({
          label:'Circular-aperture Fresnel profiles',size:[profileLength,1,1],format:'rgba8unorm',
          usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST,
        });
        upload(device);
        return texture;
      },
      sampler:{minFilter:'linear',magFilter:'linear'},
    }},
  });
  const raw=RawShaders.attach(engine);
  function face(anchor,halfWidth,halfHeight,channel) {
    raw.add(new RawMesh({
      mesh:anchor,material:display,index:[0,1,2,0,2,3],
      attributes:{
        position:{data:new Float32Array([-halfWidth,-halfHeight,0,halfWidth,-halfHeight,0,halfWidth,halfHeight,0,-halfWidth,halfHeight,0]),type:'vec3f'},
        uv:{data:new Float32Array([-1,-1,1,-1,1,1,-1,1]),type:'vec2f'},
        channel:{data:new Float32Array(4).fill(channel),type:'f32'},
      },
    }));
  }
  return {
    face,
    update(samples) {
      picture=samples.column;
      display.uniforms.apertureRadius.value=samples.mm.map((mm)=>mm*.0005/.009);
      if(textureDevice) upload(textureDevice);
    },
    dispose() {
      texture?.destroy();
    },
    async ready() { await raw.ready(); if(display.error) throw display.error; },
  };
}

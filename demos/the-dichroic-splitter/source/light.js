import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';

// The guides and illuminated areas share a material so each renderer compiles one optics pipeline.
const vertex=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) coordinate:vec2f,
  @location(1) usage:f32,
}
@vertex fn vertex(a:Attributes)->Varying {
  return Varying(camera.viewProjection * mesh.world * vec4f(a.position,1.0),a.coordinate,a.usage);
}`;
const fragment=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) coordinate:vec2f,
  @location(1) usage:f32,
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  var color=vec3f(0.94,0.96,1.0);
  if ((i.usage > 0.5 && i.usage < 1.5) || (i.usage > 3.5 && i.usage < 4.5)) {
    color=uniforms.transmitted;
  }
  if ((i.usage > 1.5 && i.usage < 3.5) || i.usage > 4.5) { color=uniforms.reflected; }
  let uv=i.coordinate;
  var opacity=0.0;
  if (i.usage < 2.5) {
    let width=uv.x*uv.x;
    opacity=exp(-22.0*width)*0.78+exp(-5.8*width)*0.28;
  } else if (i.usage < 3.5) {
    color=mix(vec3f(0.11,0.18,0.25),color,0.58);
    let rim=smoothstep(0.70,1.0,max(abs(uv.x),abs(uv.y)));
    let sheen=uv.x+uv.y*0.7;
    opacity=0.14+0.20*rim+0.07*exp(-14.0*sheen*sheen);
  } else {
    let d=dot(uv,uv);
    opacity=0.98*exp(-7.0*d)+0.26*exp(-2.6*d);
  }
  let brightness=clamp(color,vec3f(0.0),vec3f(1.0));
  return vec4f(margoEncode(vec4f(brightness,1.0)).rgb,min(1.0,opacity));
}`;

export function installLight(engine) {
  const material=new RawShaderMaterial({
    vertexShader:vertex,fragmentShader:fragment,
    uniforms:{reflected:{value:[.05,.8,1]},transmitted:{value:[1,.20,.04]}},
    blending:'additive',transparent:true,depthWrite:false,cull:'none',
  });
  const raw=RawShaders.attach(engine);
  function mount(parent,points,coords,usage,indices){
    raw.add(new RawMesh({
      mesh:parent,material,
      attributes:{position:{data:new Float32Array(points),type:'vec3f'},
        coordinate:{data:new Float32Array(coords),type:'vec2f'},
        usage:{data:new Float32Array(points.length/3).fill(usage),type:'f32'}},
      index:indices,
    }));
  }
  return {
    async ready(){await raw.ready();if(material.error)throw material.error;},
    update({reflected,transmitted}){
      material.uniforms.reflected.value=reflected;
      material.uniforms.transmitted.value=transmitted;
    },
    beam(parent,usage){
      mount(parent,[-1,0,0,1,0,0,1,0,1,-1,0,1,0,-1,0,0,1,0,0,1,1,0,-1,1],
        [-1,0,1,0,1,1,-1,1,-1,0,1,0,1,1,-1,1],usage,[0,1,2,0,2,3,4,5,6,4,6,7]);
    },
    panel(parent,width,height,usage){
      mount(parent,[-width,-height,0,width,-height,0,width,height,0,-width,height,0],
        [-1,-1,1,-1,1,1,-1,1],usage,[0,1,2,0,2,3]);
    },
  };
}

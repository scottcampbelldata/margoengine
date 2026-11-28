import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { distanceLimit, maxAngle, minAngle, rayTable, samples } from './optics.js';

const vertex = `
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
}
@vertex fn vertex(a:Attributes)->Varying {
  return Varying(vec4f(a.position.xy,.000002,1.0),a.position.xy*vec2f(.5)+vec2f(.5));
}
`;

const fragment = `
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
}
fn hash(p:vec2f)->f32 {
  let f=fract(vec3f(p.xyx)*vec3f(.1031,.1073,.0973));
  let g=f+dot(f,f.yzx+19.19);
  return fract((g.x+g.y)*g.z);
}
fn noise(p:vec2f)->f32 {
  let cell=floor(p);
  let part=fract(p);
  let w=part*part*(3.0-2.0*part);
  return mix(mix(hash(cell),hash(cell+vec2f(1.0,0.0)),w.x),
    mix(hash(cell+vec2f(0.0,1.0)),hash(cell+vec2f(1.0)),w.x),w.y);
}
fn brokenCloud(p:vec2f)->f32 {
  let q=vec2f(p.x+noise(p*.39)*.58,p.y);
  return noise(q)*.54+noise(q*2.12)*.28+noise(q*4.47)*.12+noise(q*8.27)*.06;
}
fn mesa(u:f32,center:f32,width:f32,top:f32)->f32 {
  let r=(u-center)/width;
  let profile=select(1.0-smoothstep(.22,1.0,-r),1.0-smoothstep(.35,1.0,r),r>0.0);
  let undulation=.87+.08*sin(r*17.2)+.045*sin(r*37.4)+.022*cos(r*79.7);
  return top*profile*undulation;
}
fn skyline(s:f32,h:f32)->vec3f {
  let air=mix(vec3f(.98,.62,.37),vec3f(.34,.48,.63),smoothstep(0.0,1.65,h));
  let warm=vec3f(1.0,.84,.60);
  let sun=vec2f(s+.585,(h-.48)*.45);
  let flare=exp(-7.0*dot(sun,sun))*.64;
  let cloudScale=vec2f(s*7.0,h*6.4);
  let billow=brokenCloud(cloudScale+vec2f(.6,.7));
  let lowBand=h-.99+s*.16;
  let highBand=h-1.41+s*.31;
  let bands=exp(-29.0*lowBand*lowBand)*.44+exp(-53.0*highBand*highBand)*.63;
  let tinted=mix(air,warm,flare);
  let clouds=smoothstep(.47,.69,billow)*bands;
  var color=mix(tinted,mix(vec3f(.36,.30,.36),vec3f(.98,.69,.51),smoothstep(.08,.49,clouds)),clouds*.80);
  let fineCirrus=brokenCloud(vec2f(s*3.6+2.2,h*22.0+s*4.0));
  color+=smoothstep(.56,.76,fineCirrus)*vec3f(.12,.087,.064)*smoothstep(.43,1.6,h);


  let distant=max(max(mesa(s,-1.04,.52,.36),mesa(s,-.51,.44,.355)),
    max(mesa(s,.05,.63,.18),mesa(s,.98,.57,.37)));
  let farHaze=vec3f(.52,.34,.34)+vec3f(.10,.063,.053)*exp(-2.4*abs(s+.60));
  color=mix(color,farHaze,1.0-smoothstep(distant-.011,distant+.012,h));
  let near=max(max(mesa(s,-.86,.54,.54),mesa(s,-.51,.21,.38)),
    max(max(mesa(s,.66,.57,.90),mesa(s,.295,.33,.41)),mesa(s,1.03,.45,.58)));
  let wall=exp(-8.0*abs(fract(h*8.6+sin(s*14.0)*.07)-.51));
  let gullies=noise(vec2f(s*28.0+h*.75,h*3.5));
  let saddle=smoothstep(.10,.48,near-h);
  let rock=mix(vec3f(.32,.17,.16),vec3f(.50,.275,.219),gullies*.64+wall*.18);
  let dust=mix(rock,vec3f(.55,.33,.28),saddle*.62);
  return mix(color,dust,1.0-smoothstep(near-.008,near+.009,h));
}
fn ground(s:f32,d:f32)->vec3f {
  let x=.91+s*.20*d;
  let p=vec2f(x,d);
  let weather=noise(p*vec2f(.38,.19));
  let grain=noise(p*vec2f(22.0,17.0));
  let r=fract(p*vec2f(.77,.62));
  let jitter=vec2f(hash(floor(p*.67)),hash(floor(p*.82)+2.47))*.29;
  let shrub=1.0-smoothstep(.17,.36,length((r-vec2f(.35)-jitter)*vec2f(1.1,1.5)));
  let dry=mix(vec3f(.30,.16,.119),vec3f(.56,.337,.221),weather);
  let sand=dry+vec3f(.127,.094,.063)*(grain-.5);
  let weeds=mix(sand,vec3f(.245,.213,.139),shrub*smoothstep(4.6,8.0,abs(x))*.77);
  let roadEdge=3.95+noise(vec2f(.0,d*.29))*.115+noise(p*4.5)*.055;
  let road=1.0-smoothstep(roadEdge-.044,roadEdge+.21,abs(x));
  let aggregate=.10*(grain-.45)+.042*(noise(p*vec2f(6.6,4.7))-.5);
  let patches=noise(p*vec2f(1.77,.32))*.028;
  let asphalt=mix(vec3f(.185,.172,.18),vec3f(.294,.25,.238),weather)+aggregate-patches;
  let aa=max(.018,d*.0011);
  let edge=1.0-smoothstep(.04-aa,.069+aa,abs(abs(x)-3.70));
  let stripe=1.0-smoothstep(.052-aa,.085+aa,abs(abs(x)-.165));
  let wear=smoothstep(.08,.42,grain)*smoothstep(.06,.21,weather);
  let pavement=mix(asphalt,vec3f(.83,.69,.47),stripe*wear*.87);
  var color=mix(weeds,mix(pavement,vec3f(.73,.67,.57),edge*wear*.69),road);
  let oblique=s+.40;
  color*=.77+.24*exp(-3.2*oblique*oblique);
  let dust=1.0-exp(-d*.004);
  let horizon=vec3f(.542,.362,.302);
  return mix(color,horizon,dust*.83);
}
fn shoulder(s:f32,elevation:f32,distance:f32,color:vec3f)->vec3f {
  let x=.91+s*.20*distance;
  let h=.50+distance*tan(elevation*.01745329252);
  let falloff=smoothstep(4.10,9.20,abs(x));
  let gravel=noise(vec2f(x*6.5,h*23.0));
  let riffle=noise(vec2f(x*.63,3.17));
  let bank=falloff*(.47+.058*sin(x*1.26)+.064*riffle);
  let crest=smoothstep(.075,.23,bank-h);
  let surface=mix(vec3f(.40,.247,.204),vec3f(.62,.381,.269),gravel*.44+riffle*.28);
  let weeds=smoothstep(.35,.60,noise(vec2f(x*2.9,h*5.5)));
  let soil=mix(surface,vec3f(.345,.271,.181),weeds*.44)-crest*.033;
  let mask=(1.0-smoothstep(bank-.008,bank+.004,h))*falloff;
  return mix(color,soil,mask*.98);
}
fn surveyPost(s:f32,elevation:f32,distance:f32,lateral:f32,height:f32,color:vec3f)->vec3f {
  let x=.91+s*.20*distance;
  let h=.50+distance*tan(elevation*.01745329252);
  let w=abs(x-lateral);
  let body=1.0-smoothstep(.032,.050,w);
  let top=height-w*.62;
  let visible=body*(1.0-smoothstep(top-.016,top+.006,h))*smoothstep(.15,.21,h);
  let side=smoothstep(lateral-.024,lateral+.022,x);
  let tape=smoothstep(height-.19,height-.16,h)*(1.0-smoothstep(height-.087,height-.063,h));
  let metal=mix(vec3f(.40,.337,.307),vec3f(.74,.669,.563),side);
  let cap=mix(metal,vec3f(.264,.206,.186),smoothstep(height-.068,height-.038,h));
  let marker=mix(cap,vec3f(.743,.351,.17),tape*.89);
  return mix(color,marker,visible*.98);
}
fn positionFrom(value:vec4f)->f32 {
  let channels=round(255.0*value.rg);
  return (256.0*channels.x+channels.y)/65535.0;
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let uv=i.uv;
  let s=uv.x*2.0-1.0;
  var color=vec3f(.16,.13,.145);
  if(uniforms.section<.5) {
    let address=uv.y*${samples-1}.0;
    let floorIndex=floor(address);
    let lower=textureSampleLevel(rays,raysSampler,vec2f((floorIndex+.5)/${samples}.0,.5),0.0);
    let upper=textureSampleLevel(rays,raysSampler,vec2f(min(floorIndex+1.5,${samples-.5})/${samples}.0,.5),0.0);
    let rounded=select(upper,lower,fract(address)<.5);
    let across=lower.b!=upper.b;
    let fraction=select(mix(positionFrom(lower),positionFrom(upper),fract(address)),positionFrom(rounded),across);
    if(rounded.b>.5){
      let h=mix(${minAngle},${maxAngle},fraction);
      let scene=skyline(s,h);
      let pathDust=vec3f(.545,.365,.314);
      color=mix(scene,pathDust,rounded.a*.23);
    } else {
      let distance=fraction*${distanceLimit}.0;
      color=ground(s,distance);
    }
    let elevation=mix(${minAngle},${maxAngle},uv.y);
    if(rounded.b>.5 || fraction*${distanceLimit}.0>47.0) {
      color=shoulder(s,elevation,47.0,color);
      color=surveyPost(s,elevation,46.0,-4.45,.86,color);
    }
    if(rounded.b>.5 || fraction*${distanceLimit}.0>31.0) {
      color=surveyPost(s,elevation,31.0,4.48,.825,color);
    }
    let border=(1.0-smoothstep(.12,1.24,length((uv-vec2f(.445,.54))*vec2f(1.0,1.20))))*.16;
    color*=.84+border;
  } else {
    let spot=exp(-5.4*dot(uv-vec2f(.44,.53),uv-vec2f(.44,.53)));
    color=mix(vec3f(.103,.089,.102),vec3f(.26,.205,.192),spot);
  }
  let grit=(hash(i.clip.xy)-.5)*.021;
  return margoEncode(vec4f(pow(max(color+grit,vec3f(0.0)),vec3f(2.2)),1.0));
}
`;

export function installRoad(engine, initial) {
  const pixels = rayTable(initial);
  let texture;
  const material = new RawShaderMaterial({
    name: 'Refracted view along a dry highway', vertexShader: vertex, fragmentShader: fragment,
    uniforms: { section: { value: 0 } },
    textures: { rays: {
      texture(device) {
        texture = device.createTexture({
          label: 'Outgoing angle or ground intercept by sightline',
          size: [samples, 1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture }, pixels, { bytesPerRow: samples * 4 }, [samples, 1, 1]);
        return texture;
      },
      sampler: { magFilter: 'nearest', minFilter: 'nearest' },
    } },
    cull: 'none', depthWrite: false,
  });
  const raw = RawShaders.attach(engine);
  raw.add(new RawMesh({
    material,
    index: [0, 1, 2, 0, 2, 3],
    attributes: { position: {
      data: new Float32Array([-1,-1,0,1,-1,0,1,1,0,-1,1,0]), type: 'vec3f',
    } },
  }));
  return {
    async ready() {
      await raw.ready();
      if (material.error) throw material.error;
    },
    setTemperature(temperature) {
      rayTable(temperature, pixels);
      engine.gpu.queue.writeTexture({ texture }, pixels, { bytesPerRow: samples * 4 }, [samples, 1, 1]);
    },
    setView(section) { material.uniforms.section.value = section ? 1 : 0; },
    dispose() { texture?.destroy(); },
  };
}

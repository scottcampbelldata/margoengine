import {PbrMaterial,Texture,createMesh} from '@margoengine/materials';
import {SceneTargets} from '@margoengine/post/mrt';
import {PostStack} from '@margoengine/post/stack';
import {SSS} from '@margoengine/post/sss';
import {sampleInfo,waxGeometry,marbleGeometry,jadeGeometry,thicknessPixels,marblePixels,jadePixels} from './surface-art.js';

const options={
  wax:{color:'#da9d69',roughness:.44,subsurfaceColor:'#ffc270',subsurfaceThickness:.89,
    subsurfaceDistortion:.26,subsurfacePower:1.9,subsurfaceWrap:.54},
  marble:{color:'#efeae5',roughness:.39,subsurfaceColor:'#f3dfc9',subsurfaceThickness:.91,
    subsurfaceDistortion:.21,subsurfacePower:2.8,subsurfaceWrap:.42},
  jade:{color:'#d0dec4',roughness:.38,subsurfaceColor:'#b5d8ae',subsurfaceThickness:.79,
    subsurfaceDistortion:.23,subsurfacePower:2.5,subsurfaceWrap:.50},
  carve:{color:'#527057',roughness:.62,subsurfaceColor:'#a4d4ae',subsurfaceThickness:.97},
  eyes:{color:'#38533a',roughness:.44,subsurfaceColor:'#a4ebb4',subsurfaceThickness:.92,
    subsurfaceDistortion:.19,subsurfacePower:2.4,subsurfaceWrap:.30},
};

const wgslMask=region=>({
  wgsl:'vec4f(t.subject * ('+region+'),0,0,1)',format:'r8unorm',
});

export function prepareSpecimens(){
  const maps=[
    new Texture(marblePixels(),{colorSpace:'srgb',wrapS:'repeat'}),
    new Texture(jadePixels(),{colorSpace:'srgb',wrapS:'repeat'}),
  ];
  const names=['wax','marble','jade'];
  const depths=Object.fromEntries(names.map(key=>[key,new Texture(thicknessPixels(key),{colorSpace:'linear',wrapS:'repeat'})]));
  const materials=Object.fromEntries([...names,'eyes','carve'].map(key=>[
    key,new PbrMaterial({
      ...options[key],side:'double',metalness:0,
      subsurface:sampleInfo[key]?.amount??.50,
      subsurfaceThicknessMap:depths[names.includes(key)?key:'jade'],
      ...(key==='marble'?{map:maps[0]}:key==='jade'?{map:maps[1]}:{}),
    }),
  ]));
  return {maps,depths,materials,geometry:{
    wax:waxGeometry(),marble:marbleGeometry(),jade:jadeGeometry(),
  }};
}

export function installSpecimens(engine,{maps,depths,materials,geometry}){
  const groups={
    wax:[createMesh(engine,geometry.wax,materials.wax)],
    marble:[createMesh(engine,geometry.marble,materials.marble)],
    jade:geometry.jade.map(({type,geometry:part})=>createMesh(engine,part,materials[type==='nephrite'?'jade':type])),
  };
  return {
    materials,groups,
    cleanup(){for(const map of [...maps,...Object.values(depths)])map.dispose();},
  };
}

export function diffuseSpecimen(engine,model){
  const targets=SceneTargets.attach(engine,{outputs:{
    wax:wgslMask('1.0-step(-0.22,t.position.x)'),
    marble:wgslMask('step(-0.22,t.position.x)*(1.0-step(0.22,t.position.x))'),
    jade:wgslMask('step(0.22,t.position.x)'),
  }});
  for(const meshes of Object.values(model.groups))for(const mesh of meshes)targets.add(mesh,{subject:true});
  let active='wax';
  const effect=new SSS({mask:()=>targets.texture(active),radius:sampleInfo.wax.radius,
    profile:sampleInfo.wax.profile,strength:.89,taps:10});
  PostStack.attach(engine,[effect]);
  return {
    update(key,enabled){
      active=key;
      effect.options.radius=sampleInfo[key].radius;
      effect.options.profile=sampleInfo[key].profile;
      effect.options.enabled=enabled;
    },
  };
}

export function setScattering(model,enabled){
  for(const [name,material] of Object.entries(model.materials)){
    material.subsurface=enabled?(sampleInfo[name]?.amount??.50):0;
  }
}

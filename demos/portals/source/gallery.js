import {Geometry,PbrMaterial} from '@margoengine/core';
import {Material,createMesh} from '@margoengine/materials';
import {Portals} from '@margoengine/materials/portal';

const corePalette={
  wall:['#625c68',.70],side:['#504e58',.79],floor:['#625b64',.50],floorAlt:['#6b6269',.54],
  joint:['#3a3744',.85],raised:['#877881',.72],bronze:['#b28c5e',.51],
  darkBronze:['#685146',.55],pearl:['#c9af86',.50],post:['#a0a6ab',.30,1],foot:['#4f5a64',.46,1],
};
const warmPalette={
  wall:{color:'#92745c',roughness:.87},terra:{color:'#af7a55',roughness:.74},
  sill:{color:'#d2a57c',roughness:.65},floor:{color:'#9a775d',roughness:.70},
  line:{color:'#694839',roughness:.86},warm:{color:'#aa7843',roughness:.34,metalness:1},
  bevel:{color:'#d8ad75',roughness:.34,metalness:1},
  chalk:{color:'#dfc5a3',roughness:.53},
  coil:{color:'#d4864b',roughness:.37,emissive:'#ac592f',emissiveIntensity:.65},
  lamp:{color:'#d8a468',emissive:'#f2bf89',emissiveIntensity:1.4},
};
const coolPalette={
  wall:{color:'#5c7782',roughness:.79},rib:{color:'#8aa4a9',roughness:.52},
  dark:{color:'#314959',roughness:.68},floor:{color:'#5d7177',roughness:.38,metalness:0},
  seam:{color:'#454e67',roughness:.74},chrome:{color:'#8096a2',roughness:.28,metalness:1},
  light:{color:'#a1d4d2',roughness:.34,emissive:'#499dad',emissiveIntensity:.56},
  lightBlue:{color:'#60a7ba',roughness:.30,emissive:'#48b0ca',emissiveIntensity:.72},
  glass:{color:'#3b8d9b',roughness:.31},
};

function submitRoom(engine,room,palette){
  return room.map(({id,geometry})=>{
    const mesh=createMesh(engine,geometry,new Material(palette[id]));
    mesh.root.name=id;
    return mesh;
  });
}

export function buildGallery(engine,description){
  engine.lighting.direction.set([-.57,.83,.66,2.34]);
  engine.lighting.radiance.set([1,.875,.75,.38]);
  engine.lighting.ambient.set([.78,.88,1]);
  engine.scene.background='#39333e';
  for(const {id,geometry} of description.gallery){
    const [color,roughness,metalness=0]=corePalette[id];
    const mesh=engine.createMesh();
    mesh.name='Gallery '+id;
    mesh.setGeometry(new Geometry(geometry.positions,geometry.normals,geometry.indices))
      .setMaterial(new PbrMaterial({color,roughness,metalness,doubleSided:false}));
  }
  const portals=Portals.attach(engine,{first:1,last:2});
  const palettes=[warmPalette,coolPalette];
  for(let i=0;i<description.rooms.length;i++){
    const mask=createMesh(engine,description.apertures[i],new Material({shading:'basic',color:'#918597'}));
    mask.root.name=i===0?'Copper vault stencil aperture':'Blue meridian stencil aperture';
    portals.add({mask,contents:submitRoom(engine,description.rooms[i],palettes[i])});
  }
  return portals;
}

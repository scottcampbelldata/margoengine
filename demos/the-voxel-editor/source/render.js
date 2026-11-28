import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {BlockTypes,VoxelWorld} from '@margoengine/voxel';
import {VoxelLighting} from '@margoengine/voxel/light';
import {meshChunk,meshInput} from '@margoengine/voxel/mesher';
import {BlockTextures,VoxelRenderer} from '@margoengine/voxel/render';
import {cellAt} from '@margoengine/voxel-edit';
import {palette,rgbaPalette} from './model.js';

const paletteBytes=rgbaPalette();
const unit=box(1,1,1);
function pixels(index){
  const size=16,data=new Uint8Array(size*size*4),color=paletteBytes.slice(index*4,index*4+3);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const edge=Math.min(x,15-x,y,15-y);
    const seed=(Math.imul((x+133*index)^(y*44+11),1597334677)>>>20)/4095-.5;
    const ripple=index<4?(Math.sin(y*1.45+x*.37)*.04):0;
    const layer=index===8||index===9?((y===5||y===11)?-.11:0):0;
    const shade=(edge===0?.86:edge===1?1.054:1)+seed*.067+ripple+layer;
    data.set([...color].map(value=>Math.min(255,Math.round(value*shade))).concat(255),(y*size+x)*4);
  }
  return {width:size,height:size,data};
}

function tray(width,length,height,cut){
  const w=width/2,l=length/2;
  const profile=[[-w+cut,-l],[-w,-l+cut],[-w,l-cut],[-w+cut,l],[w-cut,l],[w,l-cut],[w,-l+cut],[w-cut,-l]];
  const p=[],n=[],area=[];
  for(const [y,up] of [[height,1],[0,-1]]){
    const start=p.length/3;
    p.push(0,y,0);
    n.push(0,up,0);
    for(const [x,z] of profile){p.push(x,y,z);n.push(0,up,0);}
    for(let i=0;i<profile.length;i++){
      const a=start+1+i,b=start+1+(i+1)%profile.length;
      if(up>0)area.push(start,a,b);
      else area.push(start,b,a);
    }
  }
  for(let i=0;i<profile.length;i++){
    const [ax,az]=profile[i],[bx,bz]=profile[(i+1)%profile.length];
    const d=Math.hypot(bx-ax,bz-az),normal=[(az-bz)/d,0,(bx-ax)/d];
    const start=p.length/3;
    p.push(ax,0,az,bx,0,bz,bx,height,bz,ax,height,az);
    for(let j=0;j<4;j++)n.push(...normal);
    area.push(start,start+1,start+2,start,start+2,start+3);
  }
  return new Geometry(p,n,area);
}

export function prepareHarbor(grid){
  const blocks=new BlockTypes();
  const ids=[0],images=[];
  palette.slice(1).forEach(([name],j)=>{
    const index=j+1;
    images.push(pixels(index));
    ids[index]=blocks.define(name,{textures:j,roughness:index<4?.54:index===10?.37:.78,
      ...(index===10?{emissive:.48}:{})});
  });
  const world=new VoxelWorld({blocks,minY:0,maxY:31});
  const lighting=VoxelLighting.attach(world,{budget:65536});
  function load(previous,next){
    const edits=[];
    for(let i=0;i<next.voxels.length;i++){
      const value=next.voxels[i];
      if((previous?.voxels[i]??0)===value)continue;
      edits.push(...cellAt(next.size,i),ids[value]);
    }
    if(edits.length)world.setBlocks(edits);
    for(let i=0;i<8;i++)if(lighting.update()===0)break;
    return edits.length/4;
  }
  load(null,grid);
  const caches=new Map();
  for(const key of world.dirty){
    const input=meshInput(world,key);
    if(input)caches.set(key,meshChunk(input));
  }
  const mesher={
    async mesh(world,key){
      if(caches.has(key)){
        const mesh=caches.get(key);
        caches.delete(key);
        return mesh;
      }
      const input=meshInput(world,key);
      return input?meshChunk(input):null;
    },
    cancel(){},
    dispose(){caches.clear();}
  };
  return {world,mesher,images,load,dispose(){lighting.dispose();}};
}

export function harborView(engine,signal,opening){
  const textures=new BlockTextures({images:opening.images});
  const voxels=VoxelRenderer.attach(engine,{
    world:opening.world,textures,mesher:opening.mesher,daylight:.65,maxQuadBytes:4194304
  });
  function piece(geometry,color,p,roughness=.85){
    return engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial({color,roughness})).setPosition(p);
  }
  piece(box(460,1.5,460),'#576c70',[16,-3.6,16]);
  const rim=piece(tray(35.3,35.3,.42,2.6),'#91a7a1',[16,-.45,16],.42);
  const collar=piece(tray(34.7,34.7,.58,2.4),'#20373e',[16,-1.02,16],.50);
  const pedestal=piece(tray(33.6,33.6,1.25,2.15),'#344a51',[16,-2.25,16]);
  const casters=[rim,collar,pedestal];
  for(const [x,z] of [[3,3],[29,3],[3,29],[29,29]]){
    casters.push(piece(box(.61,.9,.61),'#9e8271',[x,-2.5,z],.51));
  }
  let fullLighting;
  function installShadows(){
    fullLighting??=import('@margoengine/shadows').then(({Shadows})=>{
      signal.throwIfAborted();
      const shadows=Shadows.attach(engine,{resolution:1024,cascades:1,distance:105,filter:'pcf'});
      shadows.add(voxels,{static:true});
      for(const caster of casters)shadows.add(caster);
    });
    return fullLighting;
  }
  const edges=Array.from({length:12},()=>piece(unit,'#ffcc8d',[0,-180,0],.5));
  function selection(from,to){
    if(!from||!to){
      for(const edge of edges)edge.position.y=-180;
      return;
    }
    const lower=from.map((value,axis)=>Math.min(value,to[axis])-.055);
    const upper=from.map((value,axis)=>Math.max(value,to[axis])+1.055);
    let index=0;
    for(let axis=0;axis<3;axis++)for(let a=0;a<2;a++)for(let b=0;b<2;b++){
      const other=(axis+1)%3,third=(axis+2)%3;
      const point=lower.slice(),scale=[.095,.095,.095];
      point[axis]=(lower[axis]+upper[axis])/2;
      point[other]=a?upper[other]:lower[other];
      point[third]=b?upper[third]:lower[third];
      scale[axis]=upper[axis]-lower[axis];
      edges[index++].setPosition(point).setScale(scale);
    }
  }
  return {
    get stats(){return voxels.stats;},
    load:opening.load,selection,installShadows,dispose:opening.dispose
  };
}

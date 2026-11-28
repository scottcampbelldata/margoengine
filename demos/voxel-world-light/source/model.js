import { BlockTypes, VoxelWorld } from '@margoengine/voxel';

export const sourceAmber = [9,3,7];
export const sourceIce = [20,3,17];
export const probe = [12,3,14];
export const sourceColors = { amber: [1,.65,.04], ice: [0,.8,1] };

const materials = [
  ['ledge', [49,60,69], 'basalt'],
  ['stratum', [78,88,91], 'basalt'],
  ['sandstone', [164,154,132], 'ashlar'],
  ['pale-ashlar', [186,178,156], 'ashlar'],
  ['carved-band', [132,124,107], 'inlay'],
  ['terrace', [143,148,145], 'floor'],
  ['paving', [168,163,149], 'floor'],
  ['grate', [76,83,81], 'copper'],
  ['bronze', [178,146,91], 'copper'],
  ['shutter', [117,128,123], 'shutter'],
  ['amber', [255,184,77], 'lamp', {light:15,emissive:1.2}],
  ['ice', [128,239,255], 'lamp', {light:15,emissive:1.2}],
  ['detector', [178,171,158], 'target'],
  ['fixture', [98,109,108], 'inlay'],
];

function grain(x,y,k) {
  let n=Math.imul(x+k,374761393)^Math.imul(y+k,668265263);
  n=Math.imul(n^(n>>>13),1274126177);
  return ((n^(n>>>16))>>>0)/4294967295;
}

function tile(rgb,pattern,seed) {
  const size=32,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const u=x%32,v=y%32,outer=Math.min(u,v,31-u,31-v);
    let shade=1+(grain(x,y,seed)-.5)*.11+(grain(x>>2,y>>2,seed+17)-.5)*.08;
    if(pattern==='basalt')shade*=.93+.09*Math.sin(y*1.7+grain(x>>3,y,seed)*1.4);
    if(pattern==='ashlar')shade*=outer===0?.66:outer===1?1.08:.96+.029*Math.sin(y*1.5+grain(x>>3,y,seed)*1.5);
    if(pattern==='floor')shade*=outer===0?.54:outer===1?1.04:x===16||y===16?.92:1;
    if(pattern==='inlay')shade*=outer===0?.75:v===4||v===27?1.15:(u+v)%11===0?.86:1;
    if(pattern==='copper')shade*=outer===0?.53:v===3||v===28?1.24:v%5===0?.76:1.02;
    if(pattern==='shutter')shade*=outer===0?.5:v===3||v===29?1.23:v%4===0?.58:1.04;
    if(pattern==='lamp')shade*=outer<2?.28:outer===2?.75:u%6===0||v===7||v===24?.55:1.12;
    if(pattern==='target') {
      const ring=Math.hypot(x-15.5,y-15.5);
      shade*=outer===0?.52:Math.abs(ring-9.6)<.85||u===15||v===15?1.27:.85;
    }
    const offset=(y*size+x)*4;
    for(let i=0;i<3;i++)data[offset+i]=Math.max(0,Math.min(255,Math.round(rgb[i]*shade)));
    data[offset+3]=255;
  }
  return {width:size,height:size,data};
}

export function buildVault() {
  const blocks=new BlockTypes(), ids={};
  const images=materials.map(([name,color,pattern,options],index)=>{
    ids[name]=blocks.define(name,{textures:index,roughness:pattern==='copper'?.49:.82,...options});
    return tile(color,pattern,index+10);
  });
  const world=new VoxelWorld({blocks,minY:0,maxY:31});
  const set=(x,y,z,name)=>world.setBlock(x,y,z,name?ids[name]:0);
  function volume(x0,x1,y0,y1,z0,z1,name) {
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)for(let y=y0;y<=y1;y++)set(x,y,z,name);
  }
  const floor=(x,z)=>set(x,2,z,(x*17+z*7)%9<3?'terrace':'paving');
  volume(1,28,0,0,2,24,'ledge');
  volume(2,27,1,1,3,23,'stratum');
  for(let x=2;x<=27;x++)for(let z=3;z<=23;z++)floor(x,z);
  for(let x=3;x<=26;x++) {
    if(x<11||x>15)set(x,2,23,'bronze');
    if(x%4===3)for(let y=0;y<2;y++)set(x,y,24,'stratum');
  }
  for(let z=4;z<23;z+=3)set(27,2,z,'bronze');
  for(let x=2;x<=27;x++)set(x,2,3,'grate');
  // Opaque transverse partition. The changeable shutter is its only short red-light path.
  for(let x=3;x<=26;x++)for(let z=11;z<=12;z++)for(let y=3;y<=8;y++){
    if(x>=12&&x<=14&&y<=5)continue;
    set(x,y,z,y===8?'carved-band':(x+2*y+z)%7<2?'pale-ashlar':'sandstone');
  }
  for(const x of [3,9,15,19,26]){
    volume(x,x,3,7,13,13,'sandstone');
    set(x,8,13,'pale-ashlar');
  }
  for(let x=11;x<=15;x++)set(x,9,11,'carved-band');
  for(let x=12;x<=14;x++)for(const z of [10,13])set(x,6,z,'bronze');
  for(const x of [11,15])for(let y=3;y<=7;y++)set(x,y,10,'fixture');
  // The upper terrace and side buttresses leave the core red path open at x=12.
  volume(3,5,3,4,4,9,'sandstone');
  volume(3,4,5,5,4,8,'pale-ashlar');
  volume(3,3,6,7,4,8,'carved-band');
  volume(4,10,3,4,4,4,'sandstone');
  for(let x=5;x<=10;x++)set(x,5,4,(x%3===0)?'fixture':'carved-band');
  volume(17,26,3,5,4,9,'stratum');
  for(let x=17;x<=26;x++)for(let z=4;z<=9;z++){
    set(x,6,z,(x+z)%6===0?'terrace':'sandstone');
    if(z===4||x===26)set(x,7,z,(x+z)%4===0?'bronze':'carved-band');
  }
  for(let x=18;x<=25;x++)set(x,4,10,(x%3===0)?'bronze':'grate');
  // Low cyan court. Labelling and the register below describe a single physical cell.
  volume(25,26,3,4,14,21,'sandstone');
  volume(26,26,5,5,15,21,'carved-band');
  for(let x=19;x<=24;x++)set(x,3,21,(x%2===0)?'bronze':'fixture');
  for(let z=14;z<=20;z++)set(24,2,z,'grate');
  for(const [x,z] of [[19,17],[20,16],[21,17],[20,18],[9,6],[8,7],[9,8],[10,7]])set(x,2,z,'bronze');
  for(let z=7;z<=16;z++)set(13,2,z,'carved-band');
  for(let x=10;x<=14;x++)set(x,2,17,'grate');
  set(probe[0],probe[1]-1,probe[2],'detector');
  set(...sourceAmber,'amber');
  set(...sourceIce,'ice');
  function setOpen(open){
    volume(12,14,3,5,11,12,open?'':'shutter');
  }
  setOpen(false);
  return {world,images,setOpen};
}

import {boxCells} from '@margoengine/voxel-edit/edit';

export const size=[32,32,32];
export const palette=[
  ['Air','#000000'],
  ['Deep Current','#183c4b'],['Tidewater','#286675'],['Foam','#9dd0c6'],
  ['Basalt','#485456'],['Slate','#616966'],['Warm Stone','#a49378'],
  ['Chalk','#dcd1b7'],['Burnt Brick','#ab4c3a'],['Vermilion','#ed7051'],
  ['Lantern Glass','#f1c768'],['Iron','#263b43'],['Oxidized Copper','#3f8a84'],
  ['Dark Copper','#28585a'],['Beach Sand','#c4af83'],['Grass','#808762']
];
export const stampAnchor=[24,8,17];

const offset=(x,y,z)=>x+32*(z+32*y);
function forms(voxels){
  const put=(x,y,z,value)=>{if(x>=0&&x<32&&y>=0&&y<32&&z>=0&&z<32)voxels[offset(x,y,z)]=value;};
  const fill=(lo,hi,value)=>{for(const cell of boxCells(lo,hi))put(...cell,value);};
  const disc=(cx,y,cz,r,value)=>{
    for(let z=Math.ceil(cz-r);z<=cz+r;z++)for(let x=Math.ceil(cx-r);x<=cx+r;x++){
      if((x-cx)**2+(z-cz)**2<=r*r)put(x,y,z,value);
    }
  };
  return {put,fill,disc};
}

export function harbor(){
  const voxels=new Uint8Array(32**3);
  const {put,fill,disc}=forms(voxels);
  for(let z=1;z<31;z++)for(let x=1;x<31;x++){
    if(Math.abs(x-15.5)+Math.abs(z-15.5)>27)continue;
    put(x,0,z,1);
    put(x,1,z,((x*7+z*11)%17===0)?2:1);
  }
  for(let z=1;z<30;z++)for(let x=1;x<29;x++){
    const distance=((x-14)/11)**2+((z-15)/8.8)**2;
    const deformed=distance+.072*Math.sin(x*.8)+.06*Math.cos(z*1.4+x*.11);
    if(deformed>1.08){
      if(deformed<1.22&&((x*3+z*11)%7)>1)put(x,1,z,(x+z)%3===0?3:2);
      continue;
    }
    const h=Math.max(2,Math.round(6.6-4.2*deformed+1.1*Math.sin(x*.37+z*.24)));
    for(let y=2;y<=h;y++)put(x,y,z,y<h&&((x*11+y*7+z*13)%9)>1?4:y===h&&h<4?14:5);
  }
  // Ashlar courtyard and an exposed seawall.
  fill([8,5,9],[21,6,19],4);
  fill([9,7,10],[20,7,18],6);
  for(let z=10;z<=18;z++)for(let x=9;x<=20;x++){
    if((x+z*3)%11===1)put(x,7,z,14);
  }
  fill([21,5,15],[27,7,20],11);
  for(let x=21;x<=27;x++)for(let z=15;z<=20;z++)put(x,7,z,(x+z)%4===0?14:6);
  for(let x=21;x<28;x+=2){
    put(x,8,15,11);put(x,8,20,11);
  }
  fill([21,9,15],[27,9,15],13);
  fill([21,9,20],[27,9,20],13);
  for(let n=0;n<6;n++){
    fill([23+n,2,18],[23+n,Math.max(2,7-n),19],6);
    put(23+n,Math.max(2,7-n),20,4);
  }

  // The tapered signal tower reads from every side, including the sea.
  const x=13.5,z=14;
  for(let y=8;y<=22;y++){
    const band=y===9?5:y<9?4:y===12||y===18||y>20?8:7;
    const radius=y<11?4.5:y<15?3.95:y<19?3.5:y<21?3.1:4.5;
    disc(x,y,z,radius,band);
    if([12,13,15,16,18,19].includes(y)){
      put(13,y,17,11);
      put(16,y,14,11);
    }
  }
  fill([12,8,18],[14,11,18],11);
  put(13,10,18,10);
  for(let i=0;i<8;i++){
    const angle=(i+.5)*Math.PI/4;
    const px=Math.round(x+4.65*Math.cos(angle)),pz=Math.round(z+4.65*Math.sin(angle));
    fill([px,22,pz],[px,23,pz],11);
  }
  disc(x,23,z,2.4,10);
  disc(x,24,z,2.4,10);
  disc(x,25,z,2.4,10);
  for(const [px,pz] of [[12,12],[15,12],[12,16],[15,16]])fill([px,23,pz],[px,25,pz],11);
  disc(x,26,z,3.45,13);
  disc(x,27,z,2.52,12);
  disc(x,28,z,1.35,13);
  put(13,29,14,8);
  put(13,30,14,10);

  // A detached cable cabinet and dock piles define the harbor scale.
  fill([6,7,13],[8,10,16],7);
  fill([6,11,13],[8,11,16],12);
  fill([6,12,14],[8,12,15],13);
  put(7,9,17,10);
  for(const cell of [[6,11],[7,21],[18,9],[22,12],[17,21],[10,5],[16,23],[9,22]]){
    const [a,b]=cell;
    for(let y=6;y>=2;y--)if(voxels[offset(a,y,b)]){put(a,y+1,b,15);break;}
  }
  return {size,voxels};
}

export function sampleBeacon(){
  const size=[5,9,5],voxels=new Uint8Array(size[0]*size[1]*size[2]);
  const put=(x,y,z,value)=>{voxels[x+5*(z+5*y)]=value;};
  for(let z=1;z<4;z++)for(let x=1;x<4;x++){
    put(x,0,z,11);
    put(x,5,z,12);
    put(x,6,z,13);
  }
  for(let y=1;y<=7;y++)put(2,y,2,y===4||y===5?10:12);
  for(const [x,z] of [[1,1],[3,1],[1,3],[3,3]])put(x,4,z,10);
  put(2,8,2,9);
  return {size,voxels};
}

export function rgbaPalette(){
  const bytes=new Uint8Array(1024);
  palette.slice(1).forEach(([,hex],index)=>{
    const rgb=Number.parseInt(hex.slice(1),16);
    bytes.set([rgb>>16,(rgb>>8)&255,rgb&255,255],(index+1)*4);
  });
  return bytes;
}

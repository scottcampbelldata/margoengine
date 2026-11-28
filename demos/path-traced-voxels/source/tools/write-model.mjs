import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout)throw new Error('Set MARGO_ENGINE_CHECKOUT to the pinned built Margo checkout.');
const {writeVox}=await import(pathToFileURL(resolve(checkout,'packages/voxel/dist/vox.js')));
const tools=fileURLToPath(new URL('.',import.meta.url));
const width=62,height=32,depth=48,voxels=new Uint8Array(width*height*depth);
const colors=[
  [42,54,62], [78,87,91], [144,145,123], [180,170,145], [195,152,86], [62,72,76],
  [234,116,46], [97,184,255], [190,221,226], [210,126,152], [156,161,151], [86,95,107],
  [84,114,124], [216,205,177], [64,88,94], [112,91,107], [40,47,59], [183,214,239],
];
const palette=new Uint8Array(1024);
colors.forEach((color,i)=>palette.set([...color,255],(i+1)*4));
const materials=[
  {id:1,type:'diffuse'},{id:2,type:'diffuse'},{id:3,type:'diffuse'},{id:4,type:'diffuse'},
  {id:5,type:'metal',weight:.8,rough:.29},{id:6,type:'metal',weight:.72,rough:.37},
  {id:7,type:'emit',weight:1,flux:.12},{id:8,type:'emit',weight:1,flux:.12},
  {id:9,type:'glass',weight:1,rough:.04,ior:1.51,attributes:new Map([['_d','.11']])},
  {id:10,type:'glass',weight:1,rough:.07,ior:1.49,attributes:new Map([['_d','.08']])},
  {id:11,type:'metal',weight:.31,rough:.62},{id:16,type:'metal',weight:.64,rough:.43},
  {id:18,type:'glass',weight:1,rough:.08,ior:1.52,attributes:new Map([['_d','.055']])},
];

const put=(x,y,z,id)=>{voxels[x+width*(z+depth*y)]=id;};
function fill(x0,x1,y0,y1,z0,z1,id){
  for(let y=y0;y<=y1;y++)for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++)put(x,y,z,id);
}
function plate(x0,x1,y0,y1,z0,z1,r,id){
  for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
    const dx=Math.max(x0+r-x,0,x-x1+r),dz=Math.max(z0+r-z,0,z-z1+r);
    if(dx+dz<=r)for(let y=y0;y<=y1;y++)put(x,y,z,id);
  }
}

plate(1,60,0,1,2,45,4,1);
plate(3,58,2,2,4,43,4,6);
plate(4,57,3,3,5,42,3,2);
plate(5,56,4,4,6,41,3,11);
for(let x=7;x<=54;x++)for(let z=8;z<=39;z++){
  const axis=x%5===0||z%5===0;
  put(x,4,z,axis?2:(Math.floor(x/5)+2*Math.floor(z/5))%3===0?4:3);
}
for(let x=10;x<=52;x++){
  put(x,3,43,x%6===0?5:2);
  if(x%6===0)put(x,2,44,5);
}
for(let z=9;z<=40;z++)if(z%5===0)put(57,3,z,5);
for(const x of [8,53])for(const z of [9,38])fill(x-1,x+1,3,5,z-1,z+1,6);

fill(8,52,5,21,7,8,1);
fill(10,50,5,26,7,7,1);
for(let x=9;x<=51;x++){
  const top=22+Math.floor(4*Math.sin((x-8)*Math.PI/44));
  fill(x,x,21,top,8,8,(x%7<2)?2:1);
  if(x%6===2)fill(x,x,7,20,9,9,13);
}
fill(8,52,5,6,9,10,6);
fill(9,51,20,20,9,9,5);
fill(12,48,25,25,6,8,6);
for(let x=12;x<=48;x+=3)put(x,25,9,5);

// Slotted bronze emitters, facing the pale bench and the transmissive column.
for(const [low,high,id] of [[16,23,7],[37,44,8]]){
  fill(low-1,high+1,7,19,10,10,6);
  for(let x=low;x<=high;x++)if((x-low)%2===0)fill(x,x,9,17,11,11,id);
  fill(low-1,high+1,18,18,11,11,5);
}
for(const x of [10,46]){
  fill(x,x+1,5,21,12,13,2);
  fill(x-1,x+2,19,20,11,14,6);
}
for(let course=0;course<4;course++){
  const y=6+course*4;
  const x=9+course*2;
  fill(x,x+2,y,y+2,15,31-course*3,course%2?13:12);
  fill(x,x+2,y+3,y+3,15,31-course*3,5);
}
for(let z=16;z<=36;z+=4){
  fill(49,51,5,6,z,z+1,13);
  put(50,7,z,5);
}

plate(22,40,5,5,16,35,3,6);
plate(24,38,6,6,19,32,3,14);
fill(27,35,7,7,21,29,3);
for(const [x,z] of [[24,20],[38,20],[24,30],[38,30]]){
  fill(x,x,7,10,z,z,5);
  put(x,11,z,6);
}
for(let y=8;y<25;y++){
  const midX=31+Math.floor((y-8)/6),midZ=25-Math.floor((y-8)/8);
  const radius=y<10?4:y<14?5:y<20?4:y<24?3:2;
  for(let x=midX-radius;x<=midX+radius;x++)for(let z=midZ-radius;z<=midZ+radius;z++){
    const step=Math.abs(x-midX)+Math.abs(z-midZ);
    if(step<=radius+2)put(x,y,z,x<=midX-2?10:z>midZ?9:18);
  }
}
for(let z=22;z<=29;z+=2){
  put(27,7,z,5);
  put(35,7,z,5);
}
plate(15,22,5,6,29,36,2,4);
plate(41,48,5,6,25,32,2,14);
for(let x=16;x<=21;x++)put(x,7,31,x%2?6:5);
for(let x=42;x<=47;x++)put(x,7,29,x%2?5:6);
for(let x=20;x<=42;x++){
  if(x%3!==1)put(x,4,37,14);
  if(x%4===0)put(x,4,38,5);
}
for(let z=16;z<=35;z++){
  if(z%3!==1)put(45,4,z,14);
}

const xyzi=[];
for(let y=0;y<height;y++)for(let z=0;z<depth;z++)for(let x=0;x<width;x++){
  const id=voxels[x+width*(z+depth*y)];
  if(id)xyzi.push(x,depth-1-z,y,id);
}
await mkdir(tools,{recursive:true});
const bytes=writeVox({version:150,models:[{size:[width,depth,height],voxels:Uint8Array.from(xyzi)}],palette,materials,nodes:[],layers:[]});
await writeFile(resolve(tools,'afterglass.vox'),bytes);
console.log(JSON.stringify({file:'afterglass.vox',cells:xyzi.length/4,bytes:bytes.byteLength}));

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const engine=process.env.MARGO_ENGINE_CHECKOUT;
const {depthVideoPoints}=await import(pathToFileURL(resolve(engine,'packages/points/dist/depth-video.js')));
const data=resolve('qa-output/depth-video');
const sources=resolve(data,'rgbd_dataset_freiburg1_desk');
const excerpt=JSON.parse(await readFile(resolve(data,'excerpt.json'),'utf8'));
const assets=new URL('./assets/',import.meta.url);
await mkdir(assets,{recursive:true});
const width=144,height=108,count=width*height,frameBytes=count*2;
const root=await readFile(resolve(data,'files-to-extract.txt'),'utf8');
assert.ok(root.includes('/depth/'));
const modes=[['rgb','rgb24','area'],['depth','gray16le','neighbor']];
const raw=await Promise.all(modes.map(async ([type,pixel,filter])=>{
  const listPath=resolve(data,type+'-ffconcat.txt');
  const entries=excerpt.matched.map(frame=>"file '"+resolve(sources,frame[type]).replaceAll('\\','/')+"'");
  await writeFile(listPath,entries.join('\n')+'\n');
  const target=resolve(data,type+'-'+width+'.raw');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',listPath,
    '-filter_threads','1','-vf','scale='+width+':'+height+':flags='+filter,'-pix_fmt',pixel,'-f','rawvideo','-fps_mode','passthrough',target],
    {timeout:35000,stdio:['ignore','pipe','pipe']});
  return readFile(target);
}));
const [rgb,depth]=raw;
assert.equal(rgb.length,count*3*excerpt.matched.length);
assert.equal(depth.length,count*2*excerpt.matched.length);
const groupSizes=[3];
for(let i=3;i<excerpt.matched.length;i+=6)groupSizes.push(Math.min(6,excerpt.matched.length-i));
const schedule=[];
const counts=[];
let first=0;
let overall=0;
for(const group of groupSizes){
  const depthArchive=Buffer.allocUnsafe(frameBytes*group);
  for(let local=0;local<group;local++){
    const frame=first+local;
    const offset=local*frameBytes;
    const rgbPixels=new Uint8Array(count*4), depthPixels=new Uint8Array(count*4);
    for(let at=0;at<count;at++){
      const src=(frame*count+at)*3;
      const d=depth.readUInt16LE((frame*count+at)*2);
      const millimeters=Math.round(d/5);
      depthArchive.writeUInt16LE(millimeters,offset+at*2);
      rgbPixels.set([rgb[src],rgb[src+1],rgb[src+2],255],at*4);
      depthPixels.set([millimeters>>8,millimeters&255,0,255],at*4);
    }
    const image={width,height,data:rgbPixels};
    const readings=depthVideoPoints(image,{layout:'separate',encoding:'millimeters',near:.43,far:5.7,maxJump:.09,
      intrinsics:{fx:525*width/640,fy:525*height/480,cx:width*.5,cy:height*.5}},
      {width,height,data:depthPixels});
    assert.ok(readings.count>2800);
    counts.push(readings.count);
  }
  const packed=gzipSync(depthArchive,{level:8});
  const pixels=rgb.subarray(first*count*3,(first+group)*count*3);
  const colorFile=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24',
    '-video_size',width+'x'+(height*group),'-i','pipe:0','-c:v','libwebp','-quality','92','-f','webp','pipe:1'],
    {input:pixels,timeout:8000});
  const key='clip-'+schedule.length+'.depth';
  const colorKey='clip-'+schedule.length+'.webp';
  await writeFile(new URL(key,assets),packed);
  await writeFile(new URL(colorKey,assets),colorFile);
  schedule.push({first,count:group,key,colorKey,bytes:packed.byteLength,colorBytes:colorFile.byteLength});
  overall+=packed.length;
  first+=group;
}
const metadata={width,height,rate:excerpt.rate,frameCount:excerpt.matched.length,grid:frameBytes,chunks:schedule,counts,
  frames:excerpt.matched.map(m=>({time:+m.seconds.toFixed(5),depth:m.depth,rgb:m.rgb,offset:+m.offset.toFixed(5)})),
  source:'TUM RGB-D benchmark, freiburg1_desk',archive:'https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_desk.tgz',
  sha256:'e983d6830916e66dc4a46a71368046b149b283de87769690e7aa4e0b9483530c',license:'CC BY 4.0'};
await writeFile(new URL('frames.json',assets),JSON.stringify(metadata)+'\n');
console.log(JSON.stringify({sizes:schedule,overall,pointRange:[Math.min(...counts),Math.max(...counts)],frames:counts.length}));

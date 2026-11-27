import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
const {openNetCDF}=await import(pathToFileURL(resolve(checkout,'packages/sciviz/dist/netcdf.js')));
const {cfTimeCodec}=await import(pathToFileURL(resolve(checkout,'packages/sciviz/dist/cf.js')));
const source='https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz';
const hash='f7788db9044d0f0e3f9561ad5d0fd82e59cdfdb82ea8a10244f78f2cb032a3c7';
const archive=resolve('qa-output/the-climate-globe/gistemp1200_GHCNv4_ERSSTv5.nc.gz');
const encoded=await readFile(archive);
assert.equal(createHash('sha256').update(encoded).digest('hex'),hash);
const ncPath=archive.slice(0,-3);
await writeFile(ncPath,gunzipSync(encoded));
const input=await open(ncPath);
const out=new URL('./assets/',import.meta.url);
await mkdir(out,{recursive:true});
function pushValue(archive,value){
  for(;value>=128;value>>>=7)archive.push((value&127)|128);
  archive.push(value);
}
const pack=(state,rows,cols,scale)=>{
  const data=[];
  let above=new Int32Array(cols), current=new Int32Array(cols);
  for(let row=0;row<rows;row++){
    let left=0,oldAbove=0;
    for(let col=0;col<cols;col++){
      const reading=state[row*cols+col];
      const top=above[col];
      if(Number.isFinite(reading)){
        const predicted=left+top-oldAbove;
        const integer=Math.round(reading/scale);
        const delta=integer-predicted;
        pushValue(data,((delta<<1)^(delta>>31))+1);
        current[col]=left=integer;
      }else{
        pushValue(data,0);
        current[col]=left=0;
      }
      oldAbove=top;
    }
    [above,current]=[current,above];
  }
  return data;
};

try {
  const {size}=await input.stat();
  const file=await openNetCDF({size,async read(at,n){
    const buffer=Buffer.allocUnsafe(n);
    const data=await input.read(buffer,0,n,at);
    return buffer.subarray(0,data.bytesRead);
  }});
  try{
    const {time,lat,lon,tempanomaly}=file.variables;
    const [timeData, y, x]=await Promise.all([time.read(),lat.read(),lon.read()]);
    const codec=cfTimeCodec(String(time.attributes.units),{calendar:'gregorian'});
    const months=Array.from(timeData,n=>codec.decode(n));
    const first=1880,last=2025,groupSize=4,scale=.02,count=x.length*y.length;
    const groups=[], dates=[];
    assert.deepEqual([x[0],x.at(-1),y[0],y.at(-1)],[-179,179,-89,89]);
    for(let start=first;start<=last;start+=groupSize){
      const end=Math.min(last,start+groupSize-1),contents=[];
      for(let year=start;year<=end;year++){
        const base=months.findIndex(value=>value.year===year&&value.month===1);
        assert.ok(base>=0&&months[base+11].year===year&&months[base+11].month===12,JSON.stringify({year,base}));
        const samples=await tempanomaly.read({start:[base,0,0],count:[12,y.length,x.length]});
        const annual=new Float64Array(count);
        let cells=0,min=Infinity,max=-Infinity,weighted=0,weights=0;
        for(let row=0;row<y.length;row++){
          const weight=Math.cos(y[row]*Math.PI/180);
          for(let col=0;col<x.length;col++){
            const index=row*x.length+col;
            let valid=0,sum=0;
            for(let month=0;month<12;month++){
              const value=samples[month*count+index];
              if(Number.isFinite(value)){valid++;sum+=value;}
            }
            if(valid>=10){
              const value=sum/valid;
              annual[index]=value;
              cells++;min=Math.min(min,value);max=Math.max(max,value);weighted+=value*weight;weights+=weight;
            } else annual[index]=NaN;
          }
        }
        assert.ok(cells>count*.4&&max>min);
        contents.push(Buffer.from(pack(annual,y.length,x.length,scale)));
        dates.push({year,cells,min:+min.toFixed(3),max:+max.toFixed(3),sampleMean:+(weighted/weights).toFixed(3)});
      }
      const encoded=gzipSync(Buffer.concat(contents),{level:9});
      const key='anomaly-'+start+'.field';
      await writeFile(new URL(key,out),encoded);
      groups.push({start,end,key,bytes:encoded.length});
    }
    const record={name:'NASA GISS/GISTEMP v4 land–ocean analysis, 1200 km smoothing',first,last,groupSize,scale,source,hash,
      archiveHistory:file.attributes.history,latitude:Array.from(y),longitude:Array.from(x),groups,dates};
    await writeFile(new URL('record.json',out),JSON.stringify(record)+'\n');
    console.log(JSON.stringify({frameCount:dates.length,bytes:groups.reduce((n,g)=>n+g.bytes,0),opening:groups.at(-1),
      nearby:dates.slice(-5),longHistory:[dates[0],dates[20],dates[70],dates[120]]}));
  }finally{file.dispose();}
} finally{await input.close();}

import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const url='https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9414290&begin_date=20251201&end_date=20251207&product=hourly_height&datum=MLLW&time_zone=gmt&units=metric&application=MargoDemos&format=json';
const raw=process.argv[2]?await readFile(process.argv[2]):new Uint8Array(await (await fetch(url)).arrayBuffer());
const {metadata,data}=JSON.parse(new TextDecoder().decode(raw));
const first=Date.UTC(2025,11,1);
if(metadata?.id!=='9414290'||data?.length!==168)throw Error('Unexpected NOAA station or observation count');
const mm=data.map((row,index)=>{
  const at=Date.parse(row.t.replace(' ','T')+':00Z'),m=Number(row.v);
  if(at!==first+index*3600000||row.f!=='0,0'||!Number.isFinite(m))throw Error('Invalid observation '+index);
  return Math.round(m*1000);
});
const digest=createHash('sha256').update(raw).digest('hex');
await writeFile(new URL('../tide.json',import.meta.url),JSON.stringify({station:metadata.id,first,digest,mm})+'\n');

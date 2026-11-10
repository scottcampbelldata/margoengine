// Government data only. --input=<download> records a previously downloaded, unmodified response.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const url='https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',input=process.argv.find(v=>v.startsWith('--input='))?.slice(8);
let bytes;
if(input)bytes=await readFile(input);else{const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(`USGS returned ${response.status}`);bytes=new Uint8Array(await response.arrayBuffer());}
const data=JSON.parse(new TextDecoder().decode(bytes));if(data.type!=='FeatureCollection'||!Array.isArray(data.features))throw new Error('Expected a USGS GeoJSON FeatureCollection');
await writeFile(new URL('./earthquakes.geojson',import.meta.url),bytes);
await writeFile(new URL('./source.json',import.meta.url),JSON.stringify({url,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,generated:data.metadata.generated,count:data.features.length,license:'US Geological Survey public-domain US government data; credit USGS Earthquake Hazards Program',terms:'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',format:'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',preparation:'Unmodified all_day GeoJSON response. Demo filters finite magnitude/time and sorts by time. Replay controls use these real observations; live mode polls the official feed with AbortSignal.'},null,2)+'\n');

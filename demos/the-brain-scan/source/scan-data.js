import metadata from './assets/pair.json';
import openingMRI from './assets/mri-opening.bin?url';
import fullMRI from './assets/mri.bin?url';
import boneCT from './assets/ct.bin?url';

export { metadata, openingMRI, fullMRI, boneCT };

export async function readScan(url, dims, size, signal) {
  const response = await fetch(url,{signal});
  if(!response.ok)throw new Error('Scan data could not be opened ('+response.status+').');
  const decoded = response.body.pipeThrough(new DecompressionStream('gzip'));
  const bytes = await new Response(decoded).arrayBuffer();
  signal.throwIfAborted();
  if(bytes.byteLength !== dims[0]*dims[1]*dims[2]*size)throw new Error('Scan dimensions do not match the source data.');
  return bytes;
}

export async function readMRI(url,dims,signal){
  return new Uint8Array(await readScan(url,dims,1,signal));
}

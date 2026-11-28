import tileset from './tools/city/tileset.json?url&no-inline';
import ll from './tools/city/ll.b3dm?url&no-inline';
import lr from './tools/city/lr.b3dm?url&no-inline';
import ur from './tools/city/ur.b3dm?url&no-inline';
import ul from './tools/city/ul.b3dm?url&no-inline';

export { tileset };
export const sectors=[
  {key:'ll',label:'Southwest',color:'#e1c8a1'},
  {key:'lr',label:'Southeast',color:'#e2caae'},
  {key:'ur',label:'Northeast',color:'#ded3ad'},
  {key:'ul',label:'Northwest',color:'#e4c2a1'},
];

const files=new Map([['ll.b3dm',ll],['lr.b3dm',lr],['ul.b3dm',ul],['ur.b3dm',ur]]);
export const sectorKey=url=>new URL(url,location.href).pathname.split('/').at(-1).slice(0,2);
export function prepareAssets(signal) {
  const manifest=new URL(tileset,location.href);
  const response=fetch(manifest,{signal});
  // A copy keeps the same first request if the engine needs to create a fallback renderer.
  void response.catch(()=>undefined);
  return async function assetFetch(url,options) {
    const address=new URL(url,location.href);
    if(address.href===manifest.href) {
      const ready=await response;
      options?.signal?.throwIfAborted();
      return ready.clone();
    }
    const name=address.pathname.split('/').at(-1);
    return fetch(files.get(name)??url,options);
  };
}

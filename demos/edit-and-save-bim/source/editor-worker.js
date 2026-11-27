import { IfcAPI, LogLevel } from 'web-ifc';
import wasm from 'web-ifc/web-ifc.wasm?url';
import { openIFC } from '@margoengine/ifc';
import { readIFCData } from '@margoengine/ifc/data';
import { editIFC,saveIFC } from '@margoengine/ifc/write';
import { prepareIFC } from './door-values.mjs';

const api=new IfcAPI();
let initialized, original;

self.onmessage=async({data:{ticket,ifcUrl,edits}})=>{
  try{
    initialized??=api.Init(()=>new URL(wasm,import.meta.url).href,true);
    original??=fetch(ifcUrl).then(async response=>{
      if(!response.ok)throw new Error('The source IFC could not be loaded.');
      return new Uint8Array(await response.arrayBuffer());
    });
    const [,source]=await Promise.all([initialized,original]);
    api.SetLogLevel(LogLevel.LOG_LEVEL_ERROR);
    const {bytes,checked}=prepareIFC(api,source,edits,{openIFC,readIFCData,editIFC,saveIFC});
    self.postMessage({ticket,bytes,checked},[bytes.buffer]);
  }catch(error){
    self.postMessage({ticket,error:error instanceof Error?error.message:String(error)});
  }
};

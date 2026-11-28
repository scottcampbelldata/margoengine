import { IfcAPI, LogLevel } from 'web-ifc';
import wasm from 'web-ifc/web-ifc.wasm?url';
import { openIFC } from '@margoengine/ifc';
import { parseIDS, checkIDS } from '@margoengine/ifc/ids';

const api = new IfcAPI();
let initialized;
self.onmessage=async ({data:{id,modelUrl,rulesUrl}})=>{
  try{
    initialized??=api.Init(()=>new URL(wasm,import.meta.url).href,true);
    const [, modelResponse, rulesResponse] = await Promise.all([initialized, fetch(modelUrl), fetch(rulesUrl)]);
    if(!modelResponse.ok||!rulesResponse.ok)throw new Error('The IFC model or IDS rules could not be loaded.');
    api.SetLogLevel(LogLevel.LOG_LEVEL_ERROR);
    const [bytes, rules] = await Promise.all([modelResponse.arrayBuffer(), rulesResponse.text()]);
    const model=openIFC(api,new Uint8Array(bytes));
    try{
      self.postMessage({id,report:checkIDS(model,parseIDS(rules))});
    }finally{
      model.close();
    }
  }catch(error){
    self.postMessage({id,error:error instanceof Error?error.message:String(error)});
  }
};

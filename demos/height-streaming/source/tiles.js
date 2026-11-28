import launchURL from './launch.tile?url';

export const tileSize=2000;
export const samples=128;
export const windowSide=6;
export const surveySide=14;
export const elevationBase=1180;
const startX=5,startZ=4;
const tileURLs=import.meta.glob('./tiles/*.tile',{eager:true,query:'?url&no-inline',import:'default'});
const count=samples*samples;
const rawTileSize=count*3;
const launched=(x,z)=>x>=startX&&z>=startZ&&x<startX+windowSide&&z<startZ+windowSide;

function decode(buffer){
  if(buffer.byteLength!==rawTileSize)throw new RangeError('Survey tile has the wrong sample count.');
  const heights=new Float32Array(count),quantized=new Int16Array(count),pigment=new Uint8Array(count*4);
  for(let j=0;j<samples;j++){
    for(let i=0;i<samples;i++){
      const k=j*samples+i,code=buffer[k]+256*buffer[k+count],shade=buffer[k+2*count];
      const residual=(code>>>1)^(-(code&1));
      const left=i?quantized[k-1]:0,top=j?quantized[k-samples]:0,diagonal=i&&j?quantized[k-samples-1]:0;
      const h=residual+left+top-diagonal;
      quantized[k]=h;
      heights[k]=h*.25;
      const a=4*k;
      if(shade>240){
        const water=(shade-240)*17,bank=255-water;
        pigment[a+1]=Math.round(bank*.61);
        pigment[a+2]=bank-pigment[a+1];
        pigment[a+3]=water;
      }
      else{
        const clay=(shade&15)*17,white=(shade>>>4)*17;
        pigment[a]=255-clay-white;
        pigment[a+1]=clay;
        pigment[a+2]=white;
      }
    }
  }
  return {heights,weights:[pigment]};
}

function inflate(response,signal){
  if(!response.ok)throw new Error('Could not open a survey tile ('+response.status+').');
  if(!response.body)throw new Error('The survey tile response has no body.');
  return response.body.pipeThrough(new DecompressionStream('gzip'),{signal});
}

export function tileSource(signal){
  const initial=new Map(),listeners=new EventTarget();
  let failure,opened=0;
  async function start(){
    const response=await fetch(launchURL,{signal}),reader=inflate(response,signal).getReader();
    const record=2+rawTileSize,data=new Uint8Array(record);
    let at=0;
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        for(let i=0;i<value.length;){
          const n=Math.min(value.length-i,record-at);
          data.set(value.subarray(i,i+n),at);
          i+=n;at+=n;
          if(at<record)continue;
          const [x,z]=data,key=x+','+z;
          if(!launched(x,z)||initial.has(key))throw new RangeError('Unexpected survey launch tile '+key+'.');
          initial.set(key,decode(data.subarray(2)));
          opened++;
          listeners.dispatchEvent(new Event(key));
          at=0;
        }
      }
      if(at||opened!==windowSide*windowSide)throw new RangeError('Survey launch file ended mid-window.');

    }finally{
      reader.releaseLock();
    }
  }
  start().catch(reason=>{
    failure=reason;
    listeners.dispatchEvent(new Event('error'));
  });

  async function load(x,z,tileSignal){
    tileSignal.throwIfAborted();
    if(x<0||z<0||x>=surveySide||z>=surveySide)return null;
    const key=x+','+z;
    if(launched(x,z)){
      if(initial.has(key))return initial.get(key);
      if(failure)throw failure;
      return new Promise((resolve,reject)=>{
        function clear(){
          listeners.removeEventListener(key,receive);
          listeners.removeEventListener('error',fail);
          tileSignal.removeEventListener('abort',abort);
        }
        function receive(){clear();resolve(initial.get(key));}
        function fail(){clear();reject(failure);}
        function abort(){clear();reject(tileSignal.reason);}
        listeners.addEventListener(key,receive,{once:true});
        listeners.addEventListener('error',fail,{once:true});
        tileSignal.addEventListener('abort',abort,{once:true});
      });
    }
    const name='./tiles/'+x+'-'+z+'.tile',url=tileURLs[name];
    if(!url)throw new Error('Survey tile is missing at '+key+'.');
    const response=await fetch(url,{signal:tileSignal});

    const data=new Uint8Array(await new Response(inflate(response,tileSignal)).arrayBuffer());
    tileSignal.throwIfAborted();
    return decode(data);
  }
  return {load,get opened(){return opened;}};
}

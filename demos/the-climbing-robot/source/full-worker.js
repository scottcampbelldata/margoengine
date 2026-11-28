import { openFull } from './full-stage.js';

const {signal}=new AbortController();
let rig,pending,busy=false;
const report=error=>postMessage({type:'error',message:error?.message??String(error),code:error?.code});

async function draw(){
  if(!rig||busy||!pending)return;
  busy=true;
  const request=pending;
  pending=undefined;
  try{
    const frame=await rig.render(request);
    postMessage({type:'frame',frame});
  }catch(error){report(error);}
  finally{busy=false;if(pending)draw();}
}

addEventListener('message',async({data})=>{
  if(data.type==='attach'){
    try{
      rig=await openFull(data.canvas,data.bytes,data.compatibility,signal,name=>postMessage({type:'phase',name}));
      rig.engine.onError=report;
      draw();
    }catch(error){report(error);}
  }else if(data.type==='frame'){
    pending=data.frame;
    draw();
  }
});

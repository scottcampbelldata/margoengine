import {applyQualityTier} from '@margoengine/quality';
import {openBench} from '@margoengine/studio/bench';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#view'),notice=document.querySelector('#notice');
const message=document.querySelector('#status'),status=demoStatus(canvas,message,document.querySelector('#error'));
const lifetime=new AbortController(),{signal}=lifetime;
let resized=()=>{};
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  message.textContent='The comparison could not open.';
  for(const control of document.querySelectorAll('button,input'))control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  lifetime.abort();
}
applyQualityTier({search:'?quality=low'});
const prepared=import('./solver.js').then(({openExperiment})=>openExperiment(signal));
prepared.then(model=>model.ready).catch(fail);
const stage=import('./scene.js');
// The bench opens WebGPU, or the WebGL2 layer when WebGPU is missing, slow or ?backend=webgl2 asks for it, sizes the
// backbuffer and casts the sun's shadows; the station brings its own floor, so the cyclorama and fills stay off.
const bench=openBench(canvas,{start:(on,o)=>import('@margoengine/webgl2-compat/auto').then(m=>m.startEngine(on,o)),loadCompat:()=>import('@margoengine/webgl2-compat'),
  signal,onError:fail,capacity:170,pixelRatio:1.75,startupTimeout:2500,background:'#25333b',
  camera:{position:[-1.87,6.02,7.72],target:[0,.16,0],near:.22,far:50,fov:35},
  light:{direction:[-2.6,7.6,4.1],color:[1,.93,.81],intensity:3.2,ambient:.46,ambientColor:[.78,.91,1]},
  environment:false,backdrop:false,contact:false,
  shadows:{lightSize:.02,bounds:{min:[-4,-.6,-2.2],max:[4,1.1,2.2]}},
  onResize:()=>resized(),
}).then(value=>{performance.mark('divider-device');return value;});
Promise.all([bench,stage,prepared]).then(([bench,{show},physics])=>
  show({bench,physics,canvas,notice,status,signal,fail,onResize:fit=>{resized=fit;}})).catch(fail);

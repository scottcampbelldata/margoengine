import {maskSize,outlineOptions,dropScale} from './layout.js';
import {outlineColliders,traceOutlines} from '@margoengine/physics2d/outline';

export const dies={
  scoop:'Scoop',
  ring:'Ring',
  fork:'Fork',
};
const rect=[0,0,maskSize,maskSize];

export function newSurface(w,h=w){
  return typeof OffscreenCanvas==='function'?new OffscreenCanvas(w,h):
    Object.assign(document.createElement('canvas'),{width:w,height:h});
}
export function cutoutEditor(invalidate){
  const canvas=newSurface(maskSize);
  const ink=canvas.getContext('2d',{willReadFrequently:true}),undo=[];
  let rev=0,last=null;
  const restore=image=>{ink.clearRect(...rect);if(image)ink.putImageData(image,0,0);};
  const image=()=>ink.getImageData(...rect);
  const remember=()=>{
    undo.push(image());
    if(undo.length>16)undo.shift();
  };
  function drawPreset(preset,record=true){
    if(preset!=='blank'&&!Object.hasOwn(dies,preset))throw new RangeError('Unknown cutout die.');
    if(record)remember();
    restore(null);
    ink.globalCompositeOperation='source-over';
    ink.fillStyle='#ffffff';
    if(preset==='scoop'){
      const path=new Path2D('M14 14 Q9 13 8.5 23 L9 46 Q10 61 23 64 L51 64 Q65 62 68 47 L69 30 Q68 23 62 23 Q56 23 57 33 L56 44 Q54 49 48 49 L28 49 Q22 49 22 43 L22 25 Q22 15 14 14 Z');
      ink.fill(path);
    }
    if(preset==='ring'){
      ink.beginPath();
      ink.ellipse(38,38,28,30,-.40,0,Math.PI*2);
      ink.ellipse(37.5,36,15,18,-.47,0,Math.PI*2);
      ink.fill('evenodd');
    }
    if(preset==='fork'){
      const path=new Path2D('M16 20 Q13 15 17 13 Q21 11 25 16 L34 28 L38 11 Q39 7 44 8 Q48 9 47 16 L45 33 L56 25 Q63 20 67 23 Q70 27 65 31 L52 48 Q47 56 40 62 Q32 67 24 62 Q15 58 17 51 L22 36 L16 20 Z');
      ink.fill(path);
    }
    changed();
  }
  function changed(){rev++;invalidate();}
  function draw(a,b,mode,brush){
    ink.globalCompositeOperation=mode==='erase'?'destination-out':'source-over';
    ink.lineCap='round';ink.lineJoin='round';
    ink.strokeStyle='#ffffff';ink.fillStyle='#ffffff';ink.lineWidth=brush;
    if(a){
      ink.beginPath();ink.moveTo(...a);ink.lineTo(...b);ink.stroke();
    }else{
      ink.beginPath();ink.arc(...b,brush/2,0,Math.PI*2);ink.fill();
    }
    ink.globalCompositeOperation='source-over';
    changed();
  }
  function start(x,y,mode,brush){
    if(last)return;
    remember();
    last=[x,y];draw(null,last,mode,brush);
  }
  function drag(x,y,mode,brush){
    if(!last)return;
    const current=[x,y];
    draw(last,current,mode,brush);
    last=current;
  }
  function end(){last=null;}
  function undoStroke(){
    if(!undo.length)return false;
    restore(undo.pop());
    changed();
    return true;
  }
  function capture(){
    const alpha=image();
    const outlines=traceOutlines(alpha,outlineOptions);
    const sprite={x:0,y:0,rotation:0,pivotX:.5,pivotY:.5,rect,scaleX:dropScale,scaleY:dropScale};
    const shapes=outlineColliders(alpha,{...outlineOptions,sprite,friction:.57,restitution:.19,density:1.8});
    let solids=0,key=2166136261;
    for(let i=3;i<alpha.data.length;i+=4){
      const a=+(alpha.data[i]>=outlineOptions.threshold);
      solids+=a;
      key=Math.imul(key^a,16777619);
    }
    return {pixels:alpha,outlines,shapes,solids,hash:(key>>>0).toString(16),rev,undo:undo.length};
  }
  drawPreset('scoop',false);
  return {start,drag,end,drawPreset,undoStroke,capture};
}

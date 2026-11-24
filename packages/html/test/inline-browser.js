import { inlineResources, resourceInliner } from '@margoengine/html/inline';
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
export async function inlineScenario(){
  const origin=window.htmlResourceOrigin,link=document.createElement('link');
  link.rel='stylesheet';link.href=`${origin}/fonts.css`;
  const loaded=new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=reject;});
  document.head.append(link);await loaded;
  const panel=document.createElement('div');
  panel.style.cssText='position:relative;width:280px;height:100px;background:white;font-family:InlineSource';
  const image=document.createElement('img');
  image.crossOrigin='anonymous';
  image.src=`${origin}/image.png`;image.style.cssText='position:absolute;left:0;top:0;width:64px;height:64px';
  const text=document.createElement('span');
  text.textContent='WWW';text.style.cssText='position:absolute;left:70px;top:0;color:black;font:40px/40px InlineSource;white-space:nowrap';
  const background=document.createElement('div');
  background.style.cssText=`position:absolute;left:0;top:64px;width:32px;height:32px;background:url("${origin}/image.png") center/32px 32px`;
  panel.append(image,text,background);document.body.append(panel);
  await image.decode();await document.fonts.load('40px InlineSource');
  const copy=await inlineResources(panel);
  assert(copy.querySelector('img').src.startsWith('data:image/png;base64,'),'Cross-origin image not embedded');
  assert(copy.querySelector('style').textContent.includes('data:font/woff2;base64,'),'Imported CORS font not embedded');
  assert(copy.querySelector('div').style.backgroundImage.includes('data:image/png;base64,'),'CSS image not embedded');
  const markup=new XMLSerializer().serializeToString(copy),svg=new Image();
  svg.src=`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="280" height="100"><foreignObject width="280" height="100">${markup}</foreignObject></svg>`)}`;
  await svg.decode();
  const canvas=document.createElement('canvas');canvas.width=280;canvas.height=100;
  const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(svg,0,0);
  const reference=document.createElement('canvas');reference.width=280;reference.height=100;
  const expected=reference.getContext('2d',{willReadFrequently:true});
  expected.fillStyle='white';expected.fillRect(0,0,280,100);expected.drawImage(image,0,0,64,64);
  expected.fillStyle='black';expected.font='40px InlineSource';expected.fillText('WWW',70,50);
  const pixels=context.getImageData(0,0,280,100).data,ref=expected.getImageData(0,0,280,100).data;
  let matched=0;
  for(let y=0;y<64;y++)for(let x=0;x<64;x++) {
    const at=(y*280+x)*4;
    if(ref[at]<220 && ref[at+1]<220 && ref[at+2]<220) {
      assert([0,1,2].every(k=>Math.abs(ref[at+k]-pixels[at+k])<=1),`Embedded image pixel differs at ${x},${y}`);matched++;
    }
  }
  const width=data=>{
    let low=280,high=-1;
    for(let y=0;y<64;y++)for(let x=70;x<280;x++)if(data[(y*280+x)*4]<128){low=Math.min(low,x);high=Math.max(high,x);}
    return high-low+1;
  };
  const fontWidth=width(pixels),referenceWidth=width(ref);
  assert(matched>100,'Real image fixture had no verified coloured area');
  assert(fontWidth===referenceWidth,`Embedded font width ${fontWidth}, live font ${referenceWidth}`);
  const prepared=await resourceInliner() (panel,new AbortController().signal);
  assert(prepared.querySelector('img').src.startsWith('data:'),'Texture prepare hook did not inline');
  panel.remove();link.remove();
  return {checks:['foreignObject: real CORS image pixels and imported font glyph width match live resources'],measurements:{matchedImagePixels:matched,fontWidth,referenceWidth}};
}

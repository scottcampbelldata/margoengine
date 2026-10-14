import {finiteVector} from '@margoengine/math/validate';
import type {SkyFeatures} from './base.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
// Same default as the sky's moon colour.
const moonColor=[0.25,0.45,0.75] as const;
/** Drives the engine's directional light (sun and moon) and, with `ambient`, the PBR ambient colour (`lighting` option). */
export const lighting:NonNullable<SkyFeatures['lighting']>={
 validate(l){
  if(typeof l!=='object'||l===null||!Number.isFinite(Math.fround(l.intensity??1))||(l.intensity??1)<0||!Number.isFinite(Math.fround(l.minimum??0))||(l.minimum??0)<0)throw new RangeError('Invalid sky options');
  if(l.moon!==undefined&&(typeof l.moon!=='object'||l.moon===null||!Number.isFinite(Math.fround(l.moon.intensity??(l.intensity??1)*0.1))||(l.moon.intensity??0)<0)||l.ambient!==undefined&&(typeof l.ambient!=='object'||l.ambient===null))throw new RangeError('Invalid sky night options');
  for(const color of [l.color,l.sunset,l.moon?.color,l.ambient?.day,l.ambient?.night])if(color!==undefined){finiteVector(color,3,'Sky color');if(color.some(v=>v<0))throw new RangeError('Invalid sky color');}
  if(l.ambient&&(!l.ambient.day||!l.ambient.night))throw new RangeError('Invalid sky ambient colors');
 },
 create(d,owned){
  const buffer=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});owned.push(buffer);const entry={binding:8,resource:{buffer}},ambient=new Float32Array(4);let source='',shader='';
  return {
   update({direction,radiance},sky,l,moonIntensity,night){
    const solar=Math.max(0,sky.sun[1])*(l.intensity??1),lunar=moonIntensity*night,weight=solar+lunar>0?solar/(solar+lunar):1;
    // shortcut: one blended directional source shares PCSS, use separate shadow maps for simultaneous sun/moon shadows.
    direction.set(sky.sun);if(l.moon){for(let i=0;i<3;i++)direction[i]=sky.sun[i]*weight+sky.moon[i]*(1-weight);const norm=Math.hypot(direction[0],direction[1],direction[2]);for(let i=0;i<3;i++)direction[i]/=norm;}
    direction[3]=Math.max(l.minimum??0,solar+lunar);
    if(l.color||l.sunset||l.moon)for(let i=0;i<3;i++)radiance[i]=sky.lights[0].radiance[i]*weight+(l.moon?.color?.[i]??moonColor[i])*(1-weight);
    if(l.ambient){for(let i=0;i<3;i++)ambient[i]=l.ambient.day[i]*(1-night)+l.ambient.night[i]*night;radiance[3]=Math.max(...ambient);}
   },
   pass(c){
    if(source!==c.shader){const patched=c.shader.replace('frame.radiance.w','skyAmbient.rgb');if(patched===c.shader)throw new Error('Sky ambient requires the standard PBR shader');source=c.shader;shader='@group(0) @binding(8) var<uniform> skyAmbient:vec4f;\n'+patched;}
    c.device.queue.writeBuffer(buffer,0,ambient as Float32Array<ArrayBuffer>);c.shader=shader;c.bindings.push(entry);
   }};
 }};

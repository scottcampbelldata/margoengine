import {Light2D} from '@margoengine/lighting2d';
import {RadianceCascade2D} from '@margoengine/lighting2d/gi';
import {occluders} from './layout.js';

const scale = 1/16, width = 49, height = 29;
const walls = occluders.map(({points,shape}) => ({shape,points:points.map(([x,y])=>[x*scale,y*scale])}));
const options = {cascades:2,baseRays:8,angularRatio:3,baseDistance:9,intervalRatio:5,albedo:.72};
const bounced = new RadianceCascade2D({...options,bounces:1});
const unbounced = new RadianceCascade2D({...options,bounces:0});
self.onmessage = ({data:{x,y}}) => {
  try {
    const scene = {
      occluders:walls,
      emitters:[{x:x*scale,y:y*scale,radius:1.85,shape:'circle',color:'#ffd38c',intensity:1.85}],
      lights:[new Light2D({x:x*scale,y:y*scale,radius:16.75,height:6.8,color:'#ffd690',intensity:1.42,falloff:1.45}),
        new Light2D({x:41.56,y:16.44,radius:27.62,height:11.56,color:'#a2d9ca',intensity:.55,falloff:1.6,shadows:false})],
    };
    const rgb = bounced.computeGrid(width,height,scene);
    const direct = unbounced.computeGrid(width,height,scene);
    const rgba = new Uint8ClampedArray(width*height*4);
    const ambient = [.349,.439,.451];
    let indirect = 0;
    for (let i=0;i<width*height;i++) {
      for (let c=0;c<3;c++) {
        const k=i*3+c;
        const reflected = Math.max(0,rgb[k]-direct[k]);
        indirect += reflected;
        const incident = direct[k]*.86 + reflected*2.65;
        rgba[i*4+c] = 255 * (ambient[c] + (1-ambient[c])*(1-Math.exp(-incident*1.45)));
      }
      rgba[i*4+3] = 255;
    }
    postMessage({width,height,rgba,indirect},[rgba.buffer]);
  } catch (error) {
    postMessage({error:error.message});
  }
};

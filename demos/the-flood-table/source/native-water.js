import { Water } from '@margoengine/water';
import { Flood } from '@margoengine/water/flood';
import { bounds, channel, damX, grid, ground, heightmap, houses, levees } from './terrain.js';
function initialWaterline(x, z) {
  if (x < damX) return 1.06;
  return Math.abs(z - channel(x)) < 2.14 ? ground(x, z) + .235 : undefined;
}

export function nativeWater(engine) {
  const lands = heightmap();
  const terrain = engine.gpu.createTexture({
    size:[grid.columns,grid.rows], format:'r32float',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST,
  });
  engine.gpu.queue.writeTexture(
    {texture:terrain},lands,{bytesPerRow:grid.columns*4},[grid.columns,grid.rows],
  );
  const water = Water.attach(engine, {
    height:-12, size:[bounds.width,bounds.length], segments:104,
    terrain:{ heightmap:()=>terrain, origin:[bounds.x,bounds.z], size:[bounds.width,bounds.length],
        heights:{ data:lands,width:grid.columns,height:grid.rows } },
    fill:initialWaterline,
    color:[.014,.20,.167],
    waves:[{direction:[1,.04],amplitude:0,wavelength:1.6}],
    whitecaps:0, chop:.035, foamDistance:.09,
  });
  water.setShallow([.092,.272,.203],.58).setGlitterRoughness(.22);
  const createFlood = () => Flood.attach(engine, {
    surface:water, roughness:.034, maxDepth:2.8, maxSpeed:6.0, boundary:{east:'open'},
    walls:[{from:[damX,-15],to:[damX,15],top:2.15,width:.58}],
    obstacles:(x,z)=>houses.some(([hx,hz])=>Math.abs(x-hx)<.59&&Math.abs(z-hz)<.49)?.95:0,
  });
  let flood = createFlood();
  let released = false;
  return {
    get time(){return flood.time;},
    release(site) {
      if (site !== -1) {
        const {x,z,halfLength,crest}=levees[site];
        flood.wall({from:[x,z-halfLength],to:[x,z+halfLength],top:crest,width:.48});
      }
      flood.breach(0,{at:flood.time,over:.42});
      released=true;
    },
    read(){return flood.read();},
    async verify(){
      const { WaveQuery } = await import('@margoengine/water/query');
      const [mesh,reading] = await Promise.all([WaveQuery.capture(water),flood.read()]);
      const {depth,bed,width,height}=reading;
      let samples=0, errors=0, worst=0;
      for(let j=3;j<height-3;j+=3){
        for(let i=3;i<width-3;i+=3){
          const k=j*width+i, waterDepth=depth[k];
          if(waterDepth<.24||Math.min(depth[k-width],depth[k+width],depth[k-1],depth[k+1])<.18)continue;
          const x=bounds.x+(i+.5)*bounds.width/width;
          if(Math.abs(x-damX)<1.7||levees.some((wall)=>Math.abs(x-wall.x)<1.20))continue;
          const z=bounds.z+(j+.5)*bounds.length/height;
          if(houses.some(([hx,hz])=>Math.abs(x-hx)<1.15&&Math.abs(z-hz)<1.15))continue;
          const measured=mesh.heightAt(x,z);
          if(measured===undefined)continue;
          const error=Math.abs(measured-(bed[k]+waterDepth));
          samples++;
          errors+=error*error;
          worst=Math.max(worst,error);
        }
      }
      return {samples,rms:Math.sqrt(errors/Math.max(samples,1)),worst,wetArea:reading.wetArea,
        solverTime:reading.time,surfaceTime:mesh.time,depth:Array.from(depth)};
    },
    reset() {
      if (!released) return;
      flood.dispose();
      water.setTime(0);
      flood = createFlood();
      released = false;
    },
    dispose(){flood.dispose();water.dispose();terrain.destroy();},
  };
}

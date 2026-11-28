import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { GeospatialControls } from '@margoengine/controls/geospatial';
import { parseGLTF } from '@margoengine/gltf';
import { Shadows } from '@margoengine/shadows';
import { TilesRenderer } from '@margoengine/tiles';
import { dressSample } from './detail.js';
import { sectorKey, sectors, tileset as source } from './assets.js';

const rad=degrees=>degrees*Math.PI/180;
const cityColors=new Map(sectors.map(({key,color})=>[key,color]));

function platform(engine, width, depth, base) {
  const mesh=(g,color,position=[0,0,0],r=.84,m=0)=>engine.createMesh().setGeometry(g)
    .setPosition([position[0],position[1]+base,position[2]]).setMaterial(new PbrMaterial({color,roughness:r,metalness:m,doubleSided:false}));
  const slab=(w,h,d,y,color,r,m)=>mesh(box(w,h,d),color,[0,y,0],r,m);
  slab(1800,2,1600,-9.9,'#294345',.97);
  slab(width+29,6,depth+29,-4.0,'#233842',.42,.28);
  slab(width+23,.60,depth+23,-1.05,'#98976a',.38,.34);
  slab(width+20,.70,depth+20,-.64,'#5b736f',.94);
  const finishes=['#657d70','#5b7468','#587674','#647b78'];
  for(const [k,dx,dz] of [[0,-1,1],[1,1,1],[2,1,-1],[3,-1,-1]]) {
    mesh(box(width/2-1.0,.22,depth/2-1.0),finishes[k],[dx*width*.25,-.178,dz*depth*.25]);
  }
  const grids=(width,depth,step)=> {
    const positions=[],normals=[],indices=[];
    function line(x0,x1,z0,z1) {
      const base=positions.length/3;
      positions.push(x0,-.055,z0,x0,-.055,z1,x1,-.055,z1,x1,-.055,z0);
      normals.push(0,1,0,0,1,0,0,1,0,0,1,0);
      indices.push(base,base+1,base+2,base,base+2,base+3);
    }
    for(let x=-Math.floor(width/2/step)*step;x<width/2;x+=step) {
      for(let z=-Math.floor(depth/2/step)*step;z<depth/2;z+=step) {
        if(x===0||z===0)continue;
        line(x-.10,x+.10,z-.82,z+.82);
        line(x-.82,x+.82,z-.10,z+.10);
      }
    }
    return new Geometry(positions,normals,indices);
  };
  mesh(grids(width,depth,16),'#7e9281',[0,0,0],.93);
  // Inlaid boundaries and tick marks express the regional frame without inventing streets.
  const edge='#a5aa87',accent='#d4b680';
  const ring=box(width+.49,.035,.26),side=box(.26,.035,depth+.49);
  for(const sign of [-1,1]) {
    mesh(ring,edge,[0,-.050,sign*depth/2]);
    mesh(side,edge,[sign*width/2,-.050,0]);
  }
  mesh(box(width,.028,8.1),'#495f61',[0,-.057,0],.90);
  mesh(box(8.1,.028,depth),'#495f61',[0,-.056,0],.90);
  mesh(box(width,.04,.31),accent,[0,-.048,0],.51,.28);
  mesh(box(.31,.04,depth),accent,[0,-.048,0],.51,.28);
  const dash=box(.22,.035,2.05),trace=box(2.05,.035,.22);
  for(let x=-Math.floor(width/2/18)*18;x<width/2;x+=18) {
    mesh(dash,edge,[x,-.01,-depth/2-1.24]);
    mesh(dash,edge,[x,-.01,depth/2+1.24]);
  }
  for(let z=-Math.floor(depth/2/18)*18;z<depth/2;z+=18) {
    mesh(trace,edge,[-width/2-1.24,-.01,z]);
    mesh(trace,edge,[width/2+1.24,-.01,z]);
  }
}
function viewFor(tile) {
  const {region}=tile.bounds;
  return {
    longitude:(region[0]+region[2])*.5,
    latitude:(region[1]+region[3])*.5,
    height:3, pitch:rad(73), heading:rad(6),range:95,
  };
}
const hasTile=(frame,key)=>frame.selected.some(tile=>sectorKey(tile.contentUrls[0])===key);

export async function openSurvey(canvas,force,signal,report,assetFetch,earlyCompatibility) {
  let engine, tiles, geo, light, revision=0, closed=false, error, datum=0;
  let stageAbort=new AbortController();
  const seen=new Set(), visible=[];
  const close=()=>{
    if(closed)return;
    closed=true;
    stageAbort.abort();
    geo?.dispose();
    tiles?.dispose();
    light?.dispose();
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const legacy=!!earlyCompatibility||force||!navigator.gpu;
  const install=async()=>{
    if(earlyCompatibility) {
      const result=await earlyCompatibility;
      if(result.error)throw result.error;
      return;
    }
    await (await import('./compatibility.js')).installCompatibility(force,signal);
  };

  function fit() {
    const ratio=Math.min(devicePixelRatio,2,1440/Math.max(1,canvas.clientWidth));
    const w=Math.max(1,Math.round(canvas.clientWidth*ratio)),h=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    engine.camera.fov=Math.min(56,37.4*Math.pow(1.77/(w/h),.63));
  }
  function read() {
    const {ready,queued,loading,failed,bytes}=tiles.tileset.progress;
    visible.length=0;
    for(const tile of tiles.last.selected) visible.push(sectorKey(tile.contentUrls[0]));
    const eye=engine.camera.position;
    return {
      visible:[...visible].sort().join(','),loaded:[...seen].sort().join(','),ready,pending:queued+loading,failed,bytes,
      altitude:eye[1]-datum,east:eye[0],south:eye[2],
    };
  }

  function awaitVisible(key,attemptSignal) {
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>settle(new Error('The requested sector did not display in time.')),9500);
      let remove=()=>{};
      function settle(cause) {
        clearTimeout(timeout);remove();
        attemptSignal.removeEventListener('abort',cancel);
        if(cause)reject(cause);
        else resolve();
      }
      const cancel=()=>settle(attemptSignal.reason);
      attemptSignal.addEventListener('abort',cancel,{once:true});
      remove=engine.onFrame(()=>{
        if(error){settle(error);return;}
        if(key==='overview'?tiles.last.selected.length!==4:!hasTile(tiles.last,key))return;
        remove();
        // This callback follows a completed selection/draw and fences its queued GPU work.
        engine.gpu.queue.onSubmittedWorkDone().then(()=>settle(error),settle);
      });
      if(attemptSignal.aborted)cancel();
    });
  }
  function decorate({kind,model,tile}) {
    if(kind!=='model')return {dispose(){}};
    const key=sectorKey(tile.contentUrls[0]);
    const releases=[];
    for(const mesh of model.meshes) {
      if(!mesh.geometry)continue;
      mesh.setMaterial(new PbrMaterial({
        color:cityColors.get(key), roughness:.74, metalness:0, doubleSided:false,
      }));
      releases.push(light.add(mesh,{static:true}),dressSample(engine,mesh,tile));
    }
    return {dispose(){for(const remove of releases)remove();}};
  }

  if(legacy)await install();
  try {
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu) {
        const fail=new Error('The survey requires WebGPU or Margo’s full WebGL2 compatibility layer.');
        fail.code='unsupported';throw fail;
      }
      engine=target;
      canvas=target.canvas;
      error=undefined;
      engine.onError=cause=>{error=cause;};
      stageAbort.abort();
      stageAbort=new AbortController();
      seen.clear();
      engine.scene.background='#263e41';
      engine.lighting.direction.set([-.56,.61,.56,2.53]);
      engine.lighting.radiance.set([1,.84,.65,.51]);
      engine.lighting.ambient.set([.53,.64,.74]);
      performance.mark('margo-device-open');
      tiles=await TilesRenderer.load(engine,source,{
        fetch:assetFetch,signal:stageAbort.signal,maximumScreenSpaceError:13,maxConcurrentRequests:2,
        memoryBudget:256*1024,budget:'content',decorate,
        async loadModel(target,gltf,sig) {
          sig.throwIfAborted();
          return parseGLTF(target,gltf);
        },
      });
      signal.throwIfAborted();
      const root=tiles.tileset.root.bounds.region;
      const a=tiles.cartographicToWorld(root[0]/rad(1),root[1]/rad(1),0);
      const b=tiles.cartographicToWorld(root[2]/rad(1),root[3]/rad(1),0);
      // The ENU centre of the root includes its height interval midpoint.
      datum=(a[1]+b[1])/2;
      platform(engine,b[0]-a[0],a[2]-b[2],datum);
      light=Shadows.attach(engine,{resolution:1024,bounds:{min:[-250,-14,-250],max:[250,32,250]},filter:'pcf',normalBias:.08});
      let lastVisible='';
      tiles.tileset.on('selection',({selected})=>{
        const changed=selected.map(t=>t.id).join('|');
        if(changed===lastVisible)return;
        lastVisible=changed;
        light.invalidate();
      });
      tiles.tileset.on('tileload',({tile})=>{seen.add(sectorKey(tile.contentUrls[0]));});
      tiles.tileset.on('error',({error:cause})=>{error=cause;});
      const first=tiles.tileset.root.children.find(tile=>sectorKey(tile.contentUrls[0])==='ll');
      geo=new GeospatialControls(engine,canvas,{
        frame:tiles,view:viewFor(first),scene:false,geoid:null,heightAt:()=>0,
        minPitch:rad(35),maxPitch:rad(86),minRange:55,maxRange:780,clearance:6,
      });
      fit();
      engine.camera.update(canvas.width/canvas.height,true);
      engine.render({delta:0});
      const ready=awaitVisible('ll',stageAbort.signal);
      engine.onFrame(()=>{
        if(signal.aborted)return;
        if(error){report({error});return;}
        fit();
        report(read());
      });
      engine.start();
      await ready;
    },{
      backend:legacy?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:true,capacity:238,startupTimeout:11000,
      camera:{near:.7,far:2200,fov:43},
    });
  } catch(cause) {
    close();throw cause;
  }
  return {
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
    close,read,
    async fly(key) {
      signal.throwIfAborted();
      const overview=key==='overview';
      const tile=overview?tiles.tileset.root:tiles.tileset.root.children.find(item=>sectorKey(item.contentUrls[0])===key);
      if(!tile)throw new Error('Unknown flight destination.');
      const token=++revision;
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
      const target=viewFor(tile);
      if(overview)Object.assign(target,{pitch:rad(67),heading:rad(16),range:704,height:0});
      const ok=await geo.flyTo(target,{duration:reduced?0:.38,arc:false,signal});
      if(!ok||token!==revision||signal.aborted)return false;
      await awaitVisible(key,stageAbort.signal);
      return true;
    },
  };
}

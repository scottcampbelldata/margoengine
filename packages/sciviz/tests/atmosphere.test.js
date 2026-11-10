import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'vite';
import {globeSunDirection,geographicFlowGrid,globeAtmosphere} from '../dist/atmosphere.js';
import {project,WGS84} from '../dist/geo.js';

test('solar ECEF frame agrees with the published NREL SPA example, without horizon refraction',()=>{
 const sun=globeSunDirection(new Date('2003-10-17T19:30:30Z'));
 const phi=39.742476*Math.PI/180,lon=-105.1786*Math.PI/180;
 const up=[Math.cos(phi)*Math.cos(lon),Math.cos(phi)*Math.sin(lon),Math.sin(phi)];
 const east=[-Math.sin(lon),Math.cos(lon),0],north=[-Math.sin(phi)*Math.cos(lon),-Math.sin(phi)*Math.sin(lon),Math.cos(phi)];
 const dot=v=>v.reduce((s,x,c)=>s+x*sun[c],0);
 const zenith=Math.acos(dot(up))*180/Math.PI;
 const azimuth=(Math.atan2(dot(east),dot(north))*180/Math.PI+360)%360;
 // NREL example uses refraction; geometric zenith is 50.12795 degrees (Appendix A).
 assert.ok(Math.abs(zenith-50.12795)<0.03,`${zenith}`);
 assert.ok(Math.abs(azimuth-194.34024)<0.03,`${azimuth}`);
 assert.ok(Math.abs(Math.hypot(...sun)-1)<1e-12);
 assert.throws(()=>globeSunDirection(new Date(NaN)),/Date/);
});

test('WGS84 geodetic metre heights and the spherical transport distortion have explicit bounds',()=>{
 for(const lat of [-90,-60,-30,0,30,60,90])for(const lon of [-180,-45,0,120]){
  const p=project(lon,lat,0,'globe'),high=project(lon,lat,1000,'globe');
  assert.ok(Math.abs(Math.hypot(...high.map((x,c)=>x-p[c]))*WGS84.a-1000)<1e-8);
  assert.ok(Math.abs(Math.hypot(p[0],p[1],p[2]/(1-WGS84.f))-1)<1e-14);
 }
 assert.ok(1/(1-WGS84.f)-1<0.003365);
});

test('east/north m/s convert to angular rates by WGS84 curvature, preserving height and time',()=>{
 const grid={dims:[2,3,2],bounds:[-30,30,-60,60,1000,10000],frames:[{time:7,u:new Float32Array(12).fill(10),v:new Float32Array(12).fill(20),w:new Float32Array(12).fill(3)}]};
 const output=geographicFlowGrid(grid);
 for(let z=0;z<2;z++)for(let y=0;y<3;y++)for(let x=0;x<2;x++){
  const at=z*6+y*2+x,phi=(-60+y*60)*Math.PI/180,h=1000+9000*z;
  const k=1-WGS84.e2*Math.sin(phi)**2,N=WGS84.a/Math.sqrt(k),M=WGS84.a*(1-WGS84.e2)/k**1.5;
  assert.equal(output.frames[0].u[at],Math.fround(10/(N+h)/Math.cos(phi)*180/Math.PI));
  assert.equal(output.frames[0].v[at],Math.fround(20/(M+h)*180/Math.PI));
 }
 assert.equal(output.frames[0].time,7);assert.deepEqual(output.frames[0].w,grid.frames[0].w);
 output.frames[0].w[0]=0;assert.equal(grid.frames[0].w[0],3);
 assert.throws(()=>geographicFlowGrid({...grid,bounds:[0,30,-90,60,1000,10000]}),/poles/);
 assert.throws(()=>geographicFlowGrid({...grid,frames:[{...grid.frames[0],u:new Float32Array(1)}]}),/per grid sample/);
});

test('cancellation settles before GPU allocation, and the root imports no atmosphere',async()=>{
 const reason={abort:'before allocation'},controller=new AbortController();controller.abort(reason);
 await assert.rejects(globeAtmosphere({}, {signal:controller.signal}),error=>error===reason);
 const root=readFileSync(new URL('../dist/index.js',import.meta.url),'utf8');
 assert.doesNotMatch(root,/sky\/planet|sky\/astro|planetWGSL|PlanetAtmosphere/);
 const source=readFileSync(new URL('../src/atmosphere.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/readPositions|mapAsync|readBuffer/);
});

test('a consuming build of root, geographic tiles, scalar meshes and flow imports no sky code',async()=>{
 const result=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,target:'es2022',lib:{entry:'atmosphere-boundary',formats:['es']},rollupOptions:{input:'atmosphere-boundary'}},plugins:[{name:'atmosphere-boundary',resolveId:id=>id==='atmosphere-boundary'?id:null,load:id=>id==='atmosphere-boundary'?`export {Figure} from '@margoengine/sciviz'; export {tileLayer} from '@margoengine/sciviz/geo'; export {meshLayer} from '@margoengine/sciviz/grids'; export {flowParticles} from '@margoengine/sciviz/flow';`:null}]});
 const modules=[result].flat().flatMap(x=>x.output).filter(x=>x.type==='chunk').flatMap(x=>Object.keys(x.modules));
 assert.ok(modules.length>10);assert.ok(modules.every(path=>!path.replaceAll('\\','/').includes('/packages/sky/')),modules.filter(path=>path.includes('sky')).join('\n'));
});

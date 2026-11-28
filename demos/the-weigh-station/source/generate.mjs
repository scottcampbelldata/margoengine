import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if (!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public engine checkout.');
const { model } = await import(pathToFileURL(resolve(checkout, 'packages/brep/dist/index.js')));
const { frameOf, cylinder, boolean, extrude, checkBody, massProperties, meshBodies } = model;
const vertical = (x, y, z) => frameOf([x, y, z], [0, 1, 0], [1, 0, 0]);
const cutBore = (name, blank, x, z, r) => boolean(name, 'subtract', blank, cylinder(name+'-tool',r,.091,vertical(x,-.010,z)));

const wheel = cutBore('flywheel', cylinder('flywheel-blank',.064,.026,vertical(0,0,0)),0,0,.016);
const cam = cutBore('eccentric-cam', cylinder('cam-blank',.055,.044,vertical(0,0,0)),-.020,.013,.018);
const points = [[-.069,0,-.043],[-.050,0,-.056],[.066,0,-.037],[.056,0,.009],[.029,0,.049],[-.055,0,.037]];
const rawYoke = extrude('yoke-blank',{
  name:'yoke-profile', start:points[0], normal:[0,1,0],
  segments:[...points.slice(1),points[0]].map(to => ({kind:'line',to})),
},[0,.023,0]);
const yoke = cutBore('yoke',cutBore('yoke-first-bore',rawYoke,-.037,-.015,.012),.027,-.010,.016);

const display = [wheel,cam,yoke].map(body => {
  const problems = checkBody(body);
  assert.equal(problems.length,0,body.name+': '+JSON.stringify(problems));
  const mass = massProperties(body);
  assert.ok(mass.volume>0 && mass.inertia.slice(0,3).every(i=>i>0));
  const { meshes:[ mesh ] } = meshBodies([body],{deflection:.000085,angle:.13,interiorDeflection:.0002});
  assert.equal(mesh.failures.length,0,body.name+' failed tessellation');
  return {
    ...mass,
    top:mesh.positions.reduce((top,value,i)=>i%3===1?Math.max(top,value):top,0),
    position:Array.from(mesh.positions,v=>+v.toFixed(7)),
    normal:Array.from(mesh.normals,v=>+v.toFixed(6)),
    index:Array.from(mesh.indices),
  };
});
const [ring,offsetCam] = display;
const [r,b,h]=[.064,.016,.026];
const value=Math.PI*(r*r-b*b)*h;
assert.ok(Math.abs(ring.volume-value)<1e-11);
assert.ok(Math.abs(ring.inertia[1]-value*(r*r+b*b)/2)<1e-11);
assert.ok(Math.abs(ring.centroid[0])<1e-10 && Math.abs(ring.centroid[2])<1e-10);
assert.ok(offsetCam.centroid[0]>0 && offsetCam.centroid[2]<0);
const data=gzipSync(JSON.stringify(display),{level:9});
await writeFile(new URL('./assets/bodies.bin',import.meta.url),data);
console.log(JSON.stringify({bytes:data.length,properties:display.map(({volume,centroid,inertia})=>({volume,centroid,inertia}))}));

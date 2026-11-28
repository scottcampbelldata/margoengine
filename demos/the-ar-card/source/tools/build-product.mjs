import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const engine = process.env.MARGO_ENGINE_CHECKOUT;
const api = (entry) => pathToFileURL(resolve(engine,'packages/exporters/dist',entry));
const { exportGLB } = await import(api('index.js'));
const { exportUSDZ, measureUSDZ } = await import(api('usdz.js'));
const tau = Math.PI * 2;
const linear = (value) => value <= .04045 ? value / 12.92 : ((value+.055)/1.055)**2.4;
const color = (hex) => [0,2,4].map((i)=>linear(Number.parseInt(hex.slice(i,i+2),16)/255)).concat(1);
const palette = {
  Enamel: ['ac4f37',.31,0], Shoulder: ['62362e',.36,0], Charcoal: ['343b3a',.41,0],
  Recess: ['262d2d',.82,0], Brass: ['c59565',.31,1], Studs: ['ead0a5',.29,1],
  Scale: ['dfb975',.52,0], Needle: ['ec9264',.38,0], Bakelite: ['51382e',.24,0],
  DialGlass: ['363d39',.19,0], Rubber: ['383433',.78,0], Rim: ['875f49',.55,0],
};
const groups = new Map(Object.entries(palette).map(([name,[hex,roughness,metalness]])=>[name,{
  positions:[],normals:[],indices:[], material:{name,color:color(hex),roughness,metalness},
}]));

function panel(name, [cx,cy,cz], [width,height,depth], radius, bevel, { samples=4, slope=0, yaw=0 }={}) {
  const {positions,normals,indices}=groups.get(name);
  const section=[];
  const arc=[ [1,1],[-1,1],[-1,-1],[1,-1] ];
  const circular = Math.abs(width-2*radius)<1e-9 && Math.abs(height-2*radius)<1e-9;
  if(circular) {
    for(let i=0;i<samples*4;i++) section.push([0,0,tau*i/(samples*4)]);
  } else {
    for (const [q,[sx,sy]] of arc.entries()) for(let i=0;i<=samples;i++) {
      section.push([(width/2-radius)*sx,(height/2-radius)*sy,(q+i/samples)*Math.PI/2]);
    }
  }
  const base=positions.length/3, steps=Math.min(width,height)>.009 ? 3 : 1;
  const cos=Math.cos(yaw), sin=Math.sin(yaw);
  const push=(x,y,z,nx,ny,nz)=>{
    positions.push(cx+x*cos-y*sin,cy+x*sin+y*cos,cz+z+(x*sin+y*cos)*slope);
    const dx=nx*cos-ny*sin, dy=nx*sin+ny*cos-nz*slope, length=Math.hypot(dx,dy,nz);
    normals.push(dx/length,dy/length,nz/length);
  };
  for(const sign of [-1,1]) for(let ring=0;ring<=steps;ring++) {
    const round=sign<0?steps-ring:ring;
    const angle=round*Math.PI/(2*steps);
    const cosBevel=Math.cos(angle), sinBevel=Math.sin(angle);
    const r=radius-bevel*(1-cosBevel), z=sign*(depth/2-bevel+bevel*sinBevel);
    for(const [x,y,azimuth] of section) {
      const nx=Math.cos(azimuth), ny=Math.sin(azimuth);
      push(x+r*nx,y+r*ny,z,nx*cosBevel,ny*cosBevel,sign*sinBevel);
    }
  }
  const n=section.length;
  for(let ring=0;ring<2*steps+1;ring++) for(let i=0;i<n;i++) {
    const a=base+n*ring+i, b=base+n*ring+(i+1)%n;
    indices.push(a,b,b+n,a,b+n,a+n);
  }
  for(const sign of [-1,1]) {
    const center=positions.length/3;
    push(0,0,sign*depth/2,0,0,sign);
    const rim=base+(sign>0?(2*steps+1)*n:0);
    for(let i=0;i<n;i++) {
      const a=rim+i,b=rim+(i+1)%n;
      if(sign>0) indices.push(center,a,b);
      else indices.push(center,b,a);
    }
  }
}

function stroke(name, a, b, width, z) {
  panel(name,[(a[0]+b[0])/2,(a[1]+b[1])/2,z],[Math.hypot(b[0]-a[0],b[1]-a[1]),width,.0007],
    width*.42,.0001,{samples:1,yaw:Math.atan2(b[1]-a[1],b[0]-a[0])});
}

// The main cast shell and anodized front and rear panels share a master silhouette.
panel('Enamel',[0,.067,-.004],[.224,.124,.080],.017,.005,{samples:9,slope:-.045});
panel('Shoulder',[0,.068,.0357],[.219,.115,.008],.016,.003,{samples:7,slope:-.045});
panel('Charcoal',[0,.068,.040],[.209,.106,.0060],.014,.002,{samples:7,slope:-.045});
panel('Shoulder',[0,.068,-.044],[.213,.112,.0065],.014,.002,{samples:6});
panel('Charcoal',[0,.068,-.0476],[.199,.098,.0045],.012,.0015,{samples:5});
for(const x of [-.073,.073]) panel('Rubber',[x,.0045,-.002],[.038,.009,.063],.004,.001,{samples:3});

// Recessed mesh and raised horizontal fins with alternate lengths at their rolled ends.
const grilleX=-.035, grilleY=.056;
panel('Recess',[grilleX,grilleY,.04325],[.127,.063,.004],.012,.0012,{samples:5,slope:-.045});
for(let i=0;i<14;i++) {
  const y=grilleY+(i-6.5)*.0036;
  const width=.113-.016*(Math.abs(i-6.5)/6.5)**4;
  panel('Rim',[grilleX,y,.0456-(y-.068)*.045],[width,.00185,.0022],.0008,.00037,{samples:2});
}
// The calibrated tuning window reads above the grille. Its scale lives on the product surface.
panel('Brass',[-.038,.103,.04165],[.119,.019,.0046],.007,.0013,{samples:5,slope:-.045});
panel('DialGlass',[-.038,.103,.0441],[.113,.0145,.0028],.0058,.00065,{samples:4,slope:-.045});
for(let i=0;i<=20;i++) {
  const x=-.088+i*.005;
  const y=.1025;
  const h=i%5===0?.0056:i%2===0?.0032:.0018;
  stroke('Scale',[x,y-.003],[x,y+h-.003],i%5===0?.00082:.00057,.04610);
}
stroke('Needle',[-.031,.097],[-.031,.109],.0014,.04643);
stroke('Needle',[-.035,.098],[-.027,.098],.0011,.04643);

// Machined tuning wheel, fine lateral grip ribs, Bakelite center and brass position mark.
const dx=.070,dy=.065;
panel('Recess',[dx,dy,.0455],[.071,.071,.006],.0355,.0013,{samples:12});
panel('Brass',[dx,dy,.050],[.0615,.0615,.018],.03075,.003,{samples:12});
for(let g=0;g<32;g++) {
  const p=tau*g/32;
  const u=dx+.0308*Math.cos(p), v=dy+.0308*Math.sin(p);
  panel('Studs',[u,v,.050],[.002,.00105,.012],.00046,.00016,{samples:1,yaw:p});
}
panel('Shoulder',[dx,dy,.0594],[.0505,.0505,.0040],.02525,.0017,{samples:10});
panel('Bakelite',[dx,dy,.0615],[.0454,.0454,.0065],.0227,.0025,{samples:10});
stroke('Scale',[dx,dy+.0152],[dx,dy+.0208],.0015,.0650);
panel('Needle',[.091,.106,.0446],[.007,.007,.003],.0035,.00075,{samples:6});

// A raised functional bridge handle and its two anodized uprights.
for(const s of [-1,1]) {
  const x=s*.059-.006;
  panel('Shoulder',[x,.129,-.017],[.021,.011,.026],.0045,.0018,{samples:4});
  panel('Brass',[x,.139,-.017],[.010,.026,.017],.0035,.0014,{samples:4,yaw:s*.22});
  panel('Studs',[x,.134,-.0079],[.004,.004,.0012],.002,.0002,{samples:4});
}
panel('Brass',[-.006,.151,-.017],[.135,.012,.016],.005,.0019,{samples:6});
panel('Charcoal',[-.006,.153,-.016],[.106,.014,.021],.006,.002,{samples:7});
for(let i=0;i<19;i++) panel('Rim',[-.051+.005*i,.1585,-.0046],[.0010,.0032,.00115],.00044,.00012,{samples:1,yaw:-.16});

// Rear thermal vents and the charging and auxiliary sockets.
for(let i=-6;i<=6;i++) panel('Recess',[i*.008,.093,-.0500],[.0045,.019,.002],.00215,.0005,{samples:2});
panel('Rim',[.045,.044,-.0506],[.054,.018,.0036],.005,.0008,{samples:4});
panel('Recess',[.040,.044,-.05255],[.018,.006,.0020],.00265,.00045,{samples:4});
panel('Brass',[.063,.044,-.05255],[.009,.009,.0020],.0045,.0004,{samples:5});
panel('Recess',[.063,.044,-.0537],[.0045,.0045,.0018],.00225,.0003,{samples:4});
for(const x of [-.077,.077]) for(const y of [.033,.102]) {
  panel('Brass',[x,y,-.0504],[.005,.005,.0016],.0025,.0005,{samples:4});
  stroke('Recess',[x-.0015,y],[x+.0015,y],.00066,-.05135);
}

const wordmark=[[[0,1],[.43,0]],[[.43,0],[.87,1]],[[1.39,.78],[1.7,1]],
  [[1.7,1],[1.7,0]],[[2.18,1],[2.82,1]],[[2.82,1],[2.42,0]]];
for(const [[ax,ay],[bx,by]] of wordmark) stroke('Scale',[-.012-ax*.006,.049+ay*.007],[-.012-bx*.006,.049+by*.007],.0007,-.05055);

const scene = { nodes:[...groups].map(([name,{positions,normals,indices,material}])=>({
  name:'Vela17_'+name,material,geometry:{positions:Float32Array.from(positions),normals:Float32Array.from(normals),indices:Uint32Array.from(indices)},
})) };
const glb=exportGLB(scene,{generator:'Margo Web Demos · Vela 17'});
const binary=Buffer.from(glb);
const manifest=JSON.parse(binary.subarray(20,20+binary.readUInt32LE(12)).toString('utf8'));
assert.equal(new Set(manifest.materials.map(m=>m.pbrMetallicRoughness.baseColorFactor.join())).size,12);
const dimensions=measureUSDZ(glb);
const usdz=exportUSDZ(glb,{ground:true});
assert.ok(dimensions.size[0]>.223 && dimensions.size[0]<.225);
assert.equal(dimensions.bounds.min[1],0);
const write=(name,bytes)=>writeFile(new URL('../assets/'+name,import.meta.url),bytes);
await Promise.all([
  write('vela-17.glb',glb),write('vela-17.bin',gzipSync(glb,{level:9})),
  write('vela-17.usdz',usdz),write('vela-17-ar.bin',gzipSync(usdz,{level:9})),
]);
console.log({dimensions,glbBytes:glb.length,usdzBytes:usdz.length,
  triangles:scene.nodes.reduce((n,mesh)=>n+mesh.geometry.indices.length/3,0)});

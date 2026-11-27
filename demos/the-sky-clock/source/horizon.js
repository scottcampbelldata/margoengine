import {Geometry,PbrMaterial,box} from '@margoengine/core';

function ridge(radius,seed,depth,amplitudes){
  const positions=[],normals=[],indices=[],n=240;
  const noise=(i)=>.58*Math.sin(i*3+seed)+.30*Math.sin(i*7-seed)+.18*Math.sin(i*17+seed*.71)+.08*Math.sin(i*41+seed*.27);
  for(let i=0;i<=n;i++){
    const theta=i*2*Math.PI/n;
    const x=Math.sin(theta)*radius,z=-Math.cos(theta)*radius;
    const height=depth+amplitudes*(noise(theta)+.10);
    positions.push(x,-7,z,x,height,z);
    normals.push(-x/radius,0,-z/radius,-x*.60/radius,.8,-z*.60/radius);
    if(i){
      const a=(i-1)*2,b=i*2;
      indices.push(a,b,b+1,a,b+1,a+1);
    }
  }
  return new Geometry(positions,normals,indices);
}
export function makeHorizon(engine){
  const mount=(geom,color)=>engine.createMesh().setGeometry(geom).setMaterial(
    new PbrMaterial({color,roughness:1,metalness:0}));
  mount(box(315,.3,315),'#0b101a').setPosition([0,-5.8,0]);
  mount(ridge(120,2.48,.2,2.2),'#18233a');
  mount(ridge(87,.82,-1.45,2.1),'#111927');
  mount(ridge(62,4.71,-2.05,1.64),'#0c1522');
}

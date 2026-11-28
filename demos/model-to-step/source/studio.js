import { Geometry,PbrMaterial } from '@margoengine/core';

function pedestal(profile,steps=96,sphere=false) {
  const positions=[],normals=[],indices=[];
  for (let i=0; i<profile.length-1; i++) {
    const [r0,y0]=profile[i], [r1,y1]=profile[i+1];
    const [dr,dy]=[r1-r0,y1-y0];
    const length=Math.hypot(dr,dy);
    const at=positions.length/3;
    for (let j=0; j<=steps; j++) {
      const angle=j*2*Math.PI/steps;
      const x=Math.cos(angle),z=Math.sin(angle);
      positions.push(r0*x,y0,r0*z,r1*x,y1,r1*z);
      if (sphere) {
        const a=Math.hypot(r0,y0), b=Math.hypot(r1,y1);
        normals.push(r0*x/a,y0/a,r0*z/a,r1*x/b,y1/b,r1*z/b);
      } else normals.push(dy*x/length,-dr/length,dy*z/length,dy*x/length,-dr/length,dy*z/length);
      if (j<steps) {
        const a=at+j*2;
        indices.push(a,a+1,a+2,a+2,a+1,a+3);
      }
    }
  }
  return new Geometry(positions,normals,indices);
}

function calibrate(inner,outer,y) {
  const positions=[],normals=[],indices=[];
  for (let k=0; k<36; k++) {
    const angle=k*Math.PI/18;
    const step=k%3===0?.008:.0036;
    const id=positions.length/3;
    for (const [r,t] of [[outer,-.007],[outer,.007],[Math.max(inner,outer-step),.007],[Math.max(inner,outer-step),-.007]]) {
      positions.push(r*Math.cos(angle+t),y,r*Math.sin(angle+t));
      normals.push(0,1,0);
    }
    indices.push(id,id+2,id+1,id,id+3,id+2);
  }
  return new Geometry(positions,normals,indices);
}

export function makeStudio(engine) {
  engine.scene.background='#34443c';
  engine.lighting.direction.set([-.56,.77,.31,3.2]);
  engine.lighting.radiance.set([1,.90,.76,.88]);
  engine.lighting.ambient.set([.80,.88,.94]);

  const enclosure=Array.from({length:25},(_,index)=>{
    const angle=index*Math.PI/24;
    return [.88*Math.sin(angle),-.88*Math.cos(angle)];
  });
  engine.createMesh().setGeometry(pedestal(enclosure,48,true))
    .setMaterial(new PbrMaterial({color:'#56695e',roughness:.95})).name='Studio cyclorama';

  const stand=pedestal([
    [0,-.010],[.074,-.010],[.078,-.0075],[.078,-.0048],[.076,-.0032],[.072,-.0029],[0,-.0029],
  ]);
  engine.createMesh().setGeometry(stand).setMaterial(new PbrMaterial({color:'#314940',roughness:.73})).name='Slate instrument rest';
  engine.createMesh().setGeometry(calibrate(.061,.071,-.0028))
    .setMaterial(new PbrMaterial({color:'#697465',roughness:.85})).name='Index marks';
  const support=pedestal([[0,-.003],[.0058,-.003],[.006,-.0024],[.006,.00001],[0,.00001]],24);
  const polymer=new PbrMaterial({color:'#26322f',roughness:.90});
  for (let k=0; k<3; k++) {
    const angle=(k/3+.13)*Math.PI*2;
    engine.createMesh().setGeometry(support).setMaterial(polymer)
      .setPosition([Math.cos(angle)*.042,0,Math.sin(angle)*.042]).name='Rest button '+(k+1);
  }

  const materials=[
    {name:'Satin bronze',color:'#a6814c',roughness:.44},
    {name:'Turned chamfer',color:'#c0a173',roughness:.33},
    {name:'Recessed bore surfaces',color:'#62553e',roughness:.49},
  ];
  const meshes=materials.map(({name,color,roughness})=>{
    const mesh=engine.createMesh().setMaterial(new PbrMaterial({color,roughness,metalness:0}));
    mesh.name=name;
    return mesh;
  });
  const holes=Array.from({length:4},(_,i)=>{
    const angle=(i+.5)*Math.PI/2;
    return [.044*Math.cos(angle),.044*Math.sin(angle)];
  });
  const finish=(p,n,i)=>{
    const radius=Math.hypot(p[i],p[i+2]);
    const y=p[i+1], nz=Math.abs(n[i+1]);
    if (nz<.22 && radius<.0201) return 2;
    if (nz<.22 && y<.0121 && radius>.029 && radius<.052) {
      const wall=holes.some(([x,z])=>{
        const d=Math.hypot(p[i]-x,p[i+2]-z);
        return Math.abs(d-.00425)<1e-5 || Math.abs(d-.0071)<1e-5;
      });
      if (wall) return 2;
    }
    if (nz>.19 && nz<.80) return 1;
    return 0;
  };
  function surfaces({positions,normals,indices},known) {
    const groups=meshes.map(()=>({positions:[],normals:[],indices:[],vertices:new Map()}));
    for (let i=0; i<indices.length; i+=3) {
      const a=indices[i],b=indices[i+1],c=indices[i+2];
      const group=groups[known?finish(positions,normals,3*a):0];
      for (const vertex of [a,b,c]) {
        let target=group.vertices.get(vertex);
        if (target===undefined) {
          target=group.positions.length/3;
          group.vertices.set(vertex,target);
          const p=vertex*3;
          group.positions.push(positions[p],positions[p+1],positions[p+2]);
          group.normals.push(normals[p],normals[p+1],normals[p+2]);
        }
        group.indices.push(target);
      }
    }
    return groups;
  }
  const turning=engine.createMesh().setMaterial(new PbrMaterial({color:'#aa8752',roughness:.51}));
  turning.name='Circular tool finish';
  function toolFinish(diameter) {
    if (!diameter) { turning.setGeometry(null); return; }
    const start=diameter/2000+.0027;
    const positions=[],normals=[],indices=[];
    const sides=96;
    for (let k=0; k<8; k++) {
      const radius=start+(.0308-start)*(k+1)/9;
      const at=positions.length/3;
      for (let j=0; j<=sides; j++) {
        const theta=j*2*Math.PI/sides, x=Math.cos(theta), z=Math.sin(theta);
        const y=.024022;
        positions.push(radius*x,y,radius*z,(radius+.000085)*x,y,(radius+.000085)*z);
        normals.push(0,1,0,0,1,0);
        if (j<sides) {
          const i=at+j*2;
          indices.push(i,i+2,i+1,i+1,i+2,i+3);
        }
      }
    }
    turning.setGeometry(new Geometry(positions,normals,indices));
  }
  return {
    shape(source,center=[0,0,0],scale=1,diameter) {
      toolFinish(diameter);
      const groups=surfaces(source,Boolean(diameter));
      const offset=center.map(value=>value*scale);
      for (const [i,part] of meshes.entries()) {
        const {positions,normals,indices}=groups[i];
        part.setGeometry(indices.length?new Geometry(positions,normals,indices):null);
        part.setScale([scale,scale,scale]);
        part.setPosition(offset);
      }
    },
  };
}
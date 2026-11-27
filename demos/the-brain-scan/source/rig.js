import { Geometry, PbrMaterial, box } from '@margoengine/core';

const ring = (inside, outside, bottom, top) => {
  const positions=[], normals=[], indices=[];
  const count=96,time=Math.PI*2/count;
  const point=(a,r,y)=>[Math.cos(a)*r,y,Math.sin(a)*r];
  function quad(corners,normal,reverse=false){
    const first=positions.length/3;
    for(const c of corners){positions.push(...c);normals.push(...normal);}
    indices.push(...(reverse?[0,2,1,0,3,2]:[0,1,2,0,2,3]).map(i=>first+i));
  }
  for(let i=0;i<count;i++){
    const a=i*time, b=a+time;
    const m=(a+b)*.5;
    const radial=[Math.cos(m),0,Math.sin(m)];
    quad([point(a,inside,top),point(b,inside,top),point(b,outside,top),point(a,outside,top)],[0,1,0]);
    quad([point(a,inside,bottom),point(b,inside,bottom),point(b,outside,bottom),point(a,outside,bottom)],[0,-1,0],true);
    quad([point(a,outside,bottom),point(a,outside,top),point(b,outside,top),point(b,outside,bottom)],radial);
    quad([point(a,inside,bottom),point(a,inside,top),point(b,inside,top),point(b,inside,bottom)],radial.map(v=>-v),true);
  }
  return new Geometry(positions,normals,indices);
};

export function buildRig(engine, dimensions) {
  const unit=(color,roughness=.62)=>new PbrMaterial({color,roughness});
  const shell=unit('#35434b',.54);
  const trim=unit('#738786',.55);
  const pad=unit('#283941',.82);
  const colors={axial:'#80aabb',coronal:'#d2a777',sagittal:'#78ae9c'};
  const piece=(parent,g,m,p)=>engine.createMesh(parent).setGeometry(g).setMaterial(m).setPosition(p);
  const deco=engine.createMesh();
  const [x,y,z]=dimensions;
  const foot=-y-.027;
  piece(deco,ring(.099,.130,foot-.011,foot-.001),shell,[0,0,0]);
  piece(deco,ring(.130,.134,foot-.009,foot-.002),trim,[0,0,0]);
  piece(deco,ring(.111,.126,foot-.0024,foot-.0008),pad,[0,0,0]);
  piece(deco,ring(.094,.097,foot-.006,foot-.002),trim,[0,0,0]);
  piece(deco,ring(.067,.068,foot-.009,foot-.004),pad,[0,0,0]);
  const tick=box(.0022,.0014,.0067);
  for(let n=0;n<36;n++){
    const a=n*Math.PI/18;
    const m=piece(deco,tick,n%3===0?trim:shell,[.123*Math.sin(a),foot+.0004,.123*Math.cos(a)]);
    m.setQuaternion([0,Math.sin(a*.5),0,Math.cos(a*.5)]);
  }

  const pairs={axial:[1,0,2],coronal:[2,0,1],sagittal:[0,2,1]};
  const frames={};
  const wireWidth=.00070;
  const corners=[-1,1];
  for (const [label,[normal,w,h]] of Object.entries(pairs)) {
    const material=unit(colors[label],.63);
    const frame=engine.createMesh();
    const width=dimensions[w]+.0007,height=dimensions[h]+.0007;
    for(const side of corners) {
      const horiz=Array(3).fill(wireWidth),vert=Array(3).fill(wireWidth);
      const first=[0,0,0],second=[0,0,0];
      horiz[w]=width*2;
      vert[h]=height*2;
      first[h]=height*side;
      second[w]=width*side;
      piece(frame,box(...horiz),material,first);
      piece(frame,box(...vert),material,second);
    }
    frames[label]={mesh:frame,normal,limit:dimensions[normal]};
  }
  return {
    update(slides,mode,inspect) {
      deco.setPosition([0,inspect ? 1e3 : 0,0]);
      for(const [label,{mesh,normal,limit}] of Object.entries(frames)){
        const seen=mode==='mri'&&(!inspect||inspect===label);
        const pose=[0,0,0];
        pose[normal]=limit*(2*slides[label]-1)*(label==='coronal'?-1:1);
        if(!seen)pose[1]+=1e3;
        mesh.setPosition(pose);
      }
    },
  };
}

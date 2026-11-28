const sin=Math.sin, cos=Math.cos, abs=Math.abs;
const ellipse=(x,y,z,rx,ry,rz)=>(Math.hypot(x/rx,y/ry,z/rz)-1)*Math.min(rx,ry,rz);
function join(a,b,falloff) {
  const h=Math.max(0,falloff-abs(a-b))/falloff;
  return Math.min(a,b)-h*h*falloff*.25;
}
function window(value,center,extent) {
  const v=Math.max(0,1-abs(value-center)/extent);
  return v*v*(3-2*v);
}

function owl(x,y,z) {
  const side=abs(x);
  const body=ellipse(x,y-.695,z+.015,.465,.660,.372);
  const tail=ellipse(x,y-.235,z+.205,.275,.260,.256);
  const neck=ellipse(x,y-1.143,z+.034,.385,.420,.322);
  const crown=ellipse(x,y-1.415,z+.034,.493,.365,.365);
  const torso=join(join(body,tail,.109),join(neck,crown,.168),.133);
  const wing=ellipse(side-.424+(y-.75)*.123,y-.718,z+.048,.148,.512,.305);
  let form=join(torso,wing,.056);

  // The pale face is a single sculpted heart with two cavities above a pointed central keel.
  const cheek=ellipse(side-.119-(y-1.43)*.26,y-1.413,z-.233,.292,.281,.188);
  const chin=ellipse(x,y-1.226,z-.229,.197,.185,.176);
  form=join(form,join(cheek,chin,.084),.043);
  const dish=ellipse(side-.163,y-1.481,z-.448,.143,.120,.135);
  form=-join(-form,dish,.022);
  const eye=ellipse(side-.167,y-1.482,z-.354,.064,.062,.093);
  const brow=ellipse(side-.158,y-1.582-(side-.160)*.162,z-.345,.128,.035,.064);
  form=join(join(form,eye,.033),brow,.025);
  const tip=y-1.338;
  const beak=ellipse(x,tip,z-.399-tip*.26,.059+Math.max(0,tip)*.24,.130,.111);
  form=join(form,beak,.030);

  // Folded flight feathers have long convex ribs and recessed, interrupted barbs.
  const wings=window(side,.447,.211)*window(y,.731,.568)*window(z,.253,.47);
  const sweep=side*74 + y*7.5 + 7*sin(y*2.1) + 12*z;
  const barbs=49*y+8*sin(side*5.1)+10*z;
  form+=wings*(.017*cos(sweep)+.0024*cos(barbs)*pow01(sin(sweep),3));
  const bib=window(x,0,.59)*window(y,.785,.46)*window(z,.351,.25);
  const offset=9*x+.22*sin(y*32);
  const quill=.50+.50*cos(Math.PI*2*offset);
  const row=y*67+6.5*x*x-2.05*quill*quill;
  form+=bib*(.0075*cos(row)+.0050*cos(2*row+.2));
  const collar=window(y,1.127,.15)*window(z,.289,.28)*window(side,.24,.26);
  form+=collar*.0063*sin(y*85-side*17+12*x*x);

  // The feet and low carved footing share the bird's continuous stone volume.
  const footing=ellipse(x,y-.060,z-.013,.535,.104,.354);
  form=join(form,footing,.095);
  for(let toe=0;toe<3;toe++) {
    const toeX=.135+toe*.067;
    const foot=ellipse(side-toeX-(z-.19)*(toe-1)*.21,y-.119,z-.213,.045,.073,.183-toe*.02);
    form=join(form,foot,.024);
  }
  const marks=sin(71*x+53*y+24*z)*sin(87*y-57*z)*sin(103*z-61*x);
  const grain=.00076*marks+.00065*sin(27*x+44*y)*sin(29*z-9*x);
  return Math.max(form+grain,-y);
}

const pow01=(v,p)=>Math.max(0,v)**p;
const offsets=[[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
const tets=[[0,1,3,7],[0,3,2,7],[0,2,6,7],[0,6,4,7],[0,4,5,7],[0,5,1,7]];

/** Extract the stone field using shared tetrahedron edges and one coherent split on every cube face. */
export function carve(step=.033) {
  const low=[-.72,-.079,-.63], high=[.72,1.89,.73];
  const dims=high.map((v,a)=>Math.ceil((v-low[a])/step)+1);
  const [sx,sy,sz]=dims;
  const index=(x,y,z)=>x+sx*(y+sy*z);
  const field=new Float32Array(sx*sy*sz), vertices=[], triangles=[], crossings=new Map();
  for(let z=0;z<sz;z++)for(let y=0;y<sy;y++)for(let x=0;x<sx;x++) {
    field[index(x,y,z)]=owl(low[0]+step*x,low[1]+step*y,low[2]+step*z);
  }
  for(let z=0;z<sz-1;z++)for(let y=0;y<sy-1;y++)for(let x=0;x<sx-1;x++) {
    const ids=offsets.map(([dx,dy,dz])=>index(x+dx,y+dy,z+dz));
    const samples=ids.map(id=>field[id]);
    if(samples.every(value=>(value<0)===(samples[0]<0)))continue;
    const crossing=(a,b)=>{
      const key=Math.min(ids[a],ids[b])*field.length+Math.max(ids[a],ids[b]);
      let vertex=crossings.get(key);
      if(vertex!==undefined)return vertex;
      const t=samples[a]/(samples[a]-samples[b]);
      const point=offsets[a].map((part,axis)=>low[axis]+step*([x,y,z][axis]+part+(offsets[b][axis]-part)*t));
      vertex=vertices.length;
      crossings.set(key,vertex);
      vertices.push(point);
      return vertex;
    };
    for(const tet of tets) {
      const inside=tet.filter(i=>samples[i]<0), outside=tet.filter(i=>samples[i]>=0);
      if(!inside.length||!outside.length)continue;
      const direction=offsets[outside[0]].map((part,i)=>part-offsets[inside[0]][i]);
      function face(a,b,c) {
        const u=vertices[b].map((v,i)=>v-vertices[a][i]),v=vertices[c].map((w,i)=>w-vertices[a][i]);
        const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
        if(normal.reduce((sum,n,i)=>sum+n*direction[i],0)>0)triangles.push(a,b,c);
        else triangles.push(a,c,b);
      }
      if(inside.length===1)face(...outside.map(b=>crossing(inside[0],b)));
      else if(outside.length===1)face(...inside.map(a=>crossing(a,outside[0])));
      else{
        const a=crossing(inside[0],outside[0]),b=crossing(inside[0],outside[1]);
        const c=crossing(inside[1],outside[1]),d=crossing(inside[1],outside[0]);
        face(a,b,c);
        face(a,c,d);
      }
    }
  }
  return {vertices,triangles};
}

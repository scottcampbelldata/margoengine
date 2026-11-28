const segments=20;
const turn=1.53;
const arc=(theta,r,label)=>({
  x:-1.46+turn*(1-Math.cos(theta)),y:.69+turn*Math.sin(theta),theta,r,label,
});
const end=(move,r,label)=>({x:.07+move,y:2.22,theta:Math.PI/2,r,label});
const profile=[
  {x:-1.46,y:.25,theta:0,r:.54,label:'mouth'},
  {x:-1.46,y:.29,theta:0,r:.61,label:'lip'},
  {x:-1.46,y:.35,theta:0,r:.631,label:'lip'},
  {x:-1.46,y:.44,theta:0,r:.631,label:'lip'},
  {x:-1.46,y:.49,theta:0,r:.575,label:'lip'},
  {x:-1.46,y:.54,theta:0,r:.49,label:'body'},
  ...Array.from({length:12},(_,i)=>arc((Math.PI/2)*i/11,.49,'body')),
  end(.32,.49,'body'),
  end(.45,.50,'body'),
  end(.48,.58,'lip'),
  end(.53,.628,'lip'),
  end(.60,.628,'lip'),
  end(.66,.60,'lip'),
  end(.69,.54,'mouth'),
  end(.69,.425,'liner'),
  end(.56,.404,'liner'),
  ...Array.from({length:8},(_,i)=>arc((Math.PI/2)*(7-i)/7,.404,'liner')),
  {x:-1.46,y:.40,theta:0,r:.404,label:'liner'},
  {x:-1.46,y:.30,theta:0,r:.417,label:'liner'},
  {x:-1.46,y:.25,theta:0,r:.425,label:'liner'},
];

const vertices=[], normals=[], faces=[], faceKinds=[];
const vertexId=(s,j)=>(s%profile.length)*segments+(j%segments);
const edgeId=(a,b)=>Math.min(a,b)+':'+Math.max(a,b);
const unit=([x,y,z])=>{
  const length=Math.hypot(x,y,z);
  return [x/length,y/length,z/length];
};
const cross=([x,y,z],[a,b,c])=>[y*c-z*b,z*a-x*c,x*b-y*a];
const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
for(const entry of profile){
  for(let j=0;j<segments;j++){
    const phase=2*Math.PI*j/segments;
    const c=entry.r*Math.cos(phase);
    vertices.push([entry.x+Math.cos(entry.theta)*c,entry.y-Math.sin(entry.theta)*c,entry.r*Math.sin(phase)]);
  }
}
for(let s=0;s<profile.length;s++){
  for(let j=0;j<segments;j++){
    const a=vertexId(s,j), b=vertexId(s+1,j), c=vertexId(s+1,j+1), d=vertexId(s,j+1);
    const corners=[a,b,c,d];
    const u0=j/segments,u1=(j+1)/segments,v0=s/profile.length,v1=(s+1)/profile.length;
    faces.push({id:'r'+s+'p'+j,vertices:corners,uv:[[u0,v0],[u0,v1],[u1,v1],[u1,v0]]});
    faceKinds.push(profile[s].label);
    const tangent=subtract(vertices[vertexId(s+1,j)],vertices[vertexId(s+profile.length-1,j)]);
    const radial=subtract(vertices[vertexId(s,j+1)],vertices[vertexId(s,j+segments-1)]);
    normals.push(unit(cross(tangent,radial)));
  }
}

export const fixture={vertices,faces};
export {normals,faceKinds};
const around=s=>Array.from({length:segments},(_,j)=>edgeId(vertexId(s,j),vertexId(s,j+1)));
const along=j=>Array.from({length:profile.length},(_,s)=>edgeId(vertexId(s,j),vertexId(s+1,j)));
export const cutStyles=[
  {id:'front',label:'Front cut',angle:53,seams:[...along(4),...around(5),...around(18),...around(23),...around(25),...around(35)]},
  {id:'side',label:'Back cut',angle:53,seams:[...along(13),...around(5),...around(18),...around(23),...around(25),...around(35)]},
  {id:'panels',label:'Four panels',angle:53,seams:[...along(0),...along(5),...along(10),...along(15),...around(5),...around(18),...around(23),...around(25),...around(35)]},
];

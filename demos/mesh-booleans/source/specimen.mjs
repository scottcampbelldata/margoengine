export const metre = .1;
export const centre = [0, 1.19, 0];
export const cuts = [
  {name:'Pocket', offset:.947, summary:'A shallow cut stops inside the stone.'},
  {name:'Deep pocket', offset:.626, summary:'The cut opens further into the stone and still has a floor.'},
  {name:'Through', offset:.119, summary:'The cutter breaks through the back and leaves a passage.'},
];

const outline = [
  [-.83,.27],[.68,.27],[.93,.39],[1.10,.66],[1.13,1.01],[1.04,1.44],[.85,1.78],
  [.57,2.11],[.245,2.28],[-.125,2.31],[-.467,2.22],[-.798,2.035],[-1.067,1.717],
  [-1.201,1.299],[-1.220,.87],[-1.12,.54],[-.98,.36],
];

export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

function ringMesh(name, rings) {
  const count=rings[0].length, vertices=rings.flat(), faces=[];
  const add=(list)=>faces.push({id:name+'-'+faces.length,vertices:list,
    uv:list.map(index=>[.5+vertices[index][0]*.3,vertices[index][1]*.32])});
  for(let i=1;i<count-1;i++) add([0,i+1,i]);
  for(let ring=0;ring<rings.length-1;ring++) {
    const a=ring*count, b=a+count;
    for(let i=0;i<count;i++) {
      const j=(i+1)%count;
      add([a+i,a+j,b+j]);
      add([a+i,b+j,b+i]);
    }
  }
  const last=vertices.length-count;
  for(let i=1;i<count-1;i++) add([last,last+i,last+i+1]);
  return {vertices,faces};
}

export function stock() {
  const sections=[
    [-.592,.912,-.037,0],[-.542,.987,-.032,0],[-.467,1,-.027,0],
    [.357,.995,.010,0],[.476,.965,.025,0],[.546,.916,.043,.010],
  ];
  const rings=sections.map(([z,s,x,y])=>outline.map(([u,v])=>[
    u*s+x, .27+(v-.27)*s+y,z,
  ]));
  return ringMesh('stone',rings);
}

export function cutter(index, display = false) {
  const depth=cuts[index].offset;
  const sections=[[-1.132,.315],[-1.062,.405],[-.72,.42],[-.515,.45],[-.33,.56],
    [-.13,.66],[.185,.69],[.385,.66],[.51,.57]];
  const sides=12;
  const rings=sections.map(([z,r])=>{
    const placedZ=z+depth;
    return Array.from({length:sides},(_,j)=>{
      const a=2*Math.PI*(j+.22)/sides;
      return [.045+.31*placedZ + r*Math.cos(a),
        1.295+.116*placedZ+r*.91*Math.sin(a),placedZ];
    });
  });
  const tool=ringMesh('cutter',rings);
  if(display) {
    const pivot=[.045+.31*depth,1.295+.116*depth,depth];
    const angle=-.72, sin=Math.sin(angle), cos=Math.cos(angle);
    tool.vertices=tool.vertices.map(point=>{
      const [x,y,z]=point.map((v,i)=>v-pivot[i]);
      return [pivot[0]+cos*x+sin*z-1.49, pivot[1]+y+.14, pivot[2]+cos*z-sin*x+.26];
    });
  }
  return tool;
}

function triangleScalar(a,b,c){return dot(a,cross(b,c));}

export function measure(compiled) {
  const {indices,positions,cornerVertices}=compiled;
  const point=(k)=>positions.slice(3*k,3*k+3);
  const edges=new Map(), used=new Set();
  let determinant=0;
  for(let i=0;i<indices.length;i+=3){
    const tri=indices.slice(i,i+3), v=tri.map(k=>cornerVertices[k]);
    for(let j=0;j<3;j++) {
      const a=v[j], b=v[(j+1)%3], key=a<b?a+':'+b:b+':'+a;
      const counts=edges.get(key)??[0,0];
      counts[a<b?0:1]++;
      edges.set(key,counts);
      used.add(a);
    }
    determinant+=triangleScalar(...tri.map(point));
  }
  const invalid=[...edges.values()].filter(([plus,minus])=>plus!==1||minus!==1).length;
  const triangles=indices.length/3;
  return {triangles, vertices:used.size, invalid, euler:used.size-edges.size+triangles, volume:determinant/6};
}

export function carve(operations, compile, index) {
  let id=0;
  const result=operations(stock(),cutter(index),'difference',{createId:()=> 'cut-'+id++});
  const compiled=compile(result.mesh);
  const counts=measure(compiled);
  if(result.nonManifoldEdges||counts.invalid)throw new Error('The cut did not close.');
  return {compiled, counts, sources:result.sources, mesh:result.mesh};
}

export function triangulated(mesh, triangulate) {
  const result={positions:[],normals:[],indices:[],triangleFaces:[],cornerVertices:[]};
  for(const face of mesh.faces) {
    const points=face.vertices.map(index=>mesh.vertices[index]);
    const start=result.positions.length/3;
    let vector=[0,0,0];
    for(let i=0;i<points.length;i++){
      const sum=cross(points[i],points[(i+1)%points.length]);
      vector=vector.map((v,j)=>v+sum[j]);
    }
    const len=Math.hypot(...vector);
    const normal=vector.map(v=>v/len);
    for(const p of points){
      result.positions.push(...p);
      result.normals.push(...normal);
    }
    result.cornerVertices.push(...face.vertices);
    for(const tri of points.length===3?[[0,1,2]]:triangulate(points)) {
      result.indices.push(...tri.map(index=>start+index));
      result.triangleFaces.push(face.id);
    }
  }
  return result;
}

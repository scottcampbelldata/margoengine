import { compilePolygonMesh, cutMeshFace, polygonGeometryError, polygonMeshEdges } from '@margoengine/mesh-edit';
import { bevelMeshEdges, bridgeMeshEdgeLoops, dissolveMeshComponents, knifeMeshFaces, subdivideMesh } from '@margoengine/mesh-edit/modeling';

const corners=[[0,0],[1,0],[1,1],[0,1]];
const face=(id,vertices)=>({id,vertices,uv:vertices.map((_,i)=>[...corners[i%4]])});
const key=(a,b)=>a<b?a+':'+b:b+':'+a;
const generated=(prefix)=>{let i=0;return {createId:()=>prefix+'-'+(++i)};};

export function boxPolygon(id,center,[w,h,d]){
  const [x,y,z]=center,[a,b,c]=[w/2,h/2,d/2];
  return {vertices:[
    [x-a,y-b,z+c],[x+a,y-b,z+c],[x+a,y+b,z+c],[x-a,y+b,z+c],
    [x-a,y-b,z-c],[x+a,y-b,z-c],[x+a,y+b,z-c],[x-a,y+b,z-c],
  ],faces:[
    face(id+'-front',[0,1,2,3]),face(id+'-right',[1,5,6,2]),face(id+'-back',[5,4,7,6]),
    face(id+'-left',[4,0,3,7]),face(id+'-top',[3,2,6,7]),face(id+'-bottom',[4,5,1,0]),
  ]};
}

const shell=boxPolygon('shell',[-.30,.61,-.055],[1.31,.89,.69]);
const cutPlate=boxPolygon('panel',[-.31,.648,.313],[1.155,.36,.047]);
const sample=boxPolygon('fairing',[.565,.65,-.09],[.43,.61,.544]);
const originalSeam=boxPolygon('seam',[-.305,.33,.308],[1.153,.145,.036]);
const split=cutMeshFace(originalSeam,'seam-front',generated('source-seam'));
const seam=key(...split.createdVertices);

function rings(){
  const sides=12, vertices=[], faces=[];
  const bottomAngle=Math.PI/12;
  const collars=[
    {x:.48,y:.948,z:-.09,r:.183},
    {x:.48,y:1.064,z:-.09,r:.159},
    {x:.59,y:1.250,z:-.04,r:.143},
    {x:.59,y:1.369,z:-.04,r:.172},
  ];
  for(const {x,y,z,r} of collars)for(let i=0;i<sides;i++){
    const angle=bottomAngle+2*Math.PI*i/sides;
    vertices.push([x+r*Math.cos(angle),y,z+r*Math.sin(angle)]);
  }
  const loop=(n)=>Array.from({length:sides},(_,i)=>n*sides+i);
  const lower=loop(0), lowerOpen=loop(1), upperOpen=loop(2), upper=loop(3);
  faces.push(face('lower-cap',lower));
  faces.push(face('upper-cap',[...upper].reverse()));
  for(let i=0;i<sides;i++){
    const j=(i+1)%sides;
    faces.push(face('lower-wall-'+i,[lower[i],lowerOpen[i],lowerOpen[j],lower[j]]));
    faces.push(face('upper-wall-'+i,[upperOpen[i],upper[i],upper[j],upperOpen[j]]));
  }
  const edgeLoop=(vertices)=>vertices.map((a,i)=>key(a,vertices[(i+1)%sides]));
  return {mesh:{vertices,faces},selected:[edgeLoop(lowerOpen),edgeLoop(upperOpen)]};
}
const collar=rings();
const cutPoints=[[-1.1,.757,.34],[.34,.538,.34]];

export const tools = [
  {id:'bevel',label:'Bevel',subject:'Housing',detail:'Chamfer the long front rim. A new strip replaces the sharp edge.',
    color:'#457b78', editedColor:'#769c88',mesh:shell,
    run:mesh=>bevelMeshEdges(mesh,[key(2,3)],.088,generated('chamfer')),
    focus:[-.31,.98,.25]},
  {id:'knife',label:'Knife',subject:'Access panel',detail:'Split the face on the diagonal. Both neighboring sides retain the cut vertices.',
    color:'#809f95',editedColor:'#c3b99a',mesh:cutPlate,
    run:mesh=>knifeMeshFaces(mesh,cutPoints,[0,0,-1],{faces:['panel-front'],...generated('knife')}),
    focus:[-.31,.66,.34]},
  {id:'subdivide',label:'Subdivide',subject:'Air fairing',detail:'Run two Catmull–Clark steps on the side fairing.',
    color:'#b0a281',editedColor:'#c89e61',mesh:sample,
    run:mesh=>subdivideMesh(mesh,{levels:2,...generated('subdivision')}),
    focus:[.58,.67,-.025]},
  {id:'dissolve',label:'Dissolve',subject:'Service cover',detail:'Remove the coplanar seam. The panel keeps its shape.',
    color:'#557e7b',editedColor:'#73978b',mesh:split.mesh,
    run:mesh=>dissolveMeshComponents(mesh,{mode:'edge',edges:[seam],...generated('dissolve')}),
    focus:[-.305,.33,.36]},
  {id:'bridge',label:'Bridge',subject:'Offset collars',detail:'Join the two open rings with two rows of faces.',
    color:'#a77d44',editedColor:'#c09560',mesh:collar.mesh,
    run:mesh=>bridgeMeshEdgeLoops(mesh,...collar.selected,{segments:2,...generated('duct')}),
    focus:[.55,1.19,-.04]},
];

export function meshStats(mesh){
  const edges=polygonMeshEdges(mesh);
  return {
    vertices:mesh.vertices.length,edges:edges.length,faces:mesh.faces.length,
    boundaries:edges.filter(e=>e.incidences.length===1).length,
    nonManifold:edges.filter(e=>e.incidences.length>2).length,
    inconsistent:edges.filter(e=>e.incidences.length===2&&e.incidences[0].from===e.incidences[1].from).length,
  };
}

export function edit(tool,mesh){
  const result=tool.run(mesh);
  const error=result.mesh.faces.map(face=>polygonGeometryError(face.vertices.map(index=>result.mesh.vertices[index]))).find(Boolean);
  if(error)throw new Error(error);
  const before=meshStats(mesh),after=meshStats(result.mesh);
  if(after.nonManifold||after.inconsistent||JSON.stringify(before)===JSON.stringify(after))
    throw new Error('This tool did not produce valid edited topology.');
  return {before,after,result};
}

export function renderPayload(mesh){
  const filled=compilePolygonMesh(mesh);
  return {...filled,segments:polygonMeshEdges(mesh).map(edge=>{
    const [first,last]=edge.vertices;
    return [mesh.vertices[first],mesh.vertices[last]];
  })};
}

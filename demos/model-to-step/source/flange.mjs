export const defaultDiameter = 28;
export const minimumDiameter = 22;
export const maximumDiameter = 40;
export const millimetre = .001;
const position = ([r,y]) => [r*millimetre,y*millimetre,0];
const accuracy = {deflection:.00007,angle:.14,interiorDeflection:.00024};

export function makeFlange(model,diameter) {
  if (!Number.isInteger(diameter) || diameter<minimumDiameter || diameter>maximumDiameter) {
    throw new RangeError('Spindle bore must be 22–40 mm in whole millimetres.');
  }
  const bore=diameter/2;
  const profile=[
    [bore,0],[52,0],[54,2],[54,10],[52,12],[38,12],[34,16],
    [34,22],[32,24],[bore+2,24],[bore,22],[bore,0],
  ];
  let body=model.revolve('Aster indexing flange',{
    name:'Turned flange section',start:position(profile[0]),normal:[0,0,1],
    segments:profile.slice(1).map((point,i)=>({kind:'line',to:position(point),name:'turn-'+i})),
  },{origin:[0,0,0],direction:[0,1,0]});
  for (let i=0; i<4; i++) {
    const angle=(i+.5)*Math.PI/2;
    const x=.044*Math.cos(angle), z=.044*Math.sin(angle);
    const drill=model.cylinder('mounting bore '+(i+1),.00425,.018,model.frameOf([x,-.001,z],[0,1,0],[1,0,0]));
    body=model.boolean('Aster indexing flange','subtract',body,drill);
    const counterbore=model.cylinder('counterbore '+(i+1),.0071,.008,model.frameOf([x,.008,z],[0,1,0],[1,0,0]));
    body=model.boolean('Aster indexing flange','subtract',body,counterbore);
  }
  return body;
}

export function inspectSolid(model,body) {
  const problems=model.checkBody(body);
  if (problems.length) throw new Error('The solid failed its boundary check: '+problems[0].problem);
  const display=model.meshBodies([body],accuracy);
  const [mesh]=display.meshes;
  if (mesh?.failures.length || !mesh?.indices.length) throw new Error('The solid could not be tessellated.');
  return {
    mesh:{positions:mesh.positions,normals:mesh.normals,indices:mesh.indices},
    properties:{...model.massProperties(body),faces:body.faces.length},
  };
}

function sampleKeys(mesh) {
  const vertices=new Array(mesh.positions.length/3);
  for (let i=0; i<vertices.length; i++) {
    const offset=i*3;
    vertices[i]=[mesh.positions[offset],mesh.positions[offset+1],mesh.positions[offset+2]]
      .map(value=>Math.round(value*1e7)).join(',');
  }
  const triangles=new Array(mesh.indices.length/3);
  for (let i=0; i<triangles.length; i++) {
    const offset=i*3;
    triangles[i]=[vertices[mesh.indices[offset]],vertices[mesh.indices[offset+1]],vertices[mesh.indices[offset+2]]]
      .sort().join('/');
  }
  return triangles.sort();
}

export function compareSolids(reference,received) {
  const a=reference.properties,b=received.properties;
  const volume=Math.abs(a.volume-b.volume);
  const area=Math.abs(a.area-b.area);
  const centroid=Math.hypot(...a.centroid.map((value,i)=>value-b.centroid[i]));
  const first=sampleKeys(reference.mesh), second=sampleKeys(received.mesh);
  const samples=first.length===second.length && first.every((key,index)=>key===second[index]);
  return {volume,area,centroid,samples,triangles:second.length,
    equivalent:volume<1e-13 && area<1e-10 && centroid<1e-7 && a.faces===b.faces && samples};
}
export const wavelengthReference=1.72828;
export const glassAbbeNumber=28.53;
export const table={minX:-.78,maxX:.72,minZ:-.74,maxZ:.68,y:0};
export const modeNames=['spectrum','clear','ground'];
export const modes={
  spectrum:{label:'Dispersive',ior:wavelengthReference,dispersion:20/glassAbbeNumber,roughness:0},
  clear:{label:'Polished',ior:wavelengthReference,dispersion:0,roughness:0},
  ground:{label:'Ground',ior:wavelengthReference,dispersion:0,roughness:[.32,.21]},
};
export const source={corner:[-.295,1.08,-.390],edgeU:[.127,0,0],edgeV:[0,0,.315],direction:[0,1,0]};
export const glass={x:-.25,z:-.246,attenuationColor:[.965,.983,.972],attenuationDistance:.55};
export const photonCount=196608;
export const irradianceScale=24;

const directions=Array.from({length:12},(_,k)=>(k+.5)*Math.PI/6);
const rings=[
  {radius:.88,height:x=>.273-.610*x},
  {radius:1,height:x=>.315-.610*x},
  {radius:1,height:x=>.478-.10*x},
  {radius:.70,height:x=>.547-.10*x},
  {radius:.38,height:x=>.594-.10*x},
];
function ringVertex(ring,angle){
  const x=.305*ring.radius*Math.cos(angle),z=.243*ring.radius*Math.sin(angle);
  return [glass.x+x,ring.height(x),glass.z+z];
}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function sub(a,b){return a.map((x,i)=>x-b[i]);}
function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
export function opticalSolid(){
  const ringsOfPoints=rings.flatMap(ring=>directions.map(angle=>ringVertex(ring,angle)));
  const vertices=[...ringsOfPoints,[glass.x,.273,glass.z],[glass.x,.613,glass.z]];
  const inside=[glass.x,.438,glass.z],indices=[],facets=[];
  const tri=(i,j,k,region)=>{
    const a=vertices[i];
    if(dot(cross(sub(vertices[j],a),sub(vertices[k],a)),sub(a,inside))<0)[j,k]=[k,j];
    indices.push(i,j,k);
    facets.push(region);
  };
  for(let k=0;k<12;k++){
    const j=(k+1)%12;
    tri(60,k,j,'foot');
    for(let row=0;row<4;row++){
      const here=row*12,next=here+12,region=['chamfer','belt','crown','crown'][row];
      tri(here+k,here+j,next+j,region);
      tri(here+k,next+j,next+k,region);
    }
    tri(61,48+k,48+j,'crown');
  }
  return {vertices,indices:Uint32Array.from(indices),facets};
}

export function bakeInputs(mode,photons=photonCount){
  const scale=10; // one transport unit = 0.1 m, permitting a denser surface grid
  const metres=v=>v.map(n=>n*scale),t=table;
  const positions=Float32Array.from([
    [t.minX,t.y,t.minZ],[t.minX,t.y,t.maxZ],[t.maxX,t.y,t.maxZ],[t.maxX,t.y,t.minZ],
  ].flatMap(metres));
  const {vertices,indices}=opticalSolid(),{ior,dispersion,roughness}=modes[mode];
  const emitter={type:'directional',direction:source.direction,color:[1,1,1],intensity:2.6,
    aperture:{corner:metres(source.corner),edgeU:metres(source.edgeU),edgeV:metres(source.edgeV)}};
  return [{positions}, {glassVolumes:[{positions:Float32Array.from(vertices.flatMap(metres)),indices,ior,dispersion,roughness,
    roughnessDirection:[0,0,1],attenuationColor:glass.attenuationColor,attenuationDistance:glass.attenuationDistance*scale}],
    emitters:[emitter], texelsPerUnit:14, padding:2, photons, maxEvents:16, seed:1245799, maxAtlasSize:256}];
}

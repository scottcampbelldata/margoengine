import { box, Geometry, PbrMaterial } from '@margoengine/core';
import { convexGeometry, roundedBoxGeometry } from '@margoengine/geometry/extras';
import { fractureMesh } from '@margoengine/procedural/voronoi';
import { surface, VOLUMES, WALL_LENGTH, wallSlabs } from 'margo-boulder/wall';

const palettes = ['#7aa78a','#71a5c7','#cb6248','#cea765','#b6c4b8'];
const paint = (color,roughness=.70,metalness=0) => new PbrMaterial({color,roughness,metalness});
const coreGeometry=data=>data instanceof Geometry?data:new Geometry(data.positions,data.normals,data.indices);
const meshes = (engine,geometry,material) => engine.createMesh().setGeometry(coreGeometry(geometry)).setMaterial(material);

function fittedChunk(chunk) {
  const values = chunk.geometry.vertices, positions=[], normals=[], indices=chunk.geometry.indices;
  let radius=0, low=Infinity, high=-Infinity;
  for(let i=0;i<values.length;i+=6) {
    radius=Math.max(radius,Math.hypot(values[i]-chunk.center[0],values[i+1]-chunk.center[1]));
    low=Math.min(low,values[i+2]);
    high=Math.max(high,values[i+2]);
  }
  for(let i=0;i<values.length;i+=6) {
    positions.push((values[i]-chunk.center[0])/radius,(values[i+1]-chunk.center[1])/radius,
      .60*(values[i+2]-low)/Math.max(.04,high-low));
    normals.push(values[i+3],values[i+4],values[i+5]);
  }
  return new Geometry(positions,normals,indices);
}

export function makeTestCell(engine, holds) {
  const slabMaterials=['#77877e','#718486','#81918c'].map(hex=>paint(hex,.68));
  for(const [i,slab] of wallSlabs().entries())meshes(engine,convexGeometry(slab),slabMaterials[i]);
  for(const volume of VOLUMES)meshes(engine,convexGeometry(volume.corners),paint('#687e79',.71));
  const rubber=paint('#424a43',.98), concrete=paint('#6a7269',.86), frame=paint('#34444a',.42,.42);
  const brass=paint('#b98d47',.53,.52), marks=paint('#ac785e',.64);
  meshes(engine,roundedBoxGeometry(5.23,.12,2.65,3,.035),rubber).setPosition([0,.06,1.31]);
  meshes(engine,box(15,.18,15),concrete).setPosition([0,-.095,3]);
  for(const x of [-2.77,2.77]){
    meshes(engine,roundedBoxGeometry(.20,4.54,.42,3,.024),frame).setPosition([x,2.16,-.115]);
    meshes(engine,box(.13,.038,2.55),brass).setPosition([x,.105,1.30]);
  }
  meshes(engine,roundedBoxGeometry(5.75,.20,.51,3,.018),frame).setPosition([0,4.17,.71]);
  meshes(engine,box(9,5.1,.1),paint('#283538')).setPosition([0,2.35,-.43]);

  const bolts = box(.019,.019,.008), minor = box(.075,.009,.006), major=box(.130,.018,.007);
  const seam=paint('#465653',.75);
  for(const x of [-1.53,1.53]) {
    for(const [start,end] of [[0,1.75],[1.75,3.525],[3.525,WALL_LENGTH]]) {
      const normal=[0,0,0], position=surface(x,(start+end)/2,[0,0,0],normal);
      meshes(engine,box(.008,end-start-.01,.003),seam)
        .setPosition([position[0],position[1]+.001*normal[1],position[2]+.001*normal[2]])
        .setRotation([Math.atan2(-normal[1],normal[2]),0,0]);
    }
  }
  const locator = paint('#4b5b59',.59,.64);
  const normal = [0,0,0];
  for(let i=1;i<=36;i++){
    const height=i*WALL_LENGTH/37;
    const position=surface(2.48,height,[0,0,0],normal);
    const theta=Math.atan2(-normal[1],normal[2]);
    meshes(engine,i%5===0?major:minor,i%5===0?marks:locator)
      .setPosition(position).setRotation([theta,0,0]);
  }
  for(const x of [-2.32,-1.16,0,1.16,2.32]){
    for(const height of [.23,1.45,2.30,3.32,4.10]){
      const p = surface(x,height,[0,0,0],normal);
      meshes(engine,bolts,locator).setPosition([p[0],p[1]+.003*normal[1],p[2]+.003*normal[2]])
        .setRotation([Math.atan2(-normal[1],normal[2]),0,0]);
    }
  }

  const stones = fractureMesh(coreGeometry(roundedBoxGeometry(2,2,2,3,.46)),12,{seed:313}).map(fittedChunk);
  const holdMaterials=palettes.map(hex=>paint(hex,.88));
  const mount=paint('#394d49',.53,.2);
  for(const hold of holds){
    const position = hold.position, theta = Math.atan2(-hold.normal[1],hold.normal[2]);
    const stone=stones[hold.shape%stones.length];
    const turn=hold.turn;
    const orientation=[theta,0,turn];
    meshes(engine,stone,holdMaterials[hold.colour]).setPosition(position)
      .setScale([hold.radius,hold.radius,hold.radius]).setRotation(orientation);
    meshes(engine,bolts,mount).setPosition([position[0],position[1]+hold.normal[1]*hold.radius*.38,
      position[2]+hold.normal[2]*hold.radius*.38]).setRotation([theta,0,0]);
  }
}

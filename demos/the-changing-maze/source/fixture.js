import {limits,fixed,gates,start,goal} from './layout.js';
import {tileRect} from './navigation.js';
import {roundedTray,cylinder,planarInk,studio} from './geometry.js';

const tileColors=['#5f7976','#617b77','#5b7573','#687e76','#607b75','#657e7a','#6c827c'];
const warmTile='#8f866b';
const tau=Math.PI*2;
function middle(a,b){return (a+b)*.5;}
function seed(){
  let value=12742;
  return ()=>{
    value=(Math.imul(1664525,value)+1013904223)>>>0;
    return value/4294967296;
  };
}

export function fixture(engine,world){
  const {block,part,paint}=studio(engine);
  engine.scene.background='#233841';
  engine.lighting.direction.set([-.48,.78,.43,3.47]);
  engine.lighting.radiance.set([1,.91,.77,.43]);
  engine.lighting.ambient.set([.58,.73,.85]);

  const desk=roundedTray(13.15,11.72,.386,-.56,-.221,.024,11);
  part('Oxidized blue exhibition desk',desk,'#314b53',[0,0,.20],.87);
  const base=roundedTray(2.90,1.995,.149,-.220,-.078,.026,12);
  part('Sealed marine lacquer base',base,'#293e46',[0,0,.043],.56);
  part('Continuous bronze waist trim',roundedTray(2.916,2.007,.158,-.117,-.105,.004,12),'#9b7959',[0,0,.043],.47);
  part('Vacuum-cast upper chassis',roundedTray(2.834,1.922,.121,-.108,-.014,.024,12),'#3b5256',[0,0,.043],.51);
  part('Floating bevel under the map bed',roundedTray(2.634,1.728,.072,-.029,-.010,.009,10),'#a99370',undefined,.51);
  part('Map bed and gap material',roundedTray(2.515,1.633,.021,-.014,-.003,.004,6),'#3e585a',undefined,.64);
  for(const x of [-1.348,1.348]){
    part('Cabinet side cover',roundedTray(.053,.935,.012,-.009,.023,.006), '#5e6c68',[x,0,.002],.43);
    for(let i=0;i<8;i++){
      block('Vent dark insert','#293e44',[x,.025,-.340+i*.097],[.029,.005,.022],.70);
    }
  }
  for(const z of [-.895,.940]){
    for(const x of [-1.25,1.25]){
      const fastening=cylinder([[.026,0],[.028,.007],[.024,.012],[0,.012]],36);
      part('Captive bronze bearing screw',fastening,'#bca47b',[x,-.012,z],.44);
      block('Screw slot','#5f594e',[x,.001,z],[.027,.002,.004],.77).setRotation([0,.63,0]);
    }
    block('Thin chassis registration band','#b49d78',[0,-.006,z],[2.309,.005,.007],.48);
  }
  const switchTrim=cylinder([[.035,0],[.039,.008],[.037,.016],[.027,.020],[.019,.020]],32);
  const button=cylinder([[.026,0],[.030,.007],[.027,.012],[0,.014]],32);
  const leds=[];
  for(const [i,x] of [-.152,.152].entries()){
    part('Gate indicator bezel',switchTrim,'#ab926c',[x,-.001,.932],.38);
    leds.push(part('Gate endpoint indicator',button,'#6a837a',[x,.011,.932],.44));
  }
  for(let i=0;i<21;i++){
    const x=(i-10)*.041;
    block('Console graduations',i%5?'#776d57':'#c8aa77',[x,.002,-.902],[.005,.004,i%5?.012:.021],.63);
  }

  const tiles=new Map();
  const span=world.tileSpan;
  for(const {x,z,mesh} of world.tileList()){
    if(!mesh)continue;
    const [x0,z0,x1,z1]=tileRect(x,z,span);
    if(x1-x0<.02||z1-z0<.02)continue;
    const color=tileColors[(x*19+z*7)%tileColors.length];
    const panel=part('Inlaid tile '+x+'/'+z,roundedTray(x1-x0-.005,z1-z0-.005,.012,-.006,0,.003,3),
      color,[middle(x0,x1),0,middle(z0,z1)],.83);
    tiles.set(x+','+z,{panel,color,rect:[x0,z0,x1,z1]});
  }
  const random=seed(),shards=[planarInk(.00031),planarInk(.00041),planarInk(.00051)];
  for(const {rect:[x0,z0,x1,z1]} of tiles.values()){
    for(let i=0;i<29;i++){
      const px=x0+.021+(x1-x0-.040)*random(),pz=z0+.021+(z1-z0-.040)*random(),
        size=.0009+random()*.0033,az=tau*random(),n=3+Math.floor(random()*3);
      const p=Array.from({length:n},(_,j)=>{
        const t=az+tau*j/n,r=size*(.65+.68*random());
        return [px+Math.cos(t)*r,pz+Math.sin(t)*r];
      });
      shards[i%3].polygon(p);
    }
  }
  for(const [i,ink] of shards.entries())part('Mineral chips in the enamel',ink.shape(),['#809389','#8d9a88','#536c66'][i],undefined,.85);

  function wall(name,entry,index=-1){
    const {x,z,width,depth}=entry,group=engine.createMesh().setPosition([x,0,z]);
    group.name=name;
    const moving=index>=0,baseColor=moving?(index?'#426c69':'#805242'):'#384e54';
    const cap=moving?(index?'#99aea1':'#c28b64'):'#8b806e';
    part('Carved wall apron',roundedTray(width+.009,depth+.004,.019,-.004,.021,.005,6), '#415758',[0,0,0],.76,group);
    part('Vertical enameled wall surface',roundedTray(width,depth,.017,.015,.130,.010,6),baseColor,[0,0,0],.50,group);
    part('Roof rail edge; brushed metal',roundedTray(width-.008,depth-.013,.013,.119,.145,.006,6),cap,[0,0,0],.37,group);
    part('Inset contrasting crown',roundedTray(width-.030,depth-.042,.011,.144,.147,.002,5),moving?cap:'#6a746d',[0,0,0],.50,group);
    if(moving){
      for(let j=0;j<=index;j++){
        part('Engraved gate marker',cylinder([[.017,0],[.017,.003],[.012,.004],[0,.004]],28),'#eee3bb',
          [0,.145,(j-index*.5)*.062],.48,group);
      }
    }
    return group;
  }
  for(const item of fixed)wall('Fixed partition',item);
  const gateMeshes=gates.map((gate,i)=>{
    for(const x of [gate.x-.062,gate.x+.062]){
      block('Brass wall track','#a68d68',[x,.0035,0],[.007,.007,1.045],.49);
      for(const z of [-.513,.513])block('Track brake','#6d7770',[x,.009,z],[.026,.012,.022],.53);
    }
    return wall(gate.name+' translating wall',{...gate,z:gate.stops[gate.initial]},i);
  });

  const dock=cylinder([[.075,0],[.082,.004],[.082,.009],[.073,.014],[.058,.014],[.055,.009],[.055,0]],52);
  const dockMedal=cylinder([[.051,0],[.052,.004],[.050,.009],[0,.009]],44);
  part('Dispatch dock collar',dock,'#b49b71',start,.47);
  part('Dispatch dock floor',dockMedal,'#416562',start,.62);
  part('Arrival dock collar',dock,'#d8b77e',goal,.38);
  const arrival=part('Arrival dock floor',dockMedal,'#708773',goal,.61);
  const smallNotches=planarInk(.015);
  for(const point of [start,goal])for(let i=0;i<12;i++){
    const a=i*tau/12,c=Math.cos(a),s=Math.sin(a);
    smallNotches.line(point[0]+.063*c,point[2]+.063*s,point[0]+.073*c,point[2]+.073*s,.0028);
  }
  part('Machined dock radial grooves',smallNotches.shape(),'#6d6757',undefined,.66);
  const courier=engine.createMesh().setPosition(start);
  courier.name='Routing shuttle';
  part('Shuttle black oxide foot',cylinder([[0,.008],[.032,.008],[.041,.016],[.040,.023],[0,.023]],44),'#263b41',undefined,.63,courier);
  part('Shuttle turned brass body',cylinder([[.039,.021],[.040,.025],[.034,.049],[.026,.063],[0,.063]],52),'#cfac73',undefined,.39,courier);
  part('Shuttle upper enamel insert',cylinder([[.023,.064],[.024,.068],[.018,.073],[0,.073]],36),'#486b62',undefined,.49,courier);
  block('Shuttle direction pointer','#f0d9a0',[0,.074,.009],[.006,.003,.023],.49,courier);

  const routeFloor=part('Recomputing route · contrast bed',null,'#46534c',undefined,.60);
  const routeMark=part('Actual path · warm inlay',null,'#ead19c',undefined,.40);
  const polygons=part('Actual walkable polygon edges',null,'#9ac6b8',undefined,.76);
  const rebuiltLines=part('Affected engine tile borders',null,'#f2be79',undefined,.50);

  function trace(points){
    const dark=planarInk(.011),light=planarInk(.0125);
    const inks=[[dark,.041],[light,.024]];
    for(const [ink,w] of inks){
      for(let i=0;i+1<points.length;i++){
        const a=points[i],b=points[i+1];
        ink.line(a[0],a[2],b[0],b[2],w);
      }
      for(let i=1;i+1<points.length;i++)ink.disk(points[i][0],points[i][2],w*.50,12);
    }
    routeFloor.setGeometry(dark.shape());routeMark.setGeometry(light.shape());
  }
  function meshEdges(show){
    polygons.visible=show;
    if(!show)return;
    const ink=planarInk(.0075);
    // The tiled graph retains sparse top-level ids across a rebuild. Within each public tile mesh the ids are dense.
    for(const {mesh} of world.tileList()){
      if(!mesh)continue;
      for(let i=0;i<mesh.polygonCount;i++){
        const points=mesh.polygonPoints(i);
        for(let j=0;j<points.length;j++){
          const a=points[j],b=points[(j+1)%points.length];
          ink.line(a[0],a[2],b[0],b[2],.006);
        }
      }
    }
    polygons.setGeometry(ink.shape());
  }
  function highlight(changed){
    const ink=planarInk(.0055);
    for(const [key,entry] of tiles){
      const active=changed.has(key);
      entry.panel.setMaterial(paint(active?warmTile:entry.color,.83));
      if(!active)continue;
      const [x0,z0,x1,z1]=entry.rect;
      ink.line(x0+.006,z0+.006,x1-.006,z0+.006,.006);
      ink.line(x1-.006,z0+.006,x1-.006,z1-.006,.006);
      ink.line(x1-.006,z1-.006,x0+.006,z1-.006,.006);
      ink.line(x0+.006,z1-.006,x0+.006,z0+.006,.006);
    }
    rebuiltLines.setGeometry(ink.shape());
  }
  function moveGate(i,z,position){
    gateMeshes[i].setPosition([gates[i].x,0,z]);
    leds[i].setMaterial(paint(position?'#b8a47a':'#7c9c90',.44));
  }
  function shuttle(point,yaw,arrived){
    courier.setPosition(point).setRotation([0,yaw,0]);
    arrival.setMaterial(paint(arrived?'#e1c383':'#708773',.61));
  }
  meshEdges(false);
  return {trace,meshEdges,highlight,moveGate,shuttle,visibleTiles:tiles.size};
}

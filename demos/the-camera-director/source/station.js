import {beveledBlock,disc,polygonMesh,profile,tau} from './geometry.js';

const white='#e3ded0', warm='#c4b79f', grey='#aeb1a6', blue='#748385';
const bowl=10.1, depth=3.7;
const surface=r=>(r*r)/(bowl*bowl)*depth;
function panelBowl(colors){
  const buckets=Array.from({length:colors},polygonMesh),rings=[0,.88,2.29,3.79,5.43,7.04,8.57,bowl],segments=48;
  function vertex(r,a){return [Math.cos(a)*r,Math.sin(a)*r,surface(r)];}
  for(let j=0;j<rings.length-1;j++)for(let i=0;i<segments;i++){
    const a0=(i/segments)*tau+.0018,a1=((i+1)/segments)*tau-.0018;
    const r0=rings[j]+.012,r1=rings[j+1]-.012,am=(a0+a1)/2,rm=(r0+r1)*.5;
    const material=buckets[(Math.floor(i/4)*7+j+(i%7===3?1:0))%colors];
    for(const [lo,hi] of [[a0,am],[am,a1]])for(const [inner,outer] of [[r0,rm],[rm,r1]]){
      material.quad(vertex(inner,lo),vertex(outer,lo),vertex(outer,hi),vertex(inner,hi));
    }
  }
  return buckets.map(bucket=>bucket.geometry());
}
function stand({paint,mesh,block,beam,diskAt}){
  const concrete=paint('#aba69c',.88),porcelain=paint(white,.56),trim=paint(grey,.55);
  const steel=paint('#737d7d',.42,1),orange=paint('#aa592f',.62),shadow=paint('#4f5655',.88);
  const root=mesh('Salar main antenna, azimuth base',undefined,undefined,[-2.6,0,-18.4]);
  for(const [i,[color,rx,rz,x,z]] of [
    ['#b3a18c',9.06,7.18,2.04,-1.49],
    ['#a8967f',7.56,6.50,1.41,-1.10],
    ['#9c8c75',6.93,6.15,.62,-.52],
  ].entries()){
    const decal=disc(1,-.001,.002,.0006,52);
    diskAt('Compact salt below the antenna foundation',decal,paint(color,.96),[x,-.086+i*.003,z],root)
      .setScale([rx,rz,1]);
  }
  diskAt('Roundcast antenna foundation',disc(6.83,-.22,.68,.15,72),concrete,[0,0,0],root);
  diskAt('Raised concrete foundation shoulder',disc(5.56,.61,.94,.066,64),trim,[0,0,0],root);
  diskAt('Brushed pedestal bearing ring',disc(3.55,.85,1.25,.09),steel,[0,0,0],root);
  diskAt('Stand diameter shoulder',profile([[0,.95],[2.87,.95],[2.94,1.11],[2.94,1.64],[2.76,1.75],[0,1.75]]),porcelain,[0,0,0],root);
  diskAt('Tapered fluted central concrete tower',profile([[0,1.55],[2.59,1.55],[2.59,2],[2.34,4],[2.08,7.51],[2.20,8.04],[0,8.04]],44),porcelain,[0,0,0],root);
  diskAt('Rolled azimuth housing',disc(2.67,7.46,8.7,.12),shadow,[0,0,0],root);
  diskAt('Rotation register bead',disc(2.68,8.14,8.25,.028),orange,[0,0,0],root);
  diskAt('Access course around the drive',disc(3.64,7.62,7.78,.038),trim,[0,0,0],root);
  const railing=polygonMesh();
  for(let i=0;i<32;i++){
    const angle=i*tau/32,a=[3.53*Math.cos(angle),7.77,3.53*Math.sin(angle)];
    beam('Azimuth ring guardrail post',steel,a,[a[0],a[1]+.85,a[2]],.055,.055,root);
    const next=(i+1)*tau/32;
    for(const y of [8.18,8.64])
      railing.ribbon([a[0],y,a[2]],[3.53*Math.cos(next),y,3.53*Math.sin(next)],.062);
  }
  mesh('Galvanized ring guardrails',railing.geometry(),steel,undefined,root);
  for(const x of [-.46,.46])beam('Access ladder uprights',steel,[x,1.18,2.82],[x,7.57,2.57],.061,.061,root);
  for(let j=0;j<21;j++){
    const y=1.49+j*.29, z=2.82-(y-1.18)*.039;
    beam('Access ladder rung',steel,[-.45,y,z],[.45,y,z],.055,.055,root);
  }
  for(let i=0;i<14;i++){
    const a=i*tau/14;
    diskAt('Foundation anchor washer',disc(.112,0,.062,.015,12),steel,[4.72*Math.cos(a),.93,4.72*Math.sin(a)],root);
  }
  const azimuth=mesh('Rotating antenna yoke',undefined,undefined,[0,8.58,0],root);
  const elevation=mesh('Antenna elevation pin',undefined,undefined,[0,4.11,1.71],azimuth);
  for(const sign of [-1,1]){
    const x=sign*2.32;
    mesh('Beveled upper azimuth cheek',beveledBlock(.89,3.97,1.27,.13),porcelain,[x,1.54,0],azimuth);
    beam('Inclined elevation frame stiffener',trim,[sign*.67,.30,.73],[x,3.26,.73],.38,.36,azimuth);
    mesh('Elevation bearing cap',disc(.83,-.45,.45,.086,36),trim,[x,4.11,.22],azimuth).setRotation([0,Math.PI/2,0]);
    mesh('Elevation bearing reinforcement',disc(.503,-.055,.055,.021,30),steel,[x+sign*.48,4.11,.22],azimuth).setRotation([0,Math.PI/2,0]);
  }
  const shell=Array.from({length:16},(_,i)=>{
    const r=i*bowl/15;
    return [r,surface(r)-.048];
  });
  mesh('Continuous aluminum reflector substrate',profile(shell.reverse(),72),trim,undefined,elevation);
  const panelColors=[white,'#dcd8c9','#deddd2','#d4d6ce','#e2e0d5','#d8d0bf'];
  for(const [index,geometry] of panelBowl(panelColors.length).entries())
    mesh('Separately fastened antenna panels',geometry,paint(panelColors[index],.62),undefined,elevation);
  const rim=profile([[9.94,3.54],[10.10,3.64],[10.19,3.69],[10.19,3.74],[10.11,3.777],[9.99,3.71]],72);
  mesh('Continuous rolled edge of reflector',rim,porcelain,undefined,elevation);
  mesh('Rear reflector cast support',disc(2.53,-1.23,-.095,.14,38),shadow,undefined,elevation);
  for(let j=0;j<12;j++){
    const a=(j+.35)*tau/12, c=Math.cos(a),s=Math.sin(a);
    const polar=(r,z)=>[c*r,s*r,z];
    const inner=polar(1.2,-.36),middle=polar(5.85,1.06),end=polar(9.14,surface(9.14)-.185);
    beam('Back of reflector radial strut',porcelain,inner,middle,.30,.28,elevation);
    beam('Outer truss radial member',porcelain,middle,end,.24,.21,elevation);
    beam('Triangulated mounting brace',shadow,[0,0,-1.68],middle,.18,.16,elevation);
  }
  for(const i of [0,1,2]){
    const a=(i+.17)*tau/3, c=Math.cos(a),s=Math.sin(a);
    const foot=[c*7.52,s*7.52,surface(7.52)],brace=[c*3.64,s*3.64,4.14];
    beam('Tapered feed-support spar',porcelain,foot,brace,.24,.29,elevation);
    beam('Precision feed cage spar',trim,brace,[c*.50,s*.50,6.55],.17,.16,elevation);
    beam('Triangulated feed counter-stay',steel,[c*6.02,s*6.02,surface(6.02)],[c*.24,s*.24,6.59],.075,.075,elevation);
  }
  mesh('Receiver front barrel',disc(.67,5.97,7.27,.18,40),shadow,undefined,elevation);
  mesh('Weatherproof copper feed cup',disc(.49,7.20,7.89,.09,40),orange,undefined,elevation);
  mesh('Receiver nose cap',disc(.37,7.82,7.94,.037,38),trim,undefined,elevation);
  const turn=time=>{
    azimuth.setRotation([0,-.09+.28*Math.sin(time*.21+.42),0]);
    elevation.setRotation([-.50-.127*Math.sin(time*.19-.22),0,0]);
  };
  return {turn,root};
}

function operations({paint,mesh,block,beam,diskAt}){
  const raw=paint('#b9b09d',.82),shell=paint('#c7c5b7',.79),dark=paint('#555b5a',.75);
  const oxide=paint('#845d4b',.82),glass=paint('#4c6671',.30),frame=paint('#8d9693',.53,1);
  const build=mesh('Field station modular service building',undefined,undefined,[-19.7,.31,-13.69]);
  mesh('Prefab service building body',beveledBlock(11.65,3.15,6.19,.16),shell,[0,1.55,0],build);
  mesh('Raised standing seam roof',beveledBlock(12.12,.18,6.51,.07),dark,[0,3.21,0],build);
  const fins=polygonMesh();
  for(let x=-5.83;x<5.87;x+=.36)fins.ribbon([x,3.319,-3.22],[x,3.319,3.22],.047);
  mesh('Standing seam roof ribbing',fins.geometry(),frame,undefined,build);
  for(const x of [-5.81,-3.9,-1.93,0,1.93,3.9,5.81])block('Recessed connection of modular panels',raw,[x,1.56,3.096],[.042,3.0,.018],build);
  for(const x of [-5.04,-3.37,-1.7,1.63,3.40,4.99]){
    block('Recessed window frame',dark,[x,2.06,3.099],[1.38,1.13,.097],build);
    block('Tinted field station glazing',glass,[x,2.06,3.151],[1.21,.96,.023],build);
    block('Narrow window sill',frame,[x,1.54,3.19],[1.35,.068,.13],build);
    block('Window division stile',frame,[x,2.056,3.171],[.035,1.01,.041],build);
  }
  block('Station entrance apron',raw,[.16,.12,3.64],[1.74,.27,1.45],build);
  block('Fire-orange station access door',oxide,[.13,1.21,3.127],[.91,2.30,.09],build);
  block('Horizontal industrial push handle',frame,[.13,1.15,3.194],[.51,.06,.086],build);
  block('Narrow access canopy',dark,[.13,2.71,3.66],[1.74,.13,1.33],build);
  for(const x of [-.62,.86])beam('Sway brace for station canopy',frame,[x,2.28,3.157],[x,2.66,4.03],.062,.076,build);

  const x=15.9,z=-20.8,platform=paint('#9b9889',.85),panel=paint('#426076',.48),grout=paint('#727b72',.65);
  block('Solar inverter and maintenance mat',platform,[x,.03,z],[12.2,.18,7.9]);
  for(const zoff of [-2.28,1.40]){
    const rack=mesh('Tilted solar collector mounting',undefined,undefined,[x,.90,z+zoff]).setRotation([.32,0,0]);
    for(const xoff of [-3.98,-2,0,2,3.98]){
      block('Solar module extruded frame',frame,[xoff,0,0],[1.92,.09,2.02],rack);
      block('Sunward photovoltaic face',panel,[xoff,.058,0],[1.85,.025,1.95],rack);
      const cells=polygonMesh();
      for(let i=-3;i<=3;i++){
        cells.ribbon([xoff+i*.23,.074,-.945],[xoff+i*.23,.074,.945],.019);
        cells.ribbon([xoff-.915,.074,i*.23],[xoff+.915,.074,i*.23],.014);
      }
      mesh('Photovoltaic current collector lines',cells.geometry(),grout,undefined,rack);
    }
    for(const off of [-4.25,0,4.25])beam('Collector mounting rack post',frame,[x+off,.08,z+zoff],[x+off,1.33,z+zoff],.085,.09);
  }
  for(const point of [[13.3,-8.9],[15.6,-8.9],[18.4,-8.9]]){
    const [x,z]=point;
    mesh('Raised instrument transit case',beveledBlock(1.05,.71,.87,.053),raw,[x,.448,z]);
    for(const off of [-.37,.37])block('Powder coated transit case pull',oxide,[x+off,.60,z+.452],[.094,.31,.063]);
  }
  for(const x of [8.8,9.64,10.49])
    diskAt('Transport bollard with amber cap',disc(.132,0,.88,.04,14),oxide,[x,.02,-8.11]);
}

export function station(studio){
  const assembly=stand(studio);
  operations(studio);
  return assembly;
}

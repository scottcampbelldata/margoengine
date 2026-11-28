import {PbrMaterial,box} from '@margoengine/core';
import {toGeometry} from '@margoengine/geometry';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';
import {cylinderGeometry} from '@margoengine/geometry/primitives';
import {crate,drum,startPoses,track} from './course.js';

const finish=(color,roughness=.57,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const P={
  backdrop:finish('#1d252b',.86),slab:finish('#555451',.86),grout:finish('#3e403e',.82),
  oil:finish('#3f423f',.91),soot:finish('#343734',.93),rail:finish('#727477',.36,.63),
  safety:finish('#bd834e',.48,.17),lead:finish('#282f33',.43,.29),copper:finish('#bc9167',.36,.41),
  brick:finish('#554d49',.74),black:finish('#242d33',.87),teal:finish('#405860',.48,.16),
  hot:finish('#ffd49b',.33),clay:finish('#be9e79',.61),oldSteel:finish('#545d68',.42,.25),
  wheel:finish('#636063',.32,.62),band:finish('#ad8e64',.34,.49),face:finish('#4d5f64',.34,.48),
  ivory:finish('#c9b693',.57),tile:[finish('#9d9672',.32),finish('#8a4943',.36),
    finish('#587170',.30),finish('#496576',.32),finish('#d0ae84',.36)],
  impression:[finish('#858365'),finish('#753b37'),finish('#4b6361'),finish('#3d596d'),finish('#b49673')],
};
const cuboid=box();
const rounded=(x,y,z,b)=>toGeometry(roundedBoxGeometry(x,y,z,3,b));
const cylinder=(n=40)=>toGeometry(cylinderGeometry(.5,.5,1,n,1));
const rollerShape=cylinder(80),boltShape=cylinder(14),shadeShape=cylinder(32);
const tileShape=rounded(...crate.map(x=>x*2),.015);
const deckShape=rounded(8.70,.28,4.57,.108);

function put(engine,geometry,material,p,scale=[1,1,1],parent){
  return engine.createMesh(parent).setGeometry(geometry).setMaterial(material).setPosition(p).setScale(scale);
}
export function buildWorks(engine){
  const shape=(geometry,material,p,s,parent)=>put(engine,geometry,material,p,s,parent);
  const block=(material,p,s,parent)=>shape(cuboid,material,p,s,parent);
  const rod=(material,p,s,parent)=>shape(boltShape,material,p,s,parent);
  const fixed=(key,material)=>{
    const {p,half}=track[key];
    return block(material,p,half.map(x=>x*2));
  };

  block(P.backdrop,[0,-.50,0],[120,.16,120]);
  shape(deckShape,P.lead,[0,-.284,0]);
  fixed('floor',P.slab);
  for(let row=0;row<16;row++){
    const x=(row-7.5)*.54;
    block(P.grout,[x,.0019,0],[.009,.004,4.30]);
  }
  for(const z of [-1.47,1.48])block(P.grout,[0,.0015,z],[8.56,.003,.008]);

  for(const z of [-1.79,1.84]){
    block(P.copper,[0,.005,z],[8.50,.009,.035]);
    for(let i=0;i<35;i++){
      const x=(i-17)*.240;
      block(i%5===0?P.ivory:P.copper,[x,.009,z*.968],[.012,.003,i%5===0?.102:.055]);
    }
  }
  for(const z of [-.42,.60]){
    block(P.rail,[-1.91,.004,z],[4.68,.007,.056]);
    block(P.black,[-1.91,.008,z],[4.68,.003,.014]);
  }
  for(let i=0;i<13;i++)block(P.grout,[-4.06+i*.359,.003,.09],[.030,.003,1.20]);
  for(const x of [-4.10,4.10])for(let i=0;i<7;i++){
    const plate=block(P.safety,[x,.010,-1.24+i*.40],[.052,.007,.195]);
    plate.setRotation([0,-.53,0]);
  }
  for(const z of [-1.35,1.35]){
    block(P.soot,[2.27,.002,z],[2.48,.003,.24]);
    block(P.safety,[2.27,.004,z],[2.48,.003,.023]);
  }
  for(const x of [-3.65,3.65])for(const z of [-1.84,1.84]){
    shape(rounded(.28,.15,.40,.027),P.lead,[x,-.355,z]);
    rod(P.copper,[x,-.346,z+.08],[.071,.126,.071]);
  }

  fixed('front',P.lead);fixed('start',P.teal);fixed('end',P.teal);
  block(P.rail,[0,.161,2.169],[8.61,.053,.097]);
  block(P.safety,[4.13,.635,0],[.135,.038,4.23]);
  block(P.rail,[-4.18,.300,0],[.092,.058,4.29]);
  for(const x of [-4.11,-3.50,-2.45,-1.40,-.35,.67,1.72,2.77,3.82,4.15]){
    block(P.copper,[x,.129,2.195],[.112,.129,.032]);
  }

  fixed('rear',P.brick);
  const back=-2.30;
  block(P.black,[.00,1.41,back],[8.61,2.82,.20]);
  block(P.teal,[.00,2.682,back+.132],[8.65,.162,.163]);
  block(P.copper,[.00,2.578,back+.207],[8.57,.038,.036]);
  block(P.copper,[.00,.256,back+.139],[8.57,.052,.079]);
  for(const x of [-4.11,-2.65,-.97,.75,2.47,4.11]){
    block(P.teal,[x,1.392,back+.167],[.17,2.687,.207]);
    block(P.rail,[x,1.419,back+.277],[.035,2.40,.019]);
    for(const y of [.498,2.424])rod(P.copper,[x,y,back+.295],[.058,.025,.058]).setRotation([Math.PI*.5,0,0]);
  }
  for(const x of [-2.21,-1.67,-.06,.43,1.80,2.17,3.13,3.60]){
    block(P.teal,[x,1.41,back+.117],[.35,2.171,.085]);
  }
  for(const x of [-3.38,-1.83,.07,1.55,3.23]){
    block(P.rail,[x,2.069,back+.288],[.30,.109,.26]);
    block(P.hot,[x,2.018,back+.336],[.236,.066,.164]);
    block(P.black,[x,1.967,back+.374],[.287,.031,.184]);
    for(let k=0;k<7;k++){
      block(P.oldSteel,[x,1.718-k*.136,back+.183],[.833,.056,.054]);
    }
  }
  const bayX=3.12;
  block(P.lead,[bayX,.73,back+.173],[.86,.55,.144]);
  block(P.ivory,[bayX,.73,back+.256],[.712,.43,.034]);
  for(let i=0;i<6;i++)block(P.black,[bayX-.24+i*.093,.75,back+.277],[.012,.131,.006]);
  for(const x of [-3.76,3.86])rod(P.copper,[x,.49,back+.319],[.145,.15,.145]).setRotation([Math.PI*.5,0,0]);

  const initial=startPoses();
  function makeBody(pose,i){
    if(i===0){
      const metal=engine.createMesh().setPosition(pose.p).setQuaternion(pose.q);
      shape(rollerShape,P.wheel,[0,0,0],[2*drum[0],2*drum[1],2*drum[0]],metal);
      for(const side of [-1,1]){
        shape(rollerShape,P.band,[0,side*.224,0],[.746,.079,.746],metal);
        shape(rollerShape,P.face,[0,side*.279,0],[.580,.023,.580],metal);
        rod(P.band,[0,side*.299,0],[.208,.031,.208],metal);
        for(let i=0;i<8;i++){
          const th=i*Math.PI/4,x=.223*Math.cos(th),z=.223*Math.sin(th);
          rod(P.copper,[x,side*.297,z],[.036,.024,.036],metal);
        }
      }
      return metal;
    }
    const body=shape(tileShape,P.tile[pose.ink],pose.p).setQuaternion(pose.q);
    block(P.impression[pose.ink],[0,crate[1]+.0015,0],[.222,.004,.205],body);
    for(const a of [-1,1]){
      block(P.ivory,[a*.052,crate[1]+.004,.02],[.026,.003,.083],body);
      block(P.impression[pose.ink],[0,0,a*(crate[2]+.002)],[.217,.098,.003],body);
      block(P.ivory,[.062,-.018,a*(crate[2]+.003)],[.051,.020,.003],body);
    }
    return body;
  }
  const movers=initial.map(makeBody);
  const outer=[],inner=[];
  for(const _ of movers){
    outer.push(shape(shadeShape,P.oil,[0,.013,0],[.53,.002,.39]));
    inner.push(shape(shadeShape,P.soot,[0,.014,0],[.37,.002,.26]));
  }
  function set(states){
    states.forEach(({p,q},i)=>{
      movers[i].setPosition(p).setQuaternion(q);
      const [x,y,z]=p;
      const low=Math.min(1.1,Math.max(0,y-(i===0?drum[0]:crate[1])));
      const cast=[x+low*.22,.014,z-low*.18];
      const submerged=x<-4.19||x>4.19||z<-2.01||z>2.01;
      const outside=submerged||y>1.12;
      outer[i].visible=inner[i].visible=!outside;
      if(!outside){
        outer[i].setPosition(cast).setScale(i===0?[.81,.002,.63]:[.50+low*.19,.002,.44+low*.21]);
        inner[i].setPosition([cast[0],.016,cast[2]]).setScale(i===0?[.63,.002,.45]:[.39+low*.04,.002,.34+low*.05]);
      }
    });
  }
  set(initial);
  return {set};
}

import { PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { CatmullRomCurve3 } from '@margoengine/geometry/shapes';
import { toGeometry } from '@margoengine/geometry/utils';
import { harmonicOrders, series } from './model.js';

const screenY=.1225;

function waveform(active) {
  const points=Array.from({length:241},(_,i)=>{
    const t=i/240;
    return [-.264+.528*t,screenY+.0037,.092-.060*series(active,4*Math.PI*t)];
  });
  return toGeometry(tubeGeometry(new CatmullRomCurve3(points),240,.00214,7));
}

export function makeOrgan(engine,shadows) {
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const studio=finish('#6d5a56',.89), rosewood=finish('#57392f',.49), walnut=finish('#493933',.59);
  const dark=finish('#403836',.66), cream=finish('#d8c7a6',.50);
  const bronze=finish('#86674e',.45,1), brass=finish('#c39b65',.32,1), polished=finish('#d3ab76',.23,1);
  const steel=finish('#9aa29f',.33,1), cavity=finish('#353a39',.74);
  const screen=finish('#385556',.50), fine=finish('#4b6c69',.65), axis=finish('#77938a',.67);
  const tracePaint=finish('#f4c47e',.45), activeLamp=finish('#f5ce83',.40), idleLamp=finish('#81755d',.68);

  function mesh(name,geometry,paint,position,casts=true) {
    const item=engine.createMesh().setPosition(position);
    item.name=name;
    item.setGeometry('uvs' in geometry?toGeometry(geometry):geometry).setMaterial(paint);
    if(casts)shadows.add(item,{static:true});
    return item;
  }
  const block=(name,dims,r,p,xyz,cast=true)=>mesh(name,roundedBoxGeometry(...dims,2,r),p,xyz,cast);
  const bolt=(name,r,h,p,xyz,sides=20)=>mesh(name,cylinderGeometry(r,r,h,sides),p,xyz);
  const drawProfile=(name,points,p,xyz,steps=64)=>mesh(name,latheGeometry(points,steps),p,xyz);

  mesh('Walnut studio sweep',box(30,.062,30),studio,[0,-.051,0],false);
  block('Cast instrument bottom',[.720,.054,.439],.017,dark,[0,.006,0]);
  block('Rosewood plinth',[.700,.069,.423],.015,rosewood,[0,.044,0]);
  block('Thin brass housing seam',[.679,.006,.404],.0024,bronze,[0,.076,0]);
  block('Raised organ rack',[.651,.036,.132],.012,walnut,[0,.095,-.130]);
  block('Ivory registration strip',[.644,.007,.050],.0032,cream,[0,.115,-.065]);
  for(const x of [-.309,.309])for(const z of [-.175,.172]){
    bolt('Countersunk trim washer',.009,.0035,brass,[x,.085,z],24);
    bolt('Steel instrument screw cap',.0047,.0035,steel,[x,.0880,z],6);
  }

  block('Oscilloscope tray',[.601,.035,.223],.011,bronze,[0,.101,.091]);
  block('Sapphire green screen',[.566,.012,.190],.0075,screen,[0,screenY-.0064,.093]);
  for(let r=0;r<=8;r++){
    block('Horizontal screen graticule',[.540,.00062,.0010],.00024,r===4?axis:fine,[0,screenY+.00012,.015+.0195*r],false);
  }
  for(let c=0;c<=16;c++){
    block('Time-base graticule',[.00091,.00062,.157],.00025,c%4===0?axis:fine,[-.270+.03375*c,screenY+.00012,.093],false);
  }
  const trace=mesh('Computed Fourier trace',waveform(2),tracePaint,[0,0,0],false);

  const lamps=[];
  for(const [i,order] of harmonicOrders.entries()){
    const x=(i-3)*.0878,z=-.136;
    const height=.105+.22/Math.sqrt(order);
    const lip=.022+i*.0009;
    const pad=.032;
    drawProfile('Threaded torsion socket',[[0,0],[.030,0],[.033,.007],[.032,.019],[.027,.023],[0,.023]],bronze,[x,.110,z],40);
    drawProfile('Turned sound pipe',[
      [0,0],[pad,0],[pad,.024],[.028,.033],[lip,.062],[lip,height-.012],
      [lip+.0024,height-.009],[lip+.0024,height-.001],[lip-.0027,height],
      [lip-.0027,height-.037],[lip-.004,height-.043],[0,height-.043],
    ],i%2===0?brass:polished,[x,.122,z],64);
    block('Charcoal pipe mouth',[.026,.014,.0060],.0019,cavity,[x,.185,z+lip-.0008]);
    block('Voicing lip',[.028,.0042,.0083],.0015,polished,[x,.1797,z+lip+.0011]);
    const ring=bolt('Indicator window rim',.0114,.0046,bronze,[x,.121,-.061],32);
    ring.receiveShadow=true;
    const lens=drawProfile('Partial indicator lens',[[0,0],[.0085,0],[.0092,.0021],[.0078,.0047],[.0037,.0063],[0,.0066]],
      i<2?activeLamp:idleLamp,[x,.123,-.061],24);
    lamps.push(lens);
  }
  let last=2;
  return {
    setCount(count) {
      if(count===last)return;
      trace.setGeometry(waveform(count));
      for(const [i,lamp] of lamps.entries()){
        if ((i<count)!==(i<last)) lamp.setMaterial(i<count?activeLamp:idleLamp);
      }
      last=count;
    },
  };
}



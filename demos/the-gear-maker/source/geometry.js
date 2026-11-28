import {gearRadii,involuteOutline,compoundRatio} from '@margoengine/procedural/gears';
import {Shape,Path} from '@margoengine/geometry';
import {extrudeGeometry} from '@margoengine/geometry/extrude';

const module=.062;
const names=['a','b','c','d'];
const widths=[.148,.156,.146,.148];
const steps=34;
const form={pressureAngle:Math.PI/9,addendum:1,dedendum:1.25};
function circle(cx,cy,r){
  const points=Array.from({length:steps},(_,i)=>{
    const f=-i*Math.PI*2/steps;
    return [cx+r*Math.cos(f),cy+r*Math.sin(f)];
  });
  return new Path(points);
}
export function design(counts){
  const radii=names.map(name=>gearRadii(counts[name],module,form));
  const centersAB=radii[0].pitch+radii[1].pitch,centersCD=radii[2].pitch+radii[3].pitch;
  const frame={drive:[-.974*centersAB,.22655*centersAB],stud:[0,0],output:[.99095*centersCD,-.134231*centersCD]};
  const magnitude=Math.hypot(...frame.drive),o=Math.hypot(...frame.output);
  frame.drive=frame.drive.map(v=>v*centersAB/magnitude);
  frame.output=frame.output.map(v=>v*centersCD/o);
  const positions=[frame.drive,frame.stud,frame.stud,frame.output];
  const meshes=names.map((s,i)=>{
    const radiiAt=radii[i],teeth=counts[s],body=new Shape(involuteOutline(teeth,module,{...form,flankPoints:5}));
    const bore=.25*radiiAt.root,lightening=teeth<26?4:6;
    body.holes.push(circle(0,0,bore));
    for(let spoke=0;spoke<lightening;spoke++){
      const angle=(spoke+.5)*Math.PI*2/lightening;
      const center=radiiAt.root*.58;
      body.holes.push(circle(Math.cos(angle)*center,Math.sin(angle)*center,radiiAt.root*.201));
    }
    const data=extrudeGeometry(body,{depth:widths[i],bevelEnabled:false,curveSegments:6});
    return {positions:data.positions,normals:data.normals,indices:data.indices,center:positions[i],radius:radiiAt,
      bore,lane:i<2?-.16:.130,width:widths[i],teeth};
  });
  return {counts,frame,ratio:compoundRatio(counts),meshes,module};
}

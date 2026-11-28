import {Spline} from '@margoengine/splines';

export const rail=new Spline([[-23,2.6,20],[-14,2.3,19],[-5,2.1,17.8],[7,2.1,17.9],[17,2.3,18.8],[25,2.6,21]],
  {kind:'bspline',divisions:96});
const courses=[
  new Spline([[-14,0,8.25],[-8,0,6.25],[2,0,5.25],[12,0,5.75],[16,0,9.25],[13,0,13.25],[4,0,14.25],[-8,0,13.25],[-15,0,11.25]],
    {closed:true,kind:'bspline',divisions:120}),
  new Spline([[10,0,-.50],[16,0,-2.0],[15,0,-5.0],[9,0,-6.1],[-1,0,-6.35],[-10,0,-5.8],[-16,0,-3.8],[-13,0,-1.3],[-4,0,.19],[4,0,.23]],
    {closed:true,kind:'bspline',divisions:120}),
];

export function vehiclePaths(){
  return courses.map((curve,index)=>{
    const point=new Float64Array(3),target=new Float64Array(3);
    const next=new Float64Array(3),previous=new Float64Array(3),distance0=index?21:1;
    const speed=index?2.18:2.65;
    function sample(seconds){
      const distance=distance0+seconds*speed;
      curve.atDistance(distance,point);
      curve.atDistance(distance-.06,previous);
      curve.atDistance(distance+.06,next);
      target.set([point[0],1.18,point[2]]);
      return {point,yaw:Math.atan2(next[0]-previous[0],next[2]-previous[2]),distance};
    }
    return {sample,target};
  });
}

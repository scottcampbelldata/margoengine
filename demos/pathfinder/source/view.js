const target=[0,-.23,0],eye=[-8.0,16.4,14.4];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=v=>{const length=Math.hypot(...v);return v.map(n=>n/length);};

export function boardView(camera){
  camera.position=eye;
  camera.target=target;
  const back=unit(eye.map((value,i)=>value-target[i]));
  const right=unit(cross([0,1,0],back)),up=cross(back,right);
  const corners=[-6.17,6.17].flatMap(x=>[-1.16,1].flatMap(y=>[-4.29,4.08].map(z=>[x,y-target[1],z])));
  const width=Math.max(...corners.map(point=>Math.abs(dot(right,point))))+.32;
  const height=Math.max(...corners.map(point=>Math.abs(dot(up,point))))+.23;
  let halfWidth=width,halfHeight=height;

  camera.project=(output,aspect,webgpu)=>{
    halfHeight=Math.max(height,width/aspect);
    halfWidth=halfHeight*aspect;
    const {near,far}=camera;
    output[0]=1/halfWidth;
    output[5]=1/halfHeight;
    output[10]=(webgpu?1:-2)/(far-near);
    output[14]=(webgpu?far:-(far+near))/(far-near);
    output[15]=1;
  };
  function point(u,v){
    const x=(2*u-1)*halfWidth,y=(1-2*v)*halfHeight;
    const onPlane=target.map((value,i)=>value+right[i]*x+up[i]*y);
    const t=onPlane[1]/back[1];
    return [onPlane[0]-back[0]*t,0,onPlane[2]-back[2]*t];
  }
  function screen(point){
    const relative=point.map((value,i)=>value-target[i]);
    return [.5+dot(right,relative)/(2*halfWidth),.5-dot(up,relative)/(2*halfHeight)];
  }
  return {point,screen};
}

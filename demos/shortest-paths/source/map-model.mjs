import {field,junction,roads,water} from './network.mjs';

export const paper='#e8e3d2';
export const mapColors={
  grid:'#d4cdb9',shore:'#7297a0',water:'#aabdb8',local:'#aaa294',arterial:'#859093',
  direction:'#756b8a',junction:'#827563',highlight:'#ad3c3e',routeShadow:'#f7e6c9',
  source:'#a3383a',target:'#234d64',
};
export const ramps=['#245868','#3d858c','#5c9496','#ac9c78','#ba8a72'];
export const ranges=[0,500,1000,1700,2500];

function addSegments(output,points) {
  for(let i=1;i<points.length;i++){
    output.push(...points[i-1],0,...points[i],0);
  }
}

const base=[],major=[],arrows=[],graticule=[],dots=[];
for(const road of roads){
  addSegments(road.arterial?major:base,road.path);
  if(!road.direction)continue;
  const pairs=road.path.slice(1).map((b,i)=>{
    const a=road.path[i];
    return {a,b,length:Math.hypot(b[0]-a[0],b[1]-a[1])};
  });
  const main=pairs.reduce((longest,next)=>longest.length>=next.length?longest:next);
  if(main.length<35)continue;
  const {a,b,length}=main;
  const x=(a[0]+b[0])*.5,y=(a[1]+b[1])*.5;
  const dx=(b[0]-a[0])/length*road.direction,dy=(b[1]-a[1])/length*road.direction;
  const tip=[x+11*dx,y+11*dy];
  addSegments(arrows,[[x-7*dx+8*dy,y-7*dy-8*dx],tip,[x-7*dx-8*dy,y-7*dy+8*dx]]);
}
for(let x=-1000;x<=1000;x+=500)addSegments(graticule,[[x,-field.height*.5],[x,field.height*.5]]);
for(let y=-1000;y<=1000;y+=500)addSegments(graticule,[[-field.width*.5,y],[field.width*.5,y]]);
for(const [x,y] of junction){
  addSegments(dots,[[x-2,y],[x+2,y]]);
}

const packed=values=>Float32Array.from(values);
const pen=(color,width,vertices)=>({color,width,vertices});
const strokes=[
  pen(mapColors.grid,.65,packed(graticule)),
  pen(mapColors.water,.76,water.hatch),
  pen(mapColors.shore,1.05,water.shore),
  pen(mapColors.local,1.32,packed(base)),
  pen(mapColors.arterial,2.29,packed(major)),
];
const arrowLayer=pen(mapColors.direction,1.18,packed(arrows));
const junctionLayer=pen(mapColors.junction,2.12,packed(dots));
export const startLocation=()=>Array.from(strokes);

export function linesFor(distances,route,showDirection){
  const layers=startLocation();
  if(distances){
    const scale=ramps.map(()=>[]);
    for(const road of roads){
      const {start,end,direction,cost,path}=road;
      const origin=direction>0?distances[start]:direction<0?distances[end]:Math.min(distances[start],distances[end]);
      if(!Number.isFinite(origin))continue;
      const meters=(origin+cost*.5)/100;
      let band=0;
      while(band+1<ranges.length&&meters>=ranges[band+1])band++;
      addSegments(scale[band],path);
    }
    for(const [i,list] of scale.entries()){
      if(list.length)layers.push(pen(ramps[i],1.75,packed(list)));
    }
  }
  layers.push(junctionLayer);
  if(showDirection)layers.push(arrowLayer);
  if(route?.steps.length){
    const geometry=[];
    for(const step of route.steps)addSegments(geometry,step.reversed?[...step.road.path].reverse():step.road.path);
    const vertices=packed(geometry);
    layers.push(pen(mapColors.routeShadow,6.8,vertices),pen(mapColors.highlight,4.15,vertices));
  }
  return layers;
}

export function projection(width,height){
  const border=width/height<1.13?16:26;
  const scale=Math.max(.001,Math.min((width-border*2)/field.width,(height-22-border*2)/field.height));
  const center=[width*.5,(height+10)*.5];
  return {
    scale,center,width,height,
    screen([x,y]){return [center[0]+x*scale,center[1]-y*scale];},
    world(x,y){return [(x-center[0])/scale,(center[1]-y)/scale];},
  };
}

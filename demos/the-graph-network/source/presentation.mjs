import {adjacency,bounds,islands,ports,routes} from './network.mjs';

export const margin={left:16,right:16,top:58,bottom:38};
export const background='#142f2b';
export const pickRadius=9;

export function graphStyle(selected){
  const direct=new Set(adjacency[selected]??[]);
  return {
    bounds,arrowSize:0,edgeOpacity:.86,
    edgeWidth:Float32Array.from(routes,({start,end,trunk})=>{
      if(start===selected||end===selected)return 2.15;
      return trunk ? (selected<0?1.32:.78) : (selected<0?.78:.49);
    }),
    edgeColor:routes.map(({start,end,trunk})=>{
      if(start===selected||end===selected)return '#fff1b0';
      if(trunk)return selected<0?'#e6b471':'#977950';
      return selected<0?islands[ports[start].group].dim:'#314f48';
    }),
    nodeSize:Float32Array.from(ports,({hub},i)=>{
      if(i===selected)return 15;
      if(direct.has(i))return 8.0;
      return hub?11.5:4.3+.28*adjacency[i].length;
    }),
    nodeColor:ports.map(({group,hub},i)=>{
      if(i===selected)return '#fff5ce';
      if(direct.has(i))return '#ffe4a1';
      return hub||selected<0?islands[group].color:islands[group].dim;
    }),
  };
}

export function screenPoint(positions,id,area,limits=bounds) {
  const {x,y,width,height}=area,[west,east,south,north]=limits;
  return [x+width*(positions[id*3]-west)/(east-west),y+height*(north-positions[id*3+1])/(north-south)];
}

export function resizeCanvas(canvas) {
  const density=Math.max(1.5,Math.min(1.75,devicePixelRatio||1));
  const w=Math.max(1,Math.round(canvas.clientWidth*density)),h=Math.max(1,Math.round(canvas.clientHeight*density));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;
  canvas.height=h;
  return true;
}

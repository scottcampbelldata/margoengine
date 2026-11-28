import {polygonMesh} from './geometry.js';

export function daylight({mesh,paint}){
  const ground=[212,215,203],high=[112,160,176],bands=64,z=-361;
  for(let i=0;i<bands;i++){
    const u=i/bands,t=Math.pow(u,.66),y0=-3+273*u,y1=i===bands-1?570:-3+273*(i+1)/bands;
    const color=ground.map((n,j)=>Math.round(n+(high[j]-n)*t));
    const tint='#'+color.map(n=>n.toString(16).padStart(2,'0')).join('');
    const band=polygonMesh(),up=[0,1,0];
    band.smoothQuad([-1600,y0,z],[1600,y0,z],[1600,y1,z],[-1600,y1,z],[up,up,up,up]);
    mesh('Elevation tint of the dry air',band.geometry(),paint(tint,1));
  }
}

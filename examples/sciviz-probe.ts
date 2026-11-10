import { Figure } from '@margoengine/sciviz';
import { meshLayer, type TriangleSet } from '@margoengine/sciviz/grids';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { clipGrid } from '@margoengine/sciviz/clip';
import { CellLocator, plotOverLine, resampleToImage, resampleDataset, integrateGrid, linkProbePlot } from '@margoengine/sciviz/probe';
import { readBumpSlice } from './sciviz-contour-data.js';
import { element } from './sciviz-demo.js';

export const nasa = await Figure.create(element<HTMLCanvasElement>('nasa'), { axes: false, controls: false });
export const mri = await Figure.create(element<HTMLCanvasElement>('mri'), { axes: false, controls: false, aspect:[174/254,1,1] });
export const nasaChart = await Figure.create(element<HTMLCanvasElement>('nasa-chart'), { mode: '2d', controls: false, titles: { x: 'Distance (reference units)', y: 'Eddy viscosity ratio' } });
export const mriChart = await Figure.create(element<HTMLCanvasElement>('mri-chart'), { mode: '2d', controls: false, titles: { x: 'Distance (mm)', y: 'Original T1 intensity' } });
for (const f of [nasa, mri, nasaChart, mriChart]) f.engine.stop();
nasa.engine.camera.position = [0,3.2,0]; nasa.engine.camera.up = [0,0,-1];
const response = await fetch(new URL('./assets/sciviz/contour/bump.dat', import.meta.url));
if (!response.ok) throw new TypeError(`NASA source HTTP ${response.status}`);
export const grid = readBumpSlice(await response.text());
export const nasaLocator = await CellLocator.create(grid);
export const nasaProfile = await plotOverLine(nasaLocator, [-0.9,0.04,0,-0.1,0.04,0], { samples: 101 });
const clipped = await clipGrid(grid, { kind:'plane', normal:[0,1,0], offset:-0.08 }, { invert:true });
const positions: number[] = [], values: number[] = [], cells: number[] = [], bounds = [Infinity,-Infinity,Infinity,-Infinity,Infinity,-Infinity];
for (let c = 0; c < clipped.types.length; c++) {
  for (let k=c?clipped.offsets[c-1]:0;k<clipped.offsets[c];k++) {
    const id=clipped.connectivity[k];
    for(let a=0;a<3;a++){const p=clipped.points[3*id+a];positions.push(p);bounds[2*a]=Math.min(bounds[2*a],p);bounds[2*a+1]=Math.max(bounds[2*a+1],p);}
    values.push(clipped.pointData![id]);
  }
  cells.push(clipped.sourceCells![c]);
}
const normals=new Float32Array(positions.length);for(let i=2;i<normals.length;i+=3)normals[i]=1;
meshLayer(nasa,{positions:new Float32Array(positions),normals,values:new Float32Array(values),cells:new Uint32Array(cells),bounds:bounds as unknown as TriangleSet['bounds']},{colormap:'viridis',range:[0,40]});
export const nasaIntegral = await integrateGrid(grid);
export const nasaResampled = await resampleDataset(nasaLocator, {points:nasaProfile.positions,connectivity:Array.from({length:100},(_,i)=>[i,i+1]).flat(),offsets:Array.from({length:100},(_,i)=>2*(i+1)),types:new Uint8Array(100).fill(3)});
export const nasaLink = await linkProbePlot(nasa,nasaChart,nasaProfile);

const source=await loadNRRD(new URL('./assets/sciviz/head.nrrd',import.meta.url));
const head=nrrdGrid(source);
export const mriLocator=await CellLocator.create({dims:head.dims,bounds:head.bounds,pointData:head.data});
export const mriResampled=await resampleToImage(mriLocator,[32,32,32],head.bounds);
await mri.volume(mriResampled.grid.pointData!,{dims:[32,32,32],bounds:head.bounds,range:head.range,colormap:'gray',opacity:[[0,0],[0.14,0],[0.35,0.06],[1,0.2]]});
export const mriProfile=await plotOverLine(mriLocator,[0,head.bounds[3]/2,head.bounds[5]/2,head.bounds[1],head.bounds[3]/2,head.bounds[5]/2],{samples:101});
export const mriLink=await linkProbePlot(mri,mriChart,mriProfile);
for(const f of [nasa,mri,nasaChart,mriChart]){await f.ready();f.engine.render();}
element('status').textContent=`Ready. NASA area ${nasaIntegral.area.measure.toFixed(6)}, scalar integral ${nasaIntegral.area.pointData!.toFixed(6)}. MRI ${mriResampled.valid.length} resampled points; hover the charts.`;
window.addEventListener('pagehide',()=>{nasaLink.dispose();mriLink.dispose();nasaLocator.dispose();mriLocator.dispose();for(const f of [nasa,mri,nasaChart,mriChart])f.dispose();},{once:true});

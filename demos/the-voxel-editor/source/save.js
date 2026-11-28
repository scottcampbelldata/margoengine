import {voxFromGrid} from '@margoengine/voxel-edit/vox';
import {writeVox} from '@margoengine/voxel/vox';
import {rgbaPalette} from './model.js';

export function download(grid){
  const bytes=writeVox({version:200,models:[voxFromGrid(grid)],palette:rgbaPalette(),materials:[],nodes:[],layers:[]});
  const href=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
  const link=document.createElement('a');
  link.href=href;
  link.download='harbor-signal.vox';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(href),1000);
  return bytes.length;
}

import {MeshBVH} from '@margoengine/bvh';
import {GPUSceneBVH} from '@margoengine/bvh/gpu-scene';
import {Matrix4} from '@margoengine/math/matrix4';
import {Quaternion} from '@margoengine/math/quaternion';
import {RTReflections} from '@margoengine/post/rt-reflections';
import {PostStack} from '@margoengine/post/stack';
import {opticalItems} from './gallery.js';

export function prepareStockMirror(){
  const trees=new Map(),matrix=new Matrix4(),rotation=new Quaternion();
  const vector=([x,y,z])=>({x,y,z});
  return opticalItems().map(({geometry,appearance,position,rotation:angles,scale})=>{
    let bvh=trees.get(geometry);
    if(!bvh){
      bvh=MeshBVH.fromGeometry(geometry);
      trees.set(geometry,bvh);
    }
    rotation.setFromEuler({...vector(angles),order:'XYZ'});
    return {bvh,matrix:matrix.compose(vector(position),rotation,vector(scale)).elements.slice(),material:appearance.optical};
  });
}

export function attachStockMirror(engine,scene,instances,settings){
  let tree=GPUSceneBVH.forShader(engine.gpu,instances);
  const traced=new RTReflections({...settings,scene:tree,shadows:false,bias:.013});
  scene.use(new PostStack([traced]));
  scene.use({
    name:'mirror-tree',
    setup(){},
    onDeviceRestored(next){
      tree.dispose();
      tree=GPUSceneBVH.forShader(next.gpu,instances);
      traced.options.scene=tree;
    },
    dispose(){tree.dispose();},
  });
  return tree.count;
}

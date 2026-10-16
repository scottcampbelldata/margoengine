import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import validator from 'gltf-validator';
import {GLTFAsset,PBRModel} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import {headlessEngine} from '../../exporters/tests/helpers.js';
import {convertFBX} from '../dist/index.js';
import {readGLB} from './native-scene-helper.js';

// Read the shipped DCC file directly, without exposing reader internals publicly.
const bundled=await build({configFile:false,publicDir:false,logLevel:'silent',build:{
  write:false,minify:false,target:'es2022',
  lib:{entry:fileURLToPath(new URL('../src/document.ts',import.meta.url)),formats:['es']},
}});
const source=(Array.isArray(bundled)?bundled[0]:bundled).output.find(item=>item.type==='chunk').code;
const {parseDocument,array,findChild,property,objectName,id}=await import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=margo-fbx-real-file-reader.js`).toString('base64')}`);

test('real Blender FBX retains its three joints, explicit bind matrix and Bend quaternion endpoints',async()=>{
  const bytes=await readFile(new URL('./fixtures/blender-rig.fbx',import.meta.url));
  const original=await parseDocument(bytes),objects=[...original.objects.values()];
  assert.equal(original.version,7400);
  const settings=original.roots.find(node=>node.name==='GlobalSettings');
  assert.deepEqual(['UpAxis','FrontAxis','FrontAxisSign','UnitScaleFactor'].map(name=>property(settings,name)),[2,1,-1,100]);
  const joints=objects.filter(node=>node.name==='Model'&&node.properties[2]==='LimbNode');
  assert.deepEqual(joints.map(objectName),['Base','Middle','Tip']);
  const clusters=objects.filter(node=>node.name==='Deformer'&&node.properties[2]==='Cluster');
  assert.equal(clusters.length,3);
  const middleCluster=clusters.find(node=>objectName(node)==='Middle');
  assert.ok(middleCluster);
  // These sixteen source numbers describe mesh bind translation +1 X and an
  // identity joint bind. inverse(TransformLink) * Transform is therefore +1 X.
  assert.deepEqual([...array(middleCluster,'Transform')],[
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    1,0,0,1,
  ]);
  assert.deepEqual([...array(middleCluster,'TransformLink')],[
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    0,0,0,1,
  ]);
  const stacks=objects.filter(node=>node.name==='AnimationStack');
  assert.deepEqual(stacks.map(objectName),['Bend']);
  const middle=joints.find(node=>objectName(node)==='Middle');
  const track=original.connections.find(c=>c.kind==='OP'&&c.parent===id(middle.properties[0])&&c.property==='Lcl Rotation');
  assert.ok(track);
  const zCurve=original.connections.find(c=>c.kind==='OP'&&c.parent===track.child&&c.property==='d|Z');
  assert.ok(zCurve);
  const curve=original.objects.get(zCurve.child),keyTimes=findChild(curve,'KeyTime').properties[0],keyValues=array(curve,'KeyValueFloat');
  assert.equal(keyTimes.length,25);
  assert.deepEqual([Number(keyTimes[0]),Number(keyTimes.at(-1))],[0,46186158000]);
  assert.deepEqual([keyValues[0],keyValues.at(-1)],[0,90.00000762939453]);
  assert.ok([...array(curve,'KeyAttrFlags')].every(flags=>(flags&14)===4));

  const buffer=await convertFBX(bytes),{doc,bin,accessor}=readGLB(buffer);
  assert.equal(doc.skins.length,1);
  const skin=doc.skins[0];
  assert.equal(skin.joints.length,3);
  assert.deepEqual(skin.joints.map(index=>doc.nodes[index].name),['Base','Middle','Tip']);
  const middleJoint=skin.joints.findIndex(index=>doc.nodes[index].name==='Middle');
  const binds=accessor(skin.inverseBindMatrices);
  assert.equal(binds.length,3*16);
  assert.deepEqual([...binds.subarray(middleJoint*16,(middleJoint+1)*16)],[
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    1,0,0,1,
  ]);
  assert.equal(doc.animations.length,1);
  const clip=doc.animations[0];
  assert.equal(clip.name,'Bend');
  const channel=clip.channels.find(c=>c.target.path==='rotation'&&doc.nodes[c.target.node].name==='Middle');
  assert.ok(channel);
  const sampler=clip.samplers[channel.sampler],times=accessor(sampler.input),quaternions=accessor(sampler.output);
  assert.equal(sampler.interpolation,'LINEAR');
  assert.deepEqual([times[0],times.at(-1)],[0,1]);
  // The file is Z-up: its +Z Euler rotation becomes glTF +Y. Half-angle sin/cos
  // of the source Float32 degrees above, rounded to Float32, give these values.
  assert.deepEqual([...quaternions.subarray(0,4)],[0,0,0,1]);
  assert.deepEqual([...quaternions.subarray(-4)],[0,0.7071068286895752,0,0.7071067094802856]);
  const report=await validator.validateBytes(new Uint8Array(buffer));
  assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));

  const engine=await headlessEngine(),model=new PBRModel(engine,new GLTFAsset(doc,[bin])),animation=new Animation(model,{loop:false});
  try{
    animation.play('Bend').seek(0);engine.store.tick(false);
    const meshIndex=doc.nodes.findIndex(node=>node.name==='Fan');
    assert.deepEqual([...model.nodes[meshIndex].matrix],[
      1,0,0,0,
      0,1,0,0,
      0,0,1,0,
      1,0,0,1,
    ]);
    // inverse(meshWorld) * jointWorld * inverseBind is identity at rest:
    // translation(-1 X) * identity * translation(+1 X).
    for(const [index,joint] of skin.joints.entries()){
      assert.deepEqual([...model.nodes[joint].matrix],[
        1,0,0,0,
        0,1,0,0,
        0,0,1,0,
        0,0,0,1,
      ]);
      assert.deepEqual([...binds.subarray(index*16,(index+1)*16)],[...model.nodes[meshIndex].matrix]);
    }
  }finally{animation.dispose();model.dispose();engine.dispose();}
});

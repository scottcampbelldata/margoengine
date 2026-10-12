import test from 'node:test';
import assert from 'node:assert/strict';
import {convertFBX} from '../dist/index.js';
import validator from 'gltf-validator';
// Browser FileReader adapter for the upstream exporter; production uses the native API.
globalThis.FileReader=class {async readAsArrayBuffer(blob){this.result=await blob.arrayBuffer();this.onloadend?.();}};
const ascii=`; FBX 7.4.0 project fixture
FBXHeaderExtension: {
\tFBXVersion: 7400
}
Objects: {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,1,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t}
}
Connections: {
\tC: "OO",1,2
\tC: "OO",2,0
}
`;
function binary(){
  const string=v=>{const b=Buffer.from(v),h=Buffer.alloc(5);h[0]=83;h.writeUInt32LE(b.length,1);return Buffer.concat([h,b]);};
  const integer=v=>{const b=Buffer.alloc(9);b[0]=76;b.writeBigInt64LE(BigInt(v),1);return b;};
  const array=(values,type)=>{const width=type==='d'?8:4,b=Buffer.alloc(13+values.length*width);b[0]=type.charCodeAt(0);b.writeUInt32LE(values.length,1);b.writeUInt32LE(values.length*width,9);values.forEach((v,i)=>type==='d'?b.writeDoubleLE(v,13+i*width):b.writeInt32LE(v,13+i*width));return b;};
  const nodes=[['Objects',[],[['Geometry',[integer(1),string('Geometry::Triangle'),string('Mesh')],[['Vertices',[array([0,0,0,1,0,0,0,1,0],'d')],[]],['PolygonVertexIndex',[array([0,1,-3],'i')],[]]]],['Model',[integer(2),string('Model::Triangle'),string('Mesh')],[]]]],['Connections',[],[['C',[string('OO'),integer(1),integer(2)],[]],['C',[string('OO'),integer(2),integer(0)],[]]]]];
  function node([name,props,children],offset){const text=Buffer.from(name),p=Buffer.concat(props),parts=[];let end=offset+13+text.length+p.length;for(const child of children){const part=node(child,end);parts.push(part);end+=part.length;}if(children.length){parts.push(Buffer.alloc(13));end+=13;}const header=Buffer.alloc(13);header.writeUInt32LE(end);header.writeUInt32LE(props.length,4);header.writeUInt32LE(p.length,8);header[12]=text.length;return Buffer.concat([header,text,p,...parts]);}
  const header=Buffer.alloc(27);header.write('Kaydara FBX Binary  \0');header[21]=26;header.writeUInt32LE(7400,23);const parts=[header];let offset=27;for(const n of nodes){const part=node(n,offset);parts.push(part);offset+=part.length;}parts.push(Buffer.alloc(256));return Buffer.concat(parts);
}
test('binary and ASCII FBX convert into validated triangle GLB',async()=>{
  for(const bytes of [new TextEncoder().encode(ascii),binary()]){
    const result=await convertFBX(bytes),view=new DataView(result);assert.equal(view.getUint32(0,true),0x46546c67);
    const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(result,20,view.getUint32(12,true))));
    assert.equal(doc.meshes.length,1);assert.equal(doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION].count,3);
    const report=await validator.validateBytes(new Uint8Array(result));assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
  }
  await assert.rejects(convertFBX(new ArrayBuffer(2)),/budget/);
  await assert.rejects(convertFBX(new ArrayBuffer(32),{resourcePath:'file:///secret'}),/HTTP/);
  await assert.rejects(convertFBX(new ArrayBuffer(32),{signal:AbortSignal.abort()}),{name:'AbortError'});
});
test('FBX animation curves survive as timed glTF translation channels',async()=>{
 const animated=ascii.replace('\n}\nConnections:',`\n\tAnimationStack: 10, "AnimStack::Move", "" {\n\t}\n\tAnimationLayer: 11, "AnimLayer::Base", "" {\n\t}\n\tAnimationCurveNode: 12, "AnimCurveNode::T", "" {\n\t}\n\tAnimationCurve: 13, "AnimCurve::X", "" {\n\t\tKeyTime: *2 {\n\t\t\ta: 0,46186158000\n\t\t}\n\t\tKeyValueFloat: *2 {\n\t\t\ta: 0,2\n\t\t}\n\t}\n}\nConnections:`).replace('\tC: "OO",2,0','\tC: "OO",2,0\n\tC: "OO",11,10\n\tC: "OO",12,11\n\tC: "OP",12,2,"Lcl Translation"\n\tC: "OP",13,12,"d|X"');
 const result=await convertFBX(new TextEncoder().encode(animated)),view=new DataView(result),length=view.getUint32(12,true),doc=JSON.parse(new TextDecoder().decode(new Uint8Array(result,20,length)));
 assert.equal(doc.animations.length,1);assert.equal(doc.animations[0].name,'Move');const channel=doc.animations[0].channels[0];assert.equal(channel.target.path,'translation');
 const sampler=doc.animations[0].samplers[channel.sampler],accessor=id=>{const a=doc.accessors[id],b=doc.bufferViews[a.bufferView];return new Float32Array(result,28+length+(b.byteOffset??0)+(a.byteOffset??0),a.count*(a.type==='VEC3'?3:1));};
 assert.deepEqual([...accessor(sampler.input)],[0,1]);assert.deepEqual([...accessor(sampler.output)],[0,0,0,2,0,0]);
 const report=await validator.validateBytes(new Uint8Array(result));assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
});

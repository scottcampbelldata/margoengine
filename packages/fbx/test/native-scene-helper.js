// Hand-authored FBX scene fixtures, independent of the parser and exporter code.
export const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const translated = x => {const out = identity.slice(); out[12] = x; return out;};
const vector = (name, values) => `P: "${name}", "Vector3D", "Vector", "A", ${values.join(',')}`;
const array = (name, values) => `${name}: *${values.length} {\n a: ${values.join(',')}\n}`;

export function rigFixture({mode = 'Normalize', units, geometric = [3,0,0], meshTranslation = [2,0,0], skin = true, morph = true, animation = true, extraModel = '', extraConnections = ''} = {}) {
  const settings = units === undefined ? '' : `GlobalSettings: {\n Properties70: {\n P: "UnitScaleFactor", "double", "Number", "", ${units}\n }\n}\n`;
  const skinObjects = !skin ? '' : `
 Deformer: 10, "Deformer::Skin", "Skin" {
  SkinningType: "Linear"
 }
 Deformer: 11, "SubDeformer::Root", "Cluster" {
  Mode: "${mode}"
  ${array('Indexes', [0,1,2])}
  ${array('Weights', [0.5,0.5,0.5])}
  ${array('Transform', translated(meshTranslation[0]))}
  ${array('TransformLink', identity)}
 }
 Deformer: 12, "SubDeformer::Tip", "Cluster" {
  Mode: "${mode}"
  ${array('Indexes', [0,1,2])}
  ${array('Weights', [0.5,0.5,0.5])}
  ${array('Transform', translated(meshTranslation[0]))}
  ${array('TransformLink', translated(1))}
 }`;
  const morphObjects = !morph ? '' : `
 Deformer: 20, "Deformer::Blend", "BlendShape" {
 }
 Deformer: 21, "SubDeformer::Raise", "BlendShapeChannel" {
  DeformPercent: 50
  ${array('FullWeights', [100])}
 }
 Geometry: 22, "Geometry::Raise", "Shape" {
  ${array('Indexes', [1])}
  ${array('Vertices', [0,0.5,0])}
 }`;
  const animationObjects = !animation ? '' : `
 AnimationStack: 30, "AnimStack::Move", "" {
 }
 AnimationLayer: 31, "AnimLayer::Base", "" {
 }
 AnimationCurveNode: 32, "AnimCurveNode::T", "" {
 }
 AnimationCurve: 33, "AnimCurve::X", "" {
  ${array('KeyTime', [0,46186158000])}
  ${array('KeyValueFloat', [1,2])}
  ${array('KeyAttrFlags', [4,4])}
 }
 ${!morph ? '' : `AnimationCurveNode: 34, "AnimCurveNode::DeformPercent", "" {\n}\n AnimationCurve: 35, "AnimCurve::Weight", "" {\n ${array('KeyTime', [0,46186158000])}\n ${array('KeyValueFloat', [50,100])}\n }`}`;
  return `; FBX 7.4.0 independent rig fixture
FBXHeaderExtension: {
 FBXVersion: 7400
}
${settings}Objects: {
 Geometry: 1, "Geometry::Triangle", "Mesh" {
  ${array('Vertices', [0,0,0,1,0,0,0,1,0])}
  ${array('PolygonVertexIndex', [0,1,-3])}
 }
 Model: 2, "Model::Mesh", "Mesh" {
  Properties70: {
   ${vector('Lcl Translation', meshTranslation)}
   ${vector('GeometricTranslation', geometric)}
  }
 }
 Model: 3, "Model::Root", "LimbNode" {
 }
 Model: 4, "Model::Tip", "LimbNode" {
  Properties70: {
   ${vector('Lcl Translation', [1,0,0])}
  }
 }
 ${skinObjects}
 ${morphObjects}
 ${animationObjects}
 ${extraModel}
}
Connections: {
 C: "OO",1,2
 C: "OO",2,0
 C: "OO",3,0
 C: "OO",4,3
 ${!skin ? '' : 'C: "OO",10,1\n C: "OO",11,10\n C: "OO",12,10\n C: "OO",3,11\n C: "OO",4,12'}
 ${!morph ? '' : 'C: "OO",20,1\n C: "OO",21,20\n C: "OO",22,21'}
 ${!animation ? '' : 'C: "OO",31,30\n C: "OO",32,31\n C: "OP",32,4,"Lcl Translation"\n C: "OP",33,32,"d|X"'}
 ${!animation || !morph ? '' : 'C: "OO",34,31\n C: "OP",34,21,"DeformPercent"\n C: "OP",35,34,"d|X"'}
 ${extraConnections}
}
`;
}

export function readGLB(buffer) {
  const view = new DataView(buffer), jsonLength = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,jsonLength)));
  const bin = new Uint8Array(buffer,28+jsonLength);
  const sizes = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
  const accessor = index => {
    const a = doc.accessors[index], b = doc.bufferViews[a.bufferView], width = a.componentType === 5123 ? 2 : 4;
    const bytes = bin.slice((b.byteOffset??0)+(a.byteOffset??0),(b.byteOffset??0)+(a.byteOffset??0)+a.count*sizes[a.type]*width);
    return a.componentType === 5126 ? new Float32Array(bytes.buffer) : a.componentType === 5123 ? new Uint16Array(bytes.buffer) : new Uint32Array(bytes.buffer);
  };
  return {doc,bin,accessor};
}

export function transformAnimationFixture({path='Lcl Rotation',curves,pivot}={}) {
  const curveObjects=curves.map((curve,index)=>`AnimationCurve: ${43+index}, "AnimCurve::${curve.axis}", "" {\n ${array('KeyTime',curve.times.map(time=>Math.round(time*46186158000)))}\n ${array('KeyValueFloat',curve.values)}\n ${array('KeyAttrFlags',curve.values.map(()=>4))}\n}`).join('\n');
  const source=rigFixture({skin:false,morph:false,animation:false,geometric:[0,0,0],meshTranslation:[0,0,0],extraModel:`
 AnimationStack: 40, "AnimStack::Transform", "" {
 }
 AnimationLayer: 41, "AnimLayer::Base", "" {
 }
 AnimationCurveNode: 42, "AnimCurveNode::Transform", "" {
 }
 ${curveObjects}`,extraConnections:`C: "OO",41,40\n C: "OO",42,41\n C: "OP",42,2,"${path}"\n ${curves.map((curve,index)=>`C: "OP",${43+index},42,"d|${curve.axis}"`).join('\n ')}`});
  return pivot?source.replace(vector('GeometricTranslation',[0,0,0]),`${vector('GeometricTranslation',[0,0,0])}\n ${vector('RotationPivot',pivot)}`):source;
}

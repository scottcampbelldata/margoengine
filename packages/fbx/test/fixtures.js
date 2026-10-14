// FBX fixture writers: one record tree emitted as ASCII or binary (optionally zlib-compressed arrays).
import {deflateSync} from 'node:zlib';
export const L=v=>({L:BigInt(v)}),I=v=>({I:v}),A=(type,values)=>({array:type,values});
const flat=v=>typeof v==='string'?`"${v}"`:v.L!==undefined?String(v.L):v.I!==undefined?String(v.I):String(v);
export function ascii(nodes,depth=0){
  const pad='\t'.repeat(depth);let out=depth?'':'; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7400\n}\n';
  for(const [name,props=[],children=[]] of nodes){
    const array=props.find(p=>p?.array);
    if(array){out+=`${pad}${name}: *${array.values.length} {\n${pad}\ta: ${array.values.map(v=>String(v)).join(',')}\n${pad}}\n`;continue;}
    out+=`${pad}${name}: ${props.map(flat).join(',')}`+(children.length||props[0]?.L!==undefined&&depth===1?` {\n${ascii(children,depth+1)}${pad}}\n`:'\n');
  }
  return out;
}
export function binary(nodes,{compress=false,version=7400}={}){
  const wide=version>=7500,head=wide?25:13;
  const prop=v=>{
    if(typeof v==='string'){const m=/^(\w+)::(.*)$/s.exec(v),b=Buffer.from(m?`${m[2]}\0\x01${m[1]}`:v),h=Buffer.alloc(5);h[0]=83;h.writeUInt32LE(b.length,1);return Buffer.concat([h,b]);}
    if(v instanceof Uint8Array){const h=Buffer.alloc(5);h[0]=82;h.writeUInt32LE(v.length,1);return Buffer.concat([h,v]);}
    if(v.L!==undefined){const b=Buffer.alloc(9);b[0]=76;b.writeBigInt64LE(v.L,1);return b;}
    if(v.I!==undefined){const b=Buffer.alloc(5);b[0]=73;b.writeInt32LE(v.I,1);return b;}
    if(v.array){
      const width=v.array==='d'||v.array==='l'?8:4,raw=Buffer.alloc(v.values.length*width);
      v.values.forEach((x,i)=>v.array==='d'?raw.writeDoubleLE(x,i*width):v.array==='f'?raw.writeFloatLE(x,i*width):v.array==='l'?raw.writeBigInt64LE(BigInt(x),i*width):raw.writeInt32LE(x,i*width));
      const data=compress?deflateSync(raw):raw,h=Buffer.alloc(13);h[0]=v.array.charCodeAt(0);h.writeUInt32LE(v.values.length,1);h.writeUInt32LE(compress?1:0,5);h.writeUInt32LE(data.length,9);return Buffer.concat([h,data]);
    }
    const b=Buffer.alloc(9);b[0]=68;b.writeDoubleLE(v,1);return b;
  };
  function node([name,props=[],children=[]],offset){
    const text=Buffer.from(name),p=Buffer.concat(props.map(prop)),parts=[];let end=offset+head+text.length+p.length;
    for(const c of children){const part=node(c,end);parts.push(part);end+=part.length;}
    if(children.length){parts.push(Buffer.alloc(head));end+=head;}
    const h=Buffer.alloc(head);
    if(wide){h.writeBigUInt64LE(BigInt(end));h.writeBigUInt64LE(BigInt(props.length),8);h.writeBigUInt64LE(BigInt(p.length),16);}else{h.writeUInt32LE(end);h.writeUInt32LE(props.length,4);h.writeUInt32LE(p.length,8);}
    h[head-1]=text.length;return Buffer.concat([h,text,p,...parts]);
  }
  const header=Buffer.alloc(27);header.write('Kaydara FBX Binary  \0');header[21]=26;header.writeUInt32LE(version,23);
  const parts=[header];let offset=27;for(const n of nodes){const part=node(n,offset);parts.push(part);offset+=part.length;}
  parts.push(Buffer.alloc(head+160));return Buffer.concat(parts);
}
const P=(name,type,...values)=>['P',[name,type,'','A',...values]],props=(...p)=>['Properties70',[],p],arr=(name,type,values)=>[name,[A(type,values)]];
const C=(a,b,rel)=>['C',[rel?'OP':'OO',L(a),L(b),...rel?[rel]:[]]];
const model=(id,name,type,...p)=>['Model',[L(id),'Model::'+name,type],[['Version',[I(232)]],props(...p)]];
const T=(x,y,z)=>{const m=[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1];return m;};
/** A segments x segments quad grid (per-vertex normals and UVs, one Phong material), Y-up: the large-file case. */
export function grid(segments){
  const n=segments+1,vertices=[],normals=[],uvs=[],polygons=[];
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){vertices.push(x/segments*4-2,0.1*Math.sin(x*0.3)*Math.cos(y*0.2),y/segments*4-2);normals.push(0,1,0);uvs.push(x/segments,y/segments);}
  for(let y=0;y<segments;y++)for(let x=0;x<segments;x++){const a=y*n+x;polygons.push(a,a+n,a+n+1,~(a+1));}
  const layer=(name,values,key)=>[name,[I(0)],[['MappingInformationType',['ByVertice']],['ReferenceInformationType',['Direct']],arr(key,'d',values)]];
  return [['GlobalSettings',[],[['Version',[I(1000)]],props(P('UpAxis','int',I(1)),P('UnitScaleFactor','double',1))]],['Objects',[],[
    ['Geometry',[L(100),'Geometry::Grid','Mesh'],[arr('Vertices','d',vertices),arr('PolygonVertexIndex','i',polygons),layer('LayerElementNormal',normals,'Normals'),layer('LayerElementUV',uvs,'UV')]],
    model(200,'Grid','Mesh'),['Material',[L(300),'Material::Grey',''],[['ShadingModel',['phong']],props(P('Diffuse','Vector3D',0.7,0.7,0.7))]]]],
  ['Connections',[],[C(200,0),C(100,200),C(300,200)]]];
}
/** Hierarchy with pivots/pre/post rotation/inherit types, n-gons, layered attributes, two materials, a skin with BindPose, a blend shape and TRS animation, Z-up. */
export function rich({morphAnimation=false}={}){
  const pent=[[0,0,0],[2,0,0],[2,2,0],[1,1,0],[0,2,0]],quad=[[0,0,1],[1,0,1.2],[1,1,1],[0,1,1]],tri=[[0,0,2],[1,0,2],[0,1,2]],points=[...pent,...quad,...tri];
  const box=['Geometry',[L(100),'Geometry::Box','Mesh'],[
    arr('Vertices','d',points.flat()),arr('PolygonVertexIndex','i',[0,1,2,3,~4,5,6,7,~8,9,10,~11]),
    ['LayerElementNormal',[I(0)],[['MappingInformationType',['ByPolygonVertex']],['ReferenceInformationType',['Direct']],arr('Normals','d',points.flatMap((_,i)=>i<5?[0,0,2]:i<9?[0.1,0,1]:[0,0.2,0.9]))]],
    ['LayerElementUV',[I(0)],[['MappingInformationType',['ByPolygonVertex']],['ReferenceInformationType',['IndexToDirect']],arr('UV','d',[0,0,1,0,1,1,0,1,0.5,0.5]),arr('UVIndex','i',[0,1,2,4,3,0,1,2,3,0,1,3])]],
    ['LayerElementUV',[I(1)],[['MappingInformationType',['ByVertice']],['ReferenceInformationType',['Direct']],arr('UV','d',points.flatMap(p=>[p[0]/2,p[1]/2]))]],
    ['LayerElementColor',[I(0)],[['MappingInformationType',['ByVertice']],['ReferenceInformationType',['Direct']],arr('Colors','d',points.flatMap((_,i)=>[i/12,0.5,1-i/12,1]))]],
    ['LayerElementMaterial',[I(0)],[['MappingInformationType',['ByPolygon']],['ReferenceInformationType',['IndexToDirect']],arr('Materials','i',[0,1,0])]],
  ]];
  const strip=[[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,2,0],[1,2,0]];
  const skin=['Geometry',[L(400),'Geometry::Skin','Mesh'],[arr('Vertices','d',strip.flat()),arr('PolygonVertexIndex','i',[0,1,3,~2,2,3,5,~4]),
    ['LayerElementNormal',[I(0)],[['MappingInformationType',['ByVertice']],['ReferenceInformationType',['Direct']],arr('Normals','d',strip.flatMap(()=>[0,0,1]))]]]];
  const cluster=(id,name,indexes,weights,link)=>['Deformer',[L(id),'SubDeformer::'+name,'Cluster'],[['Version',[I(100)]],arr('Indexes','i',indexes),arr('Weights','d',weights),arr('Transform','d',T(0,0,0)),arr('TransformLink','d',link)]];
  const curve=(id,times,values)=>['AnimationCurve',[L(id),'AnimCurve::',''],[['Default',[0]],arr('KeyTime','l',times.map(t=>Math.round(t*46186158000))),arr('KeyValueFloat','f',values)]];
  const objects=[box,
    model(200,'Box','Mesh',P('RotationOrder','enum',I(4)),P('Lcl Translation','Lcl Translation',1,2,3),P('Lcl Rotation','Lcl Rotation',10,20,30),P('Lcl Scaling','Lcl Scaling',1,2,1),P('PreRotation','Vector3D',0,90,0),P('PostRotation','Vector3D',5,0,0),
      P('RotationPivot','Vector3D',0.5,0,0),P('ScalingPivot','Vector3D',0,0.5,0),P('RotationOffset','Vector3D',0.1,0,0),P('ScalingOffset','Vector3D',0,0,0.2),P('GeometricTranslation','Vector3D',0,0,1),P('GeometricRotation','Vector3D',0,0,45),P('GeometricScaling','Vector3D',2,1,1)),
    model(210,'Child','Null',P('InheritType','enum',I(1)),P('Lcl Translation','Lcl Translation',0,1,0),P('Lcl Rotation','Lcl Rotation',0,0,30)),
    model(220,'Grand Child','Null',P('InheritType','enum',I(2)),P('Lcl Translation','Lcl Translation',1,0,0),P('Lcl Scaling','Lcl Scaling',1,1,3)),
    ['Material',[L(300),'Material::Red',''],[['ShadingModel',['phong']],props(P('Diffuse','Vector3D',0.8,0.1,0.1),P('Shininess','double',50),P('TransparencyFactor','double',0.25))]],
    ['Material',[L(310),'Material::Green',''],[['ShadingModel',['lambert']],props(P('DiffuseColor','Color',0.1,0.6,0.2))]],
    skin,model(410,'SkinMesh','Mesh',P('Lcl Translation','Lcl Translation',0,0,-1)),
    model(500,'Hip','LimbNode',P('Lcl Translation','Lcl Translation',0,0.5,0)),model(510,'Knee','LimbNode',P('Lcl Translation','Lcl Translation',0,1,0),P('Lcl Rotation','Lcl Rotation',0,0,20)),
    model(520,'Toe','LimbNode',P('Lcl Translation','Lcl Translation',5,5,5)),
    ['Deformer',[L(600),'Deformer::Skin','Skin'],[['Version',[I(101)]]]],
    cluster(610,'Hip',[0,1,2,3,4],[1,1,0.6,0.5,0.2],T(0,0.5,-1)),cluster(620,'Knee',[2,3,4,5],[0.4,0.5,0.6,0],T(0,1.5,-1)),
    ['Pose',[L(700),'Pose::BIND_POSES','BindPose'],[['Type',['BindPose']],['NbPoseNodes',[I(1)]],['PoseNode',[],[['Node',[L(520)]],arr('Matrix','d',T(1,2.5,0))]]]],
    ['Deformer',[L(800),'Deformer::Morph','BlendShape'],[['Version',[I(100)]]]],
    ['Deformer',[L(810),'SubDeformer::Smile','BlendShapeChannel'],[['Version',[I(100)]],['DeformPercent',[0]],arr('FullWeights','d',[100])]],
    ['Geometry',[L(820),'Geometry::SmileShape','Shape'],[['Version',[I(100)]],arr('Indexes','i',[1,4]),arr('Vertices','d',[0,0,0.5,0.25,0,0]),arr('Normals','d',[0,0,1,0,0,1])]],
    ['AnimationStack',[L(900),'AnimStack::Take 001',''],[props(P('LocalStop','KTime',L(46186158000)))]],
    ['AnimationLayer',[L(910),'AnimLayer::BaseLayer','']],
    ['AnimationCurveNode',[L(920),'AnimCurveNode::T','']],['AnimationCurveNode',[L(930),'AnimCurveNode::R','']],['AnimationCurveNode',[L(940),'AnimCurveNode::S','']],
    curve(950,[0,0.5,1],[1,3,1]),curve(951,[0,1],[3,6]),curve(960,[0,1],[0,45]),curve(961,[0,0.25,1],[0,30,90]),curve(962,[0,1],[20,-40]),curve(970,[0,1],[1,2]),
  ];
  const links=[C(200,0),C(100,200),C(300,200),C(310,200),C(210,200),C(220,210),C(410,0),C(400,410),C(500,0),C(510,500),C(520,510),C(600,400),C(610,600),C(620,600),C(500,610),C(510,620),C(800,400),C(810,800),C(820,810),
    C(910,900),C(920,910),C(930,910),C(940,910),C(920,200,'Lcl Translation'),C(950,920,'d|X'),C(951,920,'d|Z'),C(930,510,'Lcl Rotation'),C(960,930,'d|X'),C(961,930,'d|Y'),C(962,930,'d|Z'),C(940,210,'Lcl Scaling'),C(970,940,'d|Y')];
  if(morphAnimation){objects.push(['AnimationCurveNode',[L(980),'AnimCurveNode::DeformPercent','']],curve(981,[0,1],[0,100]));links.push(C(980,910),C(980,810,'DeformPercent'),C(981,980,'d|DeformPercent'));}
  return [['GlobalSettings',[],[['Version',[I(1000)]],props(P('UpAxis','int',I(2)),P('UnitScaleFactor','double',1))]],['Objects',[],objects],['Connections',[],links]];
}

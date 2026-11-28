import {propertySet as pset,acousticLabel} from './door-values.mjs';

const number=(x)=>x.toFixed(7).replace(/0+\$/,'');
const txt=(value)=>"'"+value.replaceAll("'","''")+"'";
const tuple=entries=>'('+entries.join(',')+')';
const axes=([x,y,z])=>[x,-z,y];

const finishes={
  basalt:['Honed basalt',.19,.27,.29],paving:['Pale exposed concrete',.65,.68,.58],
  ivory:['Ivory lime plaster',.79,.76,.64], timber:['Oiled larch',.59,.36,.18],
  seam:['Deep larch end grain',.4,.24,.14], metal:['Blue powder coat',.12,.22,.27],
  glazing:['Cerulean laminated glass',.30,.49,.55], frost:['Acid-etched glazing',.49,.63,.65],
  bronze:['Phosphor bronze',.59,.44,.27], moss:['Sedum ground cover',.22,.36,.26],
  green:['Sage rushes',.32,.47,.31], paleGreen:['Young rushes',.48,.56,.31],
};

export function buildPavilion(makeGuid){
  const rows=[], doors=[];
  const add=(type,...parameters)=>{
    rows.push(type+tuple(parameters)+';');
    return '#'+rows.length;
  };
  const gid=()=>txt(makeGuid(rows.length));
  const root=(className,name,...fields)=>add(className,gid(),'$',txt(name),'$',...fields);
  const point=(p)=>add('IFCCARTESIANPOINT',tuple(p.map(number)));
  const direction=(d)=>add('IFCDIRECTION',tuple(d.map(number)));
  const up=direction([0,0,1]), x=direction([1,0,0]);
  const axis=(p,normal=up,reference=x)=>add('IFCAXIS2PLACEMENT3D',point(p),normal,reference);
  const zero=axis([0,0,0]);
  const profileCenter=add('IFCAXIS2PLACEMENT2D',point([0,0]),'$');
  const modelCtx=add('IFCGEOMETRICREPRESENTATIONCONTEXT','$',txt('Model'),'3','0.00001',zero,'$');
  const bodyCtx=add('IFCGEOMETRICREPRESENTATIONSUBCONTEXT',txt('Body'),txt('Model'),'*','*','*','*',modelCtx,'$','.MODEL_VIEW.','$');
  const unit=add('IFCSIUNIT','*','.LENGTHUNIT.','$','.METRE.');
  const scale=add('IFCUNITASSIGNMENT',tuple([unit]));
  const project=root('IFCPROJECT','Tern Garden Pavilion','$','$','$',tuple([modelCtx]),scale);
  const placement=(parent,p)=>add('IFCLOCALPLACEMENT',parent,axis(axes(p)));
  const siteP=placement('$',[0,0,0]);
  const site=root('IFCSITE','Tern Terrace','$',siteP,'$','$','.ELEMENT.','$','$','$','$','$');
  const buildingP=placement(siteP,[0,0,0]);
  const building=root('IFCBUILDING','Tern Garden Pavilion','$',buildingP,'$','$','.ELEMENT.','$','$','$');
  const ground=placement(buildingP,[0,0,0]);
  const level=root('IFCBUILDINGSTOREY','Pavilion floor','$',ground,'$','$','.ELEMENT.','0.');
  const aggregate=(host,part)=>add('IFCRELAGGREGATES',gid(),'$','$','$',host,tuple([part]));
  aggregate(project,site); aggregate(site,building); aggregate(building,level);
  const contained=[];
  const styles=Object.fromEntries(Object.entries(finishes).map(([key,[name,r,g,b]])=>{
    const colour=add('IFCCOLOURRGB','$',number(r),number(g),number(b));
    const shading=add('IFCSURFACESTYLESHADING',colour,'0.');
    return [key,add('IFCSURFACESTYLE',txt(name),'.BOTH.',tuple([shading]))];
  }));

  function shape(parts){
    const geometry=parts.map(({position:[px,py,pz],dimensions:[w,h,d],finish,along,round=false})=>{
      const profile=round
        ? add('IFCCIRCLEPROFILEDEF','.AREA.','$',profileCenter,number(w*.5))
        : add('IFCRECTANGLEPROFILEDEF','.AREA.','$',profileCenter,number(w),number(d));
      const extrusion=along?direction(axes(along)):up;
      const reference=along&&Math.abs(along[0])>.5?direction([0,1,0]):x;
      const body=add('IFCEXTRUDEDAREASOLID',profile,axis(axes([px,py,pz]),extrusion,reference),up,number(h));
      if(finish)add('IFCSTYLEDITEM',body,tuple([styles[finish]]),'$');
      return body;
    });
    const swept=add('IFCSHAPEREPRESENTATION',bodyCtx,txt('Body'),txt('SweptSolid'),tuple(geometry));
    return add('IFCPRODUCTDEFINITIONSHAPE','$','$',tuple([swept]));
  }
  const prism=(position,dimensions,finish,params={})=>({position,dimensions,finish,...params});
  const cut=(position,dimensions)=>prism(position,dimensions,undefined);
  function product(type,name,parts,at=[0,0,0],standard='.NOTDEFINED.'){
    const loc=placement(ground,at);
    const ref=root(type,name,'$',loc,shape(parts),'$',standard);
    contained.push(ref);
    return {ref,loc};
  }
  const dressing=(name,pieces)=>product('IFCBUILDINGELEMENTPROXY',name,pieces);
  const slab=(name,finish,at,dimensions,kind='.FLOOR.')=>product('IFCSLAB',name,[prism([0,0,0],dimensions,finish)],at,kind);
  const wall=(name,finish,at,dimensions)=>product('IFCWALL',name,[prism([0,0,0],dimensions,finish)],at);

  slab('Basalt foundation','basalt',[0,-.47,.44],[10.6,.25,7.10],'.BASESLAB.');
  slab('Cast terrace','paving',[0,-.23,.44],[10.23,.23,6.77]);
  wall('Plant room north return','ivory',[3.04,0,-1.76],[3.2,2.77,.19]);
  wall('Plant room east return','ivory',[4.53,0,-.26],[.185,2.77,3.1]);
  const entry=wall('Door gallery enclosure','ivory',[0,0,1.23],[9.18,2.78,.28]);
  for(const [tag,name,px,w,rating,selfClosing] of [
    ['D01','Garden entrance',-2.43,1.43,30,true],
    ['D02','Plant room',2.51,1.02,38,false],
  ]){
    const height=2.31;
    const openingPlacement=placement(entry.loc,[px,0,0]);
    const opening=root('IFCOPENINGELEMENT',name+' aperture','$',openingPlacement,shape([cut([0,0,0],[w+.035,height+.019,.66])]),'$','.OPENING.');
    add('IFCRELVOIDSELEMENT',gid(),'$','$','$',entry.ref,opening);
    const jambs = [prism([-w/2+.03,0,0],[.070,height,.238],'metal'),
      prism([w/2-.03,0,0],[.070,height,.238],'metal'),prism([0,height-.032,0],[w,.071,.24],'metal'),
      prism([0,0,0],[w,.028,.24],'bronze')];
    const fillColor=tag==='D01'?'glazing':'timber';
    const stile=w/2-.117;
    const leaf=[
      prism([-stile,.058,.004],[.113,height-.093,.083],'metal'),
      prism([stile,.058,.004],[.113,height-.093,.083],'metal'),
      prism([0,.06,.004],[w-.23,.154,.081],'metal'),
      prism([0,height-.253,.004],[w-.23,.215,.081],'metal'),
      prism([0,.211,.004],[w-.33,height-.462,.055],fillColor),
      prism([0,.35,.038],[w-.39,.041,.021],tag==='D01'?'frost':'seam'),
      prism([0,1.14,.038],[w-.39,.049,.021],tag==='D01'?'frost':'seam'),
      prism([0,1.91,.038],[w-.39,.041,.021],tag==='D01'?'frost':'seam'),
      prism([w/2-.153,.9,.065],[.037,.55,.027],'bronze'),
      prism([w/2-.153,.96,.05],[.024,.028,.080],'bronze'),
      prism([w/2-.153,1.38,.05],[.024,.028,.080],'bronze'),
    ];
    const local=placement(openingPlacement,[0,0,0]);
    const item=root('IFCDOOR',name,'$',local,shape([...jambs,...leaf]),txt(tag),number(height),number(w),'.DOOR.','.SINGLE_SWING_LEFT.','$');
    contained.push(item);
    add('IFCRELFILLSELEMENT',gid(),'$','$','$',opening,item);
    const prop1=add('IFCPROPERTYSINGLEVALUE',txt('AcousticRating'),'$','IFCLABEL('+txt(acousticLabel(rating))+')','$');
    const prop2=add('IFCPROPERTYSINGLEVALUE',txt('SelfClosing'),'$','IFCBOOLEAN('+(selfClosing?'.T.':'.F.')+')','$');
    const propertySet=add('IFCPROPERTYSET',gid(),'$',txt(pset),'$',tuple([prop1,prop2]));
    add('IFCRELDEFINESBYPROPERTIES',gid(),'$','$','$',tuple([item]),propertySet);
    doors.push({id:+item.slice(1),tag,x:px,y:0,z:1.23,width:w,height});
  }

  slab('Shade roof','metal',[0,2.942,.85],[9.19,.15,5.61],'.ROOF.');
  dressing('Roof nosing and raked fins',[
    prism([0,2.897,3.7],[9.41,.107,.153],'timber'),
    prism([-4.63,2.864,1.02],[.121,.102,5.35],'timber'),
    prism([4.63,2.864,1.02],[.121,.102,5.35],'timber'),
    ...Array.from({length:27},(_,i)=>prism([-4.46+.343*i,3.10,.84],[.129,.107,5.85],'timber')),
  ]);
  dressing('Perimeter rib columns',[-4.36,.49,4.34].flatMap(x=>[
    prism([x,0,3.29],[.17,2.969,.187],'timber'),prism([x,0,3.29],[.253,.19,.265],'metal'),
    prism([x,2.71,2.20],[.071,1.07,.082],'timber',{along:[0,.228,.974]}),
  ]));
  dressing('West privacy screen',Array.from({length:13},(_,i)=>
    prism([-4.25,0,-1.6+.215*i],[.093,2.78,.089],'timber')));
  dressing('Toplight transom',[
    prism([0,2.66,1.391],[8.76,.083,.071],'metal'),
    ...Array.from({length:14},(_,i)=>prism([-4.06+.624*i,2.734,1.394],[.035,.159,.058],'metal')),
    prism([0,2.747,1.365],[8.73,.138,.031],'frost'),
  ]);
  dressing('Terrace movement joints',[
    ...Array.from({length:8},(_,i)=>prism([-4.52+1.285*i,.0005,2.55],[.014,.007,2.57],'basalt')),
    ...[1.85,2.56,3.3].map(z=>prism([0,.0005,z],[9.01,.007,.015],'basalt')),
  ]);
  dressing('Garden benches',[-3.67,3.74].flatMap(x=>[
    prism([x,.431,2.15],[.91,.084,.355],'timber'),
    prism([x-.341,0,2.15],[.058,.431,.297],'metal'),
    prism([x+.341,0,2.15],[.058,.431,.297],'metal'),
  ]));
  dressing('Rain garden containers',[
    prism([-3.43,.008,3.75],[1.54,.208,.59],'basalt'),
    prism([3.5,.008,3.75],[1.52,.208,.59],'basalt'),
    prism([-3.43,.22,3.75],[1.42,.04,.48],'moss'),prism([3.5,.22,3.75],[1.41,.04,.48],'moss'),
    prism([4.9,.01,-.58],[.28,.2,2.44],'basalt'),prism([4.9,.215,-.58],[.22,.04,2.31],'moss'),
  ]);
  const grasses=[];
  for(const [centerX,centerZ,n] of [[-3.43,3.75,26],[3.5,3.75,26],[4.9,-.58,22]]){
    for(let i=0;i<n;i++){
      const angle=(i*2.39996324)%6.2831853;
      const vertical=.89, outward=Math.sqrt(1-vertical*vertical);
      const along=[outward*Math.cos(angle),vertical,outward*Math.sin(angle)];
      const center=centerX===4.9?[centerX+.07*Math.sin(i),.254,centerZ+(i/n-.5)*2.2]:
        [centerX+(i/n-.5)*1.325,.254,centerZ+.15*Math.sin(i*2.1)];
      grasses.push(prism(center,[.023,.154+.031*(i%7),.016],i%3?'green':'paleGreen',{along}));
    }
  }
  dressing('Feather reed planting',grasses);
  add('IFCRELCONTAINEDINSPATIALSTRUCTURE',gid(),'$','$','$',tuple(contained),level);
  const header = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');\n"+
    "FILE_NAME('tern-garden-pavilion.ifc','2026-11-27T00:00:00',('Margo Web Demos'),('Margo Web Demos'),'Margo Web Demos','Margo Web Demos','');\n"+
    "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
  return {file:header+rows.map((row,index)=>'#'+(index+1)+'='+row).join('\n')+'\nENDSEC;\nEND-ISO-10303-21;\n',doors};
}

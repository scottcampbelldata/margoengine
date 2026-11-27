const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const xyz = (x, y, z) => [x, -z, y]; // Engine axes to IFC coordinates.
const q = (value) => "'" + value.replaceAll("'", "''") + "'";
const number = (value) => Number.isInteger(value) ? value + '.' : String(value);
const list = (values) => '(' + values.join(',') + ')';

export function makeArchive(doorOverrides = {}) {
  const rows = [], display = new Map(), doorRecords = [];
  const step = (type, ...args) => {
    rows.push(type + '(' + args.join(',') + ');');
    return '#' + rows.length;
  };
  const guid = () => {
    let digits = '', n = 0x55c92c43a8ce4f52b31d5f54ee000000n + BigInt(rows.length);
    for (let i=0;i<22;i++,n>>=6n) digits = alphabet[Number(n & 63n)] + digits;
    return q(digits);
  };
  const root = (type, name, ...args) => step(type, guid(), '$', q(name), '$', ...args);
  const point = (...p) => step('IFCCARTESIANPOINT', list(p.map(number)));
  const zUp = step('IFCDIRECTION','(0.,0.,1.)'), xRight = step('IFCDIRECTION','(1.,0.,0.)');
  const axis = (p, normal=zUp) => step('IFCAXIS2PLACEMENT3D', point(...p), normal, xRight);
  const origin = axis([0,0,0]);
  const profileOrigin=step('IFCAXIS2PLACEMENT2D',point(0,0),'$');
  const context = step('IFCGEOMETRICREPRESENTATIONCONTEXT', '$', q('Model'), '3', '0.00001', origin, '$');
  const bodyCtx = step('IFCGEOMETRICREPRESENTATIONSUBCONTEXT', q('Body'), q('Model'), '*','*','*','*', context, '$', '.MODEL_VIEW.', '$');
  const units = step('IFCUNITASSIGNMENT', list([step('IFCSIUNIT','*','.LENGTHUNIT.','$','.METRE.')]));
  const relative = (parent, p) => step('IFCLOCALPLACEMENT',parent,axis(p));
  const base = relative('$',[0,0,0]);
  const project = root('IFCPROJECT','Kestrel Archive Annex','$','$','$',list([context]),units);
  const site = root('IFCSITE','Kestrel Terrace','$',base,'$','$','.ELEMENT.','$','$','$','$','$');
  const buildingBase = relative(base,[0,0,0]);
  const building = root('IFCBUILDING','Archive Annex','$',buildingBase,'$','$','.ELEMENT.','$','$','$');
  const storeyPlacement = [relative(buildingBase,[0,0,0]),relative(buildingBase,[0,0,3.4])];
  const storeys = storeyPlacement.map((placement,i) => root('IFCBUILDINGSTOREY',i?'Mezzanine':'Ground','$',placement,'$','$','.ELEMENT.',number(3.4*i)));
  const containment = [[],[]];
  const aggregate = (host,children) => step('IFCRELAGGREGATES',guid(),'$','$','$',host,list(children));
  aggregate(project,[site]); aggregate(site,[building]); aggregate(building,storeys);

  function representation(pieces) {
    const solids = pieces.map(([x,y,z,w,h,d,direction]) => {
      const profile = step('IFCRECTANGLEPROFILEDEF','.AREA.','$',profileOrigin,number(w),number(d));
      const placementNormal=direction?step('IFCDIRECTION',list(xyz(...direction).map(number))):zUp;
      return step('IFCEXTRUDEDAREASOLID',profile,axis(xyz(x,y,z),placementNormal),zUp,number(h));
    });
    const shape = step('IFCSHAPEREPRESENTATION',bodyCtx,q('Body'),q('SweptSolid'),list(solids));
    return step('IFCPRODUCTDEFINITIONSHAPE','$','$',list([shape]));
  }
  function register(ref,finish,hidden) {
    const id=Number(ref.slice(1));
    display.set(id,{finish,hidden});
    return {ref,id};
  }
  function object({type,name,tag,role,pieces,level=0,at=[0,0,0],finish,hidden=false}) {
    const shape = representation(pieces);
    const placement = relative(storeyPlacement[level],xyz(...at));
    const ref = root(type,name,'$',placement,shape,tag?q(tag):'$',role);
    containment[level].push(ref);
    return {...register(ref,finish,hidden),placement};
  }
  function unit(name,finish,pieces,level=0) {
    return object({name,finish,pieces,level,type:'IFCBUILDINGELEMENTPROXY',role:'.NOTDEFINED.'});
  }
  function structural(type,name,finish,piece,level=0,hidden=false,role='.NOTDEFINED.') {
    const at=piece.slice(0,3), dimensions=piece.slice(3);
    return object({type,name,finish,level,hidden,role,at,pieces:[[0,0,0,...dimensions]]});
  }
  const wall = (name,finish,piece,level,hidden=false) => structural('IFCWALL',name,finish,piece,level,hidden);
  const slab = (name,finish,piece,level,hidden=false,role='.FLOOR.') => structural('IFCSLAB',name,finish,piece,level,hidden,role);
  function door({tag,name,rating,selfClosing,w=1.05,level=0,x,z,host,hostCenter}) {
    const height=2.16, openingWidth=w+.1;
    const aperture=representation([[0,0,0,openingWidth,height+.05,.58]]);
    const placement=relative(host.placement,xyz(x-hostCenter[0],0,z-hostCenter[1]));
    const opening=root('IFCOPENINGELEMENT',name+' opening','$',placement,aperture,'$','.OPENING.');
    step('IFCRELVOIDSELEMENT',guid(),'$','$','$',host.ref,opening);
    const shape=representation([
      [0,.04,.015,w-.06,height-.04,.066],
      [0,.17,.055,w-.21,.77,.012],[0,1.15,.055,w-.21,.78,.012],
      [0,1.98,.060,w-.42,.065,.013],
      [-w/2+.018,0,0,.042,height+.032,.20],[w/2-.018,0,0,.042,height+.032,.20],
      [0,height-.01,0,w+.026,.045,.20],[0,0,0,w,.022,.24],
      [w/2-.16,1.02,.09,.14,.038,.071],
    ]);
    const doorPlacement=relative(placement,[0,0,0]);
    const ref = root('IFCDOOR', name,'$',doorPlacement,shape,q(tag),number(height),number(w),'.DOOR.','.SINGLE_SWING_LEFT.','$');
    step('IFCRELFILLSELEMENT',guid(),'$','$','$',opening,ref);
    const props = [];
    const override=doorOverrides[tag];
    if(override?.rating!==null&&rating)props.push(step('IFCPROPERTYSINGLEVALUE',q('FireRating'),'$', 'IFCLABEL('+q(override?.rating??rating)+')','$'));
    props.push(step('IFCPROPERTYSINGLEVALUE',q('SelfClosing'),'$', 'IFCBOOLEAN('+((override?.selfClosing??selfClosing)?'.T.':'.F.')+')','$'));
    const set = step('IFCPROPERTYSET',guid(),'$',q('Pset_DoorCommon'),'$',list(props));
    step('IFCRELDEFINESBYPROPERTIES',guid(),'$','$','$',list([ref]),set);
    containment[level].push(ref);
    const entry=register(ref,'door',false);
    doorRecords.push({id:entry.id,tag,x,y:level*3.4,z,level});
  }

  slab('Raised terrazzo foundation','plinth',[0,-.34,0,13.85,.2,9.55]);
  slab('Ground slab','stone',[0,-.14,0,12.8,.14,8.6]);
  slab('Mezzanine rear deck','stone',[0,-.19,-2.18,12.6,.19,4.17],1);
  slab('Mezzanine west balcony','stone',[-5.735,-.19,1.08,1.11,.19,2.45],1);
  slab('Roof slab','stone',[0,3.13,0,12.8,.22,8.6],1,true,'.ROOF.');
  for(const level of [0,1]) {
    wall('West brick spine','brick',[-6.23,0,0,.34,3.17,8.5],level);
    wall('East envelope','brick',[6.23,0,0,.34,3.17,8.5],level,true);
    wall('South envelope','brick',[0,0,4.07,12.16,3.17,.33],level,true);
    wall('North brick spine','brick',[0,0,-4.08,12.16,3.17,.30],level);
  }
  const base1=wall('Ground archive partition','lime',[1.76,0,-1.62,8.22,2.78,.23],0);
  const base2=wall('Mezzanine study partition','lime',[.7,0,-2.47,10.45,2.78,.24],1);
  door({tag:'G01',name:'Ground archive',rating:'EI30',selfClosing:true,x:-.57,z:-1.62,host:base1,hostCenter:[1.76,-1.62]});
  door({tag:'G02',name:'Ground intake',rating:'EI60',selfClosing:true,x:3.94,z:-1.62,host:base1,hostCenter:[1.76,-1.62]});
  door({tag:'M01',name:'Mezzanine study',rating:'EI60',selfClosing:false,w:.98,x:1.58,z:-2.47,level:1,host:base2,hostCenter:[.7,-2.47]});
  door({tag:'M02',name:'Rare books vault',rating:'EI60',selfClosing:true,x:-3.18,z:-2.47,level:1,host:base2,hostCenter:[.7,-2.47]});

  // Planters, joinery and shelving are separate IFC products. Their finish is display metadata.
  const brickDetails=[];
  for(let course=0;course<29;course++) {
    const y=course*.104+.038;
    brickDetails.push([0,y,-3.920,12.05,.012,.021],[-6.049,y,-.15,.021,.012,7.72]);
    for(let x=-5.8+(course%2)*.29;x<6.04;x+=.58) {
      brickDetails.push([x,y+.014,-3.920,.010,.083,.021]);
    }
  }
  for(const level of [0,1]) {
    unit('Recessed brick joints','mortar',brickDetails,level);
    unit('West reveal trim','oak',[[-5.969,2.5,0,.09,.055,7.71]],level);
    const beams=[];
    for(let x=-5.75;x<6;x+=1.73)beams.push([x,2.877,-3.77,.065,.225,.18]);
    unit('Ledge north corbels','stone',beams,level);
  }

  const stairHeight=3.4, treadCount=19, stepLength=.216, stairWidth=1.22;
  const treads=[], railPosts=[];
  for(let i=0;i<treadCount;i++){
    const z=3.98-(i+.5)*stepLength,y=(i+1)*stairHeight/treadCount;
    treads.push([-4.57,y-.092,z,stairWidth,.092,stepLength+.012]);
    if(i%3===0)railPosts.push([-3.979,y,z,.044,.96,.047],[-5.161,y,z,.044,.96,.047]);
  }
  unit('Stair treads','oak',treads);
  unit('Stair balusters','blackened',railPosts);
  const stairReturn=[], stairRise=stairHeight/treadCount;
  for(let i=0;i<treadCount;i++) {
    const z=3.98-(i+.5)*stepLength,y=(i+1)*stairRise;
    stairReturn.push([-4.998,y-.2,z,.088,.14,stepLength+.026],[-4.142,y-.2,z,.088,.14,stepLength+.026]);
  }
  unit('Stair stringers','blackened',stairReturn);
  const railHeight=1.012;
  const run=(treadCount-1)*stepLength, rise=(treadCount-1)*stairRise, length=Math.hypot(run,rise);
  const slope=[0,rise/length,-run/length];
  unit('Continuous stair handrails','oak',[-3.979,-5.161].map(x=>
    [x,stairRise+railHeight,3.98-.5*stepLength,.066,length,.053,slope]));
  const rail=[];
  for(let x=-5.53;x<6.04;x+=.22)if(x<-5.25||x>-3.84)rail.push([x,0,-.117,.025,.96,.026]);
  rail.push([1.08,.93,-.117,9.9,.066,.057],[-5.72,.93,-.117,.73,.066,.057]);
  rail.push([1.08,.22,-.117,9.9,.036,.032],[-5.72,.22,-.117,.73,.036,.032]);
  unit('Mezzanine guardrail','blackened',rail,1);

  for(const level of [0,1]) {
    const rack=[], spines=[];
    for(let j=0;j<4;j++) {
      const x=-4.1+j*2.75,z=level?-3.57:-3.53;
      rack.push([x-.91,0,z,.045,2.22,.59],[x+.91,0,z,.045,2.22,.59]);
      for(let y=.22;y<2.14;y+=.43) {
        rack.push([x,y,z,1.85,.046,.6]);
        for(let k=0;k<11;k++){
          const h=.17+(k%3)*.033;
          spines.push([x-.73+k*.144,y+.046,z+.1,.11,h,.34]);
        }
      }
    }
    unit('Archive shelving frames','oak',rack,level);
    unit('Document boxes','linen',spines,level);
    const tracks=[], pendants=[];
    for(const x of [-2.4,.4,3.24]) {
      tracks.push([x,2.94,-3.13,.023,.19,.028],[x,2.94,-2.69,.023,.19,.028]);
      pendants.push([x,2.961,-2.9,.34,.038,.63]);
    }
    unit('Archive pendant mounts','blackened',tracks,level);
    unit('Warm light diffusers','lamp',pendants,level);
  }
  unit('Ground reading station','oak',[
    [1.35,.79,2.09,2.65,.085,1.15],[.29,0,2.09,.075,.79,.92],[2.41,0,2.09,.075,.79,.92],
    [.89,.44,3.02,.54,.056,.46],[1.77,.44,3.02,.54,.056,.46],
    ...[.89,1.77].flatMap(x=>[-.196,.196].flatMap(dx=>[-.155,.155].map(dz=>[x+dx,0,3.02+dz,.049,.44,.049]))),
    [1.6,.88,2,.46,.034,.35],[.98,.88,1.89,.42,.024,.34],
  ]);
  unit('Partition datum bands','oak',[
    [1.76,2.734,-1.496,8.19,.044,.052],
    [-1.21,.048,-1.487,1.89,.071,.048],[1.69,.048,-1.487,3.38,.071,.048],[5.2,.048,-1.487,1.14,.071,.048],
  ]);
  unit('Mezzanine datum bands','oak',[
    [.7,2.734,-2.342,10.45,.044,.052],
    [-4.18,.048,-2.337,.7,.071,.048],[-.77,.048,-2.337,3.6,.071,.048],[4.08,.048,-2.337,3.65,.071,.048],
  ],1);
  unit('Terrazzo divider strips','mortar',[
    [0,.004,3.71,12.07,.009,.022],[0,.004,.98,12.07,.009,.022],
    [-2.24,.004,2.333,.022,.009,2.75],[4.71,.004,2.333,.022,.009,2.75],
  ]);
  for(let i=0;i<2;i++)step('IFCRELCONTAINEDINSPATIALSTRUCTURE',guid(),'$','$','$',list(containment[i]),storeys[i]);

  const file =
    'ISO-10303-21;\nHEADER;\n'+
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');\n"+
    "FILE_NAME('kestrel-archive.ifc','2026-11-27T00:00:00',('Margo Web Demos'),('Margo Web Demos'),'Margo Web Demos','Margo Web Demos','');\n"+
    "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"+
    rows.map((row,i) => '#'+(i+1)+'='+row).join('\n')+'\nENDSEC;\nEND-ISO-10303-21;\n';
  return {file,display,doorRecords};
}

const value = (simpleValue) => ({simpleValue});
const specification = (identifier,name,baseName,dataType,expected) => ({
  identifier,name,ifcVersion:['IFC4'],minOccurs:1,maxOccurs:'unbounded',
  applicability:[{facet:'entity',name:value('IFCDOOR')}],
  requirements:[{facet:'property',propertySet:value('Pset_DoorCommon'),baseName:value(baseName),
    dataType,value:value(expected),cardinality:'required'}],
});
export const delivery = {
  info:{title:'Archive Annex door information', version:'1.0', purpose:'Demonstrate two information requirements on a sample archive.'},
  specifications:[
    specification('ARCH-FR','Fire rating','FireRating','IFCLABEL','EI60'),
    specification('ARCH-SC','Self-closing','SelfClosing','IFCBOOLEAN','true'),
  ],
};

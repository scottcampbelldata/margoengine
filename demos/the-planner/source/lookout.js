import {axis,crisp,lathe,surface,workshop} from './geometry.js';
import {PbrMaterial} from '@margoengine/core';

export const stations={
  door:{at:[.02,1.32],yaw:-.46},
  stump:{at:[-1.69,.91],yaw:-1.68},
  rack:{at:[-1.95,-.55],yaw:Math.PI},
  stove:{at:[.60,-.48],yaw:-1.63},
  cot:{at:[2.04,-.704],yaw:.42},
};
const wood=['#806453','#8a705b','#93765c','#927058','#856c55','#9e8267'];
const stone=['#53646b','#5e6b6d','#475860','#6a7371','#5e6462'];
const conifer=['#385656','#3f6661','#43665e','#566f62'];
function rng(seed){
  return ()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/4294967296;
  };
}
function landscape(w){
  const {add,block,tube}=w,random=rng(341);
  // The stepped chip of stone beneath the lookout remains open at the front edge.
  const count=26;
  const base=Array.from({length:count},(_,i)=>{
    const a=i*Math.PI*2/count;
    return [Math.sign(Math.cos(a))*Math.abs(Math.cos(a))**.56*(3.86+.21*random()),
      Math.sign(Math.sin(a))*Math.abs(Math.sin(a))**.59*(2.94+.21*random())];
  });
  const bands=[[0,-.120],[.032,-.53],[-.082,-.94],[-.20,-1.35]];
  const corners=bands.map(([scale,y],layer)=>base.map(([x,z],i)=>
    [x*(1+scale),y+(layer?.078*Math.sin(i*2.62+layer*3.9):0),z*(1+scale)]));
  for(let band=0;band+1<bands.length;band++){
    const upper=corners[band],lower=corners[band+1];
    for(let i=0;i<count;i++){
      const j=(i+1)%count,p=[upper[i],upper[j],lower[i],lower[j]];
      add('Faceted ridge stratum',crisp(p,[0,1,2,1,3,2]),stone[(i+band*2)%stone.length]);
    }
  }
  const top=[[0,-.12,0],...base.map(([x,z])=>[x,-.12,z])];
  const faces=base.flatMap((_,i)=>[0,(i+1)%count+1,i+1]);
  add('Ridge shelf',crisp(top,faces),'#6b786e');
  const boulder=crisp([[-.79,0,-.41],[.69,0,-.49],[.87,0,.36],[-.535,0,.69],[-.56,.68,-.22],
    [.22,.85,-.35],[.55,.49,.48],[-.45,.49,.47],[0,1,0]],[0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,
      3,0,4,3,4,7,4,5,8,5,6,8,6,7,8,7,4,8]);
  for(let i=0;i<23;i++){
    const side=i<12?-1:1,x=side*(3.35+random()*.34),z=-2.7+5.3*random();
    const size=.09+random()*.21;
    add('Granite ledge stone',boulder,stone[i%stone.length],[x,-.122,z],[size,size*.78,size]).setRotation([0,random()*6.28,0]);
  }
  for(const [x,z,h] of [[-3.53,-.99,2.21],[-3.45,-2.33,3.05],[3.48,-2.38,2.45],[-2.83,-2.65,1.62],[3.38,-1.95,1.67]]){
    tube('Spruce trunk','#6c5845',[x,-.11,z],[x+.03,h,z],h*.019);
    for(let j=0;j<11;j++){
      const y=h*(.22+j*.071),r=h*(.183-j*.0129),phase=random()*Math.PI*2;
      const shape=surface(30,3,(u,v)=>{
        const a=u*Math.PI*2+phase,flutes=.82+.15*Math.cos(a*7+phase)+.06*Math.cos(a*13);
        return [Math.cos(a)*r*flutes*(1-v),h*.245*v-.057*Math.cos(a*7+phase)*(1-v),Math.sin(a)*r*flutes*(1-v)];
      });
      add('Needled spruce whorl',shape,conifer[(j+(j%3?0:1))%conifer.length],[x+.025*j/11,y,z]);
    }
  }
  // Continuous mountain profiles sit at different depths. Their lower faces remain muted through the valley.
  for(let layer=0;layer<4;layer++){
    const depth=-37+layer*6.2,crest=-2.82+layer*.12;
    const profile=surface(188,10,(u,v)=>{
      const x=(u-.5)*130,main=Math.pow(.5+.5*Math.sin(x*.152+1.12*layer),2.8)*3.18;
      const slope=Math.sin(x*.27+layer*2.10)*.74+Math.sin(x*.81+layer*.51)*.39+Math.sin(x*1.63)*.16;
      const summit=-2.49+crest+main+slope;
      return [x,-42+v*(summit+42),depth+v*(1.0+1.3*Math.sin(x*.27+layer))];
    });
    add('Blue-gray valley ridge',profile,['#677d85','#5a747f','#506e7a','#44636d'][layer]);
  }
}
function cabin(w){
  const {add,block,tube,sphere}=w;
  block('Exposed cutaway sill','#463e37',[0,-.095,0],[6.33,.254,4.73]);
  for(let i=0;i<22;i++){
    const p=(i-10.5)*.286;
    block('Quarter-sawn deck board',wood[i%wood.length],[p,.007,0],[.284,.095,4.52]);
    if(i%3!==1)block('Sawing streak','#79634f',[p+.050,.056,1.24-i%4*.25],[.009,.003,1.58]);
  }
  const riser=6.15;
  for(let i=0;i<4;i++){
    const x=-3+i*2;
    block('Stone-and-wood deck pier',stone[i],[x,-.23,1.76],[.28,.35,.39]);
  }
  for(let i=0;i<10;i++){
    const y=.16+i*.189,c=wood[(i+1)%wood.length];
    block('Lookout back siding west',c,[-1.907,y,-1.822],[2.26,.178,.15]);
    block('Lookout back siding east',c,[2.03,y,-1.822],[2.13,.178,.15]);
    if(i<5||i===9)block('Siding below and above rear lookout window',c,[.103,y,-1.822],[1.98,.178,.15]);
  }
  for(let i=0;i<6;i++)block('Left retaining wall siding',wood[(i+3)%wood.length],[-3.055,.12+.195*i,-1.04],[.136,.188,1.62]);
  for(const x of [-3.05,-.76,.963,3.045]){
    block('Oiled uprights','#544a3f',[x,1.07,-1.75],[.103,2.25,.14]);
    block('Chamfered upright shoulder','#a58a6b',[x+.022,1.06,-1.666],[.027,2.11,.020]);
  }
  block('Window sill','#aa9573',[.102,.995,-1.717],[1.858,.095,.283]);
  block('Window glazing bed','#56727b',[.103,1.387,-1.862],[1.71,.706,.021]);
  for(const x of [-.746,.101,.944])block('Glazing mullion','#a18967',[x,1.38,-1.739],[.053,.712,.105]);
  for(const y of [1.386,1.739])block('Glazing crossbar','#ac9370',[.105,y,-1.723],[1.70,.041,.075]);
  block('Visually solid rear roof header','#6b5846',[0,1.988,-1.709],[riser,.184,.22]);
  block('Glulam rear ring beam','#ad9169',[0,2.125,-1.53],[6.31,.147,.223]);
  const roofAngle=-.23;
  for(let i=0;i<22;i++){
    const x=(i-10.5)*.292;
    block('Standing seam rear roof','#537877',[x,2.487,-1.282],[.290,.106,1.70],.50).setRotation([roofAngle,0,0]);
    block('Narrow raised standing seam','#668b86',[x-.14,2.534,-1.271],[.018,.055,1.725],.58).setRotation([roofAngle,0,0]);
  }
  block('Cutaway roof end cap','#708f86',[0,2.683,-.493],[6.49,.075,.071],.58);
  block('Exposed roof cross beam','#895f46',[0,2.592,-.59],[6.49,.128,.125]);
  for(const x of [-3.125,-1.56,.02,1.58,3.125]){
    tube('Exposed roof tail','#745d49',[x,2.14,-2.12],[x,2.665,-.445],.052);
  }
  // Outer side step, wooden rail and a rear cross-brace are physically attached to the cutaway.
  block('Inspection step','#987b61',[2.76,-.083,2.31],[.84,.156,.335]);
  for(const x of [-3.08,-2.69,3.07]){
    block('Deck edge stanchion','#765942',[x,.44,1.98],[.075,.86,.080]);
  }
  block('Short safety rail','#a48464',[-2.86,.83,1.98],[.55,.070,.083]);
  for(const [x,y,z] of [[-2.97,1.66,-1.61],[2.23,1.59,-1.64],[-1.11,1.49,-1.64]]){
    block('Lantern plaque','#7c674f',[x,y,z],[.12,.17,.045]);
    add('Amber lantern glass',lathe([[.053,-.066],[.072,-.045],[.072,.048],[.051,.073]],12),
      '#f0bd78',[x,y,z+.087],[1,1,1],.46);
    add('Lantern cap',lathe([[.081,0],[.065,.035],[0,.042]],14),'#665044',[x,y+.068,z+.087]);
    block('Heat-safe lantern mount','#544f45',[x,y-.09,z+.047],[.150,.051,.16]);
  }
  for(const x of [.78,1.21])for(const z of [-1.46,-1.15])
    block('Camp prep bench leg','#6a5648',[x,.345,z],[.042,.61,.041]);
  block('End grain prep board','#b08e65',[.994,.667,-1.307],[.527,.055,.379]);
  block('Prep drawer front','#795e4b',[.994,.54,-1.135],[.49,.10,.028]);
  block('Prep drawer grip','#ad9a7c',[.989,.536,-1.109],[.094,.021,.026],.46);
  block('Enamel bread board','#909a78',[1.088,.695,-1.323],[.204,.026,.18],.80);
  const tin=lathe([[0,0],[.057,0],[.054,.15],[.060,.163],[0,.163]],19);
  add('Lidded provisions tin',tin,'#b69d77',[.846,.69,-1.390],[1,1,1],.65);
  add('Glazed herb jar',tin,'#81938a',[.967,.691,-1.388],[.8,.68,.81],.54);
  block('Bedside book ledge','#9b795d',[2.529,1.085,-1.602],[.85,.06,.23]);
  for(let i=0;i<6;i++)block('Logbook spine',['#876749','#59706c','#866053','#aba080'][i%4],
    [2.22+i*.10,1.21,-1.58],[.083,.23+i%3*.02,.13],.82).setRotation([0,0,(i-3)*.025]);
  const bowl=lathe([[0,-.049],[.095,-.049],[.153,.017],[.143,.019],[.082,-.036],[0,-.039]],28);
  add('Ceramic reading cup',bowl,'#c0ad8e',[2.78,1.177,-1.59],[.31,.63,.31],.47);
  add('Corner coat hook',sphere,'#bdb099',[2.943,1.397,-1.620],[.024,.027,.024],.59);
}
function workstations(w){
  const {add,block,paint,sphere,tube}=w;
  const [sx,sz]=[-2.30,.81];
  const stump=lathe([[.245,.055],[.253,.153],[.194,.436],[.191,.464]],15);
  add('Woodblock bark',stump,'#6e4c3c',[sx,0,sz]);
  add('Woodblock end grain',lathe([[.188,.462],[.180,.472],[0,.474]],26),'#c39b69',[sx,0,sz]);
  for(let i=1;i<6;i++){
    const r=i*.028;
    add('Seasonal growth band',lathe([[r,.475],[r-.0032,.476]],32),'#99734f',[sx,0,sz],[1,1,.968]);
  }
  const logShape=lathe([[.102,-.20],[.105,-.18],[.095,.184],[.099,.20]],13);
  const disks=lathe([[.101,.199],[.096,.204],[0,.204]],14);
  function log(name,x,y,z,yaw,ratio=1){
    const root=w.engine.createMesh().setPosition([x,y,z]).setRotation([Math.PI/2,0,yaw]).setScale([ratio,ratio,ratio]);
    root.name=name;
    add('Bark around roundwood',logShape,'#785441',[0,0,0],undefined,undefined,root);
    add('End grain of roundwood',disks,'#c69d70',[0,0,0],undefined,undefined,root);
    return root;
  }
  const unsplit=log('Roundwood on the block',sx,.550,sz,Math.PI/2,.77);
  const stacks=[];
  for(let i=0;i<4;i++)for(let j=0;j<3-i%2;j++){
    stacks.push(log('Sheltered stock',-2.50+j*.13,.23+i*.156,-1.337,i%3*.12,.65+.1*(i%2)));
  }
  for(const x of [-2.68,-1.999]){
    block('Covered rack post','#624c3e',[x,.445,-1.318],[.067,.78,.070]);
  }
  for(const y of [.14,.795])block('Covered rack brace','#8a6d53',[-2.34,y,-1.341],[.745,.074,.31]);
  block('Split-log cradle','#665445',[-2.45,.107,1.29],[.66,.112,.34]);
  const splitLogs=[log('Split piece one',-2.49,.21,1.31,1.35,.56),log('Split piece two',-2.28,.17,1.29,1.71,.54)];

  const [cx,cz]=[-.064,-.665];
  block('Raised stove hearth','#857268',[cx,.095,cz],[.77,.078,.84]);
  for(const x of [-.25,.24])for(const z of [-.237,.212]){
    block('Stove cast foot','#4d4b48',[cx+x,.155,cz+z],[.073,.14,.086]);
  }
  block('Black cast iron stove','#434749',[cx,.399,cz],[.57,.464,.532],.45);
  block('Ribbed exterior stove top','#5d5b55',[cx,.647,cz],[.628,.087,.57],.44);
  block('Stove flange','#524b45',[cx,.295,cz+.261],[.432,.23,.033],.58);
  const window=block('Heat glass','#524644',[cx,.303,cz+.283],[.332,.152,.014],.49);
  block('Stove handle','#a48a6e',[cx+.184,.335,cz+.314],[.090,.023,.049],.46);
  for(let i=0;i<5;i++)block('Cooling fin','#66574f',[cx-.214+i*.105,.188,cz+.265],[.044,.021,.034],.55);
  tube('Flue to rear roof','#554f48',[cx-.177,.669,cz-.161],[cx-.177,2.63,cz-.161],.082);
  const pot=lathe([[0,-.126],[.173,-.126],[.194,-.089],[.202,.067],[.192,.080],[.179,.079],[.168,-.116],[0,-.116]],32);
  add('Cast camp stew pot',pot,'#625e58',[cx+.074,.821,cz+.044],[1,1,1],.49);
  for(const x of [-.227,.225])block('Soldered side pot handle','#948871',[cx+.074+x,.848,cz+.046],[.107,.027,.088],.50);
  const meal=add('Stew surface',lathe([[.167,0],[0,.003]],28),'#c28a59',[cx+.074,.885,cz+.044],[1,1,1],.65);
  const steam=Array.from({length:8},(_,i)=>add('Convection above cooked supper',sphere,i%2?'#a6b3a9':'#bbbbb0',[cx,.93,cz],
    [.018,.06,.018],.96));

  const bed=[2.112,-.952];
  for(const x of [-.715,.715])for(const z of [-.315,.315]){
    block('Camp bed leg','#625547',[bed[0]+x,.208,bed[1]+z],[.092,.381,.096]);
  }
  block('Bolted camp bed slat frame','#887156',[bed[0],.399,bed[1]],[1.70,.125,.790]);
  block('Mattress ticking','#d9c6a0',[bed[0],.527,bed[1]],[1.585,.184,.756],.91);
  const quilt=surface(11,6,(u,v)=>[(u-.5)*1.30,.014*Math.sin(u*Math.PI*8)**2+.012*Math.sin(v*Math.PI*6)**2,(v-.5)*.732]);
  add('Quilted olive blanket',quilt,'#7a8c70',[bed[0]+.175,.626,bed[1]],[1,1,1],.95);
  add('Bedside pillow',sphere,'#dfcdb1',[bed[0]-.52,.648,bed[1]+.014],[.246,.094,.317],.91);
  block('Woven blanket front edge','#6a8067',[bed[0]+.167,.559,bed[1]+.372],[1.312,.119,.023],.90);
  for(let i=0;i<7;i++)block('Blanket weave seam','#82967c',[bed[0]-.473+i*.189,.620,bed[1]+.384],[.012,.108,.007]);
  return {
    update(state,now){
      unsplit.visible=state.fuelSource!=='wood';
      for(const wood of splitLogs)wood.visible=state.fuelSource==='wood';
      stacks.at(-1).visible=state.fuelSource!=='shelf';
      window.setMaterial(state.fire?paint('#df6e39',.45):paint('#524644',.49));
      meal.setMaterial(state.meal?paint('#d7a062',.65):paint('#655749',.63));
      for(const [i,parcel] of steam.entries()){
        const phase=(now*.62+i*.139)%1;
        parcel.visible=state.fire;
        if(parcel.visible)parcel.setPosition([cx+.076+.068*Math.sin(phase*7+i),.927+phase*.467,cz+.04+.051*Math.cos(i*2.2+phase*4)])
          .setScale([.011+.013*phase,.026+.041*phase,.011+.013*phase]);
      }
    },
  };
}
export function lookout(engine){
  const w=workshop(engine),{add,block,paint,sphere,rod}=w;
  landscape(w);cabin(w);
  const furniture=workstations(w);
  const rainMaterial=new PbrMaterial({color:'#819ca4',roughness:.85});
  const random=rng(6842);
  const drops=Array.from({length:61},(_,i)=>({x:6.9*random()-3.46,z:.02+2.8*random(),offset:random(),
    length:.10+random()*.17,mesh:add('Falling rain streak',rod,'#8ca6aa').setMaterial(rainMaterial)}));
  const puddles=Array.from({length:9},(_,i)=>add('Rain pooling on the porch',sphere,i%3?'#627e80':'#81918c',
    [-3.02+i*.68,.054,.80+.81*random()],[.17+.16*random(),.003,.041+.05*random()],.43));
  const path=Array.from({length:56},()=>block('Computed plan route marker','#ead2a5',[0,0,0],[.117,.011,.033]));
  function markRoute(vertices){
    let count=0;
    for(let i=0;i+1<vertices.length;i++){
      const a=vertices[i],b=vertices[i+1],dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);
      if(length<.02)continue;
      for(let d=.085;d<length-.055&&count<path.length;d+=.21){
        const segment=path[count++];
        segment.visible=true;
        segment.setPosition([a[0]+dx*d/length,.061,a[1]+dz*d/length]).setRotation([0,-Math.atan2(dz,dx),0]);
      }
    }
    for(let i=count;i<path.length;i++)path[i].visible=false;
  }
  function update(state,now){
    furniture.update(state,now);
    engine.scene.background=state.rain?'#465b68':'#687d85';
    engine.lighting.direction.set(state.rain?[-.42,.722,.52,2.16]:[-.47,.702,.54,3.22]);
    engine.lighting.radiance.set(state.rain?[.77,.88,1,.45]:[1,.87,.72,.34]);
    engine.lighting.ambient.set(state.rain?[.58,.72,.83]:[.53,.72,.80]);
    for(const mesh of puddles)mesh.visible=state.rain;
    for(const {mesh,x,z,offset,length} of drops){
      mesh.visible=state.rain;
      if(state.rain){
        const p=(offset+now*.98)%1,y=3.42-p*3.32;
        axis(mesh,[x+p*.34,y,z],[x+(p+.033)*.34,y-length,z+.03],.011);
      }
    }
  }
  return {w,markRoute,update};
}

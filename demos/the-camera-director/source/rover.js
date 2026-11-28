import {beveledBlock,disc,polygonMesh,profile,tau} from './geometry.js';

function tracks(shell,skin,plate,steel,painted){
  const {paint,mesh,block}=shell;
  const rubber=paint('#363534',.91),pad=paint('#4c4b43',.89),axle=paint('#626969',.47,1);
  const wheel=profile([[0,-.18],[.34,-.18],[.386,-.13],[.394,.13],[.354,.18],[0,.18]],32);
  const plateHub=disc(.248,0,.076,.025,24),boss=disc(.108,0,.047,.012,18);
  const wheels=[];
  for(const sign of [-1,1]){
    const track=mesh('Independent tracked running gear',undefined,undefined,[sign*.89,0,0],skin);
    mesh('Cast track drive beam',beveledBlock(.265,.36,2.63,.066),plate,[0,.52,0],track);
    for(const z of [-1.238,-.619,0,.619,1.238]){
      const link=mesh('Bogey wheel pivot',undefined,undefined,[0,.414,z],track);
      mesh('Solid rubber bogey wheel',wheel,rubber,undefined,link).setRotation([0,Math.PI/2,0]);
      mesh('Machined wheel hub',plateHub,steel,[sign*.169,0,0],link).setRotation([0,sign*Math.PI/2,0]);
      mesh('Axle spindle cap',boss,axle,[sign*.235,0,0],link).setRotation([0,sign*Math.PI/2,0]);
      for(let i=0;i<4;i++){
        const a=i*tau/4;
        block('Pressed bolt around hub',axle,[sign*.232,.155*Math.cos(a),.155*Math.sin(a)],[.059,.053,.053],link);
      }
      wheels.push(link);
    }
    const shoe=beveledBlock(.445,.052,.139,.019),small=beveledBlock(.424,.045,.101,.012),length=1.237;
    for(const y of [.827,.043])for(let j=-8;j<=8;j++){
      mesh('Molded track tread',shoe,(j%4===2)?rubber:pad,[0,y,j*.145],track);
    }
    for(const end of [-1,1])for(let i=0;i<9;i++){
      const a=((i+.5)/9)*Math.PI;
      const node=mesh('Track wrap round wheel',small,pad,[0,.435+.394*Math.cos(a),end*(length+.394*Math.sin(a))],track);
      node.setRotation([end*a,0,0]);
    }
    block('Folded track skirt flange',painted,[sign*.139,.959,0],[.19,.107,2.67],track);
  }
  return (distance)=>{for(const wheel of wheels)wheel.setRotation([distance/.394,0,0]);};
}

const digits={
  one:[[[.03,.09],[.11,.19]],[[.11,.19],[.11,-.20]],[[.01,-.20],[.21,-.20]]],
  two:[[[.00,.11],[.035,.19]],[[.035,.19],[.17,.19]],[[.17,.19],[.21,.13]],[[.21,.13],[.21,.068]],
    [[.21,.068],[.00,-.12]],[[.00,-.12],[.00,-.20]],[[.00,-.20],[.23,-.20]]],
};
function badge(face){
  const m=polygonMesh(),entries=digits[face];
  for(const [[ax,ay],[bx,by]] of entries){
    const d=Math.hypot(bx-ax,by-ay),w=.018,x=-(by-ay)*w/d,y=(bx-ax)*w/d;
    m.quad([ax+x,ay+y,0],[ax-x,ay-y,0],[bx-x,by-y,0],[bx+x,by+y,0]);
  }
  return m.geometry();
}
function lens(studio,root,shell,dark,glass){
  const {mesh,block,beam,paint}=studio,ceramic=paint('#b7bcb6',.57);
  const stalk=mesh('Collimating camera gimbal',undefined,undefined,[0,1.80,.99],root);
  mesh('Reinforced camera foot',beveledBlock(.39,.124,.47,.045),dark,undefined,stalk);
  beam('Camera mast',ceramic,[0,-.045,0],[0,.51,0],.11,.11,stalk);
  block('Folded camera yoke',dark,[0,.43,0],[.29,.116,.19],stalk);
  const head=mesh('Rover camera head',undefined,undefined,[0,.55,.066],stalk);
  mesh('Sealed camera housing',beveledBlock(.445,.335,.495,.056),shell,undefined,head);
  mesh('Primary optical lens bezel',disc(.136,.20,.29,.024,28),dark,[0,0,0],head);
  mesh('Recessed optical window',disc(.088,.27,.298,.011,27),glass,[0,0,0],head);
  for(const x of [-.153,.153])mesh('Side range receiver',disc(.035,0,.013,.003,13),glass,[x,-.059,.247],head);
  return head;
}
export function rover(studio,index){
  const {paint,mesh,block,beam,diskAt}=studio;
  const shell=paint(index?'#3d7c82':'#a64c2c',.59),lip=paint(index?'#87afa5':'#d99d63',.56);
  const steel=paint('#879191',.41,1),dark=paint('#363e42',.77),cream=paint('#d6cdb2',.66),glass=paint('#466472',.29);
  const rubber=paint('#4a4b47',.93);
  const root=mesh(index?'Surveyor Two':'Surveyor One');
  for(const [i,[color,x,z,dx,dz]] of [
    ['#ad9c83',1.34,1.83,.27,-.20],
    ['#a2947b',1.20,1.65,.15,-.11],
    ['#908470',1.09,1.54,.072,-.05],
  ].entries()){
    const base=disc(1,-.001,.002,.0006,44);
    diskAt('Contact darkening under the bogies',base,paint(color,.97),[dx,-.086+i*.003,dz],root).setScale([x,z,1]);
  }
  const roll=tracks(studio,root,dark,steel,shell);
  mesh('Load-bearing cast chassis',beveledBlock(1.71,.44,3.25,.14),dark,[0,.95,.023],root);
  mesh('Main stamped protective shell',beveledBlock(1.87,.61,3.12,.191),shell,[0,1.23,0],root);
  mesh('Ventilated upper instrument deck',beveledBlock(1.55,.15,2.91,.047),cream,[0,1.559,.06],root);
  mesh('Lower rolled nose fairing',beveledBlock(1.45,.306,.735,.12),lip,[0,1.17,1.26],root);
  mesh('Floating rubber bumper rail',beveledBlock(1.82,.196,.243,.057),rubber,[0,.857,1.725],root);
  mesh('Front sensor dark housing',beveledBlock(1.24,.276,.125,.035),dark,[0,1.341,1.551],root);
  for(const x of [-.383,.383]){
    mesh('Sealed glass beam guide',beveledBlock(.29,.102,.027,.009),cream,[x,1.329,1.625],root);
    block('Bumper eye guard',lip,[x*1.64,.857,1.833],[.13,.17,.056],root);
  }
  mesh('Nose navigation camera',disc(.092,0,.073,.015,27),steel,[0,1.35,1.61],root);
  mesh('Nose navigation glass',disc(.068,0,.023,.008,27),glass,[0,1.35,1.68],root);
  for(const x of [-1,1]){
    const side=mesh('Rover service panel',undefined,undefined,[x*.936,1.231,.344],root)
      .setRotation([0,x*Math.PI/2,0]);
    mesh('Recessed marked service hatch',beveledBlock(.59,.436,.046,.021),dark,undefined,side);
    mesh('Stencil panel number',badge(index?'two':'one'),cream,[-.103,0,.030],side);
    block('Hatch release handle',steel,[.192,.013,.033],[.058,.147,.040],side);
    for(const z of [-.82,-.58,.85,1.07])block('Cast attachment shoulders',lip,[x*.905,1.345,z],[.086,.114,.12],root);
  }
  const cage=paint('#687978',.52,1);
  if(index){
    const body=mesh('Tracked spectrometer carrier on rear deck',beveledBlock(1.21,.526,.97,.093),cream,[0,1.867,-.746],root);
    mesh('Spectrometer recessed face',beveledBlock(.701,.281,.059,.026),glass,[0,0,.491],body);
    for(const x of [-.37,.37])block('Optical case corner post',lip,[x,.02,.503],[.12,.28,.041],body);
    for(const x of [-.58,.58])beam('Spectrometer retention rail',cage,[x,1.67,-1.35],[x,2.17,-.36],.065,.061,root);
  }else{
    diskAt('Strongback sample carousel cover',disc(.487,0,.367,.038,45),cream,[0,1.672,-.625],root);
    diskAt('Carousel shock-isolation flange',disc(.524,0,.095,.026,45),dark,[0,1.629,-.625],root);
    for(let i=0;i<5;i++){
      const a=i*tau/5,x=.275*Math.cos(a),z=-.625+.275*Math.sin(a);
      diskAt('Small canister cap',disc(.098,0,.061,.016,22),lip,[x,2.039,z],root);
    }
  }
  const head=lens(studio,root,shell,dark,glass);
  beam('Flexible UHF whip',steel,[-.676,1.58,-1.186],[-.701,2.301,-1.25],.043,.043,root);
  diskAt('Amber vehicle radio indicator',disc(.076,0,.075,.019,24),lip,[-.677,1.608,-.65],root);
  const move=({point,yaw,distance},time)=>{
    root.setPosition(point).setRotation([0,yaw,0]);
    head.setRotation([-.065,Math.sin(.63*time+index)*.25,0]);
    roll(distance);
  };
  return {move,root};
}

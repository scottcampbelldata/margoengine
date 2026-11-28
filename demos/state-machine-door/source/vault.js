import {disc,marks,rim,studio,surrounds,tau,turning} from './geometry.js';

const h=1.385;
const shoulder=.972;


export function vault(engine){
  const {paint,solid,block}=studio(engine);
  engine.scene.background='#20282e';
  engine.lighting.direction.set([-.35,.58,.74,3.25]);
  engine.lighting.radiance.set([1,.91,.77,.52]);
  engine.lighting.ambient.set([.57,.69,.88]);
  const navy=paint('#394650',.89), slate=paint('#48545d',.86), joint=paint('#28333c',.94);
  const deep=paint('#192529',.83), blacksteel=paint('#394247',.59,.20);
  const steel=paint('#93a1a0',.34,.30), milled=paint('#aebbb9',.39,.25), gunmetal=paint('#657174',.48,.28);
  const bronze=paint('#99734b',.48,.40), bare=paint('#c3a477',.42,.32), ringDark=paint('#554333',.63,.29);
  const parchment=paint('#d4bc89',.58,.18), lightDark=paint('#4c4035',.55,.14);
  const lampWarm=paint('#ffd496',.55,.03);
  const lampCool=paint('#a2d9cf',.55,.02);
  const lampHold=paint('#fdb273',.49,.02);

  const architecture=solid('Cut stone vault elevation',undefined,undefined,[0,h,0]);
  solid('Rebated wall with a circular opening',surrounds(1.120,5,-h,3.35),navy,[0,0,-.030],architecture);
  for(const side of [-1,1]){
    const x=side*1.93;
    block('Dressed limestone pilaster',slate,[x,1.61,.006],[.48,3.19,.087]);
    block('Receding shaft of the pilaster',navy,[x,1.67,.065],[.337,2.78,.049]);
    for(const dx of [-.117,-.038,.04,.119]){
      block('Shadow line in vertical fluting',joint,[x+dx,1.63,.095],[.013,2.60,.012]);
    }
    for(const [y,w,z] of [[.13,.55,.075],[.228,.49,.067],[2.943,.52,.104],[3.022,.60,.091]]){
      block('Stepped pilaster moulding',slate,[x,y,z],[w,.082,.174]);
    }
    for(const y of [.34,.70,1.06,1.42,1.78,2.14,2.50,2.86]){
      const inside=1.129*Math.sqrt(Math.max(0,1-((y-h)/1.129)**2))+.019;
      block('Horizontal mortar reveal',joint,[side*(inside+1.64)/2,y,-.028],[1.64-inside,.010,.0035]);
      block('Sidewall limestone joint',joint,[side*3.20,y,-.028],[2.075,.010,.0035]);
    }
    for(const [y,w] of [[.065,1.14],[.144,1.02],[.184,.88]]){
      block('Stepped stone wall skirting',slate,[side*(1.20+w/2),y,.028],[w,.046,.133]);
    }
  }
  const border=solid('Bronze lines in the carved stone lintel',undefined,undefined,[0,2.805,.084]);
  block('Carved bronze lintel plate',deep,[0,0,0],[.894,.224,.089],border);
  for(const y of [-.088,.088])block('Fine bronze edge of lintel plate',bare,[0,y,.048],[.834,.012,.009],border);
  for(const x of [-.393,.393])block('Inset corner foliation',bronze,[x,0,.048],[.012,.164,.009],border);
  const deco=solid('Radial security-house insignia',undefined,undefined,[0,0,.050],border);
  solid('Insignia outline frame',rim(.065,.071,-.004,.005,.0015,44),bare,undefined,deco);
  solid('Insignia inner circle',rim(.037,.040,-.002,.005,.0009,44),bronze,undefined,deco);
  solid('Insignia rays',marks(.042,.062,.007,24,.028,3),parchment,undefined,deco);
  for(const x of [-.29,-.19,.19,.29]){
    block('Incised horizontal detail',bronze,[x,.026,.049],[.084,.009,.008],border);
    block('Incised horizontal detail',bronze,[x,-.026,.049],[.065,.006,.008],border);
  }
  const floor=['#363b3c','#424747','#434543','#393e3e','#484a47'].map(c=>paint(c,.92));
  const aisle=paint('#66675d',.89);
  for(let x=-4;x<=4;x++){
    for(let z=0;z<6;z++){
      const mat=x===0&&z<4?aisle:floor[((x+8)*3+z*7)%5];
      block('Sealed mineral floor panel',mat,[x*.63,-.034,z*.70+.28],[.624,.061,.693]);
    }
  }
  for(const x of [-.355,.355])block('Flush bronze threshold inlay',bronze,[x,-.0005,1.30],[.016,.006,2.56]);

  const tread=paint('#687476',.62,.15),risers=paint('#343d40',.74,.13),nosings=paint('#9c845e',.38,.31);
  for(const [index,front] of [1.02,.729,.420].entries()){
    const top=.156*(index+1),width=1.52-index*.105,back=-.052;
    block('Setback riser in cast threshold',risers,[0,top-.089,(front+back)/2],[width,.171,front-back]);
    block('Honed shallow tread',tread,[0,top-.010,(front+back)/2],[width+.020,.027,front-back+.026]);
    block('Threshold nosing in brass',nosings,[0,top-.012,front+.014],[width+.026,.023,.014]);
    for(const z of [-.078,-.039]){
      block('Machined antislip flute',blacksteel,[0,top+.006,front+z],[width-.135,.006,.012]);
    }
  }
  const collar=solid('Vault jamb with swept-throat profiles',undefined,undefined,[0,h,0]);
  solid('Stepped limestone portal edge',rim(1.113,1.232,-.041,.062,.021),slate,undefined,collar);
  solid('Forged jamb flange',rim(1.035,1.150,.016,.154,.021),gunmetal,undefined,collar);
  solid('Setback copper grip on the flange',rim(1.079,1.124,.142,.179,.010),bronze,undefined,collar);
  solid('Brushed inner landing',rim(.879,1.050,-.48,.146,.012),steel,undefined,collar);
  solid('Dark circular pressure gasket',rim(.878,.917,.099,.164,.014),deep,undefined,collar);
  solid('Forward narrow polished seat',rim(.928,.950,.139,.170,.006),milled,undefined,collar);
  solid('Fine bronze bead around the stonework',rim(1.193,1.204,.053,.073,.005),bare,undefined,collar);
  const plug=disc(.018,0,.012,.003,6), socket=disc(.0067,0,.003,.001,8);
  for(let i=0;i<28;i++){
    const a=(i+.5)*tau/28,pos=[1.10*Math.cos(a),1.10*Math.sin(a),.177];
    solid('Structural hex fastener around flange',plug,bare,pos,collar).setRotation([0,0,a]);
    solid('Recessed drive on flange fastener',socket,ringDark,[pos[0],pos[1],.189],collar);
  }
  for(let i=0;i<4;i++){
    const a=(i+.5)*tau/4;
    const keeper=solid('Strike bracket fixed to the vault jamb',undefined,undefined,undefined,collar)
      .setRotation([0,0,a]);
    block('Strike bracket mounting foot',blacksteel,[.969,0,.230],[.179,.143,.202],keeper);
    block('Bolt-stop outer wall',gunmetal,[.938,0,.333],[.066,.123,.071],keeper);
    for(const dy of [-.052,.052]){
      block('Brass reinforcement on the strike cheeks',bronze,[.929,dy,.365],[.080,.024,.028],keeper);
    }
  }
  const step=turning([[.89,-.49],[.904,-.64],[.882,-.66]],64);
  solid('Sloping throat beyond the jamb',step,deep,undefined,collar);

  const chamber=solid('Inner inspection chamber',undefined,undefined,[0,h,0]);
  const innerOn=paint('#a27957',.88,.04),innerOff=paint('#423b37',.92,.06);
  const vaultBack=solid('Interior radial bulkhead',disc(.987,-1.034,-1.004,.011),innerOff,undefined,chamber);
  solid('Interior brass framing',rim(.66,.846,-.99,-.966,.011),ringDark,undefined,chamber);
  const innerLitCopper=paint('#bb916a',.54,.30),innerDarkCopper=paint('#765741',.65,.31);
  const chamberTrim=[];
  for(const [radius,z] of [[.893,-.468],[.898,-.581],[.891,-.708],[.887,-.842], [.867,-.959]]){
    chamberTrim.push(solid('Turned band along the vault throat',rim(radius-.018,radius,z-.010,z+.007,.005),innerDarkCopper,undefined,chamber));
  }
  const landing=block('Inner chamber floor',innerOff,[0,-.696,-.553],[1.09,.10,.867],chamber);
  block('Louver panel below inspection lamp',blacksteel,[0,.012,-.964],[.61,.87,.047],chamber);
  block('Inspection console shelf',gunmetal,[0,-.501,-.860],[.91,.052,.226],chamber);
  for(let i=0;i<11;i++){
    const y=-.361+i*.067;
    block('Angled louver blade',i%2?gunmetal:steel,[0,y,-.907],[.560,.046,.056],chamber).setRotation([-.25,0,0]);
  }
  for(const x of [-.38,.38]){
    block('Brass upright in the chamber',bronze,[x,.028,-.914],[.039,.915,.060],chamber);
    for(const y of [-.57,.53])solid('Fastening in chamber',plug,bare,[x,y,-.91],chamber);
  }
  block('Recessed inspection-light housing',bronze,[0,.545,-.922],[.622,.116,.123],chamber);
  const apertureLamp=block('Inspection-light opal lens',lightDark,[0,.525,-.842],[.51,.053,.043],chamber);
  for(let i=0;i<9;i++){
    block('Raised tread on vault threshold',i%3?gunmetal:milled,[(i-4)*.090,.484,-.111],[.040,.02,.475]);
  }
  block('Doorway threshold cast foot',blacksteel,[0,.440,-.117],[1.19,.067,.12]);

  const pivot=solid('Vault hinge axis',undefined,undefined,[shoulder,h,.193]);
  const door=solid('Swinging vault leaf',undefined,undefined,[-shoulder,0,-.193],pivot);
  solid('Rebated steel door barrel',disc(.877,-.064,.268,.028),gunmetal,undefined,door);
  solid('Domed outside precision face',turning([[.862,.263],[.841,.298],[.806,.325],[.756,.332],[0,.335]]),milled,undefined,door);
  solid('Machined leaf inset ring',rim(.716,.751,.327,.347,.008),blacksteel,undefined,door);
  solid('Raised inner plate',disc(.704,.328,.351,.009),steel,undefined,door);
  solid('Bronze bolt-channel frame',rim(.480,.506,.356,.390,.009),bronze,undefined,door);
  solid('Axial fastener scale face',rim(.512,.713,.352,.361,.004),gunmetal,undefined,door);
  const brushedBright=paint('#9ba3a2',.40,.29),brushedDark=paint('#7d898a',.39,.31);
  for(const [index,radius] of [.566,.579,.593,.608,.622,.635,.647,.697,.702].entries()){
    solid('Concentric feed marks in steel annulus',rim(radius,radius+.0016,.360,.362,.0004,80),
      index%3===0?brushedBright:brushedDark,undefined,door);
  }
  solid('Near-black line separating the piston guide rails',rim(.447,.454,.350,.356,.0011),blacksteel,undefined,door);
  solid('Polished inner shoulder transition',rim(.465,.472,.350,.366,.0020),milled,undefined,door);
  solid('Engraved face graduations',marks(.655,.688,.362,84,.0029,7),parchment,undefined,door);
  solid('Rear pressure web',disc(.824,-.081,-.048,.009),blacksteel,undefined,door);
  solid('Rear toothed support ring',rim(.586,.794,-.106,-.073,.009),gunmetal,undefined,door);
  solid('Rear bronze inner wear band',rim(.40,.416,-.120,-.099,.006),bare,undefined,door);
  solid('Recessed cast rear stop',disc(.358,-.138,-.087,.013),steel,undefined,door);
  for(let i=0;i<16;i++){
    const a=i*tau/16;
    solid('Flush screws in the finished face',plug,bare,[.737*Math.cos(a),.737*Math.sin(a),.346],door);
    if(i%2)continue;
    const web=solid('Radial ribs on the inside of the leaf',undefined,undefined,[0,0,0],door).setRotation([0,0,a]);
    block('Central steel rear rib',gunmetal,[.506,0,-.123],[.378,.078,.077],web);
    block('Cast root of rear rib',steel,[.421,0,-.141],[.124,.118,.095],web);
  }

  const slides=[];
  for(let i=0;i<4;i++){
    const a=(i+.5)*tau/4;
    const axis=solid('Radial bolt housing',undefined,undefined,undefined,door).setRotation([0,0,a]);
    block('Bronze flanged bolt guide',bronze,[.655,0,.364],[.232,.142,.078],axis);
    block('Recessed open channel in bolt guide',blacksteel,[.677,0,.406],[.164,.067,.018],axis);
    block('Opaque spring cover over root of the guide',bare,[.573,0,.410],[.051,.137,.024],axis);
    const slide=solid('Retracting bolt slide',undefined,undefined,undefined,axis);
    const bolt=turning([[0,-.105],[.040,-.105],[.044,-.098],[.044,.222],[.036,.228],[0,.228]],22);
    solid('Radial polished bolt and tip',bolt,milled,[.670,0,.337],slide).setRotation([0,Math.PI/2,0]);
    block('Moving bolt tracer above the open channel',milled,[.693,0,.417],[.119,.048,.022],slide);
    block('Brass tracer cap',bare,[.737,0,.433],[.024,.054,.017],slide);
    slides.push(slide);
  }

  const wheel=solid('Mechanism flywheel',undefined,undefined,undefined,door);
  solid('Flywheel outer barrel',rim(.270,.309,.451,.525,.014),blacksteel,undefined,wheel);
  solid('Bronze handwheel outer profile',rim(.274,.302,.507,.538,.009),bare,undefined,wheel);
  solid('Darkened handgrip running round the wheel',rim(.291,.313,.485,.517,.009),bronze,undefined,wheel);
  solid('Machined hub of flywheel',disc(.115,.346,.532,.010),steel,undefined,wheel);
  solid('Inset burnished bronze cap',disc(.081,.520,.550,.007),bronze,undefined,wheel);
  solid('Hexagonal central spindle head',disc(.037,.546,.568,.004,6),milled,undefined,wheel);
  for(let i=0;i<5;i++){
    const a=i*tau/5;
    const spoke=solid('Handwheel spoke assembly',undefined,undefined,undefined,wheel).setRotation([0,0,a]);
    block('Sculpted steel wheel spoke',milled,[.188,0,.500],[.190,.045,.045],spoke);
    block('Bronze spoke inlay',bronze,[.195,0,.526],[.126,.014,.011],spoke);
    solid('Raised outer handwheel shoulder',plug,bare,[.287,0,.538],spoke);
  }
  const driveHand=solid('Bronze bolt-position pointer',undefined,undefined,undefined,door);
  block('Offset bolt-position pointer',parchment,[.595,0,.378],[.068,.021,.018],driveHand);

  const shaft=disc(.102,-.166,.166,.013,36);
  for(const y of [-.529,.529]){
    block('Fixed hinge strap anchor',blacksteel,[.999,h+y,.187],[.238,.165,.106]);
    block('Fixed machined hinge mounting flange',gunmetal,[1.041,h+y,.245],[.189,.136,.083]);
    solid('Fixed barrel with upper and lower cheeks',shaft,steel,[shoulder,h+y,.192]).setRotation([Math.PI/2,0,0]);
    for(const dy of [-.142,.142]){
      solid('Bearing cap',disc(.109,-.013,.013,.006,38),bronze,[shoulder,h+y+dy,.192]).setRotation([Math.PI/2,0,0]);
    }
    block('Pivoted flange carried by door',steel,[-.116,y,-.010],[.232,.129,.132],pivot);
    for(const dy of [-.047,.047])solid('Socket bolt in hinge flange',plug,bare,[1.080,h+y+dy,.286]);
  }

  const panel=solid('Local inspection plate assembly',undefined,undefined,[-1.48,h,.088]);
  block('Control plate mounting base',blacksteel,[0,0,0],[.241,.691,.071],panel);
  block('Unlacquered copper control plate',bronze,[0,0,.044],[.190,.633,.036],panel);
  block('Inset enamel face',deep,[0,.004,.069],[.158,.544,.018],panel);
  const bez=disc(.040,0,.015,.004,32), pilot=disc(.027,0,.023,.006,32);
  for(const y of [.157,-.021,-.192])solid('Recessed pilot light bezel',bez,bare,[0,y,.079],panel);
  const lit=solid('Physical green power pilot',pilot,lampCool,[0,.157,.092],panel);
  const inspection=solid('Physical inspection lamp telltale',pilot,lightDark,[0,-.021,.092],panel);
  const held=solid('Physical hold condition pilot',pilot,lightDark,[0,-.192,.092],panel);
  for(const y of [-.293,.293])solid('Oval control plate screw',plug,milled,[0,y,.062],panel);

  let previousLight,previousHold;
  function pose({bolt,angle,light},paused){
    pivot.setRotation([0,angle*Math.PI/180,0]);
    wheel.setRotation([0,0,(1-bolt)*.86]);
    driveHand.setRotation([0,0,2.11+(1-bolt)*.68]);
    for(const slide of slides)slide.setPosition([-(1-bolt)*.148,0,0]);
    if(light!==previousLight){
      apertureLamp.setMaterial(light?lampWarm:lightDark);
      inspection.setMaterial(light?lampWarm:lightDark);
      vaultBack.setMaterial(light?innerOn:innerOff);
      landing.setMaterial(light?innerOn:innerOff);
      for(const band of chamberTrim)band.setMaterial(light?innerLitCopper:innerDarkCopper);
      previousLight=light;
    }
    if(paused!==previousHold){
      lit.setMaterial(paused?lightDark:lampCool);
      held.setMaterial(paused?lampHold:lightDark);
      previousHold=paused;
    }
  }
  return {pose};
}

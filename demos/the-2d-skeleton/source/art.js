import { width,height } from './rig.js';

function artCanvas(w,h){
  const node=document.createElement('canvas');
  node.width=w;node.height=h;
  return node;
}
function p(c,path,fill,line=null,w=1){
  const form=new Path2D(path);
  if(fill){c.fillStyle=fill;c.fill(form);}
  if(line){c.strokeStyle=line;c.lineWidth=w;c.lineJoin='round';c.lineCap='round';c.stroke(form);}
}
function circle(c,x,y,r,fill){
  c.fillStyle=fill;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();
}
function ellipse(c,x,y,rx,ry,fill){
  c.fillStyle=fill;c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fill();
}
function rect(c,x,y,w,h,fill){c.fillStyle=fill;c.fillRect(x,y,w,h);}
function gradient(c,x0,y0,x1,y1,colors){
  const g=c.createLinearGradient(x0,y0,x1,y1);
  for(const [position,color] of colors)g.addColorStop(position,color);
  return g;
}
function bloom(c,x,y,r,stops){
  const g=c.createRadialGradient(x,y,0,x,y,r);
  for(const [position,color] of stops)g.addColorStop(position,color);
  circle(c,x,y,r,g);
}
function hash(index){
  const a=Math.sin(index*93.521+14.51)*48869.442;
  return a-Math.floor(a);
}

function leaf(c,x,y,length,angle,mid,tip,vein,lean=0){
  c.save();c.translate(x,y);c.rotate(angle);
  let g=gradient(c,-length*.22,0,length*.12,-length*.86,[[0,mid],[1,tip]]);
  p(c,`M0 1 C ${-length*.27} ${-length*.25} ${-length*.22} ${-length*.60} ${lean} ${-length} C ${length*.26+lean} ${-length*.69} ${length*.33} ${-length*.32} 0 1Z`,g);
  p(c,`M0 -1 Q ${length*.12+lean} ${-length*.58} ${lean} ${-length*.94}`,null,vein,1);
  c.restore();
}

function plant(c,x,y,s,seed,palette){
  const [base,tip,vein]=palette;
  for(let i=0;i<7;i++){
    const direction=(i-3)*.235,reach=s*(.62+hash(i+seed)*.51);
    const tx=x+Math.sin(direction)*reach,ty=y-Math.cos(direction)*reach;
    const bend=x+(tx-x)*.60;
    p(c,`M${x} ${y} Q${bend} ${y-reach*.33} ${tx} ${ty}`,null,vein,1.45);
    for(let j=1;j<=4;j++){
      const f=j/5,px=x+(tx-x)*f*.89,py=y+(ty-y)*f;
      const long=reach*(.34-f*.14);
      leaf(c,px,py,long,direction-.70,base,tip,vein,-4);
      leaf(c,px,py,long*.95,direction+.80,base,tip,vein,3);
    }
    leaf(c,tx,ty+8,reach*.31,direction,base,tip,vein);
  }
}

function drawGlasshouse(){
  const canvas=artCanvas(width,height),c=canvas.getContext('2d');
  rect(c,0,0,width,height,gradient(c,0,0,0,height,[[0,'#17232d'],[.55,'#25444b'],[1,'#1f3038']]));
  p(c,'M125 510V287C125 132 268 50 407 46H679C824 46 956 159 956 292V510Z',
    gradient(c,590,20,635,534,[[0,'#2a3945'],[.56,'#3d6768'],[1,'#5e7972']]));
  bloom(c,740,179,205,[[0,'#d4c58f55'],[.5,'#c5bda82c'],[1,'#bfc7a400']]);
  circle(c,745,165,90,'#a8b5a159');
  circle(c,745,165,77,'#e2d8ae');
  circle(c,745,165,70,'#e7dcaf');
  circle(c,761,150,60,'#eee0ba');
  const haze=gradient(c,0,163,0,447,[[0,'#6588891d'],[.6,'#8da29655'],[1,'#819b8266']]);
  for(let i=0;i<8;i++){
    const y=194+i*29,drift=hash(i+461)*140;
    p(c,`M137 ${y+35} C250 ${y+9} 357 ${y+27} 526 ${y+18}
      S${740+drift} ${y-12} 945 ${y+22} V${y+65}
      C679 ${y+47} 477 ${y+57} 137 ${y+80}Z`,haze);
  }
  for(let i=0;i<44;i++){
    const x=144+hash(i*11+20)*788,y=190+hash(i*5+77)*299,h=18+hash(i*9+51)*93;
    leaf(c,x,y,h,i%2?.37:-.55,'#476f68a8','#779083a6','#587c7399',Math.sin(i)*12);
  }
  const glass=gradient(c,0,90,0,515,[[0,'#b5c8b412'],[.45,'#c0d1ac01'],[1,'#91c1b548']]);
  for(const [a,b] of [[180,222],[235,302],[330,412],[460,520],[564,647],[706,752],[793,852],[873,934]]){
    p(c,`M ${a} 498 L${a} 162 L${b} 89 L${b} 498Z`,glass);
  }
  const arch='M109 503 V288 C109 135 251 31 412 32 H676 C836 32 969 150 969 291 V503';
  p(c,arch,null,'#1c3440',26);p(c,arch,null,'#82765c',3.7);
  p(c,'M135 508 V296C135 152 272 58 413 58H675C818 58 940 158 940 297V508',null,'#294b50',10);
  p(c,'M136 508 V296C136 151 271 57 413 57H674C818 57 941 156 941 297V508',null,'#91a29280',1.1);
  for(const x of [241,346,452,559,666,773,879]){
    const dy=67+Math.round(Math.abs(x-544)*.18)+Math.round((x-550)**2*.00052);
    p(c,`M${x} ${dy} V495`,null,'#315358',8);
    p(c,`M${x+4} ${dy} V495`,null,'#a7b6a572',1.4);
    for(const y of [228,334,430]){
      circle(c,x,y,6,'#34504d');circle(c,x,y,2.4,'#b9a779');
    }
  }
  for(const y of [224,328,426,493]){
    p(c,`M143 ${y}H934`,null,'#315357',7);
    p(c,`M143 ${y-3}H934`,null,'#a8b29f83',1.2);
  }
  p(c,'M167 490 V286Q188 208 241 176Q278 132 347 102Q397 77 452 76H665Q778 99 877 192Q915 224 920 279V491',null,'#8f9d7770',1.3);
  for(const [a,b,y] of [[241,346,224],[346,452,224],[452,559,224],[559,666,224],[666,773,224],[773,879,224]]){
    p(c,`M${a} ${y}Q${(a+b)*.5} ${y-55} ${b} ${y}`,null,'#9faa8856',1.8);
  }
  rect(c,0,484,width,156,gradient(c,0,482,0,640,[[0,'#3e5756'],[.38,'#3b4c4c'],[1,'#273c44']]));
  p(c,'M0 487 H1080 M0 494 H1080 M0 512 H1080 M0 536 H1080 M0 572 H1080 M0 624H1080',null,'#77817693',1.4);
  const seams=['#92978151','#242f36a3'];
  for(let i=-8;i<=9;i++){
    const x=545+i*68;
    p(c,`M${x} 482 L${539+i*146} 640`,null,seams[(i+8)%2],1.35);
  }
  p(c,'M309 520 H781 L901 640 H190Z', '#718a7231');
  p(c,'M344 523 H737 L829 640 H251Z', '#65857a4d','#b9bc9455',2);
  for(const side of [-1,1]){
    const x=541+side*395;
    p(c,`M${x-41} 513 V423 H${x+43} V513`,null,'#879381',4.5);
    p(c,`M${x-52} 423H${x+53}`,null,'#c0a276',2.4);
    for(let i=-2;i<=2;i++){
      const a=x+i*17;
      p(c,`M${a} 427 C${a-9} 436 ${a-7} 477 ${a} 492C${a+7} 474 ${a+8} 440 ${a} 427Z`,null,'#798c78',1.20);
    }
  }
  plant(c,171,458,101,11,['#375f58','#77927a','#82927b']);
  plant(c,898,474,134,12,['#325a55','#78917c','#819677']);
  plant(c,930,512,106,37,['#264744','#54715e','#5d7d67']);
  for(const [x,y,w,h] of [[171,466,56,62],[902,484,64,56],[930,521,53,45]]){
    p(c,`M${x-w/2} ${y} Q${x} ${y+7} ${x+w/2} ${y} L${x+w*.36} ${y+h}
      Q${x} ${y+h+10} ${x-w*.34} ${y+h}Z`,gradient(c,x-w/2,y,x+w/2,y+h,[[0,'#966b59'],[.52,'#685252'],[1,'#4b3d46']]));
    ellipse(c,x,y,w*.53,6,'#a6876f');
    ellipse(c,x,y+1,w*.42,4,'#4d4247');
    ellipse(c,x,y+h,w*.27,3,'#82695b');
  }
  plant(c,24,626,219,91,['#1c3438','#355953','#3a5750']);
  plant(c,1041,645,226,23,['#182f37','#33544d','#36574e']);
  plant(c,-18,596,150,52,['#192d33','#3a5250','#2a4241']);
  plant(c,1083,611,150,141,['#192d33','#405b53','#36534b']);
  const corner=c.createRadialGradient(553,317,300,553,317,644);
  corner.addColorStop(0,'#101a2500');corner.addColorStop(1,'#0c1726b0');
  rect(c,0,0,width,height,corner);
  for(let i=0;i<1175;i++){
    const x=hash(i+229)*width,y=hash(i*1.31+71)*height;
    rect(c,x,y,hash(i*.9+44)*2.4+.45,hash(i*3+30)*1.2+.25,i%2?'#d6ccb10a':'#1016221c');
  }
  return canvas;
}

const parts=[
  ['silk',174,79,162,20],
  ['far_boot',83,109,30,4],['near_boot',83,109,30,4],
  ['far_shoulder',56,90,28,13],['far_forearm',48,79,24,14],['far_glove',44,57,21,15],
  ['hem',153,94,74,14],['coat',156,144,73,62],['face',114,112,44,83],
  ['knot',100,48,36,19],
  ['near_shoulder',62,95,29,15],['near_forearm',52,82,26,14],
  ['lantern',90,96,45,13],['near_glove',49,58,22,12],
];

function boot(c,near){
  p(c,'M-20 -3 L22 -3C21 16 19 42 15 62L15 75L36 83C43 86 45 92 41 97H-22C-29 95-32 89-24 80L-23 57Z',
    gradient(c,-22,0,24,94,[[0,near?'#4c6870':'#3a4e58'],[.55,near?'#3c555d':'#30434d'],[.73,'#382e39'],[1,'#473942']]),'#272e38',2.7);
  p(c,'M-19 60Q-4 64 17 61M-20 68Q-5 74 15 69',null,near?'#8b8270':'#696257',2);
  p(c,'M-20 90C-4 86 13 91 40 89M-6 25L-12 50L-9 58',null,near?'#8c766e':'#72645c',1.6);
  p(c,'M-19 96H40',null,'#171e29',3);
  for(let i=0;i<5;i++)circle(c,0,75+i*2,1.05,'#ad8670');
}

function arm(c,near,fore){
  const tone=near?'#467477':'#31515d',shade=near?'#244853':'#283e4e',lip=near?'#7f9a8c':'#54726d';
  if(!fore){
    p(c,'M-20 -2 C-12 -16 7 -15 19 -6C31 13 23 44 17 65 C8 76-10 76-18 64 C-20 45-25 13-20 -2Z',
      gradient(c,-26,0,18,61,[[0,lip],[.44,tone],[1,shade]]),'#1e3a45',2.4);
    p(c,'M-17 11 C-7 1 7 1 17 4 M-19 36Q-12 48-11 59 M13 18Q21 29 18 47',null,lip,1.75);
    p(c,'M-13 64Q0 71 15 65',null,'#849a875a',1.5);
  }else{
    p(c,'M-18 6Q-15-11 0-12Q16-12 19 3C20 24 16 39 13 62Q-2 70-15 60Q-17 40-18 6Z',
      gradient(c,-16,5,15,62,[[0,lip],[.40,tone],[1,shade]]),'#243a48',2.3);
    p(c,'M-13 52Q0 58 13 52L13 61Q-2 67-14 61Z',near?'#776e60':'#666360');
    p(c,'M-12 55Q2 60 13 55M-12 9Q-7 23-9 37',null,near?'#cfad83':'#9a8d79',1.55);
    for(let i=0;i<3;i++)circle(c,7+i*1.8,54+i,1.35,'#d1b58a');
  }
}

function hand(c,near){
  p(c,'M-12 -3 Q-7 -12 4 -10 Q15-7 14 4L15 10Q20 11 17 19L14 24L8 28L-2 27 Q-12 25 -15 15Q-16 6-12-3Z',gradient(c,-13,-8,16,24,[[0,near?'#c2906a':'#a47860'],[.65,'#9a6551'],[1,'#6b4b4a']]),'#4d3c45',1.9);
  p(c,'M9 2Q14 7 10 14L6 18M2 20L8 22M-10 6L-8 16L-4 20',null,'#e1a87b',1.2);
  p(c,'M-10 -3 Q0-6 10-1',null,'#e6b286',1.4);
}

function hem(c){
  p(c,'M-49 -9H46L59 60Q48 74 28 69L1 65L-34 72Q-56 69-65 58Z',
    gradient(c,-60,5,54,69,[[0,'#3d6870'],[.44,'#345662'],[1,'#1e3948']]),'#203a45',2.6);
  p(c,'M-39 -4L-48 48L-54 58M-22 2L-29 25L-27 53M18 1L25 40L25 58M38 1L44 42L50 58',null,'#83a29488',1.9);
  p(c,'M-57 57Q-36 62-18 59L1 54L24 59Q46 67 56 60',null,'#a6ac8e94',1.6);
  p(c,'M1 11L-5 52L2 65',null,'#203b44',2);
}

function coat(c){
  p(c,'M-44 -42Q-18 -57 -7 -57L20 -60Q40 -57 53 -44Q69 -21 59 2L45 29L47 67 Q23 82 3 77Q-29 84-55 69L-49 31L-54 8Q-65-22-44-42Z',
    gradient(c,-61,-30,63,49,[[0,'#779089'],[.22,'#527b7c'],[.72,'#39616b'],[1,'#31505f']]),'#233b47',2.8);
  p(c,'M-16 -56Q-26-42-26-21L-6-29L8-11L23-32L41-24L35-50L23-59Z','#40525c','#253e49',1.6);
  p(c,'M-24 -46Q-21 -30 -11 -30L6 -18L8 8L9 53L5 74',null,'#a7ad8e',2.3);
  p(c,'M-55 52Q-10 48 45 53L46 66Q7 75-55 64Z','#62564f','#405052',1.3);
  p(c,'M-5 54H13V66H-5Z','#bc946d','#524e50',1.65);
  p(c,'M-1 57H8V63H-1Z','#3c474c');
  p(c,'M-42 17Q-29 15-24 24L-27 42Q-37 47-49 39L-47 25Z','#3a6470','#84a198',1.1);
  p(c,'M27 7L47 10L45 33L28 35Z','#3b5360','#8b9b87',1.15);
  p(c,'M34 3V-6L39 -12L43 -3L38 1Z','#c7956b');
  for(const y of [-12,5,21,38]){
    circle(c,12,y,3.0,'#303d48');circle(c,11.2,y-.75,1.7,'#dfaf80');
  }
  p(c,'M-46 -23Q-36-9-37 2M-49 4L-48 18M-48 45L-49 53M-43 66L-32 67M50 -31L48 -17L50 -5',null,'#b4b58f98',1.3);
}

function face(c){
  p(c,'M-25 1Q-45-21-34-47Q-39-65-18-73Q3-82 21-66Q34-58 31-41L20-27L15-4L2 10L-15 7Z',
    gradient(c,-39,-48,24,-2,[[0,'#554448'],[.50,'#3d3443'],[1,'#292835']]),'#282732',2.5);
  p(c,'M-19 -17L-16 5L6 18L23 5L13-10L9-28Z',
    gradient(c,-14,-17,19,11,[[0,'#875149'],[1,'#bc8464']]),'#654844',1.3);
  p(c,'M12-62Q27-59 30-42L36-32L46-24Q50-17 41-15L32-15L31-7Q30 2 19 1 Q10-1 1-9L-8-19Q-16-22-14-33L-16-44Q-11-59 1-65Z',
    gradient(c,-20,-50,36,-18,[[0,'#936051'],[.53,'#bd825f'],[1,'#db9b72']]),'#65484a',1.9);
  p(c,'M15 -52Q24 -45 28-38L33-32L34-26L26-25L18-30L11-38Z','#d19672');
  p(c,'M13 -10Q22-5 30-9L26-2Q19 1 11-4Z','#b36e5d');
  p(c,'M-23-49Q-17-57-8-61L7-68L19-62Q6-52-2-44L-10-29L-18-21L-24-28Z','#413444');
  p(c,'M-25-52Q-22-62-10-67Q0-71 8-70M-29-42Q-22-53-13-54M-24-24Q-23-36-15-41',null,'#917063',1.25);
  p(c,'M-9 -24Q-17 -31-12 -36Q-8 -38-5 -34L-4 -27Q-5 -24-9 -24Z','#ca8b68','#945c53',1.2);
  p(c,'M18-39Q25-43 31-39M19-35Q23-32 29-35',null,'#51404a',1.55);
  circle(c,25,-35.5,1.35,'#262b33');
  circle(c,25.35,-36,0.6,'#f2d2a0');
  p(c,'M31-12Q37-13 40-12M31-9L35-8M39-22Q42-22 42-19',null,'#7b4c4c',1.28);
  p(c,'M-29-29Q-33-19-25-17Q-20-11-24-4Q-33 2-38-5Q-43-14-37-20Q-36-26-29-29Z','#453443','#332b36',1.2);
  p(c,'M-35-20Q-26-16-29-8M-32-5Q-36 0-34 5',null,'#a57c65',1.15);
  circle(c,-8,-22,3,'#bf8c5d');circle(c,-8,-22,.95,'#f5cb89');
  for(let j=0;j<4;j++)circle(c,12+j*3,-26+j*.50,.62,'#a76b59');
}

function scarf(c,ribbon){
  const g=gradient(c,-150,59,14,-17,[[0,'#813d4d'],[.55,'#b55f54'],[1,'#e09269']]);
  if(ribbon){
    p(c,'M2 -6Q-20 3-45 0Q-70-4-86 6Q-110 17-158 15L-147 31L-157 53Q-125 40-108 40 Q-82 40-66 26Q-50 14-19 21Q-9 19 4 15Z',g,'#713d4b',1.65);
    p(c,'M-154 19Q-124 23-98 15Q-74 7-56 7Q-23 12-2 0 M-153 46 Q-133 35-114 34 Q-92 34-75 22Q-48 11-16 16',null,'#fbbb8b91',1.56);
    for(let i=0;i<7;i++)p(c,`M${-153+i*.8} ${29+i*2.7}l${4+hash(i)*3} -2.2`,null,'#da9877',.7);
  }else{
    p(c,'M-31 -6 Q-12-15 7-12 Q35-12 51-5 L60 4L37 12Q25 20 1 13L-23 19L-34 12Z',
      gradient(c,-36,-16,46,17,[[0,'#8e4951'],[.72,'#c37660'],[1,'#e69b70']]),'#743e4b',2);
    p(c,'M-27 5Q-10-5 10-5Q25-8 41-7M-18 9Q7 4 31 7L47 2',null,'#ebad82',1.5);
    p(c,'M-6 18L8 5L24 12L14 25L0 24Z','#a35a57','#77484e',1.2);
    p(c,'M3 20L13 13L21 13',null,'#f0aa80',1.15);
  }
}

function lantern(c){
  bloom(c,2,46,43,[[0,'#ffe29170'],[.55,'#eeaa5445'],[1,'#e6aa4900']]);
  p(c,'M-11 12 C-18-12 18-12 11 12',null,'#543e43',4.4);
  p(c,'M-11 8C-13-9 12-10 12 8',null,'#c38f63',1.9);
  p(c,'M-18 28L-12 16H13L18 28L21 59L18 67H-18L-20 59Z',
    gradient(c,-17,26,20,58,[[0,'#845d49'],[.42,'#ffd582'],[.76,'#f2b466'],[1,'#b27750']]),'#513b41',2.6);
  p(c,'M-15 31L-13 56L-4 60L-5 28Z','#fbb768');
  p(c,'M-3 29L-2 57L9 56L13 29Z','#ffdf9c');
  p(c,'M-10 59L-6 31M5 31L3 60M14 32L13 59M-17 58H18',null,'#694d47',2.25);
  p(c,'M-21 27L-15 24L-11 17H11L17 24L21 28L17 33H-18L-21 30Z','#7a5550','#493941',1.65);
  p(c,'M-15 24H15M-14 26H13M-16 63H15',null,'#e8b681',1.6);
  p(c,'M-22 64Q0 59 22 64L20 73Q0 77-21 72Z','#805d51','#4a3c43',2);
  p(c,'M-12 70Q0 73 15 69',null,'#c89d72',1.7);
  p(c,'M0 51 Q-7 48-3 40L0 34L5 45Q5 51 0 51Z','#fff2b7');
}

function paintPart(c,name){
  if(name==='silk'||name==='knot'){scarf(c,name==='silk');return;}
  if(name==='face'){face(c);return;}
  if(name==='lantern'){lantern(c);return;}
  if(name==='coat'){coat(c);return;}
  if(name==='hem'){hem(c);return;}
  const near=name.startsWith('near');
  if(name.endsWith('boot'))boot(c,near);
  else if(name.endsWith('glove'))hand(c,near);
  else arm(c,near,name.endsWith('forearm'));
}

export function atlasLayout(){
  const w=592,h=448,regions=[],layout=new Map();
  let x=5,y=5,row=0;
  for(const [name,pw,ph,ox,oy] of parts){
    if(x+pw+5>w){x=5;y+=row+8;row=0;}
    if(y+ph+4>h)throw new Error('The keeper atlas is full.');
    regions.push({name,x,y,width:pw,height:ph});
    layout.set(name,{w:pw,h:ph,ox,oy});
    x+=pw+7;row=Math.max(row,ph);
  }
  return {layout,atlas:{name:'Keeper',imagePath:'keeper.png',width:w,height:h,SubTexture:regions}};
}
function atlasArt(){
  const sheet=atlasLayout();
  const canvas=artCanvas(sheet.atlas.width,sheet.atlas.height),c=canvas.getContext('2d');
  for(const {name,x,y,width,height} of sheet.atlas.SubTexture){
    const {ox,oy}=sheet.layout.get(name);
    c.save();c.beginPath();c.rect(x,y,width,height);c.clip();c.translate(x+ox,y+oy);paintPart(c,name);c.restore();
  }
  return {canvas,...sheet};
}
function effects(){
  const canvas=artCanvas(384,256),c=canvas.getContext('2d');
  bloom(c,124,124,119,[[0,'#ffca7569'],[.32,'#f3ba6437'],[.65,'#efa15b16'],[1,'#eba05a00']]);
  p(c,'M272 52Q263 45 265 37Q274 34 277 47Q285 35 291 41Q291 50 281 53Q280 60 275 62L271 55Z','#f4cf91');
  p(c,'M269 43L274 51M283 46L278 52',null,'#e59368',1.3);
  circle(c,274,81,5.8,'#b4dbd3');circle(c,274,81,3.1,'#385b62');
  rect(c,263,105,21,11,'#93d4c5');
  ellipse(c,317,168,49,13,gradient(c,317,156,317,181,[[0,'#172b36aa'],[1,'#10242b16']]));
  return canvas;
}
function source(canvas){
  const w=canvas.width,h=canvas.height;
  const bytes=canvas.getContext('2d').getImageData(0,0,w,h).data;
  return {width:w,height:h,data:new Uint8Array(bytes.buffer)};
}
export function createArt(){
  const sheet=atlasArt();
  return {backdrop:source(drawGlasshouse()),character:source(sheet.canvas),effects:source(effects()),
    atlas:sheet.atlas,parts:sheet.layout};
}

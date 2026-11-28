import {boardSize,balks,guides,release,maskSize,renderTile,dropScale,maxCutouts} from './layout.js';
import {newSurface} from './cutouts.js';

export const atlasSize=1024;
export const tiles={
  chamber:[0,0,...boardSize],
  plate:[512,0,512,420],
  grating:[0,432,288,288],
  preview:[308,440,renderTile,renderTile],
  previewTrace:[399,440,renderTile,renderTile],
  lamp:[493,450,32,32],
};
export function dropTile(i,overlay=false){
  if(i<0||i>=maxCutouts)throw new RangeError('Invalid cutout slot.');
  const col=i%5,row=Math.floor(i/5);
  return [col*renderTile+(overlay?448:0),736+row*renderTile,renderTile,renderTile];
}
const tau=Math.PI*2,margin=(renderTile-maskSize)/2;
const defaultFont='system-ui, sans-serif';
const colors=[
  ['#f2b782','#cb805a','#955439'],
  ['#b7dad3','#70a9a6','#477270'],
  ['#f3d599','#c89652','#9e613c'],
  ['#e5c8ad','#bb8d77','#825d55'],
];
const wood=['#352c26','#554032','#a57a56','#7a5538','#3e2d25'];
function surface(w,h=w){
  const canvas=newSurface(w,h);
  return [canvas,canvas.getContext('2d',{willReadFrequently:true})];
}
function round(c,x,y,w,h,r,fill,stroke,width=1){
  c.beginPath();c.roundRect(x,y,w,h,r);
  if(fill){c.fillStyle=fill;c.fill();}
  if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke();}
}
function linear(c,x,y,X,Y,stops){
  const gradient=c.createLinearGradient(x,y,X,Y);
  for(const [index,color] of stops.entries())gradient.addColorStop(index/(stops.length-1),color);
  return gradient;
}
function stroke(c,a,b,color,width=1){
  c.strokeStyle=color;c.lineWidth=width;
  c.beginPath();c.moveTo(...a);c.lineTo(...b);c.stroke();
}
function text(c,line,x,y,style='#bd9f79',size=12,wide=2){
  c.save();c.fillStyle=style;c.font='600 '+size+'px '+defaultFont;
  if('letterSpacing' in c)c.letterSpacing=wide+'px';
  c.fillText(line,x,y);c.restore();
}
function grit(c,x,y,w,h,col,amount=400){
  let seed=712009;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  c.fillStyle=col;
  for(let i=0;i<amount;i++){
    const a=next(),b=next(),length=next();
    c.fillRect(x+a*w,y+b*h,.18+length*2,.35);
  }
}
function rivet(c,x,y,r=3.6){
  let light=c.createRadialGradient(x-r*.30,y-r*.36,0,x,y,r+.10);
  for(const [a,b] of [[0,'#dec29a'],[.5,'#aa8a63'],[.78,'#7b5538'],[1,'#3a2b24']])light.addColorStop(a,b);
  c.beginPath();c.arc(x,y,r,0,tau);c.fillStyle=light;c.fill();
  stroke(c,[x-r*.48,y+r*.26],[x+r*.48,y-r*.23],'#442f25',.85);
}
function holder(c,w,h,plate){
  round(c,1,3,w-2,h-6,16,linear(c,0,4,w,h,['#594739','#2e2622','#6c513b']),'#8b6d50',1.1);
  round(c,6,8,w-12,h-16,12,linear(c,0,9,0,h-7,['#927353','#49372b','#483325']),'#201c1a',1.6);
  round(c,11,13,w-22,h-26,10,'#352d27','#b0966d',1.1);
  round(c,15,17,w-30,h-34,9,linear(c,0,17,w-16,h-10,plate?
    ['#29383a','#18272a','#202d2b']:['#0e2227','#203739','#1b2f30']),'#201b17',1.5);
  const light=c.createRadialGradient(w*.28,h*.14,12,w*.44,h*.27,w*.62);
  light.addColorStop(0,plate?'#79968a25':'#738f762d');light.addColorStop(1,'#19282500');
  round(c,16,18,w-32,h-36,8,light);
  for(const x of [18,w-18])for(const y of [18,h-18])rivet(c,x,y,4.2);
  grit(c,20,22,w-40,h-44,'#d5b98223',1100);
}
function plaque(c,title,sub){
  c.save();
  round(c,35,26,194,42,5,linear(c,36,29,38,67,['#544036','#342a27']),'#8f7052',.8);
  text(c,title,48,45,'#e4c5a0',13,2);
  text(c,sub,48,59,'#b6a087',8,1.25);
  rivet(c,218,35,2.4);rivet(c,218,60,2.4);
  c.restore();
}
function scaleMarks(c,y,x0,x1,vert=false){
  for(let x=x0;x<=x1;x+=8){
    const large=(x-x0)%40===0;
    if(vert)stroke(c,[y,x],[y-(large?9:4.5),x],large?'#b89a70':'#786653',large?1:.65);
    else stroke(c,[x,y],[x,y-(large?9:4.5)],large?'#b89a70':'#786653',large?1:.65);
  }
}
function plateFace(c){
  holder(c,512,420,true);
  plaque(c,'INK PLATE','ALPHA • 76 × 76');
  for(let i=0;i<24;i++)stroke(c,[36,79+12*i],[51,79+12*i],'#6f5e51',.65);
  for(let i=0;i<35;i++)stroke(c,[94+9*i,393],[94+9*i,399],'#8f7458',.75);
  round(c,382,31,94,27,3,'#152627','#79644d',.8);
  text(c,'CUT / SAMPLE',393,48,'#c9b394',8,1.1);
  for(const x of [39,473])for(const y of [92,363])rivet(c,x,y,3.3);
}
function grating(c){
  const w=288,h=288;
  round(c,2.5,3.5,w-5,h-7,10,'#111f21','#a48664',1.4);
  round(c,9,10,w-18,h-20,6,linear(c,0,10,w,h,['#294044','#203033','#1d292a']),'#614b39',1);
  for(let i=10;i<=h-10;i+=4.7){
    const major=Math.round((i-10)/4.7)%6===0;
    stroke(c,[11,i],[w-11,i],major?'#465d58':'#324748',major?.85:.48);
    stroke(c,[i,11],[i,w-11],major?'#465d58':'#324748',major?.85:.48);
  }
  const halo=c.createRadialGradient(w*.5,h*.5,7,w*.5,h*.5,w*.50);
  halo.addColorStop(0,'#689c7b06');halo.addColorStop(1,'#11191873');
  round(c,10,11,w-20,h-22,5,halo);
  c.beginPath();c.arc(144,144,100,0,tau);c.strokeStyle='#a58d594a';c.lineWidth=.8;c.stroke();
  stroke(c,[112,144],[176,144],'#a58d5938',.7);
  stroke(c,[144,112],[144,176],'#a58d5938',.7);
  for(const dx of [-1,1])for(const dy of [-1,1]){
    const x=144+dx*119,y=144+dy*119;
    stroke(c,[x,y+dy*6],[x,y],'#c9ac7e',1.2);stroke(c,[x,y],[x+dx*6,y],'#c9ac7e',1.2);
  }
  grit(c,14,15,w-28,h-29,'#c8a87521',1100);
}
function rail(c,{name,x,y,w,h,rotation}){
  c.save();c.translate(x,y);c.rotate(rotation);
  round(c,-w/2+1,-h/2+7,w,h+4,Math.min(h/2,5),'#030d1396');
  round(c,-w/2,-h/2,w,h,Math.min(h*.31,5),
    linear(c,0,-h/2,0,h/2,name.includes('wall')?['#675648','#8f7454','#49392f']:wood),'#191d1e',1.15);
  if(!name.includes('wall')){
    stroke(c,[-w/2+4,-h*.34],[w/2-4,-h*.34],'#e3b284',.85);
    stroke(c,[-w/2+4,h*.27],[w/2-4,h*.27],'#2c251f',1);
    for(let x=-w/2+12;x<w/2-8;x+=name==='anvil'?18:16){
      stroke(c,[x,-h*.10],[x+2,h*.12],'#dba8757a',1.1);
    }
    c.save();c.beginPath();c.roundRect(-w/2,-h/2,w,h,4);c.clip();
    grit(c,-w/2+2,-h/2+1,w-4,h-2,'#dac6aa33',160);c.restore();
  }
  if(w<30){rivet(c,0,-h*.43,3);rivet(c,0,h*.42,3);}
  else{rivet(c,-w/2+6,0,2.6);rivet(c,w/2-6,0,2.6);}
  c.restore();
}
function bearing(c,{x,y,radius:r}){
  c.save();c.translate(x,y);
  c.beginPath();c.arc(2,5,r+2,0,tau);c.fillStyle='#08171da1';c.fill();
  const rim=c.createRadialGradient(-r*.20,-r*.31,0,0,0,r);
  rim.addColorStop(0,'#e6bc91');rim.addColorStop(.47,'#bb875c');rim.addColorStop(.78,'#795038');rim.addColorStop(.93,'#b18457');rim.addColorStop(1,'#503625');
  c.beginPath();c.arc(0,0,r,0,tau);c.fillStyle=rim;c.fill();
  c.beginPath();c.arc(0,0,r*.70,0,tau);c.strokeStyle='#dfb687a2';c.lineWidth=.8;c.stroke();
  c.beginPath();c.arc(0,0,r*.48,0,tau);c.strokeStyle='#543d2e';c.lineWidth=2;c.stroke();
  for(let i=0;i<8;i++){
    const theta=i*tau/8,u=Math.cos(theta),v=Math.sin(theta);
    stroke(c,[u*r*.51,v*r*.51],[u*r*.67,v*r*.67],'#683f30',.75);
  }
  rivet(c,0,0,5.2);
  c.restore();
}
function chamberFace(c){
  const [w,h]=boardSize;
  holder(c,w,h,false);
  c.save();c.beginPath();c.roundRect(22,21,w-44,h-43,8);c.clip();
  const halo=c.createRadialGradient(295,180,35,267,216,235);
  halo.addColorStop(0,'#5c8e801c');halo.addColorStop(1,'#07181eaa');
  c.fillStyle=halo;c.fillRect(22,24,w-45,h-50);
  for(let x=58;x<w-61;x+=20)stroke(c,[x,82],[x,369],'#779e8522',.6);
  for(let y=91;y<h-57;y+=19)stroke(c,[50,y],[w-50,y],'#779e8522',.6);
  for(let j=0;j<21;j++)stroke(c,[55,95+j*12],[64-(j%5===0?0:5),95+j*12],'#b09d7963',.65);
  for(let j=0;j<20;j++)stroke(c,[450,102+j*12],[449+(j%5===0?0:5),102+j*12],'#b09d7963',.65);
  c.setLineDash([4,5]);
  c.beginPath();c.moveTo(...release);c.lineTo(226,359);c.strokeStyle='#d2ad6852';c.lineWidth=1;c.stroke();
  c.setLineDash([]);
  c.restore();
  plaque(c,'DROP CHAMBER','GRAVITY / COMPOUND BODY');
  round(c,360,29,88,29,3,'#212826','#81654a',.8);
  text(c,'CONTACT',371,47,'#c9b394',8.4,1.4);
  for(const k of balks)rail(c,k);
  for(const k of guides)bearing(c,k);
  scaleMarks(c,398,92,411);
  round(c,34,391,53,19,3,'#49392c','#9d7b58',.65);
  text(c,'DIE',49,404,'#dec29a',8.5,1.8);
  for(const x of [474,43])rivet(c,x,385,3.2);
  const [x,y]=release;
  c.beginPath();c.arc(x,y-4,18,0,Math.PI);c.strokeStyle='#bfad7e';c.lineWidth=1.1;c.stroke();
  stroke(c,[x-10,y+7],[x,y+15],'#a88e66',.9);
  stroke(c,[x,y+15],[x+10,y+7],'#a88e66',.9);
}
export function buildAtlas(){
  const [canvas,c]=surface(atlasSize);
  const [plate,p]=surface(512,420),[chamber,q]=surface(...boardSize),[grid,g]=surface(288);
  plateFace(p);chamberFace(q);grating(g);
  c.drawImage(plate,...tiles.plate.slice(0,2));c.drawImage(chamber,0,0);c.drawImage(grid,...tiles.grating.slice(0,2));
  const [lx,ly]=tiles.lamp;
  const glow=c.createRadialGradient(lx+16,ly+16,0,lx+16,ly+16,15);
  for(const [p,color] of [[0,'#ffe99ff2'],[.19,'#f9b768ea'],[.32,'#e78542a0'],[.99,'#d56d3400']])glow.addColorStop(p,color);
  c.fillStyle=glow;c.fillRect(lx,ly,32,32);
  return {width:atlasSize,height:atlasSize,data:c.getImageData(0,0,atlasSize,atlasSize).data};
}
const [decal,dc]=surface(renderTile);
const [mask,mc]=surface(maskSize);
function loop(c,positions,layout,close=true){
  c.beginPath();
  positions.forEach((point,i)=>{
    const [x,y]=layout(point);
    if(i)c.lineTo(x,y);else c.moveTo(x,y);
  });
  if(close)c.closePath();
}
export function paintCutout(capture,slot=0,flat=false){
  mc.putImageData(capture.pixels,0,0);
  dc.clearRect(0,0,renderTile,renderTile);
  dc.globalCompositeOperation='source-over';
  dc.drawImage(mask,margin,margin);
  dc.globalCompositeOperation='source-in';
  const [a,b,c]=colors[slot%colors.length];
  dc.fillStyle=linear(dc,0,0,renderTile,renderTile,[a,b,c]);
  dc.fillRect(0,0,renderTile,renderTile);
  dc.globalCompositeOperation='source-atop';
  grit(dc,margin,margin,maskSize,maskSize,'#f7d4a351',160);
  for(let i=-16;i<renderTile;i+=3.6)stroke(dc,[0,i+27],[renderTile,i-12],'#fff3c01e',.8);
  dc.globalCompositeOperation='source-over';
  for(const {outer,holes} of capture.outlines){
    for(const edge of [outer,...holes]){
      loop(dc,edge,p=>[p[0]+margin,p[1]+margin]);
      dc.strokeStyle=flat?'#ebbb89':'#9e5b49';dc.lineWidth=flat?.46:.60;dc.stroke();
    }
  }
  return dc.getImageData(0,0,renderTile,renderTile).data;
}
export function paintOutline(capture){
  dc.clearRect(0,0,renderTile,renderTile);
  const offset=n=>[n[0]+margin,n[1]+margin];
  const toArt=n=>[n[0]/dropScale+renderTile/2,n[1]/dropScale+renderTile/2];
  for(const shape of capture.shapes){
    if(shape.shape!=='polygon')continue;
    loop(dc,shape.points,toArt);
    dc.fillStyle='#7bffcf23';dc.fill();
    dc.strokeStyle='#c0f3b3a5';dc.lineWidth=.48;dc.stroke();
  }
  for(const {outer,holes} of capture.outlines){
    for(const edge of [outer,...holes]){
      loop(dc,edge,offset);
      dc.strokeStyle='#e6ffe0';dc.lineWidth=.74;dc.stroke();
      for(const point of edge){
        const [x,y]=offset(point);
        dc.fillStyle='#f3e9bd';dc.beginPath();dc.arc(x,y,.59,0,tau);dc.fill();
      }
    }
  }
  return dc.getImageData(0,0,renderTile,renderTile).data;
}

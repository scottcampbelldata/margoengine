const pi=Math.PI;
const labels=[
  ['Eclipse','The rim of an eclipsed sun across the heron’s breast.'],
  ['Tide atlas','A blue contour study crosses the wings and disappears into shadow.'],
  ['Meridian','A violet star chart shows how a straight line on the glass meets a curved surface.'],
];
export {labels};

function seeded(seed){
  return ()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/4294967296;
  };
}

function line(ctx,points){
  ctx.beginPath();
  points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
  ctx.stroke();
}

function circle(ctx,x,y,r){
  ctx.beginPath();
  ctx.arc(x,y,r,0,2*pi);
  ctx.stroke();
}

function eclipse(ctx,w,h){
  const x=w*.375,y=h*.48,r=h*.281;
  const dust=seeded(131);
  const corona=ctx.createRadialGradient(x,y,r*.96,x,y,r*1.92);
  corona.addColorStop(0,'#100705');
  corona.addColorStop(.058,'#9d5034');
  corona.addColorStop(.27,'#4f2520');
  corona.addColorStop(1,'#170e10');
  ctx.fillStyle=corona;
  ctx.fillRect(0,0,w,h);
  for(let i=0;i<450;i++){
    const theta=dust()*2*pi,a=Math.cos(theta),b=Math.sin(theta);
    const plume=.2+.8*Math.pow(.5+.5*Math.sin(theta*4+.77),2);
    const travel=r*(.18+dust()*.48)*plume;
    ctx.strokeStyle='rgba(255, '+Math.round(105+dust()*120)+', '+Math.round(54+dust()*85)+', '+(.10+dust()*.42)+')';
    ctx.lineWidth=.25+dust()*.89;
    ctx.beginPath();
    ctx.moveTo(x+a*r*.98,y+b*r*.98);
    ctx.quadraticCurveTo(x+a*(r+travel*.32)-b*8,y+b*(r+travel*.31)+a*8,x+a*(r+travel)-b*13,y+b*(r+travel)+a*13);
    ctx.stroke();
  }
  ctx.fillStyle='#1b1420';
  ctx.beginPath();
  ctx.arc(x,y,r*.992,0,2*pi);
  ctx.fill();
  ctx.lineWidth=1.6;
  ctx.strokeStyle='#ffe0a4';
  circle(ctx,x,y,r);
  ctx.strokeStyle='#e9ad65';
  ctx.lineWidth=.72;
  circle(ctx,x,y,r*1.37);
  line(ctx,[[x-r*1.53,y],[x+r*1.53,y]]);
  line(ctx,[[x,y-r*1.51],[x,y+r*1.51]]);
}

function tides(ctx,w,h){
  const sea=ctx.createLinearGradient(w*.32,0,w*.61,h);
  sea.addColorStop(0,'#13384e');
  sea.addColorStop(.52,'#175c69');
  sea.addColorStop(1,'#091b30');
  ctx.fillStyle=sea;
  ctx.fillRect(0,0,w,h);
  for(let i=0;i<39;i++){
    const data=[];
    for(let s=0;s<=110;s++){
      const x=s*w/110;
      const roll=Math.exp(-Math.pow((x-w*.52)/151,2));
      const y=15+i*h/37+43*roll*Math.sin(x*.014+i*.217)+13*Math.sin(x*.031+i*.31);
      data.push([x,y]);
    }
    ctx.strokeStyle=i%4===0?'#9fe6d2':'#62b4b3';
    ctx.lineWidth=i%4===0?2.2:1.15;
    line(ctx,data);
  }
  for(const [x,y] of [[.36,.39],[.55,.57],[.64,.37],[.41,.70],[.77,.64]]){
    ctx.strokeStyle='#b9f4da';
    ctx.lineWidth=1.4;
    circle(ctx,w*x,h*y,12);
    circle(ctx,w*x,h*y,3);
  }
}

function meridian(ctx,w,h){
  const bg=ctx.createLinearGradient(0,h,w,0);
  bg.addColorStop(0,'#221638');
  bg.addColorStop(.43,'#423057');
  bg.addColorStop(1,'#241833');
  ctx.fillStyle=bg;
  ctx.fillRect(0,0,w,h);
  ctx.strokeStyle='#ad7ee2';
  ctx.lineWidth=.78;
  const x=w*.47,y=h*.51;
  for(let i=1;i<8;i++)circle(ctx,x,y,i*19);
  for(let i=0;i<24;i++){
    const a=i*pi/12,b=(i+1)*pi/12;
    line(ctx,[[x+Math.cos(a)*14,y+Math.sin(a)*14],[x+Math.cos(b)*155,y+Math.sin(b)*155]]);
  }
  const rnd=seeded(51);
  for(let i=0;i<105;i++){
    const sx=rnd()*w,sy=rnd()*h,rad=.6+2.9*Math.pow(rnd(),3);
    ctx.beginPath();
    ctx.fillStyle=i%7===0?'#ffe8bd':'#d7c6ff';
    ctx.arc(sx,sy,rad,0,pi*2);
    ctx.fill();
  }
  const nodes=[[.23,.60],[.35,.48],[.43,.62],[.54,.58],[.58,.42],[.70,.37],[.76,.24]].map(([a,b])=>[w*a,h*b]);
  ctx.strokeStyle='#f0d8fb';
  ctx.lineWidth=1.85;
  line(ctx,nodes);
  nodes.forEach(([x,y])=>circle(ctx,x,y,4.4));
}

const drawings=[eclipse,tides,meridian];
export function makeSlide(index){
  const width=512,height=384;
  const canvas=new OffscreenCanvas(width,height);
  const g=canvas.getContext('2d',{willReadFrequently:true});
  g.fillStyle='#1c161a';
  g.fillRect(0,0,width,height);
  g.save();
  g.beginPath();
  g.rect(26,26,width-52,height-52);
  g.clip();
  drawings[index](g,width,height);
  g.restore();
  g.strokeStyle=index===0?'#dba464':index===1?'#72c3bf':'#b881d3';
  g.lineWidth=1.6;
  g.strokeRect(27,27,width-54,height-54);
  g.strokeRect(34,34,width-68,height-68);
  g.fillStyle='#f6dcb9';
  g.font='600 8px system-ui';
  g.fillText('LANTERN   /   '+labels[index][0].toUpperCase(),44,348);
  for(let i=0;i<34;i++)g.fillRect(43+i*4.9,41,.9,2+(i%5===0)*2);
  return g.getImageData(0,0,width,height);
}

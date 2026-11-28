import {height, ribs, width} from './layout.js';

function random(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function surface(w = width, h = height) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d', {willReadFrequently: true});
}
function path(ctx, points, closed = true) {
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (closed) ctx.closePath();
}
function fill(ctx, points, color) {
  path(ctx, points);
  ctx.fillStyle = color;
  ctx.fill();
}
function line(ctx, points, color, size = 1) {
  path(ctx, points, false);
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.stroke();
}
function gradient(ctx, x0, y0, x1, y1, colors) {
  const paint = ctx.createLinearGradient(x0, y0, x1, y1);
  colors.forEach((color, i) => paint.addColorStop(i / (colors.length - 1), color));
  return paint;
}
function stone(ctx, shape, palette, seed) {
  const jitter = random(seed);
  const xs = shape.map(point => point[0]), ys = shape.map(point => point[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  ctx.save();
  path(ctx, shape);
  ctx.clip();
  ctx.fillStyle = gradient(ctx, left - 15, top, right + 12, bottom, palette);
  ctx.fillRect(left, top, right - left + 1, bottom - top + 1);
  for (let y = top - 24; y <= bottom + 40; y += 3 + jitter() * 7) {
    const points = [];
    for (let x = left - 24; x <= right + 82; x += 5 + jitter() * 17) {
      points.push([x, y - (x - left) * .18 + Math.sin(x * .026 + seed) * 7 + (jitter() - .5) * 9]);
    }
    line(ctx, points, jitter() < .45 ? '#ffecb227' : '#10272858', .35 + jitter() * 1.75);
  }
  for (let i = 0, total = Math.min(6200, (right - left) * (bottom - top) / 10); i < total; i++) {
    const x = left + jitter() * (right - left), y = top + jitter() * (bottom - top);
    ctx.fillStyle = jitter() > .46 ? '#f6d9ab21' : '#142b3164';
    ctx.fillRect(x, y, .5 + jitter() * 2.1, .4 + jitter() * 1.1);
  }
  ctx.restore();
  line(ctx, [...shape, shape[0]], '#213534', 1.5);
}
function ledge(ctx, shape, seed, palette) {
  stone(ctx, shape, palette, seed);
  line(ctx, shape.slice(0, 8), '#a29370', 2.3);
}
function bridge(ctx) {
  const ends = [325, 492], sag = x => 302 + 17 * Math.sin((x - ends[0]) / (ends[1] - ends[0]) * Math.PI);
  for (let x = 324; x < 492; x += 8) {
    const y = sag(x);
    fill(ctx, [[x-2,y],[x+5,y],[x+8,y+8],[x,y+10]], gradient(ctx, x, y, x, y+10, ['#b48e62','#564730']));
    line(ctx, [[x+1,y+2],[x+5,y+8]], '#d5ba82ad', .7);
  }
  const ropes = Array.from({length: 81}, (_, i) => {
    const x = ends[0] + i * (ends[1] - ends[0]) / 80;
    return [x, sag(x) - 24];
  });
  for (let i = 0; i < ropes.length; i += 5) line(ctx, [ropes[i], [ropes[i][0], ropes[i][1] + 26]], '#aa8962', .85);
  line(ctx, ropes, '#594a32', 3.5);
  line(ctx, ropes.map(([x,y]) => [x,y-.65]), '#c9a77a', 1.1);
  for (const x of ends) {
    fill(ctx, [[x-3,308],[x-3,272],[x+2,269],[x+5,305]], '#34362c');
    line(ctx, [[x-1,305],[x-1,273],[x+2,271]], '#a78254', 1.7);
    for (let y=277;y<285;y+=2) line(ctx, [[x-4,y],[x+5,y-1]], '#d6b686', .9);
  }
}
function crystals(ctx, x, y, scale) {
  const forms = [
    [[-21,3],[-19,-25],[-12,-33],[-6,-3]], [[-10,3],[-5,-40],[5,-52],[13,-38],[9,4]],
    [[4,4],[16,-31],[24,-39],[29,-26],[17,5]], [[12,5],[32,-16],[44,-18],[41,-7],[26,7]],
  ];
  for (const shard of forms) {
    const shape = shard.map(([a,b])=>[x+a*scale,y+b*scale]);
    fill(ctx, shape, gradient(ctx,x-6*scale,y-38*scale,x+7*scale,y+10*scale,['#c5e6d4','#5b9489','#345957']));
    line(ctx, shape.slice(1,3), '#e0e4b6ab', .95);
    const [l,t] = shape[1];
    line(ctx, [[l+2,t+1],[x+5*scale,y+2]], '#a7cfb475', .75);
  }
}
export function chamber() {
  const ctx = surface(), rng = random(11089);
  ctx.fillStyle = gradient(ctx, 0, 0, 0, height, ['#233c41','#4e716f','#789991','#314547']);
  ctx.fillRect(0, 0, width, height);
  const sink = ctx.createRadialGradient(593,255,12,593,255,305);
  sink.addColorStop(0, '#b0d1c2aa'); sink.addColorStop(1, '#9bc2b900');
  ctx.fillStyle = sink; ctx.fillRect(0,0,width,height);
  for (let i=0;i<22;i++) {
    const x = i*38-46 + rng()*33, y = 164+rng()*129, n = 15+rng()*22, rise = 67+rng()*182;
    fill(ctx, [[x-21,354],[x,y+rise*.25],[x-n*.24,y],[x+n*.6,y-rise],[x+n,y+rise*.45],[x+n*1.4,359]],
      gradient(ctx,x-10,65,x+n,365,['#28434d','#547470','#7a908a']));
    line(ctx, [[x+2,y+21],[x+n*.6,y-rise],[x+n*.67,y+13]], '#b4c3aa55',1.1);
  }
  const reflected = surface();
  reflected.translate(0,668);
  reflected.scale(1,-1);
  reflected.drawImage(ctx.canvas,0,0);
  ctx.fillStyle = gradient(ctx, 0,318,0,448,['#658e86','#385a60','#132b34']);
  ctx.fillRect(0,310,width,138);
  ctx.save();ctx.globalAlpha=.48;
  for(let y=322;y<height;y++){
    const shift = Math.sin(y*.24)*3 + Math.sin(y*.071)*4;
    ctx.drawImage(reflected.canvas,0,y,width,1,shift,y,width,1);
  }
  ctx.restore();
  for(let i=0;i<780;i++){
    const y=318+Math.pow(rng(),1.6)*131,x=rng()*width,w=2+rng()*Math.pow((y-289)/5.7,1.4);
    line(ctx,[[x,y],[x+w,y-.15]],rng()<.38?'#b3d8c38f':'#1d424a6b',.36+rng()*1.1);
  }
  stone(ctx,[[0,0],[768,0],[768,90],[743,70],[714,86],[683,109],[662,141],[643,102],[610,91],[585,130],[559,120],[526,141],[512,171],[498,106],[461,118],[440,96],[407,120],[381,139],[360,129],[335,152],[315,105],[289,106],[266,122],[236,113],[207,153],[183,135],[161,167],[146,94],[116,114],[103,170],[81,143],[45,205],[0,223]],['#4b584b','#8b876b','#3f534d'],207);
  for (let i=0;i<ribs.length;i++){
    const shape=ribs[i],cx=shape[6][0],ty=shape[6][1],y=shape[0][1];
    stone(ctx, shape, ['#beb497','#777b63','#53655d'],35+i*79);
    const flutes=Array.from({length:6},(_,n)=>[
      [cx-3+n*1.5,ty+20+n*2],[cx-12+n*3,ty+55],[cx-13+n*3,ty+91],
      [cx-10+n*3,ty+119],[cx-22+n*5,y-8]
    ]);
    for(const [n,flute] of flutes.entries())line(ctx,flute,n%2?'#e3d7a98a':'#394a42b8',.85+n*.29);
  }
  ledge(ctx,[[0,312],[34,302],[76,307],[109,288],[144,289],[176,306],[208,301],[240,302],[266,310],[299,302],[330,302],[342,320],[313,337],[286,342],[250,331],[209,342],[170,335],[123,350],[78,352],[29,370],[0,363]],89,['#c5b082','#817455','#374448']);
  ledge(ctx,[[488,304],[515,296],[536,309],[565,301],[595,284],[635,287],[667,273],[705,280],[737,273],[768,268],[768,333],[730,336],[714,319],[670,337],[635,327],[606,348],[558,340],[519,349],[487,327]],67,['#b6a180','#69756b','#343d44']);
  bridge(ctx);
  crystals(ctx, 186, 318, .88); crystals(ctx, 265, 331, .62); crystals(ctx, 622, 304, 1.02); crystals(ctx, 706, 313, 1.42);
  stone(ctx,[[0,403],[37,390],[63,402],[102,390],[136,420],[157,425],[191,448],[0,448]],['#617473','#4b5147','#243536'],311);
  stone(ctx,[[635,448],[654,423],[698,405],[714,407],[742,382],[768,388],[768,448]],['#6b7464','#454b46','#374340'],425);
  crystals(ctx, 62, 437, .83); crystals(ctx, 739, 448, 1.02);
  return ctx.getImageData(0,0,width,height);
}
export function lamp(ctx,x,y){
  ctx.clearRect(0,0,width,height);
  const reflection = random(Math.round(x * 4));
  const floor = 336 + Math.max(0, 249 - y) * .12;
  ctx.save();
  path(ctx, [[0,370],[78,353],[123,351],[171,336],[213,343],[254,332],[285,343],[338,331],
    [485,330],[521,350],[566,341],[604,349],[633,328],[670,338],[715,320],[733,337],[768,333],[768,448],[0,448]]);
  ctx.clip();
  for(let i=0;i<27;i++){
    const dy=i*2.65 + reflection()*2.4, yy=floor+dy;
    const offset=Math.sin(yy*.36)*4 + Math.sin(yy*.12)*7;
    const rayWidth=(.32+reflection()*.68)*(6+dy*.56);
    const alpha=Math.max(0, .34-dy*.004)*(.24+reflection()*.76);
    line(ctx,[[x+offset-rayWidth,yy],[x+offset+rayWidth,yy]],'rgba(250,183,106,'+alpha+')',.55+reflection()*1.35);
  }
  ctx.restore();
  const warm = ctx.createRadialGradient(x,y,1,x,y,30);
  warm.addColorStop(0,'#fffae6');warm.addColorStop(.12,'#fff2b7db');warm.addColorStop(.38,'#fcb35168');warm.addColorStop(1,'#fb9b3500');
  ctx.fillStyle=warm;ctx.fillRect(x-31,y-31,62,62);
  fill(ctx,[[x-8,y+6],[x-8,y-5],[x-5,y-8],[x+5,y-8],[x+8,y-5],[x+8,y+6],[x+5,y+9],[x-5,y+9]],'#483c2d');
  ctx.fillStyle=gradient(ctx,x-5,y-5,x+4,y+6,['#ffebaa','#ffc56a','#a16d45']);
  ctx.fillRect(x-5,y-5,10,11);
  for (const dx of [-5,0,5]) line(ctx,[[x+dx,y-6],[x+dx,y+7]],'#523c28',1);
  line(ctx,[[x-5,y-8],[x-3,y-12],[x+3,y-12],[x+5,y-8]],'#c3a473',1.25);
  return ctx.getImageData(0,0,width,height);
}

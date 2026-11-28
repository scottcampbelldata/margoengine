export const width=840,height=510;
export const deck={start:220,end:620,y:315,span:400,planks:14,sag:39,thickness:15};
export const shelves=[{p:[152,314],w:86,h:12},{p:[706,308],w:83,h:14}];
export const banks=[
  {p:[420,518],w:840,h:43},{p:[-12,255],w:22,h:510},{p:[852,255],w:22,h:510},
];
export const shore=[
    [[0,298],[20,293],[55,302],[71,310],[113,306],[135,312],[160,307],[193,314],[220,319],
      [212,347],[189,378],[187,408],[151,427],[145,468],[111,474],[98,510],[0,510]],
    [[840,283],[811,282],[784,298],[742,294],[722,302],[688,302],[662,310],[638,306],[620,318],
      [627,353],[647,374],[659,406],[697,424],[697,451],[718,482],[735,510],[840,510]],
  ];
export const crateSize=33;
export const opening=[
  {x:151,y:291.3,theme:0},{x:151,y:258.1,theme:2},{x:151,y:224.9,theme:1},
  {x:680,y:284.3,theme:2},{x:720,y:284.3,theme:3},
];
export function planks(){
  const points=Array.from({length:deck.planks+1},(_,i)=>{
    const t=i/deck.planks;
    return [deck.start+deck.span*t,deck.y+deck.sag*Math.sin(t*Math.PI)];
  });
  return points.slice(0,-1).map(([x,y],i)=>{
    const [tx,ty]=points[i+1];
    return {x:(x+tx)/2,y:(y+ty)/2,rotation:Math.atan2(ty-y,tx-x),length:Math.hypot(tx-x,ty-y)};
  });
}

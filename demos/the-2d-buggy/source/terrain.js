export const firstX=-14,endX=146,spacing=.25,startX=2.9;
export const checkpoints=[19,47,77,110,139];

export function roadElevation(x){
  if(x<0)return 4.1;
  const bloom=Math.min(1,x/7), taper=Math.max(0,Math.min(1,(143-x)/10));
  return 4.1+bloom*taper*(.82*Math.sin(x*.246)+.49*Math.sin(x*.463+.45)+.82*Math.sin(x*.099-1));
}
export const trail=Array.from({length:Math.round((endX-firstX)/spacing)+1},(_,n)=>{
  const x=firstX+n*spacing;
  return [x,roadElevation(x)];
});
export const radius=.40;
export const wheelSpacing=2.10;
export const delta=1/120;

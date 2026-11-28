import {expand,interpret,parseModules,tubes} from '@margoengine/procedural/lsystem';

export const origin=[0,.281,0];
export const maxGeneration=6;
export const specimens={
  lantern:{name:'Lantern bells',kind:'bell',angle:53,axiom:'A',rules:String.raw`A = F(0.132)[+!F(0.137)L[+(23)F(0.066)L]F(0.071)LB][-(48)!F(0.132)L[-(24)F(0.070)L]F(0.069)LB][&(57)!F(0.106)L[+(23)F(0.051)L]F(0.049)B]\(83)+(5)!A`},
  fern:{name:'Silver fern',kind:'fern',angle:53,axiom:'A',rules:String.raw`A = F(0.120)[+!F(0.098)L[+F(0.042)L]F(0.064)L][-!F(0.094)L[-F(0.042)L]F(0.060)L]/(54)!A`},
  ember:{name:'Ember stems',kind:'ember',angle:28,axiom:'A',rules:String.raw`A = F(0.139)[+!F(0.121)LB][-!F(0.103)LB][&(42)!F(0.098)LB]\(92)!A`},
};

function parse(source){
  if(source.trim().length===0)throw new SyntaxError('Enter at least one symbol.');
  if(source.length>640)throw new RangeError('Keep the axiom and each rule within 640 characters.');
  const modules=parseModules(source);
  let depth=0;
  for(const {symbol,params} of modules){
    if(!/^[A-Za-z+\-&^\\/|![\]]$/.test(symbol))throw new SyntaxError('Unknown symbol '+symbol+'.');
    if(symbol==='[')depth++;
    if(symbol===']'&&--depth<0)throw new SyntaxError('Close brackets in the order they open.');
    if(depth>80)throw new RangeError('Keep bracket nesting to 80 branches.');
    if(params.length>1)throw new RangeError('Use one numeric parameter per symbol.');
    if(!params.length)continue;
    const [v]=params;
    if('FfGg'.includes(symbol)){
      if(v<.003||v>.48)throw new RangeError('Step lengths must be between 0.003 and 0.48 m.');
    }else if('+-&^\\/'.includes(symbol)){
      if(Math.abs(v)>180)throw new RangeError('Explicit turns must be within −180° and 180°.');
    }else if(symbol==='!'){
      if(v<.0008||v>.038)throw new RangeError('Stems need a radius between 0.0008 and 0.038 m.');
    }else{
      throw new SyntaxError('Only steps, turns and radius changes accept a parameter.');
    }
  }
  if(depth)throw new SyntaxError('Close each opened branch with ].');
  return modules;
}

export function generate(spec){
  const axiom=parse(spec.axiom),rules=Object.create(null);
  const lines=spec.rules.split(/\r?\n/).filter(line=>line.trim().length);
  if(!lines.length)throw new SyntaxError('Add at least one production rule.');
  if(lines.length>16)throw new RangeError('Use up to sixteen production rules.');
  for(const line of lines){
    const match=/^\s*([A-Za-z])\s*=\s*(.+?)\s*$/.exec(line);
    if(!match)throw new SyntaxError('Write one rule per line, such as A = F[+A][-A].');
    const [,symbol,successor]=match;
    if(rules[symbol])throw new SyntaxError('Use one rule for each symbol.');
    parse(successor);
    rules[symbol]=successor;
  }
  const modules=expand(axiom,rules,spec.generation,{maxModules:12000,seed:37});
  const options={origin,angle:spec.angle,step:.094,radius:.0145,radiusScale:.775};
  const branches=interpret(modules,options);
  if(branches.radii.length>1700)throw new RangeError('This generation would exceed 1,700 stems. Use fewer rewrites.');
  const markers=modules.filter(({symbol})=>symbol==='L'||symbol==='B');
  if(markers.length>720)throw new RangeError('This generation would exceed 720 leaves and flowers.');
  const withMarkers=modules.flatMap(module=>{
    if(module.symbol!=='L'&&module.symbol!=='B')return [module];
    return [{symbol:'[',params:[]},{symbol:module.symbol,params:[.001]},{symbol:']',params:[]}];
  });
  const raw=interpret(withMarkers,{...options,draw:'FGLB'});
  const organs=[];
  for(let n=0,i=0;n<modules.length;n++){
    const {symbol}=modules[n];
    if(!'FGLB'.includes(symbol))continue;
    if(symbol==='L'||symbol==='B'){
      const at=raw.positions.slice(i*6,i*6+3),end=raw.positions.slice(i*6+3,i*6+6);
      organs.push({symbol,at:[...at],direction:Array.from(end,(v,k)=>v-at[k]),up:[...raw.ups.slice(i*3,i*3+3)],index:n,depth:raw.depths[i]});
    }
    i++;
  }
  const bounds={min:[0,origin[1],0],max:[0,origin[1],0]};
  const insert=p=>{
    for(let k=0;k<3;k++){ bounds.min[k]=Math.min(bounds.min[k],p[k]); bounds.max[k]=Math.max(bounds.max[k],p[k]); }
  };
  for(let i=0;i<branches.positions.length;i+=3)insert(branches.positions.subarray(i,i+3));
  for(const {at} of organs)insert(at);
  if(bounds.max[1]-bounds.min[1]>5||bounds.max[0]-bounds.min[0]>5||bounds.max[2]-bounds.min[2]>5)
    throw new RangeError('Keep the specimen within 5 m. Use shorter steps or fewer rewrites.');
  return {geometry:branches.radii.length?tubes(branches,{radialSegments:8,tipScale:.46}):null,
    organs,bounds,symbols:modules.length,stems:branches.radii.length,leaves:organs.filter(o=>o.symbol==='L').length,
    blooms:organs.filter(o=>o.symbol==='B').length};
}

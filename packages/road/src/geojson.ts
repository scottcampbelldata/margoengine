import { Spline } from '@margoengine/splines';
import { bounded, designError, type Point3 } from './design-mesh.js';

/** Per-highway fallback policy; these are rendering assumptions, not inferred survey measurements. */
export interface HighwayDefaults {
  /** Default lane count. */
  lanes: number;
  /** Default width per lane, metres. */
  laneWidth: number;
}
/** Import settings shared by GeoJSON and OSM XML/Overpass JSON. */
export interface RoadImportOptions {
  /** WGS84 [longitude,latitude,height] local origin. Default first road coordinate. */
  origin?: readonly [number,number,number];
  /** Override WGS84 conversion, returning local Y-up [x,y,z] metres. Default WGS84 ECEF to east/up/south. */
  project?: (coordinate:readonly number[])=>Point3;
  /** Override fallback lanes/width by highway class. Default main roads 2*3.5 m; service/track 1*3 m; paths 1*1.5 m. */
  defaults?: Readonly<Record<string,HighwayDefaults>>;
  /** Allowed height difference when joining GeoJSON line crossings. Default 0.5 m. OSM trusts node identities instead. */
  crossingHeight?: number;
  /** Checked before and after synchronous import. Default none. */
  signal?: AbortSignal;
}
/** A graph edge that can be passed directly to road(), lanes() or roadGraph(). */
export interface ImportedRoad {
  /** Source feature/way identifier, shared by all its split edges. */
  sourceId: string;
  /** Network vertex IDs. */
  from: number;
  /** Network vertex ID at the authored end. */
  to: number;
  /** Two-point, exactly straight spline for this split source-polyline segment. */
  curve: Spline;
  /** Owned local Y-up endpoints. */
  points: [Point3,Point3];
  /** Total width in metres. */
  width: number;
  /** Lane count. */
  lanes: number;
  /** Per-lane metre widths, equal when no width:lanes tag exists. */
  laneWidths: number[];
  /** Relative to source point order. */
  direction: 'both' | 'forward' | 'reverse';
  /** OSM layer or inferred 1 for bridge, -1 for tunnel, 0 otherwise. */
  layer: number;
  /** True when explicitly tagged as a bridge. */
  bridge: boolean;
  /** True when explicitly tagged as a tunnel. */
  tunnel: boolean;
  /** Owned source string tags, including unrecognised tags. */
  tags: Record<string,string>;
}
/** Local road network and reproducible geographic origin. */
export interface RoadNetwork {
  /** Owned Y-up node coordinates. */
  nodes: Point3[];
  /** Split road edges, preserving source IDs. */
  roads: ImportedRoad[];
  /** Owned WGS84 origin; null for an empty network or custom projector. */
  origin: [number,number,number] | null;
  /** Explicit metadata fallback and zero-length-segment diagnostics. */
  warnings: string[];
}

type RecordValue = Record<string,unknown>;
type Source = {id:string;coordinates:number[][];ids?:string[];tags:Record<string,string>};
type Segment = {source:Source;a:Point3;b:Point3;ka:string;kb:string;meta:Omit<ImportedRoad,'sourceId'|'from'|'to'|'curve'|'points'|'tags'>;cuts:{t:number;p:Point3;key:string}[]};
const object=(v:unknown):RecordValue=>{if(!v||typeof v!=='object'||Array.isArray(v))throw designError('Invalid road document; supply GeoJSON, OSM XML or Overpass elements');return v as RecordValue;};
const identifier=(v:unknown):string=>{if((typeof v!=='string'&&typeof v!=='number')||String(v)===''||(typeof v==='number'&&!Number.isSafeInteger(v)))throw designError('Invalid OSM identifier; use a nonempty string or safe integer');return String(v);};
const tags=(v:unknown):Record<string,string>=>Object.fromEntries(Object.entries(v==null?{}:object(v)).filter(([,x])=>['string','number','boolean'].includes(typeof x)).map(([k,x])=>[k,String(x)]));
const flag=(v:string|undefined)=>v!==undefined&&!['no','false','0'].includes(v);
const coordinate=(v:unknown):number[]=>{if(!Array.isArray(v)||(v.length!==2&&v.length!==3)||!v.every(x=>typeof x==='number'&&Number.isFinite(x)))throw designError('Road coordinates need finite [longitude,latitude,altitude?] positions');return [...v.slice(0,2),v[2]??0];};
const metres=(s:string|undefined):number|undefined=>{
  if(s===undefined)return undefined;
  const feet=/^\s*(\d+(?:\.\d+)?)'\s*(?:(\d+(?:\.\d+)?)"?)?\s*$/.exec(s);
  if(feet)return Number(feet[1])*0.3048+Number(feet[2]??0)*0.0254;
  const m=/^\s*(\d+(?:\.\d+)?)\s*(m|ft|feet|metres|meters)?\s*$/.exec(s);
  return m?Number(m[1])*(m[2]==='ft'||m[2]==='feet'?0.3048:1):undefined;
};

function metadata(source:Source,options:RoadImportOptions,warnings:string[]):Segment['meta'] {
  const t=source.tags,highway=t.highway??'unclassified',path=['footway','cycleway','path','pedestrian','steps','bridleway'].includes(highway);
  const fallback=options.defaults?.[highway]??{lanes:['service','track'].includes(highway)||path?1:2,laneWidth:path?1.5:['service','track'].includes(highway)?3:3.5};
  if(!Number.isInteger(fallback.lanes)||!bounded(fallback.lanes,1,32)||!bounded(fallback.laneWidth,0.1,100))throw designError('Invalid highway defaults; use 1..32 lanes and lane widths 0.1..100 metres');
  const positive=(v:string|undefined)=>v!==undefined&&/^\d+$/.test(v)&&bounded(Number(v),1,32)?Number(v):undefined;
  const directional=['lanes:forward','lanes:backward','lanes:both_ways'].map(k=>positive(t[k])??0).reduce((a,b)=>a+b,0);
  const count=positive(t.lanes)??(directional||fallback.lanes);
  if(t.lanes!==undefined&&positive(t.lanes)===undefined)warnings.push(`${source.id}: invalid lanes tag; used fallback`);
  if(count>32)throw designError('Road lane count exceeds 32; correct the lane tags');
  let laneWidths=t['width:lanes']?.split('|').map(s=>s.trim()===''?fallback.laneWidth:metres(s)) as (number|undefined)[]|undefined;
  if(laneWidths&&(laneWidths.length!==count||laneWidths.some(w=>w===undefined||!bounded(w,0.1,100)))){warnings.push(`${source.id}: invalid width:lanes; used total/default width`);laneWidths=undefined;}
  let width=metres(t.width);
  if(t.width!==undefined&&(width===undefined||!bounded(width,0.1,1000))){warnings.push(`${source.id}: invalid width; used lane widths`);width=undefined;}
  width??=laneWidths?.reduce<number>((a,b)=>a+b!,0)??count*fallback.laneWidth;
  if(!bounded(width,0.1,1000))throw designError('Imported road width exceeds 1000 metres; correct width or lanes');
  // A total width wins, while per-lane proportions remain authored.
  const sum=laneWidths?.reduce<number>((a,b)=>a+b!,0)??width;
  const widths=laneWidths?laneWidths.map(w=>w!*width!/sum):Array(count).fill(width/count);
  const bridge=flag(t.bridge),tunnel=flag(t.tunnel),layer=t.layer===undefined?(bridge?1:tunnel?-1:0):Number(t.layer);
  if(!Number.isInteger(layer)||!bounded(layer,-100,100))throw designError('Invalid road layer; use an integer in -100..100');
  let direction:ImportedRoad['direction']='both';
  if(['yes','true','1'].includes(t.oneway)||(t.oneway===undefined&&(t.junction==='roundabout'||highway==='motorway')))direction='forward';
  else if(t.oneway==='-1'||t.oneway==='reverse')direction='reverse';
  else if(t.oneway!==undefined&&!['no','false','0'].includes(t.oneway))warnings.push(`${source.id}: dynamic/unknown oneway ${t.oneway}; retained both directions`);
  return {width,lanes:count,laneWidths:widths,direction,layer,bridge,tunnel};
}

/** GeoJSON RFC 7946 line features; mixed non-line geometries are intentionally ignored. */
export function importGeoJSON(document:unknown,options:RoadImportOptions={}):RoadNetwork {
  options.signal?.throwIfAborted();const sources:Source[]=[];
  const visit=(input:unknown,properties:Record<string,string>={},id='feature',depth=0)=>{
    if(depth>32)throw designError('GeoJSON nesting exceeds 32 levels; flatten the geometry collections');
    const g=object(input);
    if(g.type==='FeatureCollection'){if(!Array.isArray(g.features))throw designError('GeoJSON FeatureCollection needs a features array');g.features.forEach((f,i)=>visit(f,{},String(i),depth+1));}
    else if(g.type==='Feature'){if(g.geometry!==null)visit(g.geometry,{...tags(g.properties),...tags(g.properties==null?undefined:object(g.properties).tags)},(typeof g.id==='string'||typeof g.id==='number')?String(g.id):id,depth+1);}
    else if(g.type==='GeometryCollection'){if(!Array.isArray(g.geometries))throw designError('GeoJSON GeometryCollection needs geometries');g.geometries.forEach((v,i)=>visit(v,properties,`${id}/${i}`,depth+1));}
    else if(g.type==='LineString'||g.type==='MultiLineString'){
      const lines=g.type==='LineString'?[g.coordinates]:g.coordinates;
      if(!Array.isArray(lines))throw designError('GeoJSON road needs coordinate arrays');
      for(const [i,line] of lines.entries()){
        if(!Array.isArray(line)||line.length<2)throw designError('GeoJSON road needs at least two positions');
        sources.push({id:g.type==='LineString'?id:`${id}/${i}`,coordinates:line.map(coordinate),tags:{...properties,...tags(object(g).tags)}});
      }
    }else if(!['Point','MultiPoint','Polygon','MultiPolygon'].includes(String(g.type)))throw designError('Unsupported GeoJSON type; supply standard GeoJSON geometries');
    if(sources.length>65536)throw designError('Road import exceeds 65536 source lines; split the dataset');
  };
  visit(document);return network(sources,options,false);
}

/** Read OSM 0.6 XML or Overpass JSON elements, preserving explicit node topology and grade separation. */
export function importOSM(document:unknown,options:RoadImportOptions={}):RoadNetwork {
  options.signal?.throwIfAborted();const elements=typeof document==='string'?osmXML(document):object(document).elements;
  if(!Array.isArray(elements)||elements.length>1_000_000)throw designError('OSM import needs up to one million nodes/ways in XML or Overpass elements');
  const nodes=new Map<string,{p:number[];tags:Record<string,string>}>(),ways:RecordValue[]=[],seen=new Set<string>();
  for(const raw of elements){const e=object(raw);if(e.type!=='node'&&e.type!=='way')continue;
    const id=identifier(e.id),key=`${e.type}/${id}`;if(seen.has(key))throw designError('Duplicate OSM identity; import one snapshot, not history');seen.add(key);
    if(e.visible===false||e.visible==='false')continue;
    if(e.type==='node')nodes.set(id,{p:coordinate([e.lon,e.lat]),tags:tags(e.tags)});else ways.push(e);
  }
  const sources:Source[]=[];
  for(const w of ways){const t=tags(w.tags);if(!t.highway||t.area==='yes')continue;
    if(!Array.isArray(w.nodes)||w.nodes.length<2)throw designError('OSM road way needs two or more node references');
    const ids=w.nodes.map(identifier),coordinates=ids.map(id=>{
      const n=nodes.get(id);if(!n)throw designError(`OSM road references missing node ${id}; download complete ways`);
      const raw=n.tags.ele,altitude=raw===undefined?0:/^[+-]?\d+(?:\.\d+)?(?:\s*m)?$/.test(raw.trim())?Number(raw.replace(/\s*m$/,'')):NaN;
      if(!bounded(altitude,-100000,100000))throw designError('Invalid OSM elevation; supply signed metres within +/-100000');return [n.p[0],n.p[1],altitude];
    });sources.push({id:`way/${identifier(w.id)}`,coordinates,ids,tags:t});
  }
  return network(sources,options,true);
}

function network(sources:Source[],options:RoadImportOptions,osm:boolean):RoadNetwork {
  const {signal,project,crossingHeight=0.5}=options;
  if(!bounded(crossingHeight,0,100)||project!==undefined&&typeof project!=='function')throw designError('Invalid import options; use a projector function and crossingHeight 0..100 metres');
  const origin=project?null:coordinate(options.origin??sources[0]?.coordinates[0]??[0,0,0]) as [number,number,number];
  const geographic=(p:number[])=>{if(!bounded(p[0],-180,180)||!bounded(p[1],-90,90)||!bounded(p[2],-100000,100000))throw designError('Invalid WGS84 position; use lon +/-180, lat +/-90, altitude +/-100000');};
  const ecef=(p:number[])=>{
    geographic(p);const lon=p[0]*Math.PI/180,lat=p[1]*Math.PI/180,s=Math.sin(lat),n=6378137/Math.sqrt(1-0.0066943799901413165*s*s);
    return [(n+p[2])*Math.cos(lat)*Math.cos(lon),(n+p[2])*Math.cos(lat)*Math.sin(lon),(n*(1-0.0066943799901413165)+p[2])*s];
  };
  const o=origin?ecef(origin):[0,0,0],lon=(origin?.[0]??0)*Math.PI/180,lat=(origin?.[1]??0)*Math.PI/180;
  const convert=(p:number[]):Point3=>{
    let v:readonly number[];
    if(project)v=project([...p]);else{const q=ecef(p).map((x,k)=>x-o[k]),east=-Math.sin(lon)*q[0]+Math.cos(lon)*q[1],north=-Math.sin(lat)*Math.cos(lon)*q[0]-Math.sin(lat)*Math.sin(lon)*q[1]+Math.cos(lat)*q[2],up=Math.cos(lat)*Math.cos(lon)*q[0]+Math.cos(lat)*Math.sin(lon)*q[1]+Math.sin(lat)*q[2];v=[east,up,-north];}
    if(!Array.isArray(v)||v.length!==3||!v.every(x=>bounded(x,-1e6,1e6)))throw designError('Projected road must stay within +/-1000000 metres; choose a nearby origin');return v.map(x=>x+0) as [number,number,number];
  };
  const warnings:string[]=[],segments:Segment[]=[];
  const geoKey=(p:Point3,layer:number)=>`g/${layer}/${p.map(x=>x.toFixed(6)).join('/')}`;
  let count=0;
  for(const source of sources){
    if((count+=source.coordinates.length)>1_000_000)throw designError('Road import exceeds one million positions; split the dataset');
    const meta=metadata(source,options,warnings),points=source.coordinates.map(convert);
    for(let i=0;i<points.length-1;i++){
      const a=points[i],b=points[i+1];if(a.every((v,k)=>v===b[k])){warnings.push(`${source.id}: omitted zero-length segment ${i}`);continue;}
      const ka=osm?`n/${source.ids![i]}`:geoKey(a,meta.layer),kb=osm?`n/${source.ids![i+1]}`:geoKey(b,meta.layer);
      segments.push({source,a,b,ka,kb,meta,cuts:[{t:0,p:a,key:ka},{t:1,p:b,key:kb}]});
    }
  }
  if(!osm) splitCrossings(segments,crossingHeight,geoKey);
  const nodes:Point3[]=[],roads:ImportedRoad[]=[],ids=new Map<string,number>();
  const node=(key:string,p:Point3)=>{let i=ids.get(key);if(i===undefined){if(nodes.length>=65536)throw designError('Road network exceeds 65536 nodes; split the dataset');i=nodes.length;ids.set(key,i);nodes.push([...p] as [number,number,number]);}return i;};
  for(const s of segments){s.cuts.sort((a,b)=>a.t-b.t);for(let i=0;i<s.cuts.length-1;i++){
    const a=s.cuts[i],b=s.cuts[i+1];if(a.key===b.key||a.t===b.t)continue;
    const from=node(a.key,a.p),to=node(b.key,b.p),points:[Point3,Point3]=[[...nodes[from]] as Point3,[...nodes[to]] as Point3];
    if(roads.length>=65536)throw designError('Road network exceeds 65536 edges; split the dataset');
    roads.push({...s.meta,laneWidths:[...s.meta.laneWidths],sourceId:s.source.id,from,to,points,curve:new Spline(points),tags:{...s.source.tags}});
  }}
  signal?.throwIfAborted();return {nodes,roads,origin:sources.length?origin:null,warnings};
}

function splitCrossings(segments:Segment[],height:number,key:(p:Point3,layer:number)=>string):void {
  const ordered=segments.slice().sort((a,b)=>Math.min(a.a[0],a.b[0])-Math.min(b.a[0],b.b[0]));
  let pairs=0;
  const aliases=new Map<string,string>();
  const resolve=(id:string)=>{const path:string[]=[];while(aliases.has(id)){path.push(id);id=aliases.get(id)!;}for(const p of path)aliases.set(p,id);return id;};
  const interpolate=(s:Segment,t:number):Point3=>s.a.map((v,k)=>v+(s.b[k]-v)*t) as [number,number,number];
  const cut=(a:Segment,b:Segment,t:number,u:number)=>{
    if(t<0||t>1||u<0||u>1)return;const p=interpolate(a,t),q=interpolate(b,u);if(Math.abs(p[1]-q[1])>height)return;
    const at=t===0?a.ka:t===1?a.kb:undefined,bt=u===0?b.ka:u===1?b.kb:undefined;
    const shared=resolve(at??bt??key(p,a.meta.layer)),v=t===0?a.a:t===1?a.b:u===0?b.a:u===1?b.b:p;
    if(at&&resolve(at)!==shared)aliases.set(resolve(at),shared);
    if(bt&&resolve(bt)!==shared)aliases.set(resolve(bt),shared);
    // Explicit vertex ownership also joins a T endpoint to a segment interior.
    a.cuts.push({t,p:v,key:shared});b.cuts.push({t:u,p:v,key:shared});
  };
  for(let i=0;i<ordered.length;i++){const a=ordered[i],maxX=Math.max(a.a[0],a.b[0]);for(let j=i+1;j<ordered.length;j++){
    const b=ordered[j];if(Math.min(b.a[0],b.b[0])>maxX)break;
    if(++pairs>2_000_000)throw designError('GeoJSON crossing search exceeds two million candidates; spatially tile the input');
    if(a.meta.layer!==b.meta.layer||Math.max(a.a[2],a.b[2])<Math.min(b.a[2],b.b[2])||Math.max(b.a[2],b.b[2])<Math.min(a.a[2],a.b[2]))continue;
    const ax=a.b[0]-a.a[0],az=a.b[2]-a.a[2],bx=b.b[0]-b.a[0],bz=b.b[2]-b.a[2],dx=b.a[0]-a.a[0],dz=b.a[2]-a.a[2],det=ax*bz-az*bx;
    if(det!==0)cut(a,b,(dx*bz-dz*bx)/det,(dx*az-dz*ax)/det);
    else if(dx*az-dz*ax===0){
      const aa=ax*ax+az*az,bb=bx*bx+bz*bz;
      if(!aa||!bb)continue;
      for(const t of [0,1]){const p=interpolate(a,t);cut(a,b,t,((p[0]-b.a[0])*bx+(p[2]-b.a[2])*bz)/bb);}
      for(const u of [0,1]){const p=interpolate(b,u);cut(a,b,((p[0]-a.a[0])*ax+(p[2]-a.a[2])*az)/aa,u);}
    }
  }}
  for(const s of segments)for(const c of s.cuts)c.key=resolve(c.key);
}

function osmXML(source:string):RecordValue[] {
  if(source.length>32*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(source))throw designError('OSM XML exceeds 32 MiB or contains a DTD; use a bounded plain OSM snapshot');
  const elements:RecordValue[]=[],stack:string[]=[],token=/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+/g;
  let current:RecordValue|undefined,last=0,root=false;
  const decode=(s:string)=>{if(/&(?![^&;]+;)/.test(s))throw designError('Unescaped XML ampersand; use an XML entity');return s.replace(/&([^;]+);/g,(_all,k:string)=>{const fixed:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(fixed,k))return fixed[k];if(/^#(?:\d+|x[\da-f]+)$/i.test(k)){const n=k[1].toLowerCase()==='x'?parseInt(k.slice(2),16):Number(k.slice(1));if(n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff))return String.fromCodePoint(n);}throw designError('Invalid XML entity; use standard or numeric entities');});};
  for(const m of source.matchAll(token)){
    if(m.index!==last)throw designError('Malformed OSM XML; fix incomplete markup');last=m.index+m[0].length;const text=m[0];
    if(text.startsWith('<!--')||text.startsWith('<?'))continue;if(!text.startsWith('<')){if(!stack.length&&text.trim())throw designError('OSM XML has text outside its root');continue;}
    if(text.startsWith('</')){const name=text.slice(2,-1).trim();if(stack.pop()!==name)throw designError('OSM XML closing tag mismatch; supply well-formed XML');if(name==='node'||name==='way')current=undefined;continue;}
    const match=/^<([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(text);if(!match)throw designError('Invalid OSM XML tag; supply well-formed XML');
    const [,name,body,closed]=match,attrs:Record<string,string>=Object.create(null),attribute=/\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let offset=0;while(offset<body.length){attribute.lastIndex=offset;const a=attribute.exec(body);if(!a){if(body.slice(offset).trim()==='')break;throw designError('Invalid OSM XML attributes; quote each value');}if(Object.hasOwn(attrs,a[1]))throw designError('Duplicate XML attribute; supply well-formed XML');attrs[a[1]]=decode(a[2]??a[3]);offset=attribute.lastIndex;}
    if(!stack.length){if(root||name!=='osm')throw designError('OSM XML needs one osm root');root=true;}
    const parent=stack.at(-1);
    if(parent==='osm'&&(name==='node'||name==='way')){current={...attrs,type:name,tags:Object.create(null)};if(name==='node'){if(!attrs.lon?.trim()||!attrs.lat?.trim())throw designError('OSM node needs numeric longitude and latitude');current.lon=Number(attrs.lon);current.lat=Number(attrs.lat);}else current.nodes=[];elements.push(current);}
    else if(current&&parent===current.type&&name==='tag'){if(attrs.k===undefined||attrs.v===undefined)throw designError('OSM tag needs k and v');(current.tags as Record<string,string>)[attrs.k]=attrs.v;}
    else if(current&&parent==='way'&&name==='nd'){if(attrs.ref===undefined)throw designError('OSM nd needs a ref');(current.nodes as string[]).push(attrs.ref);}
    if(!closed)stack.push(name);else if(name==='node'||name==='way')current=undefined;
    if(elements.length>1_000_000)throw designError('OSM XML exceeds one million elements; split the dataset');
  }
  if(last!==source.length||stack.length||!root)throw designError('Truncated OSM XML; supply a complete osm document');return elements;
}

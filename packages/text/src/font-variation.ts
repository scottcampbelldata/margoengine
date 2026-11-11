import { BinaryReader as Reader, fontError } from './font-reader.js';

/** A design axis in the font's user coordinate system. */
export interface FontVariationAxis {
  /** Four-character OpenType axis tag. */
  tag: string;
  /** Minimum supported value. */
  min: number;
  /** Default design value. */
  default: number;
  /** Maximum supported value. */
  max: number;
}

/** Instance coordinates in the font's fvar user units; omitted axes use their defaults. */
export interface FontVariationOptions {
  /** Axis tag to design value, clamped to the supported range. Default {}. */
  variations?: Readonly<Record<string, number>>;
}

const tail = (r: Reader, offset: number) => r.slice(offset, r.length - offset);
const f2 = (r: Reader) => r.i16() / 16384;
/** a*b/c of 16.16 integers, rounded half away from zero (all three fit 2^17, so the product is exact in a double). */
const mulDiv = (a: number, b: number, c: number) => { const q = a * b / c; return Math.sign(q) * Math.round(Math.abs(q)); };

/** Internal OpenType ItemVariationStore, shared by CFF2 blending and HVAR widths. */
export class FontItemStore {
  private readonly regions: number[];
  private readonly offsets: number[];
  private readonly reader: Reader;
  constructor(reader: Reader, coordinates: readonly number[]) {
    this.reader = reader;
    reader.seek(0);
    if (reader.u16() !== 1) fontError('ItemVariationStore format must be 1');
    const regionOffset = reader.u32(), count = reader.u16();
    reader.check(reader.pos, count * 4);
    this.offsets = Array.from({ length: count }, () => reader.u32());
    const regions = tail(reader, regionOffset), axes = regions.u16(), n = regions.u16();
    if (axes !== coordinates.length) fontError('variation region axis count differs from fvar');
    regions.check(regions.pos, n * axes * 6);
    this.regions = Array.from({ length: n }, () => {
      let scalar = 1;
      for (let a = 0; a < axes; a++) {
        const start = f2(regions), peak = f2(regions), end = f2(regions), v = coordinates[a];
        // Invalid/cross-zero supports do not participate for this axis, per OpenType.
        if (start > peak || peak > end || (start < 0 && end > 0 && peak !== 0) || peak === 0) continue;
        if (v < start || v > end) scalar = 0;
        else if (v !== peak) scalar *= v < peak ? (v-start)/(peak-start) : (end-v)/(end-peak);
      }
      return scalar;
    });
  }
  private row(outer: number) {
    if (!Number.isInteger(outer) || outer < 0 || outer >= this.offsets.length) fontError('variation data index is invalid');
    if (this.offsets[outer] === 0) return {r:this.reader.slice(0,0),count:0,weights:[],long:false,wordCount:0};
    const r = tail(this.reader, this.offsets[outer]);
    const count = r.u16(), words = r.u16(), regions = r.u16();
    const long = !!(words & 0x8000), wordCount = words & 0x7fff;
    if (wordCount > regions) fontError('variation word count exceeds region count');
    r.check(r.pos, regions * 2);
    const weights = Array.from({length:regions}, () => {
      const i = r.u16();
      if (i >= this.regions.length) fontError('variation region index is invalid');
      return this.regions[i];
    });
    return {r,count,weights,long,wordCount};
  }
  weights(outer: number): number[] { return this.row(outer).weights; }
  delta(outer: number, inner: number): number {
    const {r,count,weights,long,wordCount} = this.row(outer);
    if (count === 0 && weights.length === 0 && this.offsets[outer] === 0) return 0;
    if (!Number.isInteger(inner) || inner < 0 || inner >= count) fontError('variation delta-set index is invalid');
    const stride = wordCount * (long ? 4 : 2) + (weights.length-wordCount) * (long ? 2 : 1);
    r.skip(inner * stride);
    let value = 0;
    for (let i=0;i<weights.length;i++) value += weights[i] * (i < wordCount ? (long ? r.i32() : r.i16()) : (long ? r.i16() : r.i8()));
    return value;
  }
}

function mappedIndex(r: Reader, offset: number, index: number): [number, number] {
  if (!offset) return [0,index];
  const map=tail(r,offset),format=map.u8(),entry=map.u8();
  if (format !== 0 && format !== 1) fontError('DeltaSetIndexMap format is unsupported');
  const count=format===0?map.u16():map.u32(),size=((entry>>4)&3)+1,bits=(entry&15)+1;
  if (!count || bits > size*8 || entry&0xc0) fontError('DeltaSetIndexMap encoding is invalid');
  map.skip(Math.min(index,count-1)*size);
  let value=0;
  for(let i=0;i<size;i++) value=value*256+map.u8();
  return [Math.floor(value/2**bits),value%(2**bits)];
}

/** Internal normalized instance, metrics and glyph tuple variations. */
export class FontVariations {
  readonly axes: FontVariationAxis[]=[];
  readonly coordinates: number[]=[];
  /** 16.16 normalized coordinates before the final F2Dot14 step. */
  private readonly fixed: number[]=[];
  private readonly hvar?: {reader:Reader;store:FontItemStore;map:number};
  private readonly gvar?: {reader:Reader;offsets:number[];tuples:number[][];base:number};
  constructor(tables: Map<string,Reader>, glyphCount:number, values:Readonly<Record<string,number>>={}) {
    const fvar=tables.get('fvar');
    if (fvar) {
      fvar.seek(0);
      if(fvar.u16()!==1) fontError('fvar major version is unsupported');
      fvar.u16();const offset=fvar.u16();fvar.u16();const count=fvar.u16(),size=fvar.u16();
      if(size<20) fontError('fvar axis record is too small');
      fvar.check(offset,count*size);
      for(let i=0;i<count;i++) {
        fvar.seek(offset+i*size);
        const tag=fvar.tag(),min=fvar.i32(),def=fvar.i32(),max=fvar.i32();
        const axis={tag,min:min/65536,default:def/65536,max:max/65536};
        if(axis.min>axis.default||axis.default>axis.max||this.axes.some(a=>a.tag===axis.tag)) fontError('fvar axis bounds or tags are invalid');
        const user=values[axis.tag]??axis.default;
        if(!Number.isFinite(user)) fontError('variation axis value is not finite');
        // OpenType "Coordinate scales and normalization": the user value as 16.16 Fixed, clamped, then the default
        // normalization in 16.16 (kept here as a 16.16 integer until the final F2Dot14 step below).
        const v=Math.max(min,Math.min(max,Math.round(user*65536)));
        this.axes.push(axis);
        this.fixed.push(v===def?0:v<def?-mulDiv(def-v,65536,def-min):mulDiv(v-def,65536,max-def));
      }
    }
    for(const key of Object.keys(values)) if(!this.axes.some(a=>a.tag===key)) fontError(`variation axis ${key} is absent from fvar`);
    const avar=tables.get('avar');
    if(avar) {
      avar.seek(0);const major=avar.u16();avar.u16();avar.u16();
      if(major!==1 || avar.u16()!==this.axes.length) fontError('avar version or axis count is invalid');
      for(let i=0;i<this.axes.length;i++) {
        const count=avar.u16(),pairs:number[][]=[];
        avar.check(avar.pos,count*4);
        // OpenType avar: a record whose from (or to) does not increase on the last kept one may be ignored; a map
        // without all of -1 to -1, 0 to 0 and 1 to 1 (an empty map included) leaves the axis unmodified.
        // Map values are F2Dot14, widened to 16.16 (x4) so the interpolation runs in 16.16 like the normalization.
        for(let j=0;j<count;j++){const p=[avar.i16()*4,avar.i16()*4],last=pairs[pairs.length-1];if(!last||(p[0]>last[0]&&p[1]>=last[1]))pairs.push(p);}
        if(![-65536,0,65536].every(v=>pairs.some(p=>p[0]===v&&p[1]===v))) continue;
        for(let j=1;j<pairs.length;j++) {
          const v=this.fixed[i];
          if(v>=pairs[j-1][0]&&v<=pairs[j][0]) {
            this.fixed[i]=pairs[j-1][1]+mulDiv(v-pairs[j-1][0],pairs[j][1]-pairs[j-1][1],pairs[j][0]-pairs[j-1][0]);
            break;
          }
        }
      }
    }
    // The final normalized coordinate is F2Dot14: (v + 2) >> 2 of the 16.16 value (OpenType, same section).
    for(const v of this.fixed) this.coordinates.push(((v+2)>>2)/16384);
    const hvar=tables.get('HVAR');
    if(hvar) {
      hvar.seek(0);if(hvar.u16()!==1)fontError('HVAR version is unsupported');hvar.u16();
      const store=hvar.u32(),map=hvar.u32();
      this.hvar={reader:hvar,store:new FontItemStore(tail(hvar,store),this.coordinates),map};
    }
    const gvar=tables.get('gvar');
    if(gvar) {
      gvar.seek(0);if(gvar.u16()!==1)fontError('gvar version is unsupported');gvar.u16();
      const axes=gvar.u16(),shared=gvar.u16(),sharedOffset=gvar.u32(),glyphs=gvar.u16(),flags=gvar.u16(),base=gvar.u32();
      if(axes!==this.axes.length||glyphs!==glyphCount) fontError('gvar axis or glyph count differs from font');
      gvar.check(gvar.pos,(glyphs+1)*(flags&1?4:2));
      const offsets=Array.from({length:glyphs+1},()=>flags&1?gvar.u32():2*gvar.u16());
      for(let i=0;i<glyphs;i++) if(offsets[i]>offsets[i+1])fontError('gvar offsets are not monotone');
      gvar.check(base,offsets[glyphs]);
      const tuplesReader=tail(gvar,sharedOffset);
      tuplesReader.check(0,shared*axes*2);
      const tuples=Array.from({length:shared},()=>Array.from({length:axes},()=>f2(tuplesReader)));
      this.gvar={reader:gvar,offsets,tuples,base};
    }
  }
  advance(glyph:number):number|undefined {
    if(!this.hvar)return undefined;
    return this.hvar.store.delta(...mappedIndex(this.hvar.reader,this.hvar.map,glyph));
  }
  get hasGlyphVariations():boolean { return !!this.gvar; }
  deltas(glyph:number,points:readonly (readonly number[])[],ends:readonly number[],composite=false):[number[],number[]] {
    const count=points.length+4,dx=new Array<number>(count).fill(0),dy=new Array<number>(count).fill(0),g=this.gvar;
    if(!g||g.offsets[glyph]===g.offsets[glyph+1])return [dx,dy];
    const r=g.reader.slice(g.base+g.offsets[glyph],g.offsets[glyph+1]-g.offsets[glyph]);
    const flags=r.u16(),dataOffset=r.u16(),headers:Array<{size:number;index:number;peak:number[];start?:number[];end?:number[]}>=[];
    const tuple=()=>Array.from({length:this.axes.length},()=>f2(r));
    for(let i=0;i<(flags&0xfff);i++) {
      const size=r.u16(),index=r.u16(),peak=index&0x8000?tuple():g.tuples[index&0xfff];
      if(!peak)fontError('gvar shared tuple index is invalid');
      const start=index&0x4000?tuple():undefined,end=index&0x4000?tuple():undefined;
      headers.push({size,index,peak,start,end});
    }
    if(r.pos>dataOffset)fontError('gvar tuple headers overlap data');
    r.seek(dataOffset);
    const sharedPoints=flags&0x8000?packedPoints(r,count):null;
    let pos=r.pos;
    for(const h of headers) {
      const data=r.slice(pos,h.size);pos+=h.size;
      const selected=h.index&0x2000?packedPoints(data,count):sharedPoints;
      const n=selected?.length??count,x=packedDeltas(data,n),y=packedDeltas(data,n);
      let scalar=1;
      // The region scalar of the OpenType variations overview; a non-intermediate region spans zero to its peak.
      for(let a=0;a<this.axes.length;a++) {
        const v=this.coordinates[a],peak=h.peak[a],start=h.start?h.start[a]:Math.min(peak,0),end=h.end?h.end[a]:Math.max(peak,0);
        if(start>peak||peak>end||(start<0&&end>0&&peak!==0)||peak===0)continue;
        if(v<start||v>end){scalar=0;break;}
        if(v!==peak)scalar*=v<peak?(v-start)/(peak-start):(end-v)/(end-peak);
      }
      if(!scalar)continue;
      const xs=new Array<number|undefined>(count),ys=new Array<number|undefined>(count);
      // A repeated point number carries several deltas, applied cumulatively (OpenType packed point numbers).
      for(let i=0;i<n;i++){const at=selected?.[i]??i;xs[at]=(xs[at]??0)+x[i];ys[at]=(ys[at]??0)+y[i];}
      if(selected&&!composite){iup(points,ends,xs,0);iup(points,ends,ys,1);}
      for(let i=0;i<count;i++){dx[i]+=(xs[i]??0)*scalar;dy[i]+=(ys[i]??0)*scalar;}
    }
    return [dx,dy];
  }
}

function packedPoints(r:Reader,total:number):number[]|null {
  let count=r.u8();if(!count)return null;if(count&0x80)count=((count&0x7f)<<8)|r.u8();
  if(count>total)fontError('gvar point count exceeds glyph points');
  const out:number[]=[];let value=0;
  while(out.length<count){const run=r.u8(),n=(run&0x7f)+1;if(out.length+n>count)fontError('gvar point run exceeds its count');
    for(let i=0;i<n;i++){value+=run&0x80?r.u16():r.u8();if(value>=total)fontError('gvar point index is invalid');out.push(value);}}
  return out;
}
function packedDeltas(r:Reader,count:number):number[] {
  const out:number[]=[];
  while(out.length<count){const run=r.u8(),n=(run&63)+1;if(out.length+n>count)fontError('gvar delta run exceeds its count');
    for(let i=0;i<n;i++)out.push(run&0x80?0:run&0x40?r.i16():r.i8());}
  return out;
}
function iup(points:readonly (readonly number[])[],ends:readonly number[],deltas:Array<number|undefined>,axis:number) {
  let start=0;
  for(const end of ends) {
    const refs:number[]=[];for(let i=start;i<=end;i++)if(deltas[i]!==undefined)refs.push(i);
    if(refs.length===1)for(let i=start;i<=end;i++)deltas[i]=deltas[refs[0]];
    else if(refs.length>1)for(let j=0;j<refs.length;j++) {
      const a=refs[j],b=refs[(j+1)%refs.length];let i=a===end?start:a+1;
      while(i!==b) {
        let low=a,high=b;if(points[low][axis]>points[high][axis])[low,high]=[high,low];
        const lo=points[low][axis],hi=points[high][axis],v=points[i][axis],dl=deltas[low]!,dh=deltas[high]!;
        deltas[i]=lo===hi?(dl===dh?dl:0):v<=lo?dl:v>=hi?dh:dl+(dh-dl)*(v-lo)/(hi-lo);
        i=i===end?start:i+1;
      }
    }
    start=end+1;
  }
}

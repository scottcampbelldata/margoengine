import type { HTMLResourceInliner } from './texture.js';
import { inlineCopy } from './dom.js';
import { margoError } from '../../shared/errors.js';

/** Options for a self-contained foreignObject snapshot. No network operation starts until called. */
export interface InlineResourceOptions {
  signal?: AbortSignal;
  /** Whole snapshot's network/read deadline in milliseconds, default 15000. */
  timeout?: number;
  /** Explicit @font-face CSS instead of document-sheet discovery; URLs resolve against the element's baseURI. */
  fontCSS?: string;
}
const unescapeCSS = (text:string) => text.replace(/\\(?:\r\n|[\n\r\f])/g,'').replace(/\\([\da-f]{1,6}\s?|.)/gi,(_,value:string)=>{
  if(!/^[\da-f]/i.test(value)) return value;
  const n=parseInt(value,16);
  return String.fromCodePoint(n===0||n>0x10ffff||(n>=0xd800&&n<=0xdfff)?0xfffd:n);
});
const family = (name:string) => unescapeCSS(name.trim().replace(/^(['"])(.*)\1$/,'$2')).toLowerCase();
// Consume strings/escapes before url tokens, so text like content:"url(example)" remains ordinary text.
async function rewriteCSS(text:string, resolve:(url:string)=>Promise<string>):Promise<string> {
  const edits:{start:number;end:number;value:Promise<string>}[]=[];
  for(let i=0;i<text.length;) {
    if(text.startsWith('/*',i)) {const end=text.indexOf('*/',i+2);i=end<0?text.length:end+2;continue;}
    if(text[i]==='"'||text[i]==="'") {
      const quote=text[i++];
      while(i<text.length) {if(text[i++]==='\\')i++;else if(text[i-1]===quote)break;}
      continue;
    }
    if(text.slice(i,i+4).toLowerCase()!=='url(' || (i>0&&/[\w-]/.test(text[i-1]))) {i++;continue;}
    const start=i;i+=4;
    while(/\s/.test(text[i]??'')&&i<text.length)i++;
    const quote=text[i]==='"'||text[i]==="'"?text[i++]:null,begin=i;
    while(i<text.length) {
      if(text[i]==='\\') {i+=2;continue;}
      if(quote?text[i]===quote:text[i]===')')break;
      i++;
    }
    const url=unescapeCSS(text.slice(begin,i).trim());
    if(quote) {i++;while(i<text.length&&/\s/.test(text[i]))i++;}
    if(text[i]!==')')continue;
    i++;
    edits.push({start,end:i,value:resolve(url).then(value=>`url(${JSON.stringify(value)})`)});
  }
  const values=await Promise.all(edits.map(edit=>edit.value));
  let result='',at=0;
  edits.forEach((edit,i)=>{result+=text.slice(at,edit.start)+values[i];at=edit.end;});
  return result+text.slice(at);
}

/** Fetches same-origin/CORS images and fonts into a styled detached copy; never mutates the live source. */
export async function inlineResources(element:HTMLElement,options:InlineResourceOptions={}):Promise<HTMLElement> {
  const timeout=options.timeout??15000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>2147483647)
    throw new RangeError('Invalid inline timeout; pass whole milliseconds from 1 to 2147483647');
  options.signal?.throwIfAborted();
  const deadline=AbortSignal.timeout(timeout),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
  const doc=element.ownerDocument,view=doc.defaultView!,copy=inlineCopy(element) as HTMLElement,
    resources=new Map<string,Promise<{data:string;text:string}>>(),used=new Set<string>();
  const load=(address:string)=>{
    let result=resources.get(address);
    if(!result) {
      result=(async()=>{
        try {
          const response=await fetch(address,{mode:'cors',credentials:'same-origin',signal});
          if(!response.ok)throw margoError('failed',`Resource ${address} returned ${response.status}; serve a successful CORS response`);
          const bytes=await response.arrayBuffer();
          signal.throwIfAborted();
          const data=await new Promise<string>((resolve,reject)=>{
            const reader=new view.FileReader(),abort=()=>reader.abort();
            const clean=()=>signal.removeEventListener('abort',abort);
            reader.onload=()=>{clean();resolve(String(reader.result));};
            reader.onerror=()=>{clean();reject(reader.error);};
            reader.onabort=()=>{clean();reject(signal.reason);};
            signal.addEventListener('abort',abort,{once:true});
            reader.readAsDataURL(new view.Blob([bytes],{type:response.headers.get('content-type')??'application/octet-stream'}));
          });
          return {data,text:new TextDecoder().decode(bytes)};
        } catch(error) {
          if(signal.aborted)throw signal.reason;
          throw margoError('failed',`Could not inline ${address}: ${String(error)}; serve it same-origin or with CORS`);
        }
      })();
      resources.set(address,result);
    }
    return result;
  };
  const embed=async(url:string,base:string)=>{
    if(!url||url.startsWith('#')||/^data:/i.test(url))return url;
    signal.throwIfAborted();
    const address=new URL(url,base),hash=address.hash;address.hash='';
    return (await load(address.href)).data+hash;
  };
  const originals=[element,...element.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];
  await Promise.all(originals.map(async(source,index)=>{
    const target=copies[index],base=source.baseURI,style=view.getComputedStyle(source);
    for(const name of style.fontFamily.split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/))used.add(family(name));
    const css=target.getAttribute('style');
    if(css)target.setAttribute('style',await rewriteCSS(css,url=>embed(url,base)));
    if(source instanceof view.HTMLImageElement) {
      target.removeAttribute('srcset');target.removeAttribute('sizes');
      const src=source.currentSrc||source.getAttribute('src');
      if(src)target.setAttribute('src',await embed(src,base));
    } else if(source instanceof view.HTMLSourceElement) target.removeAttribute('srcset');
    else if(source instanceof view.HTMLInputElement && source.type==='image') {
      const src=source.getAttribute('src');if(src)target.setAttribute('src',await embed(src,base));
    } else if(source.namespaceURI==='http://www.w3.org/2000/svg'&&source.localName==='image') {
      for(const attribute of ['href','xlink:href']) {
        const src=source.getAttribute(attribute);if(src)target.setAttribute(attribute,await embed(src,base));
      }
    }
  }));
  // Computed styles are already copied. Original sheets must not override the embedded faces or refetch resources.
  for(const style of copy.querySelectorAll('style,link[rel="stylesheet"]'))style.remove();
  const fonts:string[]=[],seen=new Set<string>(),sheets=new Set<CSSStyleSheet>();
  const parse=async(text:string,base:string):Promise<CSSRule[]>=>{
    // A temporary non-matching sheet gives the browser ownership of CSS grammar. Make import URLs absolute first.
    text=text.replace(/(@import\s*)(["'])((?:\\.|[^\\])*?)\2/gi,(_all,prefix:string,_quote:string,url:string)=>
      `${prefix}url(${JSON.stringify(new URL(unescapeCSS(url),base).href)})`);
    text=await rewriteCSS(text,async url=>url.startsWith('#')?url:new URL(url,base).href);
    const style=doc.createElement('style');style.media='not all';style.textContent=text;
    doc.head.append(style);
    try{return Array.from(style.sheet!.cssRules);}finally{style.remove();}
  };
  const external=async(address:string):Promise<void>=>{
    if(seen.has(address))return;
    seen.add(address);
    await rules(await parse((await load(address)).text,address),address);
  };
  const sheet=async(value:CSSStyleSheet,base:string):Promise<void>=>{
    if(sheets.has(value))return;
    sheets.add(value);
    let list:CSSRule[];
    try{list=Array.from(value.cssRules);}catch(error){
      if((error as DOMException).name!=='SecurityError'||!value.href)throw error;
      return external(value.href);
    }
    await rules(list,value.href??base);
  };
  const rules=async(list:CSSRule[],base:string):Promise<void>=>{
    for(const rule of list) {
      signal.throwIfAborted();
      if(rule.type===5) {
        const face=rule as CSSFontFaceRule;
        if(used.has(family(face.style.getPropertyValue('font-family'))))
          fonts.push(await rewriteCSS(face.cssText,url=>embed(url,base)));
      } else if(rule.type===3) {
        const imported=rule as CSSImportRule,address=new URL(imported.href,base).href;
        await external(address);
      } else if('cssRules' in rule) await rules(Array.from((rule as CSSGroupingRule).cssRules),base);
    }
  };
  if(options.fontCSS!==undefined)await rules(await parse(options.fontCSS,element.baseURI),element.baseURI);
  else {
    const all=[...Array.from(doc.styleSheets),...Array.from(doc.adoptedStyleSheets??[])];
    for(const value of all)await sheet(value,element.baseURI);
  }
  if(fonts.length) {const style=doc.createElement('style');style.textContent=[...new Set(fonts)].join('\n');copy.prepend(style);}
  signal.throwIfAborted();
  return copy;
}

/** Creates HTMLTexture's prepare hook, combining caller cancellation with surface removal. */
export function resourceInliner(options:InlineResourceOptions={}):HTMLResourceInliner {
  return (element,signal)=>inlineResources(element,{...options,signal:options.signal?AbortSignal.any([signal,options.signal]):signal});
}

import {Engine} from '@margoengine/core';
import {createTheme,Ui,UiRenderer} from '@margoengine/ui';
import {LayoutDocument} from '@margoengine/ui/editor';
import {parseMarkup,parseStyleSheet} from '@margoengine/ui/markup';
import {demoStatus} from 'margo-demo-status';
import {containers,initialSource,numericWidgets,reference,textWidgets,themeOptions,widgetTypes} from './relay.js';

const by = id => document.getElementById(id);
const workspace = by('workspace'), board = by('artboard'), canvas = by('canvas');
const loading = by('loading'), failure = by('failure'), previewInput = by('preview-input');
const hierarchy = by('hierarchy'), frame = by('selection-frame'), code = by('source-code');
const session = new AbortController(), {signal} = session;
const status = demoStatus(workspace, loading, failure);
const query = new URLSearchParams(location.search);
const palette = [...document.querySelectorAll('[data-add]')];
const tabs = [...document.querySelectorAll('[data-source]')];
const model = new LayoutDocument(initialSource);
const ui = new Ui({width:reference[0],height:reference[1],scale:{reference,match:0,min:.25},
  theme:createTheme(themeOptions),font:{family:'system-ui, sans-serif',weight:550},reducedMotion:true});
const buttonIds = ['undo','redo','apply','export','open','move-up','move-down','delete'];
const textInput = by('property-text'), gapInput = by('property-gap'), valueInput = by('property-value'), parentInput = by('property-parent');
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const create = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
const on = (element,event,handler) => element.addEventListener(event,handler,{signal});
function activate(element,handler) {
  let finger, lastTouch;
  on(element,'pointerdown',event => {
    if (event.pointerType === 'touch' && event.isPrimary && !element.disabled) {
      finger = {id:event.pointerId,x:event.clientX,y:event.clientY};
    }
  });
  on(element,'pointercancel',() => { finger = undefined; });
  on(element,'pointerup',event => {
    if (finger?.id !== event.pointerId) return;
    const start = finger;
    finger = undefined;
    const hit = document.elementFromPoint(event.clientX,event.clientY);
    if (element.disabled || !element.contains(hit) || Math.hypot(event.clientX-start.x,event.clientY-start.y)>=8) return;
    lastTouch = {time:performance.now(),x:event.clientX,y:event.clientY};
    handler(event);
  });
  on(element,'click',event => {
    const duplicate = event.detail !== 0 && lastTouch && performance.now()-lastTouch.time<650 &&
      (event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents ||
      (!event.pointerType && event.isTrusted && Math.hypot(event.clientX-lastTouch.x,event.clientY-lastTouch.y)<4));
    if (!duplicate) handler(event);
  });
}
const editable = {
  markup: 'Margo UI markup',
  styles: 'Margo UI styles',
};
const drafts = {markup:undefined,styles:undefined};
let engine, renderer, screen, observer, resizeId, drawId, inDraw = false, redrawn = false, ready = false;
let selected = 'station', entries = new Map(), sourceMode = 'markup';
let revision = 0, paintedRevision = -1, firstRevision, firstComplete = false;
let drag, over, ignoreClickUntil = 0;

const note = message => { by('notice').textContent = message; };
function sourceNote(message) {
  by('source-note').textContent = message ?? (drafts[sourceMode] === undefined ? '' : 'Unapplied changes');
}
function reject(error) {
  const message = error instanceof Error ? error.message : String(error);
  note(message);
  return message;
}
function renderError(error) {
  if (signal.aborted || status.failed) return;
  ready = false;
  loading.hidden = true;
  failure.hidden = false;
  status.error(error);
  for (const element of [...palette,...buttonIds.map(by)]) element.disabled = true;
  if (query.has('inspect')) console.error(error);
}
function rebuildIndex() {
  const next = new Map();
  const descend = (nodes,parent,depth) => {
    nodes.forEach((node,index) => {
      const id = node.attributes.id;
      if (id && node.tag !== 'item') next.set(id,{id,tag:node.tag,node,parent,depth,index});
      descend(node.children,id ?? parent,depth+1);
    });
  };
  descend(model.tree,'',0);
  entries = next;
}
function belongsTo(id,ancestor) {
  while (id) {
    if (id === ancestor) return true;
    id = entries.get(id)?.parent;
  }
  return false;
}
function childrenOf(parent) {
  return [...entries.values()].filter(item => item.parent === parent);
}
function insertionParent() {
  const item = entries.get(selected);
  if (item && containers.has(item.tag)) return item.id;
  if (item?.parent) return item.parent;
  return [...entries.values()].find(item => containers.has(item.tag))?.id ?? '';
}
function layerCaption(item) {
  return item.node.attributes.text || item.node.text || item.id;
}
function updateSelectionFrame() {
  const rect = selected && screen?.get(selected)?.rect;
  frame.hidden = !rect?.width || !rect.height;
  if (frame.hidden) return;
  frame.style.left = (100*rect.x/ui.width)+'%';
  frame.style.top = (100*rect.y/ui.height)+'%';
  frame.style.width = (100*rect.width/ui.width)+'%';
  frame.style.height = (100*rect.height/ui.height)+'%';
}
function updateSelection() {
  const item = entries.get(selected);
  for (const row of hierarchy.children) {
    const active = row.dataset.id === selected;
    row.classList.toggle('is-selected',active);
    row.firstElementChild.setAttribute('aria-pressed',String(active));
  }
  by('current-type').textContent = item ? '<'+item.tag+'>' : '';
  by('inspector-empty').hidden = Boolean(item);
  by('properties').hidden = !item;
  workspace.dataset.selected = item?.id ?? '';
  updateSelectionFrame();
  if (!item) return;
  by('node-id').textContent = item.id;
  by('text-field').hidden = !textWidgets.has(item.tag);
  by('spacing-field').hidden = !containers.has(item.tag);
  by('value-field').hidden = !numericWidgets.has(item.tag);
  textInput.value = item.node.attributes.text ?? item.node.text ?? '';
  gapInput.value = item.node.attributes.gap?.split(' ')[0] ?? '';
  valueInput.value = item.node.attributes.value ?? '';
  parentInput.replaceChildren(new Option('Artboard',''));
  for (const candidate of entries.values()) {
    if (containers.has(candidate.tag) && !belongsTo(candidate.id,item.id)) {
      parentInput.add(new Option(candidate.id,candidate.id));
    }
  }
  parentInput.value = item.parent;
  const siblings = childrenOf(item.parent);
  const index = siblings.findIndex(sibling => sibling.id === item.id);
  by('move-up').disabled = index < 1;
  by('move-down').disabled = index === siblings.length-1;
  by('delete').disabled = false;
}
function select(id) {
  selected = entries.has(id) ? id : '';
  updateSelection();
}
function buildTree() {
  const rows = document.createDocumentFragment();
  for (const item of entries.values()) {
    const li = create('li'), title = create('button'), grip = create('button','⠿');
    li.className = 'layer';
    li.dataset.id = item.id;
    li.style.setProperty('--depth',item.depth);
    title.type = grip.type = 'button';
    title.className = 'layer-name';
    title.title = layerCaption(item);
    title.setAttribute('aria-label',layerCaption(item)+' ('+item.tag+')');
    title.append(create('span',item.tag),create('strong',layerCaption(item)));
    grip.className = 'grip';
    grip.title = 'Drag '+item.id;
    grip.setAttribute('aria-label',grip.title);
    activate(title,() => select(item.id));
    on(grip,'pointerdown',event => beginDrag(event,{kind:'move',id:item.id,caption:layerCaption(item)}));
    activate(grip,() => {
      if (performance.now() >= ignoreClickUntil) select(item.id);
    });
    li.append(title,grip);
    rows.append(li);
  }
  const scroll = hierarchy.scrollTop;
  hierarchy.replaceChildren(rows);
  hierarchy.scrollTop = scroll;
  by('node-count').textContent = entries.size+' elements';
}
function showSource() {
  by('source-label').textContent = editable[sourceMode];
  code.value = drafts[sourceMode] ?? model.source[sourceMode];
  by('apply').disabled = !ready || drafts[sourceMode] === undefined;
  sourceNote();
}
function refresh() {
  for (const widget of screen?.widgets ?? []) {
    ui.remove(widget);
    widget.dispose();
  }
  screen = model.build();
  ui.add(...screen.widgets);
  rebuildIndex();
  if (!entries.has(selected)) selected = '';
  buildTree();
  updateSelection();
  showSource();
  by('undo').disabled = !ready || !model.canUndo;
  by('redo').disabled = !ready || !model.canRedo;
  workspace.dataset.elements = String(entries.size);
  workspace.dataset.revision = String(++revision);
  scheduleDraw();
}
function run(event,operation,message) {
  if (!ready) return;
  const old = revision;
  try {
    operation();
    if (revision !== old && !firstRevision && event.isTrusted) firstRevision = revision;
    if (message) note(message);
  } catch (error) {
    reject(error);
  }
}
function insert(tag,parent = insertionParent(),index) {
  const recipe = widgetTypes[tag];
  const edit = new LayoutDocument(model.source);
  try {
    const id = edit.insert(tag,parent || undefined);
    if (recipe.text) edit.setText(id,recipe.text);
    for (const [name,value] of Object.entries(recipe.attributes)) edit.setAttribute(id,name,value);
    if (index !== undefined) edit.move(id,parent || undefined,index);
    model.apply(edit.source);
    select(id);
  } finally {
    edit.dispose();
  }
}
function move(id,parent,index) {
  if (belongsTo(parent,id)) return;
  model.move(id,parent || undefined,index);
  select(id);
}
function previewPoint(x,y) {
  const area = board.getBoundingClientRect();
  if (x < area.left || x > area.right || y < area.top || y > area.bottom) return null;
  return {x:(x-area.left)*ui.width/area.width,y:(y-area.top)*ui.height/area.height};
}
function widgetAt(point) {
  const ordered = [...entries.values()].sort((a,b) => b.depth-a.depth || b.index-a.index);
  return ordered.find(item => {
    const widget = screen.get(item.id), r = widget?.rect;
    return widget?.visible && r?.width > 0 && r?.height > 0 &&
      point.x >= r.x && point.x <= r.x+r.width && point.y >= r.y && point.y <= r.y+r.height;
  });
}
function slotAt(x,y,payload) {
  const point = previewPoint(x,y);
  if (point) {
    const item = widgetAt(point);
    if (!item || containers.has(item.tag)) {
      const parent = item?.id ?? insertionParent();
      if (payload.kind === 'move' && belongsTo(parent,payload.id)) return null;
      return {parent,index:childrenOf(parent).length,board:true};
    }
    const rect = screen.get(item.id).rect;
    const horizontal = entries.get(item.parent)?.tag === 'row';
    const after = horizontal ? point.x > rect.x+rect.width/2 : point.y > rect.y+rect.height/2;
    if (payload.kind === 'move' && belongsTo(item.parent,payload.id)) return null;
    return {parent:item.parent,index:item.index+Number(after),board:true};
  }
  const row = document.elementFromPoint(x,y)?.closest('.layer');
  if (!row || (payload.kind === 'move' && row.dataset.id === payload.id)) return null;
  const item = entries.get(row.dataset.id), r = row.getBoundingClientRect();
  const position = (y-r.top)/r.height;
  const into = containers.has(item.tag) && position > .23 && position < .77;
  const parent = into ? item.id : item.parent;
  if (payload.kind === 'move' && belongsTo(parent,payload.id)) return null;
  return {parent,index:into ? childrenOf(parent).length : item.index+Number(position >= .5),
    row,hint:into ? 'inside' : position >= .5 ? 'after' : 'before'};
}
function setOver(target) {
  if (over?.row) over.row.classList.remove('drop-'+over.hint);
  if (target?.row) target.row.classList.add('drop-'+target.hint);
  board.classList.toggle('is-over',Boolean(target?.board));
  over = target;
}
function beginDrag(event,payload) {
  if (!ready || drag || !event.isPrimary || event.button !== 0) return;
  const target = event.currentTarget;
  drag = {target,pointer:event.pointerId,payload,x:event.clientX,y:event.clientY,token:null};
  target.setPointerCapture(event.pointerId);
}
function dragging(event) {
  if (drag?.pointer !== event.pointerId) return;
  if (!drag.token && Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<7) return;
  if (!drag.token) {
    drag.token = create('span',drag.payload.caption);
    drag.token.className = 'drag-token';
    drag.token.setAttribute('aria-hidden','true');
    document.body.append(drag.token);
  }
  drag.token.style.transform = 'translate('+(event.clientX+10)+'px,'+(event.clientY+10)+'px)';
  setOver(slotAt(event.clientX,event.clientY,drag.payload));
}
function endDrag(event,cancelled = false) {
  if (!drag || drag.pointer !== event.pointerId) return;
  const {target,payload,token,pointer} = drag;
  const slot = !cancelled && token ? slotAt(event.clientX,event.clientY,payload) : null;
  drag = undefined;
  if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
  setOver(null);
  if (!token) return;
  token.remove();
  ignoreClickUntil = performance.now()+300;
  if (!slot) return;
  // Let touchend reach the captured control before a layer refresh replaces it.
  requestAnimationFrame(() => {
    if (signal.aborted) return;
    if (payload.kind === 'add') {
      run(event,() => insert(payload.tag,slot.parent,slot.index),payload.caption+' added.');
    } else {
      const item = entries.get(payload.id);
      if (!item) return;
      const index = slot.index-Number(item.parent === slot.parent && item.index < slot.index);
      run(event,() => move(item.id,slot.parent,index),'Layer moved.');
    }
  });
}
for (const button of palette) {
  const tag = button.dataset.add, {name} = widgetTypes[tag];
  on(button,'pointerdown',event => beginDrag(event,{kind:'add',tag,caption:name}));
  activate(button,event => {
    if (drag?.token || (performance.now() < ignoreClickUntil && event.type === 'click' && event.detail !== 0)) return;
    run(event,() => insert(tag),name+' added.');
  });
}
on(document,'pointermove',dragging);
on(document,'pointerup',event => endDrag(event));
on(document,'pointercancel',event => endDrag(event,true));
on(document,'lostpointercapture',event => endDrag(event,true));
activate(previewInput,event => {
  if (!ready || performance.now() < ignoreClickUntil) return;
  const point = previewPoint(event.clientX,event.clientY);
  select(point ? widgetAt(point)?.id : '');
});
on(textInput,'change',event => run(event,() => {
  const item = entries.get(selected);
  if (item.node.attributes.text === undefined) model.setText(item.id,textInput.value);
  else model.setAttribute(item.id,'text',textInput.value);
},'Text updated.'));
for (const [input,attribute] of [[gapInput,'gap'],[valueInput,'value']]) {
  on(input,'change',event => {
    if (!input.reportValidity()) return;
    run(event,() => model.setAttribute(selected,attribute,input.value || undefined),'Property updated.');
  });
}
on(parentInput,'change',event => run(event,() => {
  const parent = parentInput.value;
  move(selected,parent,childrenOf(parent).length);
},'Layer moved.'));
for (const [id,direction] of [['move-up',-1],['move-down',1]]) {
  activate(by(id),event => run(event,() => {
    const item = entries.get(selected), siblings = childrenOf(item.parent);
    const index = siblings.findIndex(sibling => sibling.id === item.id);
    if (siblings[index+direction]) move(item.id,item.parent,siblings[index+direction].index);
  },'Layer moved.'));
}
activate(by('delete'),event => run(event,() => {
  const item = entries.get(selected);
  model.remove(item.id);
  select(item.parent);
},'Layer deleted.'));
for (const direction of ['undo','redo']) {
  activate(by(direction),event => run(event,() => model[direction](),direction === 'undo' ? 'Edit undone.' : 'Edit restored.'));
}
for (const tab of tabs) {
  activate(tab,() => {
    sourceMode = tab.dataset.source;
    for (const candidate of tabs) candidate.setAttribute('aria-pressed',String(candidate === tab));
    showSource();
  });
}
on(code,'input',() => {
  drafts[sourceMode] = code.value === model.source[sourceMode] ? undefined : code.value;
  by('apply').disabled = drafts[sourceMode] === undefined || !ready;
  sourceNote();
});
activate(by('apply'),event => {
  const field = sourceMode, draft = drafts[field];
  if (!ready || draft === undefined) return;
  const old = revision;
  try {
    const patch = {[field]:draft};
    validateSource({...model.source,...patch});
    model.apply(patch);
    drafts[field] = undefined;
    if (revision !== old && !firstRevision && event.isTrusted) firstRevision = revision;
    showSource();
    note('Source applied.');
  } catch (error) {
    sourceNote(reject(error));
  }
});
function validateSource(source) {
  // Margo resolves colour roles when drawing. Validate them before committing the edit.
  const isColor = name => name === 'color' || name === 'background';
  const visit = nodes => {
    for (const node of nodes) {
      for (const [name,value] of Object.entries(node.attributes)) {
        if (value && isColor(name)) ui.color(value);
      }
      visit(node.children);
    }
  };
  visit(parseMarkup(source.markup));
  for (const rule of parseStyleSheet(source.styles)) {
    for (const {property,value} of rule.declarations) {
      if (value && isColor(property)) ui.color(value);
    }
  }
}
function download(name,body) {
  const url = URL.createObjectURL(new Blob([body],{type:'application/json'}));
  const a = create('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
activate(by('export'),() => download('coastal-relay-layout.json',model.save()));
activate(by('open'),() => by('project-file').click());
on(by('project-file'),'change',async event => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file) return;
  try {
    if (file.size>2*1024*1024) throw new Error('Choose a project under 2 MB.');
    const json = await file.text();
    signal.throwIfAborted();
    run(event,() => {
      const project = new LayoutDocument(model.source);
      try {
        project.load(json);
        validateSource(project.source);
        model.apply(project.source);
        drafts.markup = drafts.styles = undefined;
        showSource();
      } finally {
        project.dispose();
      }
    },'Project opened.');
  } catch (error) {
    if (!signal.aborted) reject(error);
  }
});

function resize() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const dpi = Math.min(devicePixelRatio || 1,2);
  canvas.width = Math.round(width*dpi);
  canvas.height = Math.round(height*dpi);
}
async function engineRoute() {
  const options = {backend:'webgpu',exactSize:true,signal};
  if (query.get('backend') !== 'webgl2' && navigator.gpu) {
    try {
      const native = await Engine.create(canvas,options);
      workspace.dataset.renderer = 'webgpu';
      return native;
    } catch (error) {
      signal.throwIfAborted();
      if (error?.code && !['unsupported','adapter','device','timeout','startup'].includes(error.code)) throw error;
    }
  }
  const {webglRenderer} = await import('@margoengine/webgl2-compat/preview');
  const fallback = await Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
  workspace.dataset.renderer = 'webgl2';
  return fallback;
}
function scheduleDraw() {
  if (!ready || status.failed || signal.aborted) return;
  if (inDraw) { redrawn = true; return; }
  if (!drawId) drawId = requestAnimationFrame(() => { drawId = 0; void renderEdit().catch(renderError); });
}
function paint() {
  engine.render({delta:0});
  updateSelectionFrame();
  return renderer.stats.glyphs;
}
async function renderEdit() {
  inDraw = true;
  const actual = revision;
  paint();
  const first = firstRevision && actual >= firstRevision && !firstComplete;
  if (first) {
    await engine.gpu?.queue.onSubmittedWorkDone();
    await nextFrame();
    if (status.failed || signal.aborted) return;
    performance.mark('layout-first-edit');
    workspace.dataset.firstEffect = 'painted';
    firstComplete = true;
  }
  paintedRevision = actual;
  workspace.dataset.paintedRevision = String(actual);
  inDraw = false;
  if (redrawn) {
    redrawn = false;
    scheduleDraw();
  }
}
async function boot() {
  resize();
  const opening = engineRoute();
  refresh();
  engine = await opening;
  performance.mark('layout-device');
  engine.scene.background = '#132d30';
  engine.onError = renderError;
  renderer = UiRenderer.attach(engine,ui,{input:false,mirror:false,atlasSize:512});
  await ui.ready;
  const start = performance.now();
  while (!paint()) {
    if (performance.now()-start > 5000) throw new Error('The layout preview could not draw its first frame.');
    await nextFrame();
    signal.throwIfAborted();
  }
  await engine.gpu?.queue.onSubmittedWorkDone();
  await nextFrame();
  if (!status.ready()) return;
  ready = true;
  paintedRevision = revision;
  workspace.dataset.paintedRevision = String(revision);
  performance.mark('layout-ready');
  loading.hidden = true;
  for (const element of [...palette,by('export'),by('open'),code]) element.disabled = false;
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeId);
    resizeId = requestAnimationFrame(() => { resize(); scheduleDraw(); });
  });
  observer.observe(canvas);
  if (query.has('inspect')) Object.defineProperty(globalThis,'layoutInspection',{configurable:true,value:() => ({
    source:model.source,tree:model.tree,revision,paintedRevision,
    stats:{...renderer.stats},width:ui.width,height:ui.height,
    boxes:Object.fromEntries([...entries].map(([id]) => [id,{...screen.get(id)?.rect}])),
  })});
}
model.onChange(refresh);
on(window,'pagehide',() => {
  session.abort();
  cancelAnimationFrame(drawId);
  cancelAnimationFrame(resizeId);
  observer?.disconnect();
  renderer?.dispose();
  engine?.dispose();
  ui.dispose();
  model.dispose();
});
boot().catch(renderError);

/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { createGraphMaterial, type SurfaceGraph, type SurfaceOperation } from './graph.js';
import {
  EDITOR_OPERATIONS,
  type EditorOperation,
  GraphModel,
  HEAD_HEIGHT,
  NODE_WIDTH,
  OUTPUT_HEIGHT,
  OUTPUT_SLOTS,
  ROW_HEIGHT,
  ROW_PADDING,
  inputLabel,
  inputSocket,
  INPUT_DEFAULTS,
  nodeHeight,
  outputSocket,
  type EditorNode,
  type EditorStatus,
  type GraphLayout,
  type OutputSlot,
} from './editor-model.js';

export * from './editor-model.js';

/** Options of {@link NodeEditor}. */
export interface NodeEditorOptions {
  /** A valid portable graph to start from; default an empty graph. */
  graph?: SurfaceGraph;
  /** Node positions saved with the graph (`editor.layout`); nodes without one are arranged. */
  layout?: GraphLayout;
  /** Show the graph but refuse edits: no palette, no dragging, no typing. Default false. */
  readOnly?: boolean;
  /** Disposes the editor when aborted. */
  signal?: AbortSignal;
}

const css = /* css */ `
:host{display:block;position:relative;min-height:240px;color-scheme:light dark;--bg:#f4f5f7;--grid:#e1e4e9;--panel:#fff;--ink:#1f2328;--muted:#5d636b;--line:#c3c8cf;--accent:#0b6bcb;--bad:#c4281c;--ok:#12805c;--f32:#6c8196;--vec3f:#b8860b;font:12px/1.35 system-ui,sans-serif;color:var(--ink)}
@media(prefers-color-scheme:dark){:host{--bg:#16181c;--grid:#23262c;--panel:#23272e;--ink:#e6e8eb;--muted:#a0a7b0;--line:#4a515a;--accent:#5aa2f2;--bad:#ff7b72;--ok:#4cc38a;--f32:#8fa6bb;--vec3f:#e0b43c}}
*{box-sizing:border-box}
.editor{display:flex;flex-direction:column;height:100%;min-height:inherit;background:var(--bg)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--panel)}
.toolbar .status{margin-left:auto;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ok);cursor:default}
.toolbar .status[data-ok=false]{color:var(--bad);cursor:pointer}
button,input,select{font:inherit;color:inherit}
button{border:1px solid var(--line);background:var(--panel);border-radius:4px;padding:3px 9px;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible,.viewport:focus-visible,.node:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.viewport{position:relative;flex:1;overflow:hidden;touch-action:none;cursor:grab;background-color:var(--bg);background-image:radial-gradient(var(--grid) 1px,transparent 1px);background-size:24px 24px}
.viewport[data-panning]{cursor:grabbing}
.world{position:absolute;left:0;top:0;transform-origin:0 0}
svg.wires{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
path.wire{fill:none;stroke:var(--line);stroke-width:2.5;stroke-linecap:round}
path.wire[data-type=f32]{stroke:var(--f32)}path.wire[data-type=vec3f]{stroke:var(--vec3f)}
path.wire[data-pending]{stroke:var(--accent);stroke-dasharray:6 4}
.node{position:absolute;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.18);user-select:none}
.node[data-selected]{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}
.node[data-invalid]{border-color:var(--bad);box-shadow:0 0 0 2px var(--bad)}
.head{height:${HEAD_HEIGHT}px;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid var(--line);cursor:move;font-weight:600;border-radius:6px 6px 0 0}
.head .id{color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.head .type{margin-left:auto;font-weight:400;color:var(--muted);font-family:ui-monospace,monospace;font-size:11px}
.rows{padding:${ROW_PADDING}px 0}
.row{height:${ROW_HEIGHT}px;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 12px}
.row .label{color:var(--muted)}
.row input,.row select{width:56px;height:20px;padding:0 3px;border:1px solid var(--line);border-radius:3px;background:var(--bg)}
.row input.wide{width:100%}
.row .triple{display:flex;gap:3px;width:100%}.row .triple input{width:0;flex:1}
.socket{position:absolute;width:12px;height:12px;padding:0;border-radius:50%;border:2px solid var(--line);background:var(--panel)}
.socket[data-type=f32]{border-color:var(--f32)}.socket[data-type=vec3f]{border-color:var(--vec3f)}
.socket[data-connected]{background:currentColor}.socket[data-type=f32][data-connected]{background:var(--f32)}.socket[data-type=vec3f][data-connected]{background:var(--vec3f)}
.socket[data-armed]{outline:2px solid var(--accent)}
.socket:hover{transform:scale(1.25)}
.palette{position:absolute;z-index:3;width:260px;max-height:70%;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.28)}
.palette[hidden]{display:none}
.palette input{margin:6px;padding:4px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg)}
.palette ul{list-style:none;margin:0;padding:0 0 6px;overflow:auto}
.palette li{padding:4px 12px;cursor:pointer}.palette li small{display:block;color:var(--muted)}
.palette li[aria-selected=true]{background:var(--accent);color:#fff}.palette li[aria-selected=true] small{color:inherit;opacity:.85}
.code{position:absolute;right:8px;bottom:8px;z-index:2;width:min(460px,60%);max-height:50%;overflow:auto;margin:0;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:6px;font:11px/1.4 ui-monospace,monospace;white-space:pre;user-select:text}
.code[hidden]{display:none}
@media(prefers-reduced-motion:no-preference){.socket{transition:transform .08s}}
`;

type Target = { node: string; input: number } | { slot: OutputSlot };
type Gesture =
  | { kind: 'pan'; x: number; y: number; moved: boolean }
  | { kind: 'move'; ids: string[]; x: number; y: number; moved: boolean }
  | { kind: 'wire'; from: string; detach?: Target; x: number; y: number; moved: boolean };

const svgNS = 'http://www.w3.org/2000/svg';
const HIT = 14;

/**
 * A visual editor for the portable surface graph (`SurfaceGraph`): drag nodes from a palette, wire outputs to inputs,
 * type constants, and watch the graph validate as you edit. It edits a {@link GraphModel}; {@link NodeEditor.onGraph}
 * reports each valid graph so a material can be rebuilt (hot reload). Styled in a shadow root, light and dark, with no
 * global side effects. Mouse, touch and keyboard all work: sockets are buttons (click an output, then click an input),
 * `Shift+A` or double click opens the node palette, `Delete`, `Ctrl+Z`, `Ctrl+Y`, `Ctrl+D`, `Ctrl+A`, `F` and the arrow
 * keys do what they do in other node editors.
 * @throws TypeError or RangeError when `options.graph` is invalid; MargoError `'disposed'` from methods after `dispose()`.
 */
export class NodeEditor {
  /** The editor's root element, already appended to the parent you passed. */
  readonly element: HTMLElement;
  /** The editable graph; change it directly or through the user's gestures. */
  readonly model: GraphModel;
  readonly readOnly: boolean;
  private readonly doc: Document;
  private readonly root: ShadowRoot;
  private readonly viewport: HTMLElement;
  private readonly world: HTMLElement;
  private readonly wires: SVGSVGElement;
  private readonly palette: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private readonly code: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly buttons: Record<'add' | 'undo' | 'redo' | 'arrange' | 'fit' | 'wgsl', HTMLButtonElement>;
  private readonly nodes = new Map<string, HTMLElement>();
  private readonly selected = new Set<string>();
  private readonly graphListeners = new Set<(graph: SurfaceGraph) => void>();
  private readonly changeListeners = new Set<(status: EditorStatus) => void>();
  private readonly unsubscribe: () => void;
  private readonly abort?: () => void;
  private pan = { x: 24, y: 24, zoom: 1 };
  private gesture?: Gesture;
  private armed?: string;
  private lastJSON = '';
  private matches: EditorOperation[] = [];
  private choice = 0;
  private addAt: [number, number] = [0, 0];
  private lastPoint?: [number, number];
  private pendingWire?: [number, number, number, number];
  private flash = '';
  private disposed = false;

  /**
   * @param parent Element to append the editor to; the editor fills it, so give the parent a height.
   */
  constructor(parent: HTMLElement, options: NodeEditorOptions = {}) {
    this.doc = parent.ownerDocument;
    this.readOnly = options.readOnly === true;
    this.model = new GraphModel(options.graph, options.layout);
    this.element = this.doc.createElement('div');
    this.element.dataset.margoNodeEditor = '';
    this.root = this.element.attachShadow({ mode: 'open' });
    const el = this.make.bind(this);
    const style = el('style');
    style.textContent = css;
    const bar = el('div', 'toolbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Graph editor tools');
    const button = (label: string, title: string) => {
      const b = el('button') as HTMLButtonElement;
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      return b;
    };
    this.buttons = {
      add: button('Add node', 'Add a node (Shift+A)'),
      undo: button('Undo', 'Undo (Ctrl+Z)'),
      redo: button('Redo', 'Redo (Ctrl+Y)'),
      arrange: button('Arrange', 'Lay the nodes out in columns'),
      fit: button('Fit', 'Show every node (F)'),
      wgsl: button('WGSL', 'Show the generated WGSL'),
    };
    this.buttons.wgsl.setAttribute('aria-pressed', 'false');
    this.statusText = el('span', 'status');
    this.statusText.setAttribute('role', 'status');
    this.statusText.setAttribute('aria-live', 'polite');
    bar.append(...Object.values(this.buttons), this.statusText);
    this.viewport = el('div', 'viewport');
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', 'application');
    this.viewport.setAttribute('aria-label', 'Surface graph canvas. Shift+A adds a node.');
    this.world = el('div', 'world');
    this.wires = this.doc.createElementNS(svgNS, 'svg') as SVGSVGElement;
    this.wires.classList.add('wires');
    this.wires.setAttribute('aria-hidden', 'true');
    this.world.append(this.wires);
    this.palette = el('div', 'palette');
    this.palette.hidden = true;
    this.palette.setAttribute('role', 'dialog');
    this.palette.setAttribute('aria-label', 'Add a node');
    this.search = el('input') as HTMLInputElement;
    this.search.type = 'search';
    this.search.placeholder = 'Search nodes';
    this.search.setAttribute('aria-label', 'Search nodes');
    this.list = el('ul') as HTMLUListElement;
    this.list.setAttribute('role', 'listbox');
    this.palette.append(this.search, this.list);
    this.code = el('pre', 'code');
    this.code.hidden = true;
    this.code.tabIndex = 0;
    this.code.setAttribute('aria-label', 'Generated WGSL');
    this.viewport.append(this.world, this.palette, this.code);
    const editor = el('div', 'editor');
    editor.append(bar, this.viewport);
    this.root.append(style, editor);
    parent.append(this.element);

    this.wire(bar);
    this.unsubscribe = this.model.subscribe((event) => (event === 'layout' ? this.layoutOnly() : this.render()));
    if (options.signal) {
      if (options.signal.aborted) {
        this.dispose();
        return;
      }
      const stop = () => this.dispose();
      options.signal.addEventListener('abort', stop, { once: true });
      this.abort = () => options.signal!.removeEventListener('abort', stop);
    }
    this.render();
    if (this.model.nodes.length) this.fit();
    else this.applyPan();
  }

  private make(tag: string, className?: string): HTMLElement {
    const e = this.doc.createElement(tag);
    if (className) e.className = className;
    return e;
  }
  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'This NodeEditor is disposed; create a new NodeEditor');
  }

  /** The current graph, validated. Throws like {@link GraphModel.toGraph} while the graph is invalid or incomplete. */
  get graph(): SurfaceGraph {
    return this.model.toGraph();
  }
  /** Whether the graph validates, or the first thing to fix. */
  get status(): EditorStatus {
    return this.model.status();
  }
  /** Ids of the selected nodes. */
  get selection(): readonly string[] {
    return [...this.selected];
  }
  /** Node positions, to save beside the graph. */
  get layout(): GraphLayout {
    return this.model.layout;
  }
  /**
   * Calls `listener` with every new valid graph (once on subscribe if the graph is valid now, then after each edit that
   * changes it; moves and invalid states do not call it). Rebuild a material from it for hot reload. Returns a function
   * that stops the calls.
   */
  onGraph(listener: (graph: SurfaceGraph) => void): () => void {
    this.live();
    this.graphListeners.add(listener);
    const status = this.model.status();
    if (status.ok) listener(this.model.toGraph());
    return () => this.graphListeners.delete(listener);
  }
  /** Calls `listener` with the status after every edit. Returns a function that stops the calls. */
  onChange(listener: (status: EditorStatus) => void): () => void {
    this.live();
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  /** Replaces the graph being edited (one undo step). */
  load(graph: SurfaceGraph, layout?: GraphLayout): void {
    this.live();
    this.selected.clear();
    this.model.load(graph, layout);
    this.fit();
  }
  /** Selects nodes by id (unknown ids are ignored). */
  select(ids: Iterable<string>): void {
    this.live();
    this.selected.clear();
    for (const id of ids) if (this.model.node(id)) this.selected.add(id);
    this.paintSelection();
  }
  /** Zooms and pans so every node and the output panel are visible. */
  fit(): void {
    this.live();
    let x0 = this.model.output.x,
      y0 = this.model.output.y,
      x1 = x0 + NODE_WIDTH,
      y1 = y0 + OUTPUT_HEIGHT;
    for (const n of this.model.nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + NODE_WIDTH);
      y1 = Math.max(y1, n.y + nodeHeight(n));
    }
    const w = this.viewport.clientWidth || 800,
      h = this.viewport.clientHeight || 500,
      zoom = Math.min(1, Math.max(0.25, Math.min((w - 48) / (x1 - x0), (h - 48) / (y1 - y0))));
    this.pan = { zoom, x: (w - (x1 - x0) * zoom) / 2 - x0 * zoom, y: (h - (y1 - y0) * zoom) / 2 - y0 * zoom };
    this.applyPan();
  }
  /** Adds a node of `op` where the palette would put it, selects it and returns its id. */
  add(op: SurfaceOperation, at?: readonly [number, number]): string {
    this.live();
    if (this.readOnly)
      throw new MargoError('state', 'This NodeEditor is read-only; create it without readOnly to edit');
    const node = this.model.addNode(op, at);
    this.selected.clear();
    this.selected.add(node.id);
    this.paintSelection();
    return node.id;
  }

  /** Removes the editor from the page and stops every listener. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.abort?.();
    this.graphListeners.clear();
    this.changeListeners.clear();
    this.element.remove();
    this.nodes.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  // ---------------------------------------------------------------- view

  private applyPan(): void {
    const { x, y, zoom } = this.pan;
    this.world.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    this.viewport.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
  }
  private point(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.viewport.getBoundingClientRect();
    return [(e.clientX - r.left - this.pan.x) / this.pan.zoom, (e.clientY - r.top - this.pan.y) / this.pan.zoom];
  }

  private render(): void {
    if (this.disposed) return;
    const m = this.model,
      status = m.status();
    for (const id of [...this.selected]) if (!m.node(id)) this.selected.delete(id);
    if (this.armed && !m.node(this.armed)) this.armed = undefined;
    const focused = this.focusedSocket();
    for (const e of this.nodes.values()) e.remove();
    this.nodes.clear();
    for (const n of m.nodes) this.world.append(this.drawNode(n, status));
    this.world.append(this.drawOutput());
    this.drawWires(status);
    this.paintSelection();
    if (focused) this.root.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
    this.buttons.undo.disabled = this.readOnly || !m.canUndo;
    this.buttons.redo.disabled = this.readOnly || !m.canRedo;
    this.buttons.add.disabled = this.buttons.arrange.disabled = this.readOnly;
    this.statusText.textContent = this.flash || status.message;
    this.statusText.dataset.ok = String(status.ok && !this.flash);
    this.statusText.title = this.statusText.textContent;
    if (!this.code.hidden) this.showCode(status);
    this.flash = '';
    for (const listener of [...this.changeListeners]) listener(status);
    if (status.ok) {
      const json = m.toJSON();
      if (json !== this.lastJSON) {
        this.lastJSON = json;
        const graph = m.toGraph();
        for (const listener of [...this.graphListeners]) listener(graph);
      }
    }
  }

  /** Selector of the socket that has keyboard focus, so a redraw can give it back (the redraw replaces the buttons). */
  private focusedSocket(): string | undefined {
    const a = this.root.activeElement as HTMLElement | null;
    if (!a?.dataset?.socket) return undefined;
    const node = a.closest<HTMLElement>('[data-node]')?.dataset.node;
    if (a.dataset.slot) return `.socket[data-slot="${a.dataset.slot}"]`;
    return `[data-node="${node}"] .socket[data-socket="${a.dataset.socket}"]${a.dataset.input === undefined ? '' : `[data-input="${a.dataset.input}"]`}`;
  }

  private layoutOnly(): void {
    for (const n of this.model.nodes) {
      const e = this.nodes.get(n.id);
      if (e) this.place(e, n.x, n.y);
    }
    const out = this.nodes.get('output');
    if (out) this.place(out, this.model.output.x, this.model.output.y);
    this.drawWires(this.model.status());
  }
  private place(e: HTMLElement, x: number, y: number): void {
    e.style.left = x + 'px';
    e.style.top = y + 'px';
  }

  private socket(
    kind: 'in' | 'out',
    top: number,
    label: string,
    type: string | undefined,
    connected: boolean,
  ): HTMLButtonElement {
    const s = this.make('button', 'socket') as HTMLButtonElement;
    s.type = 'button';
    s.dataset.socket = kind;
    if (type) s.dataset.type = type;
    if (connected) s.dataset.connected = '';
    s.style.top = top - 6 + 'px';
    if (kind === 'in') s.style.left = '-6px';
    else s.style.right = '-6px';
    s.setAttribute('aria-label', label);
    return s;
  }
  private field(value: number, onCommit: (v: number) => void, label: string, wide = false): HTMLInputElement {
    const input = this.make('input', wide ? 'wide' : '') as HTMLInputElement;
    input.type = 'number';
    input.step = 'any';
    input.value = String(Number(value.toPrecision(7)));
    input.disabled = this.readOnly;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const v = input.valueAsNumber;
      if (Number.isFinite(v))
        try {
          onCommit(v);
        } catch (error) {
          this.say(error);
          this.render();
        }
      else this.render();
    });
    return input;
  }

  private drawNode(n: EditorNode, status: EditorStatus): HTMLElement {
    const type = status.types[n.id],
      info = EDITOR_OPERATIONS.find((o) => o.op === n.op)!;
    const e = this.make('div', 'node');
    e.dataset.node = n.id;
    e.setAttribute('role', 'group');
    e.setAttribute('aria-label', `${info.label} node ${n.id}${type ? ', outputs ' + type : ''}`);
    e.style.width = NODE_WIDTH + 'px';
    e.style.height = nodeHeight(n) + 'px';
    this.place(e, n.x, n.y);
    if (!status.ok && status.node === n.id) e.dataset.invalid = '';
    const head = this.make('div', 'head');
    head.dataset.drag = '';
    const title = this.make('span');
    title.textContent = info.label;
    const id = this.make('span', 'id');
    id.textContent = n.id;
    const kind = this.make('span', 'type');
    kind.textContent = type ?? '';
    head.append(title, id, kind);
    const rows = this.make('div', 'rows');
    n.inputs.forEach((source, i) => {
      const row = this.make('div', 'row'),
        name = inputLabel(n.op, i),
        label = this.make('span', 'label');
      label.textContent = name;
      row.append(label);
      const fallback = INPUT_DEFAULTS[n.op]?.[i];
      if (source === null && fallback !== undefined)
        row.append(
          this.field(
            n.inline[i] ?? fallback,
            (v) => this.model.setInline(n.id, i, v),
            `${n.id} ${name} (default ${fallback})`,
          ),
        );
      rows.append(row);
      const s = this.socket(
        'in',
        HEAD_HEIGHT + ROW_PADDING + ROW_HEIGHT * (i + 0.5),
        `${n.id} input ${i + 1} ${name}, ${source ? 'wired from ' + source : 'not wired'}`,
        source ? status.types[source] : undefined,
        source !== null,
      );
      s.dataset.node = n.id;
      s.dataset.input = String(i);
      e.append(s);
    });
    if (n.op === 'float' || n.op === 'vec3' || n.op === 'component') {
      const row = this.make('div', 'row');
      if (n.op === 'float')
        row.append(this.field(n.value as number, (v) => this.model.setValue(n.id, v), `${n.id} value`, true));
      else if (n.op === 'vec3') {
        const triple = this.make('div', 'triple');
        (n.value as number[]).forEach((c, k) =>
          triple.append(
            this.field(
              c,
              (v) =>
                this.model.setValue(
                  n.id,
                  (n.value as number[]).map((o, j) => (j === k ? v : o)) as [number, number, number],
                ),
              `${n.id} ${'xyz'[k]}`,
            ),
          ),
        );
        row.append(triple);
      } else {
        const select = this.make('select') as HTMLSelectElement;
        select.disabled = this.readOnly;
        select.setAttribute('aria-label', `${n.id} component`);
        ['X', 'Y', 'Z'].forEach((name, k) => select.append(this.option(name, String(k), k === n.value)));
        select.addEventListener('change', () => this.model.setValue(n.id, Number(select.value)));
        row.append(select);
      }
      rows.append(row);
    } else if (!n.inputs.length) rows.append(this.make('div', 'row'));
    e.append(head, rows);
    const out = this.socket(
      'out',
      HEAD_HEIGHT + ROW_PADDING + ROW_HEIGHT * 0.5,
      `${n.id} output${type ? ' ' + type : ''}`,
      type,
      this.usedBy(n.id),
    );
    out.dataset.node = n.id;
    if (this.armed === n.id) out.dataset.armed = '';
    e.append(out);
    this.nodes.set(n.id, e);
    return e;
  }
  private option(label: string, value: string, selected: boolean): HTMLOptionElement {
    const o = this.doc.createElement('option');
    o.textContent = label;
    o.value = value;
    o.selected = selected;
    return o;
  }
  private usedBy(id: string): boolean {
    return this.model.nodes.some((n) => n.inputs.includes(id)) || Object.values(this.model.outputs).includes(id);
  }

  private drawOutput(): HTMLElement {
    const m = this.model,
      e = this.make('div', 'node');
    e.dataset.node = 'output';
    e.setAttribute('role', 'group');
    e.setAttribute('aria-label', 'Material output');
    e.style.width = NODE_WIDTH + 'px';
    e.style.height = OUTPUT_HEIGHT + 'px';
    this.place(e, m.output.x, m.output.y);
    const head = this.make('div', 'head');
    head.dataset.drag = '';
    const title = this.make('span');
    title.textContent = 'Material output';
    head.append(title);
    const rows = this.make('div', 'rows');
    OUTPUT_SLOTS.forEach(({ slot, label, type }, i) => {
      const row = this.make('div', 'row'),
        name = this.make('span', 'label'),
        source = m.outputs[slot];
      name.textContent = `${label} (${type === 'f32' ? 'number' : 'vec3'})`;
      row.append(name);
      rows.append(row);
      const s = this.socket(
        'in',
        HEAD_HEIGHT + ROW_PADDING + ROW_HEIGHT * (i + 0.5),
        `Output ${label}, ${source ? 'wired from ' + source : 'not wired'}`,
        type,
        source !== undefined,
      );
      s.dataset.slot = slot;
      e.append(s);
    });
    const f = m.fallback;
    const triple = (name: string, key: 'color' | 'emissive') => {
      const row = this.make('div', 'row'),
        wrap = this.make('div', 'triple');
      f[key].forEach((c, k) =>
        wrap.append(
          this.field(
            c,
            (v) => m.setFallback({ [key]: f[key].map((o, j) => (j === k ? v : o)) }),
            `Fallback ${name} ${'rgb'[k]}`,
          ),
        ),
      );
      row.append(wrap);
      return row;
    };
    const scalars = this.make('div', 'row'),
      wrap = this.make('div', 'triple');
    (['roughness', 'metalness', 'opacity'] as const).forEach((key) =>
      wrap.append(this.field(f[key], (v) => m.setFallback({ [key]: v }), `Fallback ${key}`)),
    );
    scalars.append(wrap);
    rows.append(triple('color', 'color'), triple('emissive', 'emissive'), scalars);
    e.append(head, rows);
    this.nodes.set('output', e);
    return e;
  }

  private curve(x1: number, y1: number, x2: number, y2: number): string {
    const d = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M${x1} ${y1}C${x1 + d} ${y1} ${x2 - d} ${y2} ${x2} ${y2}`;
  }
  private drawWires(status: EditorStatus): void {
    this.wires.replaceChildren();
    const add = (d: string, type?: string, pending = false) => {
      const p = this.doc.createElementNS(svgNS, 'path');
      p.setAttribute('class', 'wire');
      p.setAttribute('d', d);
      if (type) p.setAttribute('data-type', type);
      if (pending) p.setAttribute('data-pending', '');
      this.wires.append(p);
    };
    const m = this.model;
    for (const n of m.nodes)
      n.inputs.forEach((source, i) => {
        const from = source === null ? undefined : m.node(source);
        if (!from) return;
        const [x1, y1] = outputSocket(from),
          [x2, y2] = inputSocket(n, i);
        add(this.curve(x1, y1, x2, y2), status.types[from.id]);
      });
    OUTPUT_SLOTS.forEach(({ slot }, i) => {
      const from = m.outputs[slot] ? m.node(m.outputs[slot]!) : undefined;
      if (!from) return;
      const [x1, y1] = outputSocket(from),
        [x2, y2] = inputSocket(m.output, i);
      add(this.curve(x1, y1, x2, y2), status.types[from.id]);
    });
    if (this.pendingWire) add(this.curve(...this.pendingWire), undefined, true);
  }
  private paintSelection(): void {
    for (const [id, e] of this.nodes) {
      if (this.selected.has(id)) e.dataset.selected = '';
      else delete e.dataset.selected;
    }
  }
  private say(error: unknown): void {
    this.flash = error instanceof Error ? error.message : String(error);
    this.statusText.textContent = this.flash;
    this.statusText.dataset.ok = 'false';
    this.statusText.title = this.flash;
  }

  // ------------------------------------------------------------ gestures

  /** The input socket or output-panel slot whose centre is within reach of a point, if any. */
  private targetAt(x: number, y: number): Target | undefined {
    const reach = HIT / this.pan.zoom;
    const near = (c: [number, number]) => Math.hypot(c[0] - x, c[1] - y) <= reach;
    for (let i = 0; i < OUTPUT_SLOTS.length; i++)
      if (near(inputSocket(this.model.output, i))) return { slot: OUTPUT_SLOTS[i].slot };
    for (const n of this.model.nodes)
      for (let i = 0; i < n.inputs.length; i++) if (near(inputSocket(n, i))) return { node: n.id, input: i };
    return undefined;
  }
  private connectTo(from: string, target: Target): void {
    if ('slot' in target) this.model.connectOutput(from, target.slot);
    else this.model.connect(from, target.node, target.input);
  }
  private sourceOf(target: Target): string | undefined {
    if ('slot' in target) return this.model.outputs[target.slot];
    return this.model.node(target.node)?.inputs[target.input] ?? undefined;
  }
  private socketTarget(s: HTMLElement): Target | undefined {
    if (s.dataset.slot) return { slot: s.dataset.slot as OutputSlot };
    if (s.dataset.node !== undefined && s.dataset.input !== undefined)
      return { node: s.dataset.node, input: Number(s.dataset.input) };
    return undefined;
  }

  private wire(bar: HTMLElement): void {
    const v = this.viewport;
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b || b.disabled) return;
      if (b === this.buttons.add) this.openPalette(this.centre());
      else if (b === this.buttons.undo) this.model.undo();
      else if (b === this.buttons.redo) this.model.redo();
      else if (b === this.buttons.arrange) {
        this.model.arrange();
        this.fit();
      } else if (b === this.buttons.fit) this.fit();
      else if (b === this.buttons.wgsl) {
        this.code.hidden = !this.code.hidden;
        b.setAttribute('aria-pressed', String(!this.code.hidden));
        if (!this.code.hidden) this.showCode(this.model.status());
      }
    });
    this.statusText.addEventListener('click', () => {
      const s = this.model.status();
      if (!s.ok && s.node && this.model.node(s.node)) this.select([s.node]);
    });
    v.addEventListener('pointerdown', (e) => this.down(e as PointerEvent));
    v.addEventListener('pointermove', (e) => this.moved(e as PointerEvent));
    v.addEventListener('pointerup', (e) => this.up(e as PointerEvent));
    v.addEventListener('pointercancel', () => this.cancel());
    v.addEventListener('click', (e) => this.clicked(e as MouseEvent));
    v.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      if (this.readOnly || t.closest('[data-node],.palette,.code')) return;
      this.openPalette(this.point(e as MouseEvent));
    });
    v.addEventListener('wheel', (e) => this.wheel(e as WheelEvent), { passive: false });
    v.addEventListener('keydown', (e) => this.key(e as KeyboardEvent));
    this.search.addEventListener('input', () => this.filter());
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.choice =
          (this.choice + (e.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % Math.max(1, this.matches.length);
        this.paintChoice();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.choose(this.choice);
      } else if (e.key === 'Escape') this.closePalette();
    });
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (li) this.choose(Number(li.dataset.index));
    });
  }
  /** The middle of the visible canvas in editor pixels, stepped down and right for each node so new nodes do not stack. */
  private centre(): [number, number] {
    const step = (this.model.nodes.length % 8) * 24;
    return [
      Math.round(((this.viewport.clientWidth || 800) / 2 - this.pan.x) / this.pan.zoom - NODE_WIDTH / 2) + step,
      Math.round(((this.viewport.clientHeight || 500) / 2 - this.pan.y) / this.pan.zoom - 40) + step,
    ];
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    const t = e.target as HTMLElement;
    if (t.closest('.palette,.code')) return;
    if (t.closest('input,select')) return;
    if (!this.palette.hidden) this.closePalette();
    const socket = t.closest<HTMLElement>('[data-socket]'),
      node = t.closest<HTMLElement>('[data-node]');
    this.viewport.setPointerCapture?.(e.pointerId);
    if (socket) {
      const kind = socket.dataset.socket;
      if (this.readOnly) return;
      if (kind === 'out') {
        this.gesture = { kind: 'wire', from: socket.dataset.node!, x: e.clientX, y: e.clientY, moved: false };
      } else {
        const target = this.socketTarget(socket),
          source = target && this.sourceOf(target);
        if (target && source)
          this.gesture = { kind: 'wire', from: source, detach: target, x: e.clientX, y: e.clientY, moved: false };
      }
      return;
    }
    if (node && t.closest('[data-drag]')) {
      const id = node.dataset.node!;
      if (id !== 'output') {
        if (e.shiftKey) {
          if (!this.selected.delete(id)) this.selected.add(id);
        } else if (!this.selected.has(id)) {
          this.selected.clear();
          this.selected.add(id);
        }
      }
      this.paintSelection();
      if (!this.readOnly)
        this.gesture = {
          kind: 'move',
          ids: id === 'output' ? ['output'] : [...this.selected],
          x: e.clientX,
          y: e.clientY,
          moved: false,
        };
      this.viewport.focus({ preventScroll: true });
      return;
    }
    if (node) {
      this.selected.clear();
      if (node.dataset.node !== 'output') this.selected.add(node.dataset.node!);
      this.paintSelection();
      return;
    }
    if (!e.shiftKey) {
      this.selected.clear();
      this.paintSelection();
    }
    this.gesture = { kind: 'pan', x: e.clientX, y: e.clientY, moved: false };
    this.viewport.dataset.panning = '';
    this.viewport.focus({ preventScroll: true });
  }
  private moved(e: PointerEvent): void {
    this.lastPoint = this.point(e);
    const g = this.gesture;
    if (!g) return;
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return;
    if (g.kind === 'pan') {
      this.pan.x += e.clientX - g.x;
      this.pan.y += e.clientY - g.y;
      g.x = e.clientX;
      g.y = e.clientY;
      g.moved = true;
      this.applyPan();
    } else if (g.kind === 'move') {
      if (!g.moved) this.model.checkpoint();
      const dx = (e.clientX - g.x) / this.pan.zoom,
        dy = (e.clientY - g.y) / this.pan.zoom;
      g.x = e.clientX;
      g.y = e.clientY;
      g.moved = true;
      this.model.move(g.ids, dx, dy);
    } else {
      g.moved = true;
      const from = this.model.node(g.from);
      if (!from) return;
      const [x1, y1] = outputSocket(from),
        [x2, y2] = this.point(e);
      this.pendingWire = [x1, y1, x2, y2];
      this.drawWires(this.model.status());
    }
  }
  private up(e: PointerEvent): void {
    const g = this.gesture;
    this.gesture = undefined;
    delete this.viewport.dataset.panning;
    this.viewport.releasePointerCapture?.(e.pointerId);
    this.pendingWire = undefined;
    if (!g) return;
    if (g.kind === 'move' && g.moved) {
      this.suppress();
      return;
    }
    if (g.kind === 'pan' && g.moved) return;
    if (g.kind !== 'wire') return;
    if (!g.moved) {
      this.drawWires(this.model.status());
      return; // a click: handled by `click`
    }
    this.suppress();
    const [x, y] = this.point(e),
      target = this.targetAt(x, y);
    try {
      this.model.batch(() => {
        if (g.detach && !(target && JSON.stringify(target) === JSON.stringify(g.detach))) {
          if ('slot' in g.detach) this.model.disconnectOutput(g.detach.slot);
          else this.model.disconnect(g.detach.node, g.detach.input);
        }
        if (target) this.connectTo(g.from, target);
      });
    } catch (error) {
      this.say(error);
    }
    this.drawWires(this.model.status());
  }
  private cancel(): void {
    this.gesture = undefined;
    this.pendingWire = undefined;
    delete this.viewport.dataset.panning;
    this.drawWires(this.model.status());
  }
  private suppressNext = false;
  private suppress(): void {
    this.suppressNext = true;
    setTimeout(() => (this.suppressNext = false), 0);
  }
  private clicked(e: MouseEvent): void {
    if (this.suppressNext || this.readOnly) return;
    const s = (e.target as HTMLElement).closest<HTMLElement>('[data-socket]');
    if (!s) return;
    if (s.dataset.socket === 'out') {
      this.armed = this.armed === s.dataset.node ? undefined : s.dataset.node;
      this.render();
      return;
    }
    const target = this.socketTarget(s);
    if (!target) return;
    if (this.armed) {
      try {
        this.connectTo(this.armed, target);
        this.armed = undefined;
      } catch (error) {
        this.say(error);
      }
    } else if (this.sourceOf(target)) {
      // A click on a wired input with nothing armed picks the wire up: arm its source and clear the input.
      const source = this.sourceOf(target)!;
      this.model.batch(() => {
        if ('slot' in target) this.model.disconnectOutput(target.slot);
        else this.model.disconnect(target.node, target.input);
      });
      this.armed = source;
      this.render();
    }
  }
  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const zoom = Math.min(2, Math.max(0.25, this.pan.zoom * Math.pow(1.0015, -e.deltaY)));
    const r = this.viewport.getBoundingClientRect(),
      px = e.clientX - r.left,
      py = e.clientY - r.top;
    this.pan.x = px - ((px - this.pan.x) / this.pan.zoom) * zoom;
    this.pan.y = py - ((py - this.pan.y) / this.pan.zoom) * zoom;
    this.pan.zoom = zoom;
    this.applyPan();
  }
  private key(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey,
      k = e.key.toLowerCase();
    if ((e.target as HTMLElement).closest?.('input,select')) return;
    const ro = this.readOnly;
    if (k === 'escape') {
      this.armed = undefined;
      this.cancel();
      this.closePalette();
      this.render();
    } else if (mod && k === 'z' && !ro) {
      e.preventDefault();
      if (e.shiftKey) this.model.redo();
      else this.model.undo();
    } else if (mod && k === 'y' && !ro) {
      e.preventDefault();
      this.model.redo();
    } else if (mod && k === 'a') {
      e.preventDefault();
      this.select(this.model.nodes.map((n) => n.id));
    } else if (mod && k === 'd' && !ro) {
      e.preventDefault();
      try {
        const ids = this.model.duplicate(this.selected);
        this.select(ids);
      } catch (error) {
        this.say(error);
      }
    } else if ((k === 'delete' || k === 'backspace') && !ro) {
      e.preventDefault();
      const focus = (e.target as HTMLElement).closest?.<HTMLElement>('[data-socket=in]');
      if (focus) {
        const t = this.socketTarget(focus);
        if (t && 'slot' in t) this.model.disconnectOutput(t.slot);
        else if (t) this.model.disconnect(t.node, t.input);
      } else this.model.removeNodes([...this.selected]);
    } else if (k === 'a' && e.shiftKey && !ro) {
      e.preventDefault();
      this.openPalette(this.lastPoint ?? this.centre());
    } else if (k === 'f' && !mod) {
      e.preventDefault();
      this.fit();
    } else if (k.startsWith('arrow') && this.selected.size && !ro) {
      e.preventDefault();
      const step = e.shiftKey ? 32 : 8;
      this.model.checkpoint();
      this.model.move(
        this.selected,
        k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0,
        k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0,
      );
    }
  }

  // ------------------------------------------------------------- palette

  private openPalette(at: readonly number[]): void {
    if (this.readOnly) return;
    this.addAt = [at[0], at[1]];
    this.palette.hidden = false;
    this.palette.style.left =
      Math.max(8, Math.min((at[0] * this.pan.zoom + this.pan.x) | 0, (this.viewport.clientWidth || 800) - 270)) + 'px';
    this.palette.style.top =
      Math.max(8, Math.min((at[1] * this.pan.zoom + this.pan.y) | 0, (this.viewport.clientHeight || 500) - 280)) + 'px';
    this.search.value = '';
    this.filter();
    this.search.focus();
  }
  private closePalette(): void {
    if (this.palette.hidden) return;
    this.palette.hidden = true;
    this.viewport.focus({ preventScroll: true });
  }
  private filter(): void {
    const words = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    this.matches = EDITOR_OPERATIONS.filter((o) => {
      const hay = `${o.label} ${o.op} ${o.group} ${o.description}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    this.choice = 0;
    this.list.replaceChildren(
      ...this.matches.map((o, i) => {
        const li = this.make('li');
        li.dataset.index = String(i);
        li.setAttribute('role', 'option');
        li.textContent = `${o.label} `;
        const small = this.make('small');
        small.textContent = `${o.group}: ${o.description}`;
        li.append(small);
        return li;
      }),
    );
    this.paintChoice();
  }
  private paintChoice(): void {
    [...this.list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === this.choice)));
    this.list.children[this.choice]?.scrollIntoView?.({ block: 'nearest' });
  }
  private choose(i: number): void {
    const o = this.matches[i];
    if (!o) return;
    try {
      this.add(o.op, [this.addAt[0], this.addAt[1]]);
    } catch (error) {
      this.say(error);
    }
    this.closePalette();
  }

  private showCode(status: EditorStatus): void {
    if (!status.ok) {
      this.code.textContent = status.message;
      return;
    }
    try {
      this.code.textContent = createGraphMaterial(this.model.toGraph()).fragmentCode;
    } catch (error) {
      this.code.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}

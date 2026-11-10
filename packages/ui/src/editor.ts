/// <reference lib="esnext.disposable" preserve="true" />
import { Panel, type Ui, type Widget } from '@margoengine/ui';
import { buildScreen, parseMarkup, type MarkupElement, type ScreenOptions, type Screen } from '@margoengine/ui/markup';
import { rangeError, typeError } from '../../shared/errors.js';
/** Editable, portable layout source. Text remains markup and style sheets, never executable JavaScript. */
export interface LayoutSource {
  markup: string;
  styles: string;
}
/** Layout source with its version for disk persistence. */
export interface LayoutProject extends LayoutSource {
  version: 1;
}
const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function serialize(elements: readonly MarkupElement[], depth = 0): string {
  return elements
    .map((e) => {
      const open = `${'  '.repeat(depth)}<${e.tag}${Object.entries(e.attributes)
        .map(([k, v]) => ` ${k}="${escape(v)}"`)
        .join('')}>`;
      return e.children.length
        ? `${open}\n${serialize(e.children, depth + 1)}\n${'  '.repeat(depth)}</${e.tag}>`
        : `${open}${escape(e.text)}</${e.tag}>`;
    })
    .join('\n');
}
function locate(
  elements: MarkupElement[],
  id: string,
): { element: MarkupElement; siblings: MarkupElement[]; index: number } | null {
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element.attributes.id === id) return { element, siblings: elements, index: i };
    const child = locate(element.children, id);
    if (child) return child;
  }
  return null;
}

// Authoring selection includes labels and layout boxes, even when they ignore game pointers.
function pick(widget: Widget, x: number, y: number): Widget | null {
  if (!widget.visible) return null;
  const r = widget.rect,
    inside = x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  if (!inside && (widget.style.overflow === 'hidden' || widget.style.overflow === 'scroll')) return null;
  for (const child of [...widget.children].reverse()) {
    const hit = pick(child, x, y);
    if (hit) return hit;
  }
  return inside ? widget : null;
}
/** Validated source document with visual edits, bounded undo/redo and portable JSON. No DOM or GPU is needed. */
export class LayoutDocument {
  private states: LayoutSource[] = [];
  private cursor = 0;
  private readonly listeners = new Set<() => void>();
  /** Maximum retained edits, default 100. */
  readonly historyLimit: number;
  constructor(
    source: LayoutSource,
    private readonly options: ScreenOptions & { historyLimit?: number } = {},
  ) {
    this.historyLimit = options.historyLimit ?? 100;
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 1)
      throw rangeError('historyLimit must be a positive integer; use 100', 'ui');
    this.validate(source);
    this.states = [{ markup: source.markup, styles: source.styles }];
  }
  /** Defensive snapshot of the current valid source. */
  get source(): LayoutSource {
    return { ...this.states[this.cursor] };
  }
  get canUndo(): boolean {
    return this.cursor > 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.states.length - 1;
  }
  private validate(source: LayoutSource): void {
    if (!source || typeof source.markup !== 'string' || typeof source.styles !== 'string')
      throw typeError('Layout needs markup and styles strings; supply both source fields', 'ui');
    const screen = buildScreen(source.markup, { ...this.options, styles: source.styles });
    for (const widget of screen.widgets) widget.dispose();
  }
  /** Validate both sources before committing. Invalid edits retain the previous valid document and preview. */
  apply(patch: Partial<LayoutSource>): void {
    const next = { ...this.source, ...patch };
    this.validate(next);
    if (next.markup === this.source.markup && next.styles === this.source.styles) return;
    this.states = this.states.slice(0, this.cursor + 1);
    this.states.push(next);
    if (this.states.length > this.historyLimit + 1) this.states.shift();
    this.cursor = this.states.length - 1;
    this.changed();
  }
  /** Build fresh widgets from the current document. Caller owns these widgets. */
  build(): Screen {
    return buildScreen(this.source.markup, { ...this.options, styles: this.source.styles });
  }
  /** The current markup tree, detached from document state. */
  get tree(): MarkupElement[] {
    return parseMarkup(this.source.markup);
  }
  /** Edit an element attribute, or remove it with undefined. */
  setAttribute(id: string, name: string, value: string | undefined): void {
    if (!/^[A-Za-z_][\w.-]*$/.test(name))
      throw typeError('Attribute name must be an XML name; use width, padding or another widget property', 'ui');
    const tree = this.tree,
      item = locate(tree, id);
    if (!item) throw rangeError(`No layout element ${id}; select an existing id`, 'ui');
    if (value === undefined) delete item.element.attributes[name];
    else item.element.attributes[name] = value;
    this.apply({ markup: serialize(tree) });
  }
  /** Replace the text of an element. The markup builder validates whether the tag accepts it. */
  setText(id: string, text: string): void {
    const tree = this.tree,
      item = locate(tree, id);
    if (!item) throw rangeError(`No layout element ${id}; select an existing id`, 'ui');
    item.element.text = text;
    this.apply({ markup: serialize(tree) });
  }
  /** Insert a widget into a container, or the top level; returns its generated stable id. */
  insert(tag: string, parentId?: string): string {
    const tree = this.tree;
    let n = 1;
    while (locate(tree, `element-${n}`)) n++;
    const id = `element-${n}`;
    const element: MarkupElement = {
      tag,
      attributes: { id },
      children: [],
      text: ['label', 'button', 'toggle'].includes(tag) ? tag : '',
      line: 1,
      column: 1,
    };
    const parent = parentId ? locate(tree, parentId) : null;
    if (parentId && !parent) throw rangeError(`No parent ${parentId}; select an existing container`, 'ui');
    (parent ? parent.element.children : tree).push(element);
    this.apply({ markup: serialize(tree) });
    return id;
  }
  /** Delete a widget and its subtree, undoably. */
  remove(id: string): void {
    const tree = this.tree,
      item = locate(tree, id);
    if (!item) throw rangeError(`No layout element ${id}; select an existing id`, 'ui');
    item.siblings.splice(item.index, 1);
    this.apply({ markup: serialize(tree) });
  }
  /** Reparent/reorder an element. Descendant cycles and invalid container tags reject atomically. */
  move(id: string, parentId: string | undefined, index = 0): void {
    const tree = this.tree,
      item = locate(tree, id),
      parent = parentId ? locate(tree, parentId) : null;
    if (!item || (parentId && !parent) || !Number.isInteger(index) || index < 0)
      throw rangeError('Move needs existing ids and a non-negative index; select valid elements', 'ui');
    if (parent && (parent.element === item.element || locate(item.element.children, parentId!)))
      throw rangeError('Cannot move an element into its descendant; select another parent', 'ui');
    item.siblings.splice(item.index, 1);
    const siblings = parent ? parent.element.children : tree;
    siblings.splice(Math.min(index, siblings.length), 0, item.element);
    this.apply({ markup: serialize(tree) });
  }
  undo(): boolean {
    if (!this.canUndo) return false;
    this.cursor--;
    this.changed();
    return true;
  }
  redo(): boolean {
    if (!this.canRedo) return false;
    this.cursor++;
    this.changed();
    return true;
  }
  /** Save exact validated sources, without handler functions or runtime state. */
  save(): string {
    return JSON.stringify({ version: 1, ...this.source } satisfies LayoutProject, null, 2);
  }
  /** Load a project string as one undoable edit; unsupported versions reject without changing the document. */
  load(json: string): void {
    let project: LayoutProject;
    try {
      project = JSON.parse(json);
    } catch {
      throw typeError('Layout project is not JSON; open a saved layout project', 'ui');
    }
    if (project?.version !== 1) throw rangeError('Unsupported layout project version; open a version 1 project', 'ui');
    this.apply({ markup: project.markup, styles: project.styles });
  }
  /** Subscribe to committed edits, undo and redo. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  dispose(): void {
    this.listeners.clear();
    this.states = [this.source];
    this.cursor = 0;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}

/** Options for the browser layout workspace. Rendering stays with the application's existing UiRenderer. */
export interface LayoutEditorOptions extends LayoutSource {
  ui: Ui;
  /** Engine canvas. The editor moves it into the preview until disposed, then restores its original place. */
  canvas: HTMLCanvasElement;
  /** Explicit action handlers allowed in markup, default none. Never loaded from project JSON. */
  actions?: ScreenOptions['actions'];
  signal?: AbortSignal;
}
/** Browser source/visual editor with selection, properties, hierarchy, preview, undo/redo and save/open. */
export class LayoutEditor {
  readonly document: LayoutDocument;
  readonly element: HTMLElement;
  private readonly preview: Panel;
  private readonly abort = new AbortController();
  private readonly cleanup: () => void;
  private selected: string | undefined;
  constructor(
    host: HTMLElement,
    private readonly options: LayoutEditorOptions,
  ) {
    options.signal?.throwIfAborted();
    this.document = new LayoutDocument(options, { actions: options.actions });
    this.preview = new Panel({ direction: 'stack', anchor: 'stretch', pointerEvents: 'none' });
    options.ui.add(this.preview);
    const owner = host.ownerDocument,
      root = owner.createElement('section');
    this.element = root;
    host.append(root);
    const shadow = root.attachShadow({ mode: 'open' }),
      style = owner.createElement('style');
    style.textContent = EDITOR_STYLE;
    shadow.append(style);
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: Node, caption?: string) => {
      const e = owner.createElement(tag);
      if (caption) e.textContent = caption;
      parent.appendChild(e);
      return e;
    };
    const shell = element('div', shadow);
    shell.className = 'workspace';
    const toolbar = element('header', shell);
    element('strong', toolbar, 'Layout studio');
    const status = element('output', toolbar, 'Ready');
    status.setAttribute('aria-live', 'polite');
    const run = (action: () => void) => {
      try {
        action();
        status.value = 'Ready';
      } catch (error) {
        status.value = error instanceof Error ? error.message : String(error);
      }
    };
    const button = (text: string, parent: Node, action: () => void, signal = this.abort.signal) => {
      const b = element('button', parent, text);
      b.type = 'button';
      b.addEventListener('click', () => run(action), { signal });
      return b;
    };
    button('Undo', toolbar, () => {
      this.document.undo();
    });
    button('Redo', toolbar, () => {
      this.document.redo();
    });
    const download = (name: string, text: string, type: string) => {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = element('a', shadow);
      a.href = url;
      a.download = name;
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const validateDraft = () => this.document.apply({ markup: markup.value, styles: styles.value });
    const save = () => {
      validateDraft();
      download('layout.json', this.document.save(), 'application/json');
    };
    button('Save project', toolbar, save);
    button('Export markup', toolbar, () => {
      validateDraft();
      download('layout.xml', this.document.source.markup, 'application/xml');
    });
    button('Export styles', toolbar, () => {
      validateDraft();
      download('layout.css', this.document.source.styles, 'text/css');
    });
    const file = element('input', toolbar);
    file.type = 'file';
    file.accept = '.json,application/json';
    file.setAttribute('aria-label', 'Open layout project');
    file.addEventListener(
      'change',
      () => {
        const selected = file.files?.[0];
        if (selected)
          void this.open(selected).then(
            () => {
              status.value = 'Opened project';
            },
            (error) => {
              status.value = String(error);
            },
          );
      },
      { signal: this.abort.signal },
    );
    const body = element('div', shell);
    body.className = 'body';
    const sidebar = element('aside', body);
    element('h2', sidebar, 'Elements');
    const palette = element('div', sidebar);
    palette.className = 'palette';
    for (const tag of ['panel', 'label', 'button', 'slider', 'toggle'])
      button(`Add ${tag}`, palette, () => {
        this.selected = this.document.insert(tag, this.selected);
        sync();
      });
    const tree = element('div', sidebar);
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Layout hierarchy');
    button('Delete selected', sidebar, () => {
      if (this.selected) {
        const id = this.selected;
        this.selected = undefined;
        this.document.remove(id);
      }
    });
    const stage = element('main', body);
    element('h2', stage, 'Preview');
    const viewport = element('div', stage);
    viewport.className = 'viewport';
    const canvas = options.canvas,
      originalParent = canvas.parentNode,
      placeholder = owner.createComment('UI editor canvas location'),
      mirror = canvas.nextElementSibling?.matches('[data-margo-ui="mirror"]') ? canvas.nextElementSibling : null;
    originalParent?.insertBefore(placeholder, canvas);
    viewport.append(canvas);
    if (mirror) viewport.append(mirror);
    const propertyPanel = element('aside', body);
    element('h2', propertyPanel, 'Properties');
    const selectedName = element('p', propertyPanel, 'Select an element');
    const fields = new Map<string, HTMLInputElement>();
    for (const name of ['text', 'width', 'height', 'padding', 'gap', 'direction', 'background', 'anchor']) {
      const label = element('label', propertyPanel, name),
        input = element('input', label);
      input.setAttribute('aria-label', `Selected ${name}`);
      fields.set(name, input);
      input.addEventListener(
        'change',
        () =>
          run(() => {
            if (!this.selected) return;
            if (name === 'text') this.document.setText(this.selected, input.value);
            else this.document.setAttribute(this.selected, name, input.value || undefined);
          }),
        { signal: this.abort.signal },
      );
    }
    const source = element('div', shell);
    source.className = 'sources';
    const area = (title: string) => {
      const label = element('label', source, title),
        text = element('textarea', label);
      text.setAttribute('aria-label', title);
      text.spellcheck = false;
      return text;
    };
    const markup = area('Markup'),
      styles = area('Style sheet');
    const select = (id: string | undefined) => {
      this.selected = id;
      const item = id ? locate(this.document.tree, id)?.element : undefined;
      selectedName.textContent = item ? `${item.tag} #${id}` : 'Select an element';
      for (const [name, field] of fields)
        field.value = item ? (name === 'text' ? item.text : (item.attributes[name] ?? '')) : '';
    };
    let treeAbort = new AbortController();
    const sync = () => {
      treeAbort.abort();
      treeAbort = new AbortController();
      const screen = this.document.build();
      for (const widget of [...this.preview.children]) widget.dispose();
      this.preview.add(...screen.widgets);
      options.ui.update(0);
      markup.value = this.document.source.markup;
      styles.value = this.document.source.styles;
      tree.replaceChildren();
      const addTree = (elements: MarkupElement[], depth = 1) => {
        for (const item of elements) {
          const id = item.attributes.id,
            b = button(`${item.tag}${id ? ' #' + id : ''}`, tree, () => select(id), treeAbort.signal);
          b.setAttribute('role', 'treeitem');
          b.setAttribute('aria-level', String(depth));
          b.style.paddingInlineStart = `${depth * 12}px`;
          b.disabled = !id;
          b.draggable = !!id;
          b.addEventListener('dragstart', (event) => event.dataTransfer?.setData('text/plain', id!), {
            signal: treeAbort.signal,
          });
          b.addEventListener('dragover', (event) => event.preventDefault(), { signal: treeAbort.signal });
          b.addEventListener(
            'drop',
            (event) => {
              event.preventDefault();
              const from = event.dataTransfer?.getData('text/plain');
              if (from) run(() => this.document.move(from, id, item.children.length));
            },
            { signal: treeAbort.signal },
          );
          addTree(item.children, depth + 1);
        }
      };
      addTree(this.document.tree);
      select(this.selected);
    };
    const sourceEdit = () => run(() => this.document.apply({ markup: markup.value, styles: styles.value }));
    markup.addEventListener('input', sourceEdit, { signal: this.abort.signal });
    styles.addEventListener('input', sourceEdit, { signal: this.abort.signal });
    viewport.addEventListener(
      'pointerdown',
      (event) => {
        const rect = canvas.getBoundingClientRect(),
          hit = pick(
            this.preview,
            (event.clientX - rect.left) / options.ui.cssScale,
            (event.clientY - rect.top) / options.ui.cssScale,
          );
        if (hit) select(hit.id);
      },
      { signal: this.abort.signal, capture: true },
    );
    root.addEventListener(
      'keydown',
      (event) => {
        const e = event as KeyboardEvent;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          run(save);
        } else if (
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === 'z' &&
          (e.composedPath()[0] as HTMLElement)?.tagName !== 'TEXTAREA'
        ) {
          e.preventDefault();
          run(() => {
            if (e.shiftKey) this.document.redo();
            else this.document.undo();
          });
        }
      },
      { signal: this.abort.signal },
    );
    const off = this.document.onChange(sync);
    sync();
    const externalAbort = () => this.dispose();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    this.cleanup = () => {
      this.abort.abort();
      treeAbort.abort();
      off();
      options.signal?.removeEventListener('abort', externalAbort);
      this.preview.dispose();
      this.document.dispose();
      const currentMirror = canvas.nextElementSibling?.matches('[data-margo-ui="mirror"]')
        ? canvas.nextElementSibling
        : mirror;
      if (originalParent)
        originalParent.insertBefore(canvas, placeholder.parentNode === originalParent ? placeholder : null);
      else canvas.remove();
      if (currentMirror) canvas.after(currentMirror);
      placeholder.remove();
      root.remove();
    };
  }
  /** Load a saved project from disk, respecting editor lifetime and caller cancellation. */
  async open(file: Blob, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.abort.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    const text = await file.text();
    this.abort.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    this.document.load(text);
  }
  /** Detach listeners and preview widgets. The application retains its Ui, canvas, renderer and engine. */
  dispose(): void {
    if (!this.abort.signal.aborted) this.cleanup();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}
const EDITOR_STYLE = `:host{display:block;color:#dce3e8;font:13px system-ui;background:#13181d;min-height:100vh}*{box-sizing:border-box}.workspace{padding:20px;max-width:1600px;margin:auto}header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #34414b;padding-bottom:16px}strong{font-size:20px;margin-right:20px}output{flex:1;min-width:100px;color:#98b4c5}button,input,textarea{font:inherit;color:inherit;background:#222b33;border:1px solid #43525e;border-radius:4px;padding:8px}button{cursor:pointer;min-height:40px;transition:background .12s}button:active{transform:translateY(1px)}button:hover{background:#354754}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #8fd3ff;outline-offset:2px}.body{display:grid;grid-template-columns:200px minmax(300px,1fr) 200px;gap:20px;padding:16px 0}h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#9cabb5}aside button{display:block;width:100%;text-align:left;margin-bottom:5px}.palette{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:16px}.palette button{font-size:11px}label{display:block;margin-bottom:12px}label input{display:block;width:100%;margin-top:4px}.viewport{position:relative;overflow:auto;background:#080b0e;border:1px solid #34414b;min-height:360px}canvas{display:block;width:640px;height:auto;aspect-ratio:16/9;max-width:100%;margin-inline:auto}.sources{display:grid;grid-template-columns:1fr 1fr;gap:20px}textarea{display:block;margin-top:8px;width:100%;min-height:280px;resize:vertical;font:12px/1.6 Consolas,monospace;tab-size:2}@media(max-width:900px){.body{grid-template-columns:160px minmax(0,1fr)}.body>aside:last-child{grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap}.sources{grid-template-columns:1fr}header input{max-width:220px}}@media(max-width:650px){.workspace{padding:12px}.body{grid-template-columns:minmax(0,1fr)}.body>aside:last-child{display:grid;grid-template-columns:1fr 1fr}.palette{grid-template-columns:repeat(3,1fr)}[role=tree]{max-height:180px;overflow:auto}.sources{grid-template-columns:minmax(0,1fr)}button{min-height:44px}.viewport{min-height:200px}header strong{width:100%}}`;

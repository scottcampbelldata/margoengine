/// <reference lib="esnext.disposable" preserve="true" />
import type { NodeSpec, Status, TreeDocument } from './spec.js';
import type { TraceEntry } from './tree.js';
import { MargoError } from '@margoengine/math/errors';

/** Read-only runtime interface; inspecting never advances the simulation. */
export interface TreeInspectionSource {
  readonly document: TreeDocument;
  readonly trace: readonly TraceEntry[];
  readonly ticks: number;
  readonly time: number;
  readonly status: Status;
}
/** Panel settings. All DOM and scheduling are local to the supplied container. */
export interface TreeInspectorOptions {
  /** Accessible panel title (default Behavior tree). */
  title?: string;
  /** Refresh with the container window's animation frames (default true). */
  autoRefresh?: boolean;
  /** Dispose the panel when aborted. */
  signal?: AbortSignal;
}
interface Row {
  element: HTMLElement;
  status: HTMLElement;
  scores: HTMLElement;
}
const colors = { idle: '#9ba7ba', success: '#76dcad', failure: '#ff9696', running: '#f5cd76' };

/** Collapsible live behavior-tree inspector, including untouched nodes and utility scores. */
export class TreeInspector {
  /** Panel appended to the supplied container. */
  readonly element: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private readonly summary: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly window: Window | null;
  private frame: number | null = null;
  private disposed = false;
  private readonly automatic: boolean;
  private paused = false;
  private readonly abort = (): void => this.dispose();
  private readonly signal?: AbortSignal;
  private readonly animate = (): void => {
    this.frame = null;
    if (this.disposed || this.paused) return;
    this.refresh();
    this.frame = this.window!.requestAnimationFrame(this.animate);
  };
  /** Mount a panel. Build the tree with trace:true, or the panel will explain why statuses are absent.
   * @throws TypeError if automatic refresh has no window scheduler; pass autoRefresh:false and call refresh.
   */
  constructor(
    private readonly source: TreeInspectionSource,
    container: HTMLElement,
    options: TreeInspectorOptions = {},
  ) {
    const doc = container.ownerDocument;
    this.window = doc.defaultView;
    this.automatic = options.autoRefresh !== false;
    if (options.autoRefresh !== false && !this.window?.requestAnimationFrame)
      throw new TypeError(
        'TreeInspector needs requestAnimationFrame; pass autoRefresh:false and call refresh after ticks',
      );
    this.element = doc.createElement('section');
    this.element.setAttribute('aria-label', options.title ?? 'Behavior tree');
    this.element.style.cssText =
      'font:13px/1.6 ui-monospace,monospace;color:#e5ebf5;background:#17202e;border:1px solid #465368;border-radius:8px;padding:16px;overflow:auto;max-height:80vh';
    const heading = doc.createElement('strong');
    heading.textContent = options.title ?? 'Behavior tree';
    this.summary = doc.createElement('p');
    this.summary.style.cssText = 'margin:4px 0 12px;color:#b4c1d5';
    this.toggle = doc.createElement('button');
    this.toggle.type = 'button';
    this.toggle.textContent = 'Pause display';
    this.toggle.setAttribute('aria-pressed', 'false');
    this.toggle.addEventListener('click', this.click);
    this.element.append(heading, this.summary, this.toggle);
    const list = doc.createElement('ul');
    list.style.cssText = 'list-style:none;padding-left:0;margin:12px 0 0';
    const draw = (node: NodeSpec, path: string, parent: HTMLElement): void => {
      const item = doc.createElement('li');
      item.dataset.path = path;
      const children: [NodeSpec, string][] = [];
      if ('children' in node) node.children.forEach((child, i) => children.push([child, `${path}.children[${i}]`]));
      if ('child' in node) children.push([node.child, `${path}.child`]);
      if (node.type === 'utility')
        node.options.forEach((option, i) => children.push([option.child, `${path}.options[${i}].child`]));
      const details = children.length ? doc.createElement('details') : null;
      const line = doc.createElement(details ? 'summary' : 'div');
      line.style.cssText = 'padding:3px 0;white-space:nowrap';
      const name = doc.createElement('span');
      name.textContent =
        `${node.type} ${node.label ?? ('name' in node ? node.name : 'condition' in node ? node.condition : '')}`.trim();
      const status = doc.createElement('span'),
        scores = doc.createElement('span');
      status.style.marginLeft = '12px';
      scores.style.cssText = 'margin-left:12px;color:#c6bcff';
      line.append(name, status, scores);
      this.rows.set(path, { element: item, status, scores });
      if (details) {
        details.open = true;
        const group = doc.createElement('ul');
        group.style.cssText = 'list-style:none;padding-left:22px;border-left:1px solid #465368;margin-left:5px';
        details.append(line, group);
        item.append(details);
        for (const [child, at] of children) draw(child, at, group);
      } else item.append(line);
      parent.append(item);
    };
    draw(source.document.root, 'root', list);
    this.element.append(list);
    this.signal = options.signal;
    container.append(this.element);
    this.refresh();
    if (this.signal?.aborted) this.dispose();
    else {
      this.signal?.addEventListener('abort', this.abort, { once: true });
      if (options.autoRefresh !== false) this.frame = this.window!.requestAnimationFrame(this.animate);
    }
  }
  private readonly click = (): void => {
    this.paused ? this.resume() : this.pause();
  };
  /** Copy the current trace into every node; unvisited nodes read idle.
   * @throws MargoError disposed after disposal; create a new inspector.
   */
  refresh(): void {
    if (this.disposed) throw new MargoError('disposed', 'TreeInspector is disposed; create a new inspector');
    this.summary.textContent = `Tick ${this.source.ticks} | ${this.source.time.toFixed(3)} s | ${this.source.status}${this.source.trace.length ? ' | Last tick' : ' | No trace: enable trace:true and tick the tree'}`;
    const entries = new Map(this.source.trace.map((entry) => [entry.path, entry]));
    for (const [path, row] of this.rows) {
      const entry = entries.get(path),
        status = entry?.status ?? 'idle';
      row.element.dataset.status = status;
      row.status.textContent = status;
      row.status.style.color = colors[status];
      const nodeScores = entry?.scores;
      row.scores.textContent = nodeScores
        ? `scores: ${nodeScores.map((score) => Number(score.toFixed(3))).join(', ')}`
        : '';
    }
  }
  /** Pause display updates; the source tree keeps running. */
  pause(): void {
    this.paused = true;
    if (this.frame !== null) this.window?.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.toggle.textContent = 'Resume display';
    this.toggle.setAttribute('aria-pressed', 'true');
  }
  /** Resume automatic display updates and immediately copy the latest trace.
   * @throws MargoError disposed after disposal; create a new inspector.
   */
  resume(): void {
    this.refresh();
    this.paused = false;
    this.toggle.textContent = 'Pause display';
    this.toggle.setAttribute('aria-pressed', 'false');
    if (this.automatic && this.frame === null && this.window?.requestAnimationFrame)
      this.frame = this.window.requestAnimationFrame(this.animate);
  }
  /** Cancel scheduled updates, detach listeners and remove only this panel. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.abort);
    this.toggle.removeEventListener('click', this.click);
    this.element.remove();
    this.rows.clear();
  }
  /** Dispose for using declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

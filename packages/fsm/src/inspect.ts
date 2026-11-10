import type { StateMachine } from './index.js';
import { MachineTrace } from './trace.js';

/** Where the live machine overlay is mounted and how it obtains trace records. */
export interface MachineViewOptions<C> {
  /** Inspector host. Its open shadow root is used when present. Default none. */
  inspector?: { element: HTMLElement };
  /** Explicit mount point, taking precedence over inspector. Default document.body. */
  parent?: HTMLElement;
  /** Existing trace to read without taking ownership. Default a new MachineTrace. */
  trace?: Pick<MachineTrace<C>, 'records'>;
  /** Most recent trace entries shown, whole number 1 to 10,000. Default 32. */
  capacity?: number;
  /** Refresh on animation frames. Default true; false requires refresh(). */
  live?: boolean;
  /** Dispose when aborted. Default none. */
  signal?: AbortSignal;
}

/** Live, accessible hierarchy and transition view, embeddable in the inspector without a renderer dependency. */
export class MachineView<C> {
  /** Overlay host, removed on disposal. */
  readonly element: HTMLDivElement;
  private readonly machine: StateMachine<C>;
  private readonly trace: Pick<MachineTrace<C>, 'records'>;
  private readonly owned: MachineTrace<C> | undefined;
  private readonly capacity: number;
  private readonly content: HTMLDivElement;
  private readonly window: Window | null;
  private readonly detach: () => void;
  private frame: number | undefined;
  private disposed = false;
  private signature = '';
  /** Mount a view. If the machine is already traced, supply that trace to avoid taking its listener. */
  constructor(machine: StateMachine<C>, options: MachineViewOptions<C> = {}) {
    const { capacity = 32 } = options;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000)
      throw new RangeError('Invalid view capacity; use an integer from 1 to 10000');
    const parent = options.parent ?? options.inspector?.element ?? globalThis.document?.body;
    if (!parent) throw new TypeError('Missing DOM mount point; pass parent or inspector from a browser document');
    const doc = parent.ownerDocument;
    this.window = doc.defaultView;
    this.machine = machine;
    this.capacity = capacity;
    this.element = doc.createElement('div');
    this.element.dataset.margoMachineView = '';
    if (!options.parent) this.element.style.cssText = 'position:fixed;left:12px;bottom:12px;width:min(480px,calc(100vw - 24px));z-index:10002';
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', 'State machine');
    const root = this.element.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = ':host{display:block;box-sizing:border-box;background:#151b24;color:#e7edf5;font:12px/1.5 ui-monospace,monospace;max-width:520px;max-height:70vh;overflow:auto;border:1px solid #405064;border-radius:6px;padding:14px}h2{font:600 15px system-ui;margin:0 0 10px}h3{font:600 12px system-ui;color:#a5b8cd;margin:16px 0 6px}ol{padding-left:22px;margin:0}li{padding:2px 0;overflow-wrap:anywhere}button,input{font:inherit;color:inherit;background:#222e3e;border:1px solid #53677e;border-radius:3px;padding:4px 7px}input{width:140px;margin-left:8px}[aria-current=true]{color:#85edc8;font-weight:bold}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.state{border-left:2px solid #405064;padding-left:10px;margin:4px 0}.active{border-color:#85edc8}.muted{color:#9aacbf}summary{cursor:pointer}';
    const title = doc.createElement('h2'); title.textContent = 'State machine';
    const bar = doc.createElement('div');
    const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh';
    refresh.addEventListener('click', () => this.refresh(filter.value));
    const filter = doc.createElement('input'); filter.type = 'search'; filter.placeholder = 'Filter states';
    filter.setAttribute('aria-label', 'Filter states');
    filter.addEventListener('input', () => { this.signature = ''; this.refresh(filter.value); });
    bar.append(refresh, filter);
    this.content = doc.createElement('div');
    root.append(style, title, bar, this.content);
    this.owned = options.trace ? undefined : new MachineTrace(machine, { capacity });
    this.trace = options.trace ?? this.owned!;
    const stop = () => this.dispose();
    this.detach = () => options.signal?.removeEventListener('abort', stop);
    if (options.signal?.aborted) { this.dispose(); return; }
    options.signal?.addEventListener('abort', stop, { once: true });
    const mount = !options.parent && options.inspector ? parent.shadowRoot ?? parent : parent;
    mount.append(this.element);
    this.refresh();
    if (options.live !== false && this.window?.requestAnimationFrame) {
      const tick = () => { this.refresh(filter.value); if (!this.disposed) this.frame = this.window!.requestAnimationFrame(tick); };
      this.frame = this.window.requestAnimationFrame(tick);
    }
  }
  /** Refresh active paths, remembered history and recent transitions, including nested parallel machines. */
  refresh(filter = ''): void {
    if (this.disposed) return;
    const records = this.trace.records.slice(-this.capacity);
    const configurations: { name: string; machine: StateMachine<C>; path: string[] }[] = [];
    const visit = (machine: StateMachine<C>, name: string) => {
      const path: string[] = [];
      for (let at: string | undefined = machine.state; at !== undefined; at = machine.states[at]?.parent) path.unshift(at);
      configurations.push({ name, machine, path });
      for (const [state, spec] of Object.entries(machine.states)) if (spec.regions)
        for (const [region, child] of Object.entries(spec.regions.machines)) visit(child, `${name}/${state}/${region}`);
    };
    visit(this.machine, 'root');
    const signature = JSON.stringify([filter, configurations.map(c => [c.name, c.path, [...c.machine.memory]]),
      records.map(({ machine, clock, from, to, event, after }) => [machine, clock, from, to, event, after])]);
    // Payloads may be cyclic; only ordinary TraceRecord fields are rendered and compared.
    if (signature === this.signature) return;
    this.signature = signature;
    const doc = this.element.ownerDocument;
    const nodes: HTMLElement[] = [];
    const heading = (text: string) => { const h = doc.createElement('h3'); h.textContent = text; nodes.push(h); };
    for (const { name, machine, path } of configurations) {
      heading(`${name}: ${path.join(' > ')}`);
      const tree = doc.createElement('div'); tree.dataset.machine = name;
      for (const [state, spec] of Object.entries(machine.states)) {
        if (filter && !state.toLowerCase().includes(filter.toLowerCase())) continue;
        const row = doc.createElement('details'); row.className = `state${path.includes(state) ? ' active' : ''}`;
        row.dataset.state = state;
        if (path.includes(state)) row.setAttribute('aria-current', 'true');
        let depth = 0;
        for (let at = spec.parent; at !== undefined; at = machine.states[at]?.parent) depth++;
        row.style.marginLeft = `${depth * 16}px`;
        const label = doc.createElement('summary'); label.textContent = state;
        const edges = doc.createElement('pre');
        edges.textContent = machine.transitions.filter(t => t.from === state)
          .map(t => `${t.event?.startsWith('\0') ? 'internal' : t.event ?? `after ${t.after}s`} -> ${t.to}`).join('\n') || 'No outgoing transitions';
        row.append(label, edges); tree.append(row);
      }
      nodes.push(tree);
      const history = doc.createElement('pre'); history.dataset.history = name;
      history.textContent = [...machine.memory].map(([state, remembered]) => `${state}: ${remembered}`).join('\n') || 'No remembered history';
      heading(`${name} history`); nodes.push(history);
    }
    heading('Recent transitions');
    const list = doc.createElement('ol'); list.dataset.trace = '';
    for (const record of records) {
      const row = doc.createElement('li');
      row.textContent = `${record.clock}s ${record.machine || 'root'}: ${record.from ?? '(start)'} -> ${record.to ?? '(stop)'} [${record.event ?? (record.after === null ? 'goto / always' : `after ${record.after}s`)}]`;
      list.append(row);
    }
    nodes.push(list);
    this.content.replaceChildren(...nodes);
  }
  /** Remove the overlay, stop frame callbacks and dispose only the trace created by this view. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) this.window?.cancelAnimationFrame(this.frame);
    this.detach(); this.owned?.dispose(); this.element.remove();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void { this.dispose(); }
}

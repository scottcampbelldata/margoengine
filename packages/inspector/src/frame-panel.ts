import type {CommandReport, FrameReport, GPUPassReport, PipelineReport} from './frame.js';

const css = `
:host{position:fixed;left:12px;bottom:12px;width:520px;max-width:calc(100vw - 24px);z-index:10001;display:block;color:#202226;font:12px/1.4 system-ui;letter-spacing:0}
*{box-sizing:border-box}section{background:#fafbfc;border:1px solid #b9bec7;border-radius:4px;max-height:min(70dvh,640px);overflow:auto}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid #d5d9df;position:sticky;top:0;background:#fafbfc}
h2{font-size:14px;margin:0}button{font:inherit;border:1px solid #9aa1ab;border-radius:3px;background:#fff;color:inherit;cursor:pointer;padding:3px 8px}
button:focus-visible,summary:focus-visible{outline:2px solid #087e67;outline-offset:1px}
p,ul{margin:0;padding:6px 12px}ul{padding-left:28px;color:#8a4b00}details{padding:2px 0 2px 12px}summary{cursor:pointer;padding:2px 0}
.body{padding:4px 12px 10px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:2px 6px 2px 0;border-bottom:1px solid #e3e6ea;vertical-align:top}
th{font-weight:600}.muted{color:#5d636b}td button{padding:0 6px}
`;

const ms = (value: number | null): string => (value === null ? '-' : value.toFixed(3) + ' ms');
const bytes = (value: number): string => (value >= 1048576 ? (value / 1048576).toFixed(2) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B');
const name = (pipeline: PipelineReport): string => pipeline.label || `(${pipeline.passes.join(', ') || 'unused'})`;
const count = (value: number | null | undefined): string => (value === null || value === undefined ? '?' : value.toLocaleString('en-US'));

/** DOM view of a FrameReport: frame graph tree, draw tables, pipelines and memory. Text only (no HTML injection). */
export class FramePanel {
  readonly element: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly doc: Document;

  constructor(parent: HTMLElement, onCapture: () => void, private readonly onSelect: (entity: number) => void) {
    this.doc = parent.ownerDocument;
    this.element = this.doc.createElement('div');
    this.element.dataset.margoFrameDebugger = '';
    const root = this.element.attachShadow({mode: 'open'}), style = this.el('style', css), section = this.el('section'), header = this.el('header');
    const button = this.el('button', 'Capture frame');
    button.type = 'button';
    button.addEventListener('click', onCapture);
    header.append(this.el('h2', 'Frame debugger'), button);
    this.body = this.el('div');
    this.body.append(this.el('p', 'No capture yet.'));
    section.append(header, this.body);
    root.append(style, section);
    parent.append(this.element);
  }

  show(report: FrameReport): void {
    const t = report.totals, body = this.body;
    body.replaceChildren(
      this.el('p', `${t.draws} draws (${t.indexedDraws} indexed, ${t.indirectDraws} indirect), ${t.dispatches} dispatches, ${count(t.triangles)} triangles, ` +
        `${t.renderPasses + t.computePasses} GPU passes. CPU ${ms(report.cpuMilliseconds)}, GPU ${ms(report.gpuMilliseconds)}. ` +
        `Uploads ${bytes(t.uploadBytes)} in ${t.uploads} writes; ${t.pipelinesCreated} pipelines compiled this frame.`));
    if (report.note) body.append(this.el('p', report.note, 'muted'));
    if (report.warnings.length) {
      const list = this.el('ul');
      for (const warning of report.warnings) list.append(this.el('li', warning));
      body.append(list);
    }
    for (const entry of report.graph) {
      const draws = entry.passes.reduce((sum, pass) => sum + pass.commands.length, 0);
      const node = this.details(`${entry.name} (${entry.owner}${entry.order === null ? '' : ', order ' + entry.order}): ${draws} commands, CPU ${ms(entry.cpuMilliseconds)}, GPU ${ms(entry.gpuMilliseconds)}`);
      for (const pass of entry.passes) node.append(this.pass(pass, report.pipelines));
      body.append(node);
    }
    const pipelines = this.details(`Pipelines (${report.pipelines.length})`);
    pipelines.append(this.table(['#', 'Label (passes)', 'Kind', 'Cull', 'Blend', 'Depth', 'MSAA', 'Textures', 'Samplers', 'New'], report.pipelines.map(p => [
      String(p.id), name(p), p.kind, p.cullMode ?? '?', p.blend?.join(', ') ?? '?',
      p.depth === undefined ? '?' : p.depth === null ? 'none' : `${p.depth.format} ${p.depth.compare}${p.depth.write ? ' write' : ''}`,
      p.samples === undefined ? '?' : String(p.samples), `${p.textures}/16`, `${p.samplers}/16`, p.createdThisFrame ? 'yes' : ''])));
    body.append(pipelines);
    const memory = report.memory, memoryNode = this.details(`GPU memory ${bytes(memory.bytes)} (tracked since attach)`);
    memoryNode.append(this.table(['Kind', 'Label', 'Size'], [
      ['buffers', `${memory.buffers.count} live`, bytes(memory.buffers.bytes)], ['textures', `${memory.textures.count} live`, bytes(memory.textures.bytes)],
      ...memory.largest.map(item => [item.kind, item.label, bytes(item.bytes)])]));
    body.append(memoryNode);
  }

  dispose(): void {
    this.element.remove();
  }

  private pass(pass: GPUPassReport, pipelines: PipelineReport[]): HTMLDetailsElement {
    const node = this.details(`${pass.kind} pass ${pass.label ? `"${pass.label}" ` : ''}(encoder ${pass.encoder}): ${pass.commands.length} commands, GPU ${ms(pass.gpuMilliseconds)}`);
    for (const target of pass.attachments) {
      const view = target.view ? `${target.view.label || 'texture'} ${target.view.format} ${target.view.width}x${target.view.height}${target.view.sampleCount > 1 ? ' x' + target.view.sampleCount : ''}` : 'view created before attach';
      node.append(this.el('p', `${target.target}${target.target === 'color' ? target.index : ''}: ${view}, ${target.loadOp ?? '-'}/${target.storeOp ?? '-'}`, 'muted'));
    }
    const rows = pass.commands.map((command, index) => this.row(index, command, pipelines));
    if (rows.length) {
      const table = this.table(['#', 'Command', 'Count', 'Instances', 'Triangles', 'Pipeline', 'Groups', 'Object'], []);
      table.tBodies[0].append(...rows);
      node.append(table);
    }
    return node;
  }

  private row(index: number, command: CommandReport, pipelines: PipelineReport[]): HTMLTableRowElement {
    const pipeline = command.pipeline === null ? undefined : pipelines[command.pipeline];
    const amount = command.workgroups !== undefined ? (command.workgroups ? command.workgroups.join('x') : '?') : command.bundles !== undefined ? `${command.bundles} bundles` : count(command.indexCount ?? command.vertexCount);
    const row = this.doc.createElement('tr');
    for (const text of [String(index), command.kind, amount, count(command.instanceCount), count(command.triangles), pipeline ? `#${pipeline.id} ${pipeline.label}`.trim() : '-', command.bindGroups.map(id => id ?? '-').join(', ')]) row.append(this.el('td', text));
    const cell = this.el('td');
    if (command.entities.length) {
      const button = this.el('button', `${command.entities.length} mesh${command.entities.length > 1 ? 'es' : ''}`);
      button.type = 'button';
      button.title = 'Select in the Inspector';
      button.addEventListener('click', () => this.onSelect(command.entities[0]));
      cell.append(button);
    }
    row.append(cell);
    return row;
  }

  private details(title: string): HTMLDetailsElement {
    const node = this.el('details');
    node.append(this.el('summary', title));
    return node;
  }

  private table(head: string[], rows: string[][], className?: string): HTMLTableElement {
    const table = this.el('table', '', className), header = this.el('tr'), tbody = this.el('tbody');
    for (const text of head) header.append(this.el('th', text));
    table.append(this.el('thead'), tbody);
    table.tHead!.append(header);
    for (const values of rows) {
      const row = this.el('tr');
      for (const text of values) row.append(this.el('td', text));
      tbody.append(row);
    }
    return table;
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className?: string): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
}

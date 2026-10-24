// Result files. Every run writes benchmarks/runs/<id>.json (schema margo-bench/1), a Markdown report and an HTML
// report next to it (git-ignored). --baseline merges the run into benchmarks/baselines/<machine>.json and --record
// keeps a copy in benchmarks/records/ (both committed). --compare resolves a run id, commit, file or "baseline".
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { worsening } from './stats.mjs';
import { root } from './env.mjs';

export const SCHEMA = 'margo-bench/1';
export const dirs = {
  runs: resolve(root, 'benchmarks/runs'),
  baselines: resolve(root, 'benchmarks/baselines'),
  records: resolve(root, 'benchmarks/records'),
};

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const listed = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(dir, f))
    : [];

/** Writes the run's JSON, Markdown and HTML; returns their paths. */
export function writeRun(result) {
  mkdirSync(dirs.runs, { recursive: true });
  const base = join(dirs.runs, result.id);
  writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(`${base}.md`, markdown(result));
  writeFileSync(`${base}.html`, html(result));
  return { json: `${base}.json`, md: `${base}.md`, html: `${base}.html` };
}

/** Merges this run's suites into the machine's baseline (other suites already there are kept). */
export function saveBaseline(result, name = result.env.machine) {
  mkdirSync(dirs.baselines, { recursive: true });
  const file = join(dirs.baselines, `${name}.json`),
    previous = existsSync(file) ? read(file) : null;
  const merged = { ...result, suites: { ...(previous?.suites ?? {}), ...result.suites }, baselineOf: result.id };
  delete merged.compare;
  writeFileSync(file, `${JSON.stringify(merged, null, 1)}\n`);
  return file;
}

/** Keeps a committed copy of the run (and its report) in benchmarks/records/. */
export function saveRecord(result) {
  mkdirSync(dirs.records, { recursive: true });
  const base = join(dirs.records, result.id);
  writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(`${base}.md`, markdown(result));
  return `${base}.json`;
}

/**
 * Writes bench/web/reference.json, the medians the in-browser runner shows as "ours": every Margo case of the browser
 * suites. A smoke or dev run never replaces an official reference.
 */
export function saveReference(result) {
  const file = resolve(root, 'bench/web/reference.json'),
    previous = existsSync(file) ? read(file) : {};
  if (previous.label === 'official' && result.label !== 'official') return null;
  const cases = {};
  for (const [suite, s] of Object.entries(result.suites))
    if (s.uses === 'gpu')
      for (const [id, c] of Object.entries(s.cases ?? {}))
        if (!id.includes('@') && c.metrics && !c.unsupported)
          cases[`${suite}/${id}`] = Object.fromEntries(Object.entries(c.metrics).map(([m, v]) => [m, v.median]));
  if (!Object.keys(cases).length) return null;
  const { env } = result,
    browser = env.browser ? `, ${env.browser.browser.name} ${env.browser.browser.version}` : '';
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        id: result.id,
        label: result.label,
        valid: result.valid,
        date: result.date,
        machine: `${env.host.cpu}, ${env.gpu.map((g) => g.name).join(' + ')}${browser}`,
        cases,
      },
      null,
      1,
    )}
`,
  );
  return file;
}

/**
 * Finds the result `target` names: a file path, "baseline" (this machine's), "last" (the newest run before this one),
 * a run id (or its start) or an engine commit (newest run of that commit, from runs, records and baselines).
 */
export function resolveTarget(target, { machine, exclude }) {
  if (existsSync(target)) return read(target);
  if (target === 'baseline') {
    const file = join(dirs.baselines, `${machine}.json`);
    return existsSync(file) ? read(file) : null;
  }
  const all = [...listed(dirs.runs), ...listed(dirs.records), ...listed(dirs.baselines)]
    .map((file) => {
      try {
        return { file, result: read(file) };
      } catch {
        return null;
      }
    })
    .filter((x) => x?.result.schema === SCHEMA && x.result.id !== exclude)
    .sort((a, b) => (a.result.date < b.result.date ? 1 : -1));
  if (target === 'last') return all.find((x) => x.file.startsWith(dirs.runs))?.result ?? null;
  return (
    all.find((x) => x.result.id === target || basename(x.file, '.json') === target)?.result ??
    all.find((x) => x.result.id.startsWith(target))?.result ??
    all.find((x) => x.result.env.engine.commitFull?.startsWith(target) || x.result.env.engine.commit === target)
      ?.result ??
    null
  );
}

/**
 * Compares `current` with `base` metric by metric. A metric regresses when it is worse by more than its threshold
 * (default `threshold`) and by more than either run's spread (so noise alone never fails a run). Timings from another
 * machine are shown but not judged; exact metrics (bytes, counts) are judged on any machine.
 */
export function compare(current, base, { threshold }) {
  const sameMachine = current.env.machine === base.env.machine,
    rows = [];
  for (const [suite, s] of Object.entries(current.suites))
    for (const [id, c] of Object.entries(s.cases ?? {}))
      for (const [metric, m] of Object.entries(c.metrics ?? {})) {
        const b = base.suites?.[suite]?.cases?.[id]?.metrics?.[metric];
        if (!b || m.median == null || b.median == null) continue;
        const worse = worsening(b.median, m.median, m.better),
          limit = m.threshold ?? threshold,
          judged = m.exact || sameMachine;
        const status =
          worse == null
            ? m.median === b.median
              ? 'same'
              : 'changed'
            : !judged
              ? 'not judged'
              : worse > limit && (m.exact || worse > Math.max(m.spread ?? 0, b.spread ?? 0))
                ? 'regression'
                : worse < -limit && (m.exact || -worse > Math.max(m.spread ?? 0, b.spread ?? 0))
                  ? 'improvement'
                  : 'same';
        rows.push({ suite, case: id, metric, before: b.median, after: m.median, change: worse, status });
      }
  return {
    against: base.id,
    commit: base.env.engine.commit,
    sameMachine,
    threshold,
    regressions: rows.filter((r) => r.status === 'regression').length,
    improvements: rows.filter((r) => r.status === 'improvement').length,
    rows,
  };
}

const fmt = (x) =>
  x == null
    ? ''
    : Math.abs(x) >= 1000
      ? Math.round(x).toLocaleString('en-US')
      : Math.abs(x) >= 10
        ? x.toFixed(1)
        : x.toFixed(2);
const pct = (x) => (x == null ? '' : `${(x * 100).toFixed(1)}%`);
const signed = (r) =>
  r.change == null ? '' : r.change > 0 ? `${pct(r.change)} worse` : r.change < 0 ? `${pct(-r.change)} better` : '0%';

function lines(result) {
  const { env, gate } = result,
    gpu = env.gpu?.map((g) => `${g.name} (driver ${g.driver ?? '?'})`).join(', ') || 'unknown',
    browser = env.browser
      ? `${env.browser.browser.name} ${env.browser.browser.version} (${env.browser.browser.channel}); WebGPU adapter ${
          env.browser.webgpu ? `${env.browser.webgpu.vendor} ${env.browser.webgpu.architecture}` : 'none'
        }`
      : 'not used';
  return {
    head: [
      ['Label', result.label],
      ['Valid', result.valid ? 'yes' : `no: ${result.invalid.join('; ')}`],
      [
        'Engine',
        `${env.engine.name} ${env.engine.version}, commit ${env.engine.commit}${env.engine.dirty ? ' (dirty)' : ''}`,
      ],
      ['Date', result.date],
      ['Machine', `${env.host.cpu}, ${env.host.cores} threads, ${env.host.memoryGB} GB (id ${env.machine})`],
      ['GPU', gpu],
      ['OS', `${env.host.os} ${env.host.osRelease} (${env.host.osVersion}), Node ${env.host.node}`],
      ['Browser', browser],
      [
        'Gate',
        gate
          ? `AC ${gate.ac ?? 'unknown'}; GPU lock ${gate.lock ? 'held' : 'not needed'}; CPU ${gate.quiet?.cpuLoadPercent ?? '?'}% after ${gate.quiet?.waitedSeconds ?? 0} s${gate.quiet?.skipped ? ' (gate skipped)' : ''}`
          : 'none',
      ],
      [
        'Method',
        `${result.options.warmup} warm-up + ${result.options.runs} runs per case; median, p95 and spread (max - min) / median over runs; noise threshold ${pct(result.options.noise)}`,
      ],
    ],
  };
}

/** Markdown report of a result (with its comparison when there is one). */
export function markdown(result) {
  const { head } = lines(result),
    out = [`# Margo benchmark ${result.id}`, '', '| | |', '| --- | --- |', ...head.map(([k, v]) => `| ${k} | ${v} |`)];
  const deltas = new Map((result.compare?.rows ?? []).map((r) => [`${r.suite}/${r.case}/${r.metric}`, r]));
  if (result.compare)
    out.push(
      '',
      `Compared with ${result.compare.against} (commit ${result.compare.commit}${result.compare.sameMachine ? ', same machine' : ', another machine: timings not judged'}): ${result.compare.regressions} regressions, ${result.compare.improvements} improvements over ${pct(result.compare.threshold)}.`,
    );
  for (const [name, s] of Object.entries(result.suites)) {
    out.push('', `## ${name}`, '', `${s.title}. ${s.status}${s.seconds != null ? ` in ${s.seconds} s` : ''}.`);
    if (s.note) out.push('', s.note);
    if (s.error) out.push('', `Error: ${s.error}`);
    const rows = Object.entries(s.cases ?? {});
    if (!rows.length) continue;
    out.push(
      '',
      '| Case | Metric | Median | p95 | Spread | Runs | Change |',
      '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    );
    for (const [id, c] of rows) {
      if (c.error) {
        out.push(`| ${id} | error | ${c.error.replaceAll('|', '/').slice(0, 200)} | | | | |`);
        continue;
      }
      if (c.unsupported) {
        out.push(`| ${id} | skipped: ${c.unsupported} | | | | | |`);
        continue;
      }
      for (const [metric, m] of Object.entries(c.metrics).sort((a, b) => b[1].primary - a[1].primary)) {
        if (m.median == null) continue;
        const d = deltas.get(`${name}/${id}/${metric}`);
        out.push(
          `| ${id} | ${m.primary ? `**${metric}**` : metric}${m.unit ? ` (${m.unit})` : ''} | ${fmt(m.median)} | ${fmt(m.p95)} | ${m.exact ? '' : pct(m.spread)}${m.noisy ? ' noisy' : ''} | ${m.n} | ${d ? `${d.status === 'same' ? '' : `${d.status} `}${signed(d)}`.trim() : ''} |`,
        );
      }
    }
  }
  return `${out.join('\n')}\n`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Self-contained HTML report of a result. */
export function html(result) {
  const { head } = lines(result),
    deltas = new Map((result.compare?.rows ?? []).map((r) => [`${r.suite}/${r.case}/${r.metric}`, r]));
  const suites = Object.entries(result.suites)
    .map(([name, s]) => {
      const rows = Object.entries(s.cases ?? {})
        .flatMap(([id, c]) =>
          c.error || c.unsupported
            ? [`<tr><td>${esc(id)}</td><td colspan="6">${esc(c.error ?? `skipped: ${c.unsupported}`)}</td></tr>`]
            : Object.entries(c.metrics)
                .filter(([, m]) => m.median != null)
                .sort((a, b) => b[1].primary - a[1].primary)
                .map(([metric, m]) => {
                  const d = deltas.get(`${name}/${id}/${metric}`);
                  return `<tr class="${m.noisy ? 'noisy' : ''}"><td>${esc(id)}</td><td>${m.primary ? `<b>${esc(metric)}</b>` : esc(metric)} ${esc(m.unit)}</td><td>${fmt(m.median)}</td><td>${fmt(m.p95)}</td><td>${m.exact ? '' : pct(m.spread)}${m.noisy ? ' noisy' : ''}</td><td>${m.n}</td><td class="${d?.status ?? ''}">${d ? esc(`${d.status} ${signed(d)}`) : ''}</td></tr>`;
                }),
        )
        .join('');
      return `<section><h2>${esc(name)}</h2><p>${esc(s.title)}. ${esc(s.status)}${s.seconds != null ? ` in ${s.seconds} s` : ''}.${s.note ? ` ${esc(s.note)}` : ''}${s.error ? ` Error: ${esc(s.error)}` : ''}</p>${rows ? `<table><thead><tr><th>Case</th><th>Metric</th><th>Median</th><th>p95</th><th>Spread</th><th>Runs</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>` : ''}</section>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Margo benchmark ${esc(result.id)}</title>
<style>:root{color-scheme:light dark;--fg:#1d2430;--bg:#fbfbfd;--line:#d9dde5;--bad:#b42318;--good:#067647;--muted:#5b6474}@media (prefers-color-scheme:dark){:root{--fg:#e7eaf0;--bg:#12151b;--line:#2c323d;--bad:#ff7a6b;--good:#5ad19a;--muted:#9aa3b2}}body{font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:1100px;padding:16px}table{border-collapse:collapse;width:100%;margin:8px 0 24px;font-variant-numeric:tabular-nums}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}td:nth-child(n+3){text-align:right}.regression{color:var(--bad);font-weight:600}.improvement{color:var(--good)}.noisy td{color:var(--muted)}h1{font-size:20px}h2{font-size:16px;margin-top:28px}.head td:first-child{color:var(--muted);width:90px}.head td{text-align:left!important}section{overflow-x:auto}</style></head><body>
<h1>Margo benchmark ${esc(result.id)}</h1><table class="head">${head.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${result.compare ? `<p>Compared with ${esc(result.compare.against)} (commit ${esc(result.compare.commit)}${result.compare.sameMachine ? ', same machine' : ', another machine: timings not judged'}): <b>${result.compare.regressions} regressions</b>, ${result.compare.improvements} improvements over ${pct(result.compare.threshold)}.</p>` : ''}
${suites}</body></html>
`;
}

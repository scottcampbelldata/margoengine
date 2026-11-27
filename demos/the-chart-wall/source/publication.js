import { methods } from './archive.mjs';
import provenance from './tools/source.json';

const theme = { background:'#fcfaf2', text:'#424a3e', fontFamily:'Segoe UI, Arial, sans-serif' };

export function publicationSVG(markup, chart, snapshot) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = doc.documentElement, ns = 'http://www.w3.org/2000/svg';
  if (svg.localName !== 'svg' || svg.querySelector('image')) throw new Error('The chart export did not preserve its vector marks.');
  const width = Number.parseFloat(svg.getAttribute('width'));
  const height = Number.parseFloat(svg.getAttribute('height'));
  const offset = 53, footing = 35;
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + (height + offset + footing));
  svg.setAttribute('height', String(height + offset + footing));
  svg.setAttribute('role', 'img');
  if (chart.id === 'orbits') {
    const dark = methods.find(method => method.shape === 'square');
    for (const mark of svg.querySelectorAll('circle[fill="' + dark.color + '"]')) {
      const square = doc.createElementNS(ns, 'rect');
      const half = Number(mark.getAttribute('r'));
      square.setAttribute('x', String(Number(mark.getAttribute('cx')) - half));
      square.setAttribute('y', String(Number(mark.getAttribute('cy')) - half));
      square.setAttribute('width', String(half * 2));
      square.setAttribute('height', String(half * 2));
      square.setAttribute('fill', dark.color);
      mark.replaceWith(square);
    }
  }
  const group = doc.createElementNS(ns, 'g');
  group.setAttribute('transform', 'translate(0 ' + offset + ')');
  group.append(...svg.childNodes);
  const paper = doc.createElementNS(ns, 'rect');
  paper.setAttribute('width', '100%');
  paper.setAttribute('height', '100%');
  paper.setAttribute('fill', theme.background);
  svg.append(paper, group);
  const text = (tag, value, attrs = {}) => {
    const element = doc.createElementNS(ns, tag);
    element.textContent = value;
    for (const [key, attribute] of Object.entries(attrs)) element.setAttribute(key, attribute);
    return element;
  };
  svg.prepend(
    text('title', chart.title + ' through ' + snapshot.cutoff),
    text('desc', 'NASA Exoplanet Archive PSCompPars snapshot ' + provenance.snapshotDate +
      ' · Discovery records from 1992 through ' + snapshot.cutoff + ' · ' + snapshot.total + ' records'),
  );
  svg.append(
    text('text', chart.title, { x: 16, y: 31, 'font-size': 23, 'font-family': 'Georgia, serif', fill: '#21261c' }),
    text('text', 'Through ' + snapshot.cutoff, { x: width - 16, y: 46, 'text-anchor': 'end', 'font-size': 11, 'font-family': theme.fontFamily, fill: theme.text }),
    text('text', 'Source: NASA Exoplanet Archive (PSCompPars)', { x: 16, y: height + offset + 19,
      'font-size': 10, 'font-family': theme.fontFamily, fill: theme.text }),
  );
  return new XMLSerializer().serializeToString(svg);
}


const search = document.querySelector('#search');
const count = document.querySelector('#result-count');
const modules = document.querySelector('#modules');
const feedback = document.querySelector('#copy-status');
const cards = [];
const sources = new Map();
let feedbackTimer;

function filter() {
  const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const { element, text } of cards) {
    element.hidden = !terms.every(term => text.includes(term));
    if (!element.hidden) visible++;
  }
  count.textContent = `${visible} of ${cards.length} published packages`;
  document.querySelector('#empty').hidden = visible !== 0;
  const url = new URL(location.href);
  if (search.value.trim()) url.searchParams.set('q', search.value.trim());
  else url.searchParams.delete('q');
  history.replaceState(null, '', url);
}

async function copy(text, button, code) {
  clearTimeout(feedbackTimer);
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  try {
    await navigator.clipboard.writeText(text);
    feedback.textContent = 'Copied to clipboard.';
    if (button.dataset.copy) {
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = label; }, 1800);
    }
  } catch {
    code.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    code.closest('pre')?.focus();
    feedback.textContent = 'Text selected. Press Ctrl+C or ⌘C to copy.';
  }
  feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 7000);
}

async function exampleSource(entry, card) {
  const code = card.querySelector('.example-code');
  if (!sources.has(entry.id)) {
    sources.set(entry.id, fetch(entry.example).then(response => {
      if (!response.ok) throw new Error('Example unavailable');
      return response.text();
    }).catch(error => { sources.delete(entry.id); throw error; }));
  }
  try {
    const text = await sources.get(entry.id);
    code.textContent = text;
    return text;
  } catch (error) {
    code.textContent = 'Could not load the source. Use Run example to open the file, then reload this page to try again.';
    throw error;
  }
}

async function load() {
  try {
    const response = await fetch('./catalog.json');
    if (!response.ok) throw new Error('Catalog unavailable');
    const entries = await response.json();
    for (const entry of entries) {
      const card = document.querySelector('#module-template').content.firstElementChild.cloneNode(true);
      card.id = entry.id;
      card.querySelector('h2').textContent = entry.title;
      card.querySelector('.package').textContent = entry.package;
      card.querySelector('.description').textContent = entry.description;
      card.querySelector('.requirements').textContent = entry.requirements;
      card.querySelector('.install').textContent = entry.install;
      card.querySelector('.imports').textContent = entry.imports;
      card.querySelector('.example-title').textContent = entry.exampleTitle;
      card.querySelector('.example-note').textContent = entry.exampleNote;
      card.querySelector('.run').href = entry.example;
      card.querySelector('.npm').href = `https://www.npmjs.com/package/${entry.package}`;
      card.querySelector('.readme').href = `https://github.com/scottcampbelldata/vexel/blob/main/packages/${entry.id}/README.md`;
      card.querySelector('.permalink').href = `./#${entry.id}`;
      card.querySelector('.exports summary').textContent = `Browse ${entry.exports.length} public exports`;
      for (const name of entry.exports) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = name;
        button.setAttribute('aria-label', `Copy import for ${name}`);
        const statement = `import { ${name} } from '${entry.package}';`;
        button.addEventListener('click', () => copy(statement, button, card.querySelector('.imports')));
        card.querySelector('.export-list').append(button);
      }
      for (const kind of ['install', 'imports']) {
        const button = card.querySelector(`[data-copy="${kind}"]`);
        button.setAttribute('aria-label', `Copy ${kind} for ${entry.title}`);
        button.addEventListener('click', () => copy(entry[kind], button, card.querySelector(`.${kind}`)));
      }
      card.querySelector('.source').addEventListener('toggle', event => {
        if (event.currentTarget.open) exampleSource(entry, card).catch(() => {});
      });
      const copyExample = card.querySelector('[data-copy="example"]');
      copyExample.setAttribute('aria-label', `Copy example for ${entry.title}`);
      copyExample.addEventListener('click', async () => {
        copyExample.disabled = true;
        try { await copy(await exampleSource(entry, card), copyExample, card.querySelector('.example-code')); }
        catch { feedback.textContent = 'Could not copy the example. Use Run example to open the file.'; }
        finally { copyExample.disabled = false; }
      });
      const text = [entry.title, entry.package, entry.description, entry.requirements, entry.keywords, ...entry.exports].join(' ').toLowerCase();
      cards.push({ element: card, text });
      modules.append(card);
    }
    search.disabled = false;
    search.value = new URL(location.href).searchParams.get('q') || '';
    filter();
    const target = document.getElementById(location.hash.slice(1));
    if (target?.classList.contains('module') && !target.hidden) target.scrollIntoView();
  } catch {
    count.textContent = 'Could not load the catalog. Reload this page, or use the package list in Get started. For a local copy, run npm run catalog instead of opening the HTML file directly.';
  }
}

document.querySelector('#search-form').addEventListener('submit', event => event.preventDefault());
search.addEventListener('input', filter);
document.querySelector('#clear').addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
load();

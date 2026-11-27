const catalog = await fetch(new URL('./catalog.json', import.meta.url)).then((response) => {
  if (!response.ok) throw new Error('The example list did not load.');
  return response.json();
});
const films = catalog.films;
const find = document.querySelector('#find');
const list = document.querySelector('#list');
const grid = document.querySelector('#grid');
const empty = document.querySelector('#empty');
const gridView = document.querySelector('#grid-view');
const viewer = document.querySelector('#viewer');
const frame = document.querySelector('#frame');
const source = document.querySelector('#source');
const files = document.querySelector('#files');
const code = document.querySelector('#code');
const title = document.querySelector('#viewer-title');
const sourceLink = document.querySelector('#source-link');
const openLink = document.querySelector('#open-link');

const fileName = (path) => path.slice(path.lastIndexOf('/') + 1);

function query() {
  return find.value.trim().toLowerCase();
}

function matches(film, text) {
  if (!text) return true;
  return [film.title, film.group, film.description, film.id].join(' ').toLowerCase().includes(text);
}

function route() {
  const raw = location.hash.replace(/^#/, '');
  const slash = raw.indexOf('/');
  const id = decodeURIComponent(slash < 0 ? raw : raw.slice(0, slash));
  const mode = slash < 0 ? '' : raw.slice(slash + 1);
  const film = films.find((item) => item.id === id) ?? null;
  return { film, source: mode === 'source' };
}

function renderList() {
  const text = query();
  const shown = films.filter((film) => matches(film, text));
  list.replaceChildren();
  let group = '';
  for (const film of shown) {
    if (film.group !== group) {
      group = film.group;
      const heading = document.createElement('div');
      heading.className = 'group';
      heading.textContent = group;
      list.append(heading);
    }
    const link = document.createElement('a');
    link.className = 'list-link';
    link.href = `#${film.id}`;
    link.textContent = film.title;
    if (route().film?.id === film.id) link.setAttribute('aria-current', 'page');
    list.append(link);
  }
  grid.replaceChildren();
  for (const film of shown) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `#${film.id}`;
    const image = document.createElement('img');
    image.src = `./thumbs/${film.id}.webp`;
    image.width = 400;
    image.height = 225;
    image.alt = '';
    const label = document.createElement('span');
    label.textContent = film.title;
    card.append(image, label);
    grid.append(card);
  }
  empty.hidden = shown.length > 0;
}

function showGrid() {
  gridView.hidden = false;
  viewer.hidden = true;
  frame.hidden = true;
  frame.removeAttribute('src');
  source.hidden = true;
  document.title = 'Examples | Margo Engine';
  renderList();
}

async function showSource(film) {
  files.replaceChildren();
  code.textContent = 'Loading source.';
  const names = film.sources.map(fileName);
  let current = names[0];
  async function load(name) {
    current = name;
    for (const button of files.querySelectorAll('button')) {
      button.setAttribute('aria-selected', button.dataset.file === name ? 'true' : 'false');
    }
    const response = await fetch(`./source/${film.id}/${name}`);
    code.textContent = response.ok ? await response.text() : 'This source file is not on the site build.';
  }
  names.forEach((name, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.dataset.file = name;
    button.textContent = name;
    button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    button.addEventListener('click', () => load(name));
    files.append(button);
  });
  if (current) await load(current);
}

function showFilm() {
  const { film, source: wantSource } = route();
  if (!film) {
    showGrid();
    return;
  }
  gridView.hidden = true;
  viewer.hidden = false;
  title.textContent = film.title;
  document.title = `${film.title} | Margo Engine`;
  sourceLink.href = `#${film.id}/source`;
  sourceLink.textContent = wantSource ? 'Hide source' : 'View source';
  if (wantSource) sourceLink.href = `#${film.id}`;
  openLink.href = `./${film.id}/`;
  frame.hidden = wantSource;
  source.hidden = !wantSource;
  if (wantSource) {
    frame.removeAttribute('src');
    showSource(film);
  } else if (!frame.src.endsWith(`/${film.id}/index.html`)) {
    frame.src = `./${film.id}/index.html`;
    frame.title = film.title;
  }
  renderList();
}

find.addEventListener('input', () => renderList());
window.addEventListener('hashchange', showFilm);
showFilm();

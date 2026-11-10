import test from 'node:test';
import assert from 'node:assert/strict';
import { Localization } from '../dist/i18n.js';
import { Label, Panel } from '../dist/index.js';
import { TextInput } from '../dist/input.js';
import { makeUi } from './helpers.js';
test('canonical locale lookup falls back through parents then configured locale, with plural forms and parameters', () => {
  const l = new Localization(
    {
      en: {
        hello: 'Hello {name}',
        n: { '=0': 'None', one: '{count} planet', other: '{count} planets' },
        fallback: 'English',
      },
      fr: { hello: 'Bonjour {name}' },
      'fr-CA': { local: 'Quebec' },
    },
    { locale: 'fr-ca', fallback: 'en' },
  );
  assert.equal(l.locale, 'fr-CA');
  assert.equal(l.t('hello', { name: 'Ada' }), 'Bonjour Ada');
  assert.equal(l.t('fallback'), 'English');
  assert.equal(l.t('local'), 'Quebec');
  assert.equal(l.t('n', { count: 0 }), 'None');
  assert.equal(l.t('n', { count: 1 }), '1 planet');
  assert.equal(l.t('n', { count: 8 }), '8 planets');
  assert.equal(l.t('missing'), 'missing');
  assert.equal(l.t('hello'), 'Bonjour {name}');
  assert.throws(() => l.t('n', { count: Infinity }), RangeError);
  assert.throws(() => new Localization({}, { locale: 'bad_tag' }), RangeError);
  const strict = new Localization({ en: { g: 'Hello {name}' } }, { missing: 'error' });
  assert.throws(() => strict.t('missing'), RangeError);
  assert.throws(() => strict.t('g'), RangeError);
});
test('bound widget text, placeholder and accessible label relayout and switch RTL on locale changes', () => {
  const ui = makeUi(),
    label = new Label({ text: '' }),
    input = new TextInput(),
    p = new Panel({ direction: 'row', children: [label, input], anchor: 'top-left' });
  ui.add(p);
  let n = 1;
  const l = new Localization({
    en: { title: 'Mars', hint: 'Name', a: 'Planet {count}' },
    ar: { title: '??????', hint: '???', a: '???? {count}' },
  });
  const c = new AbortController(),
    off = l.bind(
      ui,
      [
        { target: label, key: 'title' },
        { target: input, key: 'hint', property: 'placeholder' },
        { target: input, key: 'a', property: 'label', parameters: () => ({ count: n }) },
      ],
      { signal: c.signal },
    );
  ui.update(0);
  const width = label.rect.width;
  l.locale = 'ar';
  ui.update(0);
  assert.equal(ui.direction, 'rtl');
  assert.equal(label.text, '??????');
  assert.notEqual(label.rect.width, width);
  assert.equal(input.placeholder, '???');
  assert.equal(input.label, '???? 1');
  n = 2;
  l.refresh();
  assert.equal(input.label, '???? 2');
  l.locale = 'en';
  ui.update(0);
  assert.equal(ui.direction, 'ltr');
  assert.equal(label.rect.width, width);
  c.abort();
  l.locale = 'ar';
  assert.equal(label.text, 'Mars');
  off();
  ui.dispose();
  l.dispose();
});
test('table replacement is defensive, RTL metadata can override scripts, unsubscription is disposable', () => {
  const table = { n: { one: 'one', other: 'many' } };
  const l = new Localization({ en: table }, { locale: 'ar-Latn', directions: { 'en': 'rtl' } });
  table.n.other = 'bad';
  assert.equal(l.t('n', { count: 4 }), 'many');
  assert.equal(l.direction, 'ltr');
  l.locale = 'en';
  assert.equal(l.direction, 'rtl');
  let changed = 0;
  const off = l.onChange(() => changed++);
  l.setTable('en', { n: 'Updated' });
  assert.equal(l.t('n'), 'Updated');
  assert.equal(changed, 1);
  off[Symbol.dispose]();
  l.refresh();
  assert.equal(changed, 1);
  assert.throws(() => l.setTable('en', { n: { one: 'incomplete' } }), TypeError);
  assert.equal(l.t('n'), 'Updated');
});

test('disposing localization removes abort subscriptions that retain bound widgets', () => {
  const ui = makeUi(),
    l = new Localization({ en: { title: 'Mars' } }),
    signal = new AbortController().signal;
  const add = signal.addEventListener.bind(signal),
    remove = signal.removeEventListener.bind(signal);
  let active = 0;
  signal.addEventListener = (...args) => {
    active++;
    add(...args);
  };
  signal.removeEventListener = (...args) => {
    active--;
    remove(...args);
  };
  l.bind(ui, [{ target: new Label(), key: 'title' }], { signal });
  assert.equal(active, 1);
  l.dispose();
  assert.equal(active, 0);
  ui.dispose();
});

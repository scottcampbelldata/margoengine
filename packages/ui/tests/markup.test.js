import test from 'node:test';
import assert from 'node:assert/strict';
import { Button, Label, List, Panel, Slider, Toggle } from '../dist/index.js';
import { buildScreen, loadScreen, parseMarkup, parseStyleSheet } from '../dist/markup.js';
import { makeUi } from './helpers.js';

test('parseMarkup reads elements, attributes, text, comments and character references, with their lines', () => {
  const [root] = parseMarkup(`<?xml version="1.0"?>
<!-- a pause menu -->
<panel id="pause" class="menu big">
  <label>Paused &amp; waiting &#x2014; &#33;</label>
  <button on-click='resume'/>
</panel>`);
  assert.equal(root.tag, 'panel');
  assert.deepEqual(root.attributes, { id: 'pause', class: 'menu big' });
  assert.equal(root.line, 3);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].text, 'Paused & waiting — !');
  assert.deepEqual(root.children[1].attributes, { 'on-click': 'resume' });
  assert.equal(root.children[1].line, 5);
});

test('markup errors name the line and column and what to fix', () => {
  const bad = (source, pattern) =>
    assert.throws(
      () => parseMarkup(source),
      (e) => e instanceof TypeError && pattern.test(e.message),
    );
  bad('<panel>\n  <label>x</panel>', /line 2, column 11: <\/panel> closes <label> from line 2/);
  bad('<panel>', /line 1, column 8: <panel> from line 1 is not closed/);
  bad('<label text=hi/>', /line 1, column 13: the value of text must be in quotes/);
  bad('<label a="1" a="2"/>', /attribute a is given twice/);
  bad('<label>a & b</label>', /a bare '&' must be written &amp;/);
  bad('<label>&nbsp;</label>', /unknown reference &nbsp;/);
  bad('hello', /text outside an element/);
  bad('</panel>', /closes nothing/);
  bad('<!DOCTYPE x><panel/>', /not supported/);
});

test('parseStyleSheet reads selector lists, combinators and specificity; comments keep line numbers', () => {
  const rules = parseStyleSheet(`/* menu */
panel.menu > button, #title { gap: 8; color: primary }
.hud label { size: small; }`);
  assert.deepEqual(
    rules.map((r) => [
      r.selector,
      r.specificity.join(','),
      r.declarations.map((d) => `${d.property}=${d.value}@${d.line}`),
    ]),
    [
      ['panel.menu > button', '0,1,2', ['gap=8@2', 'color=primary@2']],
      ['#title', '1,0,0', ['gap=8@2', 'color=primary@2']],
      ['.hud label', '0,1,1', ['size=small@3']],
    ],
  );
  const bad = (source, pattern) =>
    assert.throws(
      () => parseStyleSheet(source),
      (e) => e instanceof TypeError && pattern.test(e.message),
    );
  bad('a:hover { gap: 1 }', /only type, #id and \.class selectors/);
  bad('a { gap 1 }', /needs property: value/);
  bad('\n\nbutton { gap: 1', /line 3, column 8: a rule is not closed/);
  bad('#a#b { gap: 1 }', /names two ids/);
  bad('> a { gap: 1 }', /> needs a selector on each side/);
  bad('a { gap: }', /gap has no value/);
});

test('buildScreen makes the widgets, styled by the cascade: specificity, then order, then attributes', () => {
  const clicks = [];
  const screen = buildScreen(
    `<panel class="menu" id="menu">
  <label id="title" class="heading">Settings</label>
  <row class="buttons">
    <button id="ok" variant="primary" on-click="ok">OK</button>
    <button id="cancel" class="quiet">Cancel</button>
  </row>
  <toggle id="sound" checked="true">Sound</toggle>
  <slider id="volume" min="0" max="10" value="7" step="1">Volume</slider>
  <list id="saves" height="120"><item detail="2 h">Slot 1</item><item disabled="true">Slot 2</item></list>
</panel>`,
    {
      styles: [
        `panel { gap: 4; padding: 8 16 }
         .menu { anchor: center; gap: 12; width: 320 }
         label { size: small }
         .heading { size: large }
         #title { size: body }
         .buttons > button { min-width: 100; grow: 1 }
         .menu button { min-width: 60 }`,
        '.quiet { variant: ghost }',
      ],
      actions: { ok: (e) => clicks.push(e.target.id) },
    },
  );
  const get = (id) => screen.get(id);
  assert.equal(screen.widgets.length, 1);
  const menu = get('menu');
  assert.ok(menu instanceof Panel);
  assert.equal(menu.style.gap, 12, 'a class rule beats a type rule');
  assert.deepEqual(menu.style.padding, [8, 16], 'two numbers');
  assert.equal(menu.style.width, 320);
  assert.equal(menu.style.anchor, 'center');
  assert.ok(get('title') instanceof Label);
  assert.equal(get('title').text, 'Settings');
  assert.equal(get('title').size, 'body', 'an id rule beats class and type rules');
  assert.equal(get('ok').style.minWidth, 60, '.buttons > button and .menu button tie at (0,1,1): the later rule wins');
  assert.equal(get('ok').style.grow, 1, 'and the earlier one still gives what the later does not set');
  assert.equal(get('ok').variant, 'primary', 'the attribute wins over the sheet');
  assert.equal(get('cancel').variant, 'ghost', 'a later sheet adds its rules');
  assert.ok(get('sound') instanceof Toggle && get('sound').checked === true);
  assert.ok(get('volume') instanceof Slider && get('volume').value === 7);
  const saves = get('saves');
  assert.ok(saves instanceof List);
  assert.equal(saves.children.length, 2);
  assert.equal(saves.children[1].active, false, 'the disabled item');
  const ui = makeUi();
  ui.add(...screen.widgets);
  ui.update(0);
  get('ok').activate();
  assert.deepEqual(clicks, ['ok']);
  assert.ok(get('ok') instanceof Button);
});

test('descendant and child combinators match only where they should', () => {
  const screen = buildScreen(
    '<panel class="a"><row><label id="deep">x</label></row><label id="near">y</label></panel>',
    {
      styles: '.a > label { size: large } .a label { color: danger }',
    },
  );
  assert.equal(screen.get('near').size, 'large');
  assert.notEqual(screen.get('deep').size, 'large', '> takes children only');
  assert.equal(screen.get('deep').color, 'danger', 'a space takes any descendant');
});

test('buildScreen errors name the line: unknown element, property, action, bad value, duplicate id', () => {
  const bad = (markup, pattern, options) =>
    assert.throws(
      () => buildScreen(markup, options),
      (e) => e instanceof TypeError && pattern.test(e.message),
    );
  bad('<panel>\n<video/></panel>', /Markup line 2: unknown element <video>/);
  bad('<label colour="red">x</label>', /unknown property colour/);
  bad('<button on-click="go">x</button>', /on-click="go" names no function in actions/);
  bad('<panel grow="lots"/>', /grow takes a number, not 'lots'/);
  bad('<label id="a">x</label><label id="a">y</label>', /id a is used twice/);
  bad('<label><panel/></label>', /<label> cannot hold <panel>/);
  bad('<panel>text</panel>', /holds elements, not text/);
  bad('<panel/>', /Style line 1 \(panel\): gap takes 1 or 2 numbers/, { styles: 'panel { gap: 1 2 3 }' });
});

test('loadScreen fetches the markup and its style sheets, and stops on an aborted signal', async () => {
  const files = {
    'https://game.test/ui/hud.xml': '<row class="hud"><label id="gold">0</label></row>',
    'https://game.test/ui/hud.css': '.hud { gap: 9 }',
  };
  const fetched = [],
    real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    init?.signal?.throwIfAborted();
    const body = files[String(url)];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body };
  };
  try {
    const screen = await loadScreen('https://game.test/ui/hud.xml', { styles: 'https://game.test/ui/hud.css' });
    assert.equal(screen.widgets[0].style.gap, 9);
    assert.equal(screen.get('gold').text, '0');
    await assert.rejects(loadScreen('https://game.test/ui/none.xml'), /HTTP 404/);
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    await assert.rejects(loadScreen('https://game.test/ui/hud.xml', { signal: controller.signal }), /closed/);
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(fetched.includes('https://game.test/ui/hud.css'));
});

// XML 1.0 section 4.1 (WFC Legal Character) refers character references to production [2] Char.
test('character references outside XML Char are refused: surrogates, C0 controls, U+FFFE', () => {
  for (const ref of ['&#xD800;', '&#1;', '&#xFFFE;', '&#x110000;'])
    assert.throws(() => parseMarkup(`<label>${ref}</label>`), /not an XML character/, ref);
  assert.equal(parseMarkup('<label>&#x1F600;&#xE000;</label>')[0].text, '\u{1F600}\uE000');
});

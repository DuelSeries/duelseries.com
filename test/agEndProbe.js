'use strict';
// The shared end card and board (public/js/shared/dsEnd.js) on the agar.io tests' fake pages: the REAL component is
// loaded into the fake window (vm), and the probe reads what it built back out of the fake DOM (texts, buttons, the
// board's rows), so the tests pin what a player sees rather than what agScreens passed in.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared', 'dsEnd.js'), 'utf8');

// Puts window.DSEnd on a fake window (its document is the fake page's). The fake elements need children, firstChild,
// appendChild / removeChild, setAttribute / getAttribute, addEventListener and a style object; the document needs
// createElement, createTextNode, head and body.
function installDSEnd(win) {
  vm.runInNewContext(SRC, { window: win }, { filename: 'dsEnd.js' });
  return win.DSEnd;
}

const classes = (el) => String((el && el.className) || '').split(/\s+/).filter(Boolean);
function all(el, pred, out) {
  out = out || [];
  for (const c of (el && el.children) || []) {
    if (pred(c)) out.push(c);
    all(c, pred, out);
  }
  return out;
}
const byClass = (el, cls) => all(el, (c) => classes(c).includes(cls));
const one = (el, cls) => byClass(el, cls)[0] || null;
const text = (el) => (el ? String(el.textContent || '') : '');

// What the end card shows, or null when none is on the page.
function readCard(doc) {
  const root = (doc.body.children || []).find((c) => classes(c).includes('dse'));
  if (!root) return null;
  const tone = (classes(root).find((k) => k.startsWith('t-')) || 't-plain').slice(2);
  const facts = byClass(root, 'dse-facts').flatMap((dl) => dl.children.map((d) => [text(d.children[0]), text(d.children[1])]));
  const ledger = byClass(root, 'dse-lr').map((r) => [text(r.children[0]), text(r.children[1])].concat(classes(r).includes('net') ? ['net'] : []));
  const st = one(root, 'dse-st');
  let status = null;
  if (st) {
    const tn = st.children.find((c) => c.nodeType === 3);
    const a = st.children.find((c) => c.tagName === 'A');
    status = { text: text(tn), state: classes(st).includes('ok') ? 'ok' : classes(st).includes('err') ? 'err' : 'pending' };
    if (a) status.link = { href: a.href, text: text(a), target: a.target, rel: a.rel };
  }
  // the one row of buttons; the free card's Share pill (dse-share, 2026-10-26) is read on its own below
  const buttons = all(root, (c) => c.tagName === 'BUTTON' && classes(c).includes('dse-btn')).map((b) => ({ id: b.getAttribute('data-dse-btn'), text: text(b),
    primary: classes(b).includes('pri'), disabled: !!b.disabled }));
  return {
    tone,
    verdict: text(one(root, 'dse-v')),
    hero: text(one(root, 'dse-big')),
    unit: text(one(root, 'dse-unit')),
    facts,
    ledger,
    status,
    notes: byClass(root, 'dse-note').map(text),
    buttons,
    share: !!one(root, 'dse-share'),
    z: root.style.zIndex,
    el: root
  };
}
// Clicks the card's button with that id (the component's own click listener).
function clickCard(doc, id) {
  const card = readCard(doc);
  if (!card) throw new Error('no end card on the page');
  const b = all(card.el, (c) => c.tagName === 'BUTTON' && c.getAttribute('data-dse-btn') === id)[0];
  if (!b) throw new Error('no ' + id + ' button on the end card: ' + JSON.stringify(card.buttons));
  b.dispatch('click', {});
}
// The board: shown, money, rows [rank, name, value, me] ('gap' for the row before a pinned own row).
function readBoard(doc) {
  const root = (doc.body.children || []).find((c) => classes(c).includes('dsb'));
  if (!root) return null;
  const ol = root.children.find((c) => c.tagName === 'OL');
  const rows = ol.children.map((li) => (classes(li).includes('gap') ? 'gap'
    : [text(li.children[0]), text(li.children[1]), text(li.children[2]), classes(li).includes('me')]));
  return { shown: root.style.display !== 'none', money: classes(root).includes('money'), title: text(root.children[0]), rows,
    z: root.style.zIndex, el: root };
}

module.exports = { installDSEnd, readCard, clickCard, readBoard };

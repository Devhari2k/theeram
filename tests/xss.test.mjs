// Theeram — escaping tests for the stored-XSS remediation.
//
// Run with:  node --test tests/xss.test.mjs
//
// www/js/escape.js is a classic script (see the comment at its head), so it
// is evaluated in a vm context here rather than imported; its top-level
// function declarations become globals of that context, exactly as they do
// in the browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../www/js/escape.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const { escapeHtml, safeCssColor } = ctx;

// The payloads named in the remediation brief.
const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  "'><svg onload=alert(1)>",
  'javascript:alert(1)',
  '</div><script>alert(1)</script><div>'
];

describe('escapeHtml', () => {
  test('neutralises every angle bracket and quote', () => {
    for (const p of PAYLOADS) {
      const out = escapeHtml(p);
      assert.ok(!out.includes('<'), `raw < survived: ${p}`);
      assert.ok(!out.includes('>'), `raw > survived: ${p}`);
      assert.ok(!out.includes('"'), `raw " survived: ${p}`);
      assert.ok(!out.includes("'"), `raw ' survived: ${p}`);
    }
  });

  test('escapes the five HTML-significant characters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });

  test('escapes & first so entities are not double-decoded into markup', () => {
    // If & were escaped last, "&lt;" would become "<" after one decode pass.
    assert.equal(escapeHtml('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
  });

  test('null and undefined render as empty, never "null"/"undefined"', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('non-strings are coerced safely', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml({ toString: () => '<b>' }), '&lt;b&gt;');
  });

  test('leaves ordinary place and member names untouched', () => {
    for (const s of ['Kochi', 'Alappuzha, Kerala', 'തീരം', 'Bob K', 'Anne-Marie']) {
      assert.equal(escapeHtml(s), s);
    }
  });

  test('a payload cannot terminate a double-quoted attribute', () => {
    const attr = `<img src="${escapeHtml('" onerror="alert(1)')}" alt="">`;
    assert.ok(!/onerror\s*=/.test(attr.replace(/&quot;/g, '')) || !attr.includes('" onerror'));
    assert.ok(attr.includes('&quot;'), 'quote was not encoded');
    // Exactly three raw quotes remain: the two wrapping src and... alt's pair.
    assert.equal((attr.match(/"/g) || []).length, 4);
  });

  test('a payload cannot terminate a single-quoted attribute', () => {
    const attr = `<div data-x='${escapeHtml("' onmouseover='alert(1)")}'></div>`;
    assert.equal((attr.match(/'/g) || []).length, 2);
  });
});

describe('safeCssColor', () => {
  test('passes through every colour the risk engine actually emits', () => {
    for (const c of ['var(--coral)', 'var(--amber)', 'var(--safe)', 'var(--text-faint)',
                     '#3FA7D6', 'rgb(63, 167, 214)', 'rgba(0,0,0,.5)', 'transparent']) {
      assert.equal(safeCssColor(c, 'FALLBACK'), c);
    }
  });

  test('rejects a second declaration smuggled in after a semicolon', () => {
    assert.equal(safeCssColor('red;background-image:url(//evil.test/x)', 'FALLBACK'), 'FALLBACK');
  });

  test('rejects url() exfiltration and legacy expression()', () => {
    assert.equal(safeCssColor('url(//evil.test/x)', 'FALLBACK'), 'FALLBACK');
    assert.equal(safeCssColor('expression(alert(1))', 'FALLBACK'), 'FALLBACK');
  });

  test('rejects comment-based obfuscation', () => {
    assert.equal(safeCssColor('re/*x*/d', 'FALLBACK'), 'FALLBACK');
  });

  test('rejects attribute-breaking payloads', () => {
    for (const p of PAYLOADS) {
      assert.equal(safeCssColor(p, 'FALLBACK'), 'FALLBACK', `accepted: ${p}`);
    }
  });

  test('empty, null and undefined fall back', () => {
    assert.equal(safeCssColor('', 'FALLBACK'), 'FALLBACK');
    assert.equal(safeCssColor(null, 'FALLBACK'), 'FALLBACK');
    assert.equal(safeCssColor(undefined, 'FALLBACK'), 'FALLBACK');
  });
});

// ---------------------------------------------------------------------------
// Static assertions over the real source: every sink that renders a
// Firestore-controlled value must route it through a helper. These guard
// against a future edit quietly reintroducing a raw interpolation.
// ---------------------------------------------------------------------------
describe('source-level sink guards', () => {
  const read = (p) => readFileSync(new URL(`../www/${p}`, import.meta.url), 'utf8');

  test('index.html escapes location names and ids in cardTemplate', () => {
    const s = read('index.html');
    assert.ok(s.includes('${escapeHtml(loc.name)}'), 'loc.name not escaped');
    assert.ok(!s.includes('${loc.name}'), 'raw ${loc.name} still present');
  });

  test('index.html escapes alert banner values', () => {
    const s = read('index.html');
    for (const frag of ['escapeHtml(a.placeName)', 'escapeHtml(a.ownerName)',
                        'escapeHtml(a.risk.reason)', 'escapeHtml(a.locationId)']) {
      assert.ok(s.includes(frag), `missing ${frag}`);
    }
    assert.ok(!s.includes('${a.placeName}'), 'raw ${a.placeName} still present');
    assert.ok(!s.includes('${a.ownerName}'), 'raw ${a.ownerName} still present');
  });

  test('index.html loads escape.js before the inline script', () => {
    const s = read('index.html');
    const helper = s.indexOf('js/escape.js');
    // Anchored on a UI function that stays in the inline script. The previous
    // anchor was `const TERRAIN_ICONS`, which moved into js/risk.js in Phase
    // 2.4.1; the ordering requirement it asserts is unchanged.
    const inline = s.indexOf('function cardTemplate(');
    assert.ok(helper !== -1, 'escape.js not loaded');
    assert.ok(inline !== -1, 'inline script anchor not found');
    assert.ok(helper < inline, 'escape.js must load before the inline script');
  });

  test('family-ui.js escapes photoURL, ids, risk level and terrain type', () => {
    const s = read('js/family-ui.js');
    for (const frag of ['escapeHtml(m.photoURL)', 'escapeHtml(m.id)', 'escapeHtml(f.id)',
                        'escapeHtml(risk.level)', 'escapeHtml(l.terrainType)',
                        'safeCssColor(risk.color']) {
      assert.ok(s.includes(frag), `missing ${frag}`);
    }
    assert.ok(!s.includes('src="${m.photoURL}"'), 'raw photoURL attribute still present');
    assert.ok(!s.includes('background:${risk.color}'), 'raw risk.color still present');
  });

  test('family-ui.js no longer defines its own escapeHtml copy', () => {
    assert.ok(!/function\s+escapeHtml/.test(read('js/family-ui.js')),
      'duplicate escapeHtml definition reintroduced');
  });

  test('auth.js builds the avatar with DOM APIs, not innerHTML', () => {
    const s = read('js/auth.js');
    assert.ok(s.includes("createElement('img')"), 'avatar not built via createElement');
    assert.ok(!/accountAvatar\.innerHTML/.test(s), 'accountAvatar.innerHTML still present');
  });

  test('member status is pinned to a known key before reaching a class attribute', () => {
    const s = read('js/family-ui.js');
    assert.ok(s.includes('STATUS_LABEL[m.status] ? m.status'), 'status not constrained');
  });
});

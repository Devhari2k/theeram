// Theeram — privacy policy integrity.
// Run with: npm run test:privacy
//
// The policy ships twice:
//
//   www/privacy.html          bundled in the app, so it opens offline. Sits
//                             beside index.html and icon.svg, so it carries a
//                             Back link and a favicon.
//   docs/privacy-policy.html  the public copy, hosted standalone on GitHub
//                             Pages at /theeram/docs/privacy-policy.html.
//                             Nothing sits beside it, so it carries neither.
//
// They are NOT byte-identical, and deliberately so — the chrome differs. What
// must never drift is the policy itself, so the <style>, <main> and <footer>
// blocks are compared exactly. Anything outside them is chrome, and the tests
// below pin what each copy is allowed to have there.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(url(p), 'utf8');
const APP = read('www/privacy.html');
const DOCS = read('docs/privacy-policy.html');
const MD = read('docs/PRIVACY_POLICY.md');
const INDEX = read('www/index.html');

// The two HTML copies, and the directory each is served from.
const COPIES = [
  { name: 'www/privacy.html', html: APP, dir: 'www' },
  { name: 'docs/privacy-policy.html', html: DOCS, dir: 'docs' }
];

const block = (html, tag) => {
  const m = html.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`));
  assert.ok(m, `no <${tag}> block found`);
  return m[0];
};

// Every href/src that is not an absolute URL, a mailto: or a fragment.
const relativeRefs = (html) =>
  (html.match(/(?:src|href)=["'][^"']*["']/g) || [])
    .map(a => a.replace(/^(?:src|href)=["']/, '').replace(/["']$/, ''))
    .filter(v => !/^(?:https?:|mailto:|data:|#)/.test(v));

describe('the policy itself cannot drift between the two copies', () => {
  // Only the policy and its styling are compared. The chrome is asserted
  // separately below, because it is *supposed* to differ.
  for (const tag of ['style', 'main', 'footer']) {
    test(`the <${tag}> block is byte-identical in both copies`, () => {
      assert.equal(block(APP, tag), block(DOCS, tag),
        `the <${tag}> block has diverged between www/privacy.html and ` +
        `docs/privacy-policy.html — edit one and copy it to the other`);
    });
  }

  test('the substantive policy is the same text, not merely the same length', () => {
    // A cheap guard that the comparison above is actually comparing the
    // policy: if <main> ever stopped containing the sections, this fails.
    for (const { name, html } of COPIES) {
      const main = block(html, 'main');
      for (const heading of ['1. What Theeram is', '8. Data retention and deletion',
                             '13. Contact']) {
        assert.ok(main.includes(heading), `${name}: <main> is missing "${heading}"`);
      }
    }
  });
});

describe('neither copy contains a dead link', () => {
  // This is the bug this suite exists to prevent: the hosted copy used to
  // carry "← Back" pointing at an index.html that does not exist beside it.
  for (const { name, html, dir } of COPIES) {
    test(`every relative reference in ${name} resolves to a real file`, () => {
      for (const ref of relativeRefs(html)) {
        const target = fileURLToPath(new URL(`../${dir}/${ref}`, import.meta.url));
        assert.ok(existsSync(target),
          `${name} references "${ref}", which does not exist in ${dir}/ — ` +
          `it would 404 for anyone who clicks it`);
      }
    });
  }
});

describe('each copy carries the chrome appropriate to where it is served', () => {
  test('the app copy has a Back link, because index.html sits beside it', () => {
    assert.match(APP, /<a class="back" href="index\.html">/,
      'the bundled copy should offer a way back into the app');
  });

  test('the hosted copy has no Back link at all', () => {
    // Not hidden by script, not pointed somewhere plausible — absent. There is
    // no "back" from a URL someone opened from a Play Store listing.
    assert.ok(!/class="back"/.test(DOCS),
      'docs/privacy-policy.html must not render a Back link');
    assert.ok(!/href="index\.html"/.test(DOCS),
      'docs/privacy-policy.html links to an index.html that is not served beside it');
  });

  test('the hosted copy has no relative reference whatsoever', () => {
    // It must render identically wherever it is hosted, so it depends on no
    // neighbouring file — not even a favicon.
    assert.deepEqual(relativeRefs(DOCS), [],
      'the hosted copy must be self-contained');
  });
});

describe('the policy is reachable and offline-safe', () => {
  test('linked from the account menu', () => {
    assert.match(INDEX, /<a class="menu-link" href="privacy\.html">Privacy Policy<\/a>/);
  });

  test('linked from the account-deletion dialog', () => {
    const modal = INDEX.slice(INDEX.indexOf('id="deleteAccountModal"'),
                             INDEX.indexOf('id="confirmModal"'));
    assert.match(modal, /href="privacy\.html"/,
      'deletion is exactly where someone wants to read the retention section');
  });

  test('neither copy makes a network request', () => {
    // The app copy ships inside a flood app, used precisely when connectivity
    // is poor; a webfont or CDN stylesheet would leave it unstyled offline.
    // The hosted copy is a privacy policy, so it should not phone anyone home.
    for (const { name, html } of COPIES) {
      const refs = html.match(/(?:src|href)=["']https?:\/\/[^"']+/g) || [];
      assert.deepEqual(refs, [], `${name}: external references found: ${refs.join(', ')}`);
    }
  });

  test('neither copy loads a tracker, or runs any script at all', () => {
    // Match tracker HOSTS and call sites, not the word "analytics" — the page
    // legitimately says in prose that Theeram contains no analytics SDK.
    for (const { name, html } of COPIES) {
      for (const bad of ['googletagmanager.com', 'google-analytics.com', 'gtag(',
                         'connect.facebook.net', 'doubleclick.net', 'hotjar', 'segment.com']) {
        assert.ok(!html.includes(bad), `${name} loads a tracker: ${bad}`);
      }
      assert.equal((html.match(/<script/g) || []).length, 0,
        `${name}: the policy is static text and needs no script`);
    }
  });
});

describe('the internal data inventory stays out of the repository', () => {
  test('docs/PRIVACY_DATA_INVENTORY.md is not present', () => {
    // An internal engineering data map. Everything committed here is public —
    // and everything under docs/ is additionally served by GitHub Pages — so
    // this file must not come back. The policy is the public-facing document.
    assert.ok(!existsSync(fileURLToPath(url('docs/PRIVACY_DATA_INVENTORY.md'))),
      'the internal data inventory is back in the repository, where it is public');
  });

  test('nothing links to it', () => {
    for (const p of ['monitor/README.md', 'monitor/SCHEDULER.md',
                     'docs/PRIVACY_POLICY.md', 'www/privacy.html',
                     'docs/privacy-policy.html']) {
      assert.ok(!read(p).includes('PRIVACY_DATA_INVENTORY'),
        `${p} still references the removed data inventory`);
    }
  });
});

describe('the policy matches what the code actually does', () => {
  test('every third party the client contacts is disclosed', () => {
    // Derived from the code, not from memory: any new outbound host must be
    // added to the policy or this fails.
    const sources = ['www/index.html', 'www/js/auth.js', 'www/js/family.js',
                     'www/js/push.js', 'www/js/firebase-init.js',
                     'www/js/google-auth.js', 'www/service-worker.js'].map(read).join('\n');
    const hosts = new Set(
      (sources.match(/https?:\/\/[^"'`\s)]+/g) || [])
        .map(u => u.replace(/^https?:\/\//, '').split('/')[0])
        .filter(h => !h.includes('w3.org'))
    );
    // Host -> the name the policy uses for it.
    const disclosed = {
      'api.open-meteo.com': 'Open-Meteo',
      'nominatim.openstreetmap.org': 'Nominatim',
      '{s}.basemaps.cartocdn.com': 'CARTO',
      'fonts.googleapis.com': 'Google Fonts',
      'www.gstatic.com': 'gstatic',
      'unpkg.com': 'unpkg',
      'cdn.jsdelivr.net': 'jsDelivr'
    };
    for (const h of hosts) {
      assert.ok(h in disclosed, `undisclosed outbound host in the client: ${h}`);
      assert.ok(APP.includes(disclosed[h]), `policy does not mention ${disclosed[h]} (${h})`);
      assert.ok(MD.includes(disclosed[h]), `markdown policy does not mention ${disclosed[h]}`);
    }
  });

  test('the lock-screen disclosure matches the channel configuration', () => {
    const push = read('www/js/push.js');
    const isPublic = /visibility:\s*1\b/.test(push);
    assert.ok(isPublic, 'channel visibility changed — re-check the policy wording');
    assert.match(APP, /lock screen/i,
      'a publicly visible channel must be disclosed');
  });

  test('the no-GPS claim is still true', () => {
    const client = ['www/index.html', 'www/js/auth.js', 'www/js/family.js',
                    'www/js/push.js'].map(read).join('\n');
    for (const api of ['navigator.geolocation', 'getCurrentPosition', 'watchPosition']) {
      assert.ok(!client.includes(api),
        `${api} is now used — the policy claims Theeram never reads device GPS`);
    }
    assert.match(APP, /does not use your device's GPS/);
  });

  test('the emergency-contact field still exists and is still disclosed', () => {
    assert.match(read('www/js/auth.js'), /emergencyContact/);
    assert.match(APP, /[Ee]mergency contact/);
  });
});

describe('the policy is fully filled in for publication', () => {
  const PLACEHOLDERS = ['[LEGAL ENTITY NAME]', '[PRIVACY CONTACT EMAIL]',
                        '[EFFECTIVE DATE]', '[BUSINESS ADDRESS]'];
  const CONTACT = 'harishreyasv@gmail.com';
  // All three published formats: both HTML copies and the Markdown source.
  const FORMATS = [...COPIES.map(c => c), { name: 'docs/PRIVACY_POLICY.md', html: MD }];

  test('no drafting placeholder survives into any format', () => {
    // These were deliberate blanks while the operator's details were unknown.
    // Shipping one would put "[PRIVACY CONTACT EMAIL]" in front of a user.
    for (const { name, html } of FORMATS) {
      for (const ph of PLACEHOLDERS) {
        assert.ok(!html.includes(ph), `${name} still contains ${ph}`);
      }
      assert.ok(!/\[[A-Z][A-Z ]{3,}\]/.test(html),
        `${name}: an unfilled bracket placeholder remains`);
    }
  });

  test('the contact email is the configured one, and the only one', () => {
    for (const { name, html } of FORMATS) {
      const emails = [...new Set(html.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [])];
      assert.deepEqual(emails, [CONTACT],
        `unexpected email address in ${name}: ${emails.join(', ')}`);
    }
  });

  test('an operator and a contact route are both named', () => {
    // Play and the App Store both require a reachable privacy contact.
    for (const { name, html } of FORMATS) {
      assert.ok(html.includes('Harishreyas Vijay'), `${name}: the operator is not named`);
      assert.ok(html.includes(CONTACT), `${name}: no contact email`);
      assert.ok(/Kerala 689643/.test(html), `${name}: no postal address`);
      assert.ok(/15 September 2026/.test(html), `${name}: no effective date`);
    }
  });

  test('no company or entity is implied for an individual publisher', () => {
    // Theeram is published by an individual, so the policy must not describe
    // itself as operated by a company that does not exist.
    for (const { name, html } of FORMATS) {
      for (const bad of ['Pvt Ltd', 'Private Limited', 'Inc.', 'LLC', 'LLP', 'GmbH']) {
        assert.ok(!html.includes(bad), `${name} implies a legal entity: ${bad}`);
      }
    }
  });
});

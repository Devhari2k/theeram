// Theeram — privacy policy integrity.
// Run with: npm run test:privacy
//
// The policy ships twice: www/privacy.html is bundled in the app so it opens
// offline, and docs/privacy-policy.html is the copy meant for public hosting.
// Two copies drift, so the drift is asserted away here rather than trusted.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const APP = read('www/privacy.html');
const DOCS = read('docs/privacy-policy.html');
const MD = read('docs/PRIVACY_POLICY.md');
const INDEX = read('www/index.html');

describe('the two HTML copies cannot drift', () => {
  test('bundled and hostable copies are byte-identical', () => {
    assert.equal(APP, DOCS,
      'www/privacy.html and docs/privacy-policy.html have diverged — re-copy one over the other');
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

  test('the page makes NO network request', () => {
    // It ships inside a flood app, which is used precisely when connectivity
    // is poor. A webfont or CDN stylesheet would leave it unstyled offline.
    const refs = APP.match(/(?:src|href)=["']https?:\/\/[^"']+/g) || [];
    assert.deepEqual(refs, [], `external references found: ${refs.join(', ')}`);
  });

  test('it loads no tracker', () => {
    // Match tracker HOSTS and call sites, not the word "analytics" — the page
    // legitimately says in prose that Theeram contains no analytics SDK.
    for (const bad of ['googletagmanager.com', 'google-analytics.com', 'gtag(',
                       'connect.facebook.net', 'doubleclick.net', 'hotjar', 'segment.com']) {
      assert.ok(!APP.includes(bad), `policy page loads a tracker: ${bad}`);
    }
    assert.equal((APP.match(/<script/g) || []).length, 1,
      'exactly one inline script (the Back-link guard) and no others');
  });
});

describe('the policy matches what the code actually does', () => {
  test('every third party the client contacts is disclosed', () => {
    // Derived from the code, not from memory: any new outbound host must be
    // added to the policy or this fails.
    const sources = ['www/index.html', 'www/js/auth.js', 'www/js/family.js',
                     'www/js/push.js', 'www/js/firebase-init.js',
                     'www/service-worker.js'].map(read).join('\n');
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

describe('unresolved placeholders are visible, not silently shipped', () => {
  const PLACEHOLDERS = ['[LEGAL ENTITY NAME]', '[PRIVACY CONTACT EMAIL]',
                        '[EFFECTIVE DATE]', '[BUSINESS ADDRESS]'];

  test('the same placeholders appear in both formats', () => {
    for (const ph of PLACEHOLDERS) {
      assert.ok(APP.includes(ph), `HTML policy is missing ${ph}`);
      assert.ok(MD.includes(ph), `Markdown policy is missing ${ph}`);
    }
  });

  test('no invented company name, email or address slipped in', () => {
    // A plausible-looking fake contact is worse than an obvious placeholder.
    const body = APP + MD;
    const emails = (body.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])
      .filter(e => !e.includes('example'));
    assert.deepEqual(emails, [], `a concrete email address was invented: ${emails.join(', ')}`);
  });
});

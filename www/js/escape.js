// Shared HTML-escaping helpers for Theeram.
//
// Loaded as a CLASSIC script, deliberately, not an ES module: index.html's
// main script is an inline classic <script> and cannot `import`, while the
// module files (family-ui.js et al.) can still read these as globals. That
// keeps ONE definition instead of a copy per file, and matches how the rest
// of this app already shares across that boundary (window.theeramFamily,
// window.theeramGeocode). It must be loaded before the inline script runs.
//
// Why this exists: family member names, saved place names, profile photo URLs
// and cached risk/terrain values all come back from Firestore, where one
// family member can write values another member's device renders. Anything
// from that boundary is untrusted text, not markup.

// Escapes for HTML text content AND for values inside double- or
// single-quoted attributes (both quote characters are encoded, so a value
// can never terminate the attribute it sits in).
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Constrains a value destined for a CSS property inside a style attribute.
// Escaping alone stops the attribute being broken out of, but a value like
// "red;background-image:url(//evil)" would still inject a second declaration
// and phone home, so restrict to a conservative colour charset that still
// admits everything the risk engine actually produces: var(--coral),
// var(--amber), var(--safe), var(--text-faint), #rrggbb, rgb(...) and
// friends. Anything else falls back rather than rendering attacker input.
function safeCssColor(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  return (s && /^[#a-zA-Z0-9(),.%\s_-]+$/.test(s) && !/url|expression|\/\*/i.test(s))
    ? s
    : fallback;
}

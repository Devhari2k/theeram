// Theeram — account deletion, the decision half.
//
// Deliberately free of Firebase, Firestore and the DOM so it can be imported
// and exercised directly by Node. account-delete.js does the I/O and imports
// everything here; nothing is duplicated between the two.

/**
 * Normalise joinedAt to milliseconds. Firestore hands back a Timestamp, tests
 * hand back numbers or ISO strings, and a member written mid-join can have
 * null. Anything unreadable sorts LAST, so a member with a known join date is
 * always preferred over one without.
 */
export function joinedAtMs(member) {
  const v = member && member.joinedAt;
  if (v == null) return Number.POSITIVE_INFINITY;
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return Number.POSITIVE_INFINITY;
}

/**
 * Who inherits a family when its only admin deletes their account.
 * Longest-serving member wins; uid breaks ties, so the choice is deterministic
 * and a retry after a partial failure picks the same person.
 */
export function pickSuccessor(others) {
  const sorted = [...(others || [])].sort((a, b) => {
    const d = joinedAtMs(a) - joinedAtMs(b);
    if (d !== 0) return d;
    return String(a.uid) < String(b.uid) ? -1 : 1;
  });
  return sorted[0] || null;
}

/**
 * What must happen to ONE family when `uid` deletes their account.
 *
 * action is one of:
 *   'delete-family'      last member out — nothing of anyone else's is lost
 *   'promote-then-leave' sole admin with others — hand the family over, then go
 *   'leave'              ordinary member, or one admin among several
 *   'skip'               not actually a member
 */
export function planFamilyDisposition(uid, family) {
  const familyId = family && family.id;
  const members = (family && family.members) || [];
  const me = members.find(m => m && m.uid === uid);
  if (!me) return { familyId, action: 'skip', reason: 'not-a-member' };

  const others = members.filter(m => m && m.uid !== uid);
  if (others.length === 0) return { familyId, action: 'delete-family' };

  const otherAdmins = others.filter(m => m.role === 'admin');
  if (me.role !== 'admin' || otherAdmins.length > 0) return { familyId, action: 'leave' };

  // Sole admin with other members still in the family. Deleting it would
  // destroy other people's saved places, so it is handed over instead.
  const successor = pickSuccessor(others);
  return { familyId, action: 'promote-then-leave', successorUid: successor.uid };
}

export function planDeletion(uid, families) {
  return (families || []).map(f => planFamilyDisposition(uid, f));
}

/** Which sign-in method this account actually uses. */
export function primaryProviderId(user) {
  const list = (user && user.providerData) || [];
  if (list.some(p => p && p.providerId === 'password')) return 'password';
  const first = list.find(p => p && p.providerId);
  return first ? first.providerId : 'password';
}

/**
 * What a client-side purge provably cannot reach, and why. Surfaced in the
 * report rather than hidden: a deletion promise that quietly leaves data
 * behind is worse than one that names the gap.
 */
export const RESIDUAL = Object.freeze([
  Object.freeze({
    collection: 'alertDecisions',
    field: 'recipients.<uid>, undeliveredTo[]',
    why: 'No security rule matches alertDecisions, so it falls to the default-deny ' +
         'catch-all. Clients cannot read or write it at all — by design, since it is ' +
         'server-owned. Needs a server-side sweep.'
  }),
  Object.freeze({
    collection: 'inviteCodes',
    field: 'usedBy',
    why: 'allow delete is `if false`, and allow update requires resource.data.used == false. ' +
         'A code carrying this uid is already used, so it is immutable to every client. ' +
         'Needs a server-side sweep.'
  })
]);

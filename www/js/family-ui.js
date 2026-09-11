import * as Family from './family.js';

// ---- Tabs ----
const tabPlacesBtn = document.getElementById('tabPlacesBtn');
const tabFamilyBtn = document.getElementById('tabFamilyBtn');
const placesTab = document.getElementById('placesTab');
const familyTab = document.getElementById('familyTab');

function setTab(name){
  const isPlaces = name === 'places';
  tabPlacesBtn.classList.toggle('active', isPlaces);
  tabFamilyBtn.classList.toggle('active', !isPlaces);
  placesTab.style.display = isPlaces ? '' : 'none';
  familyTab.style.display = isPlaces ? 'none' : '';
}
tabPlacesBtn.addEventListener('click', () => setTab('places'));
tabFamilyBtn.addEventListener('click', () => setTab('family'));

// ---- DOM refs ----
const familyOnboarding = document.getElementById('familyOnboarding');
const familyDashboard = document.getElementById('familyDashboard');
const familySwitcher = document.getElementById('familySwitcher');
const familyNameDisplay = document.getElementById('familyNameDisplay');
const familyRoleBadge = document.getElementById('familyRoleBadge');
const renameFamilyBtn = document.getElementById('renameFamilyBtn');
const memberCards = document.getElementById('memberCards');
const noFamilyNotice = document.getElementById('noFamilyNotice');

const createFamilyName = document.getElementById('createFamilyName');
const createFamilyBtn = document.getElementById('createFamilyBtn');
const createFamilyError = document.getElementById('createFamilyError');

const joinFamilyCode = document.getElementById('joinFamilyCode');
const joinFamilyBtn = document.getElementById('joinFamilyBtn');
const joinFamilyError = document.getElementById('joinFamilyError');
const joinPreview = document.getElementById('joinPreview');

const inviteBtn = document.getElementById('inviteBtn');
const familyMenuBtn = document.getElementById('familyMenuBtn');
const familyMenu = document.getElementById('familyMenu');
const leaveFamilyBtn = document.getElementById('leaveFamilyBtn');
const deleteFamilyBtn = document.getElementById('deleteFamilyBtn');

const inviteModal = document.getElementById('inviteModal');
const inviteFamilyName = document.getElementById('inviteFamilyName');
const inviteCodeDisplay = document.getElementById('inviteCodeDisplay');
const inviteLinkInput = document.getElementById('inviteLinkInput');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const closeInviteModal = document.getElementById('closeInviteModal');
const regenerateCodeBtn = document.getElementById('regenerateCodeBtn');
const inviteModalStatus = document.getElementById('inviteModalStatus');

const joinLinkModal = document.getElementById('joinLinkModal');
const joinLinkText = document.getElementById('joinLinkText');
const joinLinkConfirmBtn = document.getElementById('joinLinkConfirmBtn');
const joinLinkCancelBtn = document.getElementById('joinLinkCancelBtn');
const joinLinkError = document.getElementById('joinLinkError');

const confirmModal = document.getElementById('confirmModal');
const confirmTitle = document.getElementById('confirmTitle');
const confirmText = document.getElementById('confirmText');
const confirmActionBtn = document.getElementById('confirmActionBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');

let state = { myFamilies: [], activeFamilyId: null, family: null, members: [], locations: [], myUid: null };
let expandedMemberId = null;

function relTime(ts){
  if(!ts) return 'unknown';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if(secs < 60) return 'just now';
  if(secs < 3600) return Math.floor(secs/60) + 'm ago';
  if(secs < 86400) return Math.floor(secs/3600) + 'h ago';
  return Math.floor(secs/86400) + 'd ago';
}

const STATUS_LABEL = { safe: 'Safe', need_help: 'Need Help', no_response: 'No Response' };

function render(){
  const hasFamily = !!state.activeFamilyId && !!state.family;
  familyOnboarding.style.display = hasFamily ? 'none' : '';
  familyDashboard.style.display = hasFamily ? '' : 'none';
  noFamilyNotice.style.display = state.myFamilies.length ? 'none' : '';

  if(state.myFamilies.length > 1){
    familySwitcher.style.display = 'flex';
    familySwitcher.innerHTML = state.myFamilies.map(f =>
      `<button class="switcher-pill ${f.id === state.activeFamilyId ? 'active' : ''}" data-fid="${f.id}">${escapeHtml(f.name)}</button>`
    ).join('');
    familySwitcher.querySelectorAll('[data-fid]').forEach(btn => {
      btn.addEventListener('click', () => Family.setActiveFamily(btn.getAttribute('data-fid')));
    });
  } else {
    familySwitcher.style.display = 'none';
    familySwitcher.innerHTML = '';
  }

  if(!hasFamily) return;

  familyNameDisplay.textContent = state.family.name || '';
  const myRole = (state.members.find(m => m.id === state.myUid) || {}).role || 'member';
  familyRoleBadge.textContent = myRole === 'admin' ? 'Admin' : 'Member';
  deleteFamilyBtn.style.display = myRole === 'admin' ? '' : 'none';
  // Invite-code minting is admin-only at the rules level (isFamilyAdmin) —
  // hide the button for non-admins rather than let them hit a confusing
  // permission-denied error after typing a family name and clicking it.
  inviteBtn.style.display = myRole === 'admin' ? '' : 'none';
  renameFamilyBtn.style.display = myRole === 'admin' ? '' : 'none';

  const sorted = [...state.members].sort((a,b) => {
    if(a.id === state.myUid) return -1;
    if(b.id === state.myUid) return 1;
    return (a.name||'').localeCompare(b.name||'');
  });

  memberCards.innerHTML = sorted.map(m => memberCardHtml(m, myRole)).join('');

  memberCards.querySelectorAll('.member-top').forEach(top => {
    top.addEventListener('click', () => {
      const card = top.closest('.member-card');
      const id = card.getAttribute('data-mid');
      expandedMemberId = expandedMemberId === id ? null : id;
      render();
    });
  });
  memberCards.querySelectorAll('.make-admin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = btn.getAttribute('data-uid');
      const member = state.members.find(m => m.id === uid);
      confirmAction(
        'Transfer ownership?',
        `${member.name} will become the new admin of this family. You'll remain a member.`,
        async () => { await Family.transferOwnership(state.activeFamilyId, uid); }
      );
    });
  });
  memberCards.querySelectorAll('.remove-member-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = btn.getAttribute('data-uid');
      const member = state.members.find(m => m.id === uid);
      confirmAction(
        'Remove member?',
        `${member.name} will lose access to this family circle and their saved places in it will be deleted.`,
        async () => { await Family.removeMember(state.activeFamilyId, uid); }
      );
    });
  });
}

function memberCardHtml(m, myRole){
  const isMe = m.id === state.myUid;
  const places = state.locations.filter(l => l.ownerUid === m.id);
  const expanded = expandedMemberId === m.id;
  const initial = (m.name || '?').trim().charAt(0).toUpperCase();
  const avatar = m.photoURL ? `<img src="${m.photoURL}" alt="">` : initial;
  const status = m.status || 'safe';

  const placesHtml = places.length
    ? places.map(placeMiniHtml).join('')
    : `<div class="no-places-note">No saved places yet.</div>`;

  const adminActions = (myRole === 'admin' && !isMe) ? `
    <div class="member-admin-actions">
      <button class="make-admin-btn" data-uid="${m.id}">Make admin</button>
      <button class="remove-member-btn danger" data-uid="${m.id}">Remove</button>
    </div>` : '';

  return `
    <div class="member-card ${expanded ? 'expanded' : ''}" data-mid="${m.id}">
      <div class="member-top">
        <div class="member-avatar">${avatar}</div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.name || 'Member')} ${isMe ? '<span class="you-badge">You</span>' : ''}</div>
          <div class="member-meta">${m.role === 'admin' ? 'Admin' : 'Member'} · Active ${relTime(m.lastActiveAt)} · ${places.length} place${places.length === 1 ? '' : 's'}</div>
        </div>
        <span class="status-badge ${status}">${STATUS_LABEL[status] || 'Safe'}</span>
        <span class="expand-chevron">▾</span>
      </div>
      ${m.homeLocation ? `<div class="member-home">🏠 ${escapeHtml(m.homeLocation.name)}</div>` : ''}
      <div class="member-places">${placesHtml}</div>
      ${adminActions}
    </div>
  `;
}

function placeMiniHtml(l){
  const risk = l.risk || { level: 'Unknown', color: 'var(--text-faint)' };
  const terrainBit = l.terrainType ? `${l.terrainType}${l.elevation != null ? ' · ~' + Math.round(l.elevation) + 'm' : ''} · ` : '';
  return `
    <div class="place-mini">
      <div class="place-mini-top">
        <span class="place-mini-name">${escapeHtml(l.name)}</span>
        <span class="risk-pill" style="background:${risk.color}">${risk.level}</span>
      </div>
      <div class="place-mini-meta">${terrainBit}Updated ${relTime(l.lastUpdated)}</div>
    </div>
  `;
}

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.addEventListener('theeram:familieschanged', (e) => {
  state.myFamilies = e.detail.myFamilies;
  state.activeFamilyId = e.detail.activeFamilyId;
  render();
});
document.addEventListener('theeram:dashboardchanged', (e) => {
  state.family = e.detail.family;
  state.members = e.detail.members;
  state.locations = e.detail.locations;
  state.myUid = e.detail.myUid;
  render();
});

// ---- Create / Join ----
createFamilyBtn.addEventListener('click', async () => {
  const name = createFamilyName.value.trim();
  createFamilyError.textContent = '';
  if(!name){ createFamilyError.textContent = 'Enter a family name.'; return; }
  createFamilyBtn.disabled = true;
  try{
    await Family.createFamily(name);
    createFamilyName.value = '';
  }catch(err){
    createFamilyError.textContent = err.message || 'Could not create family.';
  }finally{
    createFamilyBtn.disabled = false;
  }
});

let previewTimer = null;
joinFamilyCode.addEventListener('input', () => {
  clearTimeout(previewTimer);
  joinPreview.style.display = 'none';
  const code = joinFamilyCode.value.trim();
  if(code.length < 4) return;
  previewTimer = setTimeout(async () => {
    const preview = await Family.previewInviteCode(code).catch(() => null);
    if(preview){
      joinPreview.textContent = `Valid code — you'll join "${preview.familyName}".`;
      joinPreview.style.display = '';
    }
  }, 400);
});
joinFamilyBtn.addEventListener('click', async () => {
  joinFamilyError.textContent = '';
  joinFamilyBtn.disabled = true;
  try{
    await Family.joinFamilyByCode(joinFamilyCode.value);
    joinFamilyCode.value = '';
    joinPreview.style.display = 'none';
  }catch(err){
    joinFamilyError.textContent = err.message || 'Could not join family.';
  }finally{
    joinFamilyBtn.disabled = false;
  }
});

// ---- Rename ----
renameFamilyBtn.addEventListener('click', async () => {
  const name = prompt('Rename family circle:', state.family.name);
  if(name && name.trim() && name.trim() !== state.family.name){
    try{ await Family.renameFamily(state.activeFamilyId, name.trim()); }
    catch(err){ alert(err.message || 'Could not rename family.'); }
  }
});

// ---- Family menu (leave / delete) ----
familyMenuBtn.addEventListener('click', () => familyMenu.classList.toggle('open'));
document.addEventListener('click', (e) => {
  if(!familyMenuBtn.contains(e.target) && !familyMenu.contains(e.target)) familyMenu.classList.remove('open');
});
leaveFamilyBtn.addEventListener('click', () => {
  familyMenu.classList.remove('open');
  confirmAction(
    'Leave this family?',
    'You\'ll lose access to everyone\'s saved places, and your own places in this family will be deleted.',
    async () => {
      try{ await Family.leaveFamily(state.activeFamilyId); }
      catch(err){ alert(err.message || 'Could not leave family.'); }
    }
  );
});
deleteFamilyBtn.addEventListener('click', () => {
  familyMenu.classList.remove('open');
  confirmAction(
    'Delete this family circle?',
    'This permanently deletes the family, every member\'s saved places in it, and the active invite code. This cannot be undone.',
    async () => { await Family.deleteFamily(state.activeFamilyId); }
  );
});

// ---- Invite modal ----
async function openInviteModal(){
  inviteFamilyName.textContent = state.family.name || '';
  inviteModalStatus.textContent = 'Generating invite code…';
  inviteCodeDisplay.textContent = '······';
  inviteModal.style.display = 'flex';
  try{
    const code = await Family.generateInviteCode(state.activeFamilyId);
    inviteCodeDisplay.textContent = code;
    const link = Family.buildShareLink(code);
    inviteLinkInput.value = link;
    inviteModalStatus.textContent = '';
    if(window.QRCode){
      QRCode.toCanvas(document.getElementById('inviteQR'), link, { width: 180, margin: 1, color: { dark: '#0B2027', light: '#FFFFFF' } }, () => {});
    }
  }catch(err){
    inviteModalStatus.textContent = err.message || 'Could not generate invite code.';
  }
}
inviteBtn.addEventListener('click', openInviteModal);
regenerateCodeBtn.addEventListener('click', openInviteModal);
closeInviteModal.addEventListener('click', () => { inviteModal.style.display = 'none'; });
copyLinkBtn.addEventListener('click', async () => {
  try{
    await navigator.clipboard.writeText(inviteLinkInput.value);
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => { copyLinkBtn.textContent = 'Copy'; }, 1500);
  }catch(e){
    inviteLinkInput.select();
  }
});

// ---- Generic confirm modal ----
function confirmAction(title, text, onConfirm){
  confirmTitle.textContent = title;
  confirmText.textContent = text;
  confirmModal.style.display = 'flex';
  const cleanup = () => {
    confirmModal.style.display = 'none';
    confirmActionBtn.removeEventListener('click', onOk);
    confirmCancelBtn.removeEventListener('click', onCancel);
  };
  const onOk = async () => {
    confirmActionBtn.disabled = true;
    try{ await onConfirm(); }
    catch(err){ alert(err.message || 'Something went wrong.'); }
    finally{ confirmActionBtn.disabled = false; cleanup(); }
  };
  const onCancel = () => cleanup();
  confirmActionBtn.addEventListener('click', onOk);
  confirmCancelBtn.addEventListener('click', onCancel);
}

// ---- Join via share link (?join=CODE) ----
document.addEventListener('theeram:authready', async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('join');
  if(!code) return;
  const url = new URL(window.location.href);
  url.searchParams.delete('join');
  window.history.replaceState({}, '', url.toString());

  const preview = await Family.previewInviteCode(code).catch(() => null);
  if(!preview){
    joinLinkText.textContent = 'This invite link is invalid or has already been used.';
    joinLinkConfirmBtn.style.display = 'none';
  } else {
    joinLinkText.textContent = `You've been invited to join "${preview.familyName}".`;
    joinLinkConfirmBtn.style.display = '';
  }
  joinLinkError.textContent = '';
  joinLinkModal.style.display = 'flex';

  joinLinkConfirmBtn.onclick = async () => {
    joinLinkConfirmBtn.disabled = true;
    try{
      await Family.joinFamilyByCode(code);
      joinLinkModal.style.display = 'none';
      setTab('family');
    }catch(err){
      joinLinkError.textContent = err.message || 'Could not join family.';
    }finally{
      joinLinkConfirmBtn.disabled = false;
    }
  };
});
joinLinkCancelBtn.addEventListener('click', () => { joinLinkModal.style.display = 'none'; });

import { requireAuth, getCurrentProfile } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav, roleLabel, avatar } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { resizeImage } from './image.js';
import { logActivity } from './activity.js';
import { formatDate, formatDateTime } from './catalog.js';

// My Profile (profile.html): anyone signed in can change their own name, job title, phone
// numbers, photo and password. Role and email are shown but not editable here -- those are
// set by the owner/admin.
//
// Writes go through update_my_profile() / set_my_avatar() (my_profile migration), which
// only ever touch the caller's own row and those columns. Photos go to the "avatars"
// storage bucket under a folder named after the user's id, which is the only folder its
// policies let them write to.
let profile = null;

async function init() {
  registerServiceWorker();
  const auth = await requireAuth();
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  document.getElementById('edit-btn').addEventListener('click', () => setEditing(true));
  document.getElementById('cancel-edit').addEventListener('click', () => {
    fillForm();
    setEditing(false);
  });
  document.getElementById('profile-form').addEventListener('submit', saveProfile);
  document.getElementById('avatar-input').addEventListener('change', uploadAvatar);
  document.getElementById('remove-avatar').addEventListener('click', removeAvatar);
  document.getElementById('password-form').addEventListener('submit', changePassword);
  document.querySelectorAll('[data-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const input = document.querySelector(`input[name="${btn.dataset.toggle}"]`);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    })
  );

  render();
  fillForm();
  await renderActivity();
}

// After any change: re-read the profile and refresh every place that shows it (hero,
// sidebar, top-bar avatar).
async function refresh() {
  const fresh = await getCurrentProfile();
  if (fresh) profile = fresh.profile;
  renderNav(profile);
  const topbar = document.querySelector('.topbar-tools .avatar-link');
  if (topbar) topbar.innerHTML = avatar(profile);
  render();
}

function render() {
  document.getElementById('hero-avatar').innerHTML = avatar(profile, 'avatar avatar-xl');
  document.getElementById('hero-name').textContent = profile.full_name;
  document.getElementById('hero-role').textContent = roleLabel(profile.role);
  document.getElementById('hero-email').textContent = profile.email ?? '';
  document.getElementById('hero-phone').textContent = profile.phone ?? '';
  document.getElementById('remove-avatar').hidden = !profile.avatar_url;
  document.querySelector('#password-form input[name="username"]').value = profile.email ?? '';
  document.getElementById('summary').innerHTML = `
    <div><dt>Account type</dt><dd>${roleLabel(profile.role)}</dd></div>
    <div><dt>Member since</dt><dd>${formatDate(profile.created_at)}</dd></div>
    <div><dt>Last active</dt><dd>${formatDateTime(profile.last_seen_at)}</dd></div>
    <div><dt>Sign-in email</dt><dd>${profile.email ?? '—'}</dd></div>`;
}

function fillForm() {
  const f = document.getElementById('profile-form');
  f.full_name.value = profile.full_name ?? '';
  f.job_title.value = profile.job_title ?? '';
  f.email.value = profile.email ?? '';
  f.role.value = roleLabel(profile.role);
  f.phone.value = profile.phone ?? '';
  f.alt_phone.value = profile.alt_phone ?? '';
}

function setEditing(on) {
  document.getElementById('profile-fields').disabled = !on;
  document.getElementById('profile-actions').hidden = !on;
  document.getElementById('edit-btn').hidden = on;
  document.getElementById('profile-success').textContent = '';
  if (on) document.querySelector('#profile-form input[name="full_name"]').focus();
}

async function saveProfile(event) {
  event.preventDefault();
  const f = event.target;
  const errorEl = document.getElementById('profile-error');
  errorEl.textContent = '';
  if (!f.full_name.value.trim()) {
    f.full_name.setAttribute('aria-invalid', 'true');
    f.full_name.focus();
    return (errorEl.textContent = 'Enter your full name.');
  }
  f.full_name.removeAttribute('aria-invalid');
  const { error } = await getClient().rpc('update_my_profile', {
    p_full_name: f.full_name.value,
    p_job_title: f.job_title.value,
    p_phone: f.phone.value,
    p_alt_phone: f.alt_phone.value,
  });
  if (error) return (errorEl.textContent = error.message);
  await logActivity(profile, 'profile_updated', `${f.full_name.value.trim()} updated their profile`);
  await refresh();
  fillForm();
  setEditing(false);
  document.getElementById('profile-success').textContent = 'Profile saved.';
  await renderActivity();
}

async function uploadAvatar(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  const errorEl = document.getElementById('avatar-error');
  errorEl.textContent = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return (errorEl.textContent = 'Choose an image file (JPG or PNG).');
  const client = getClient();
  try {
    const blob = await resizeImage(file, 400, 0.85);
    // A new file name each time, so browsers don't keep showing a cached old photo.
    const path = `${profile.id}/avatar-${Date.now()}.jpg`;
    const { error: uploadError } = await client.storage.from('avatars').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (uploadError) throw new Error(uploadError.message);
    const url = client.storage.from('avatars').getPublicUrl(path).data.publicUrl;
    const { error } = await client.rpc('set_my_avatar', { p_avatar_url: url });
    if (error) throw new Error(error.message);
    await logActivity(profile, 'profile_updated', `${profile.full_name} changed their profile photo`);
    await refresh();
    await renderActivity();
  } catch (err) {
    errorEl.textContent = err.message ?? 'Could not upload that photo.';
  }
}

async function removeAvatar() {
  const { error } = await getClient().rpc('set_my_avatar', { p_avatar_url: null });
  if (error) return (document.getElementById('avatar-error').textContent = error.message);
  await refresh();
}

async function changePassword(event) {
  event.preventDefault();
  const f = event.target;
  const errorEl = document.getElementById('password-error');
  const okEl = document.getElementById('password-success');
  errorEl.textContent = '';
  okEl.textContent = '';
  const current = f.current_password.value;
  const next = f.new_password.value;
  if (!current) return (errorEl.textContent = 'Enter your current password.');
  if (next.length < 8 || !/[a-z]/i.test(next) || !/\d/.test(next)) return (errorEl.textContent = 'Use at least 8 characters, including letters and numbers.');
  if (next !== f.confirm_password.value) return (errorEl.textContent = 'The new passwords don’t match.');
  if (next === current) return (errorEl.textContent = 'The new password must be different from the current one.');

  const client = getClient();
  // Check the current password first, so a device left signed in can't be used to
  // take over the account.
  const { error: signInError } = await client.auth.signInWithPassword({ email: profile.email, password: current });
  if (signInError) return (errorEl.textContent = 'Your current password is incorrect.');
  const { error } = await client.auth.updateUser({ password: next });
  if (error) return (errorEl.textContent = error.message);
  f.reset();
  okEl.textContent = 'Password changed.';
  await logActivity(profile, 'password_changed', `${profile.full_name} changed their password`);
}

async function renderActivity() {
  // activity_log is readable by managers/owner/admin only (RLS); for everyone else the
  // card simply isn't shown.
  const { data, error } = await getClient().from('activity_log').select('*').eq('user_id', profile.id).order('created_at', { ascending: false });
  const card = document.getElementById('activity-card');
  if (error || !data) {
    card.hidden = true;
    return;
  }
  document.getElementById('my-activity').innerHTML =
    data
      .slice(0, 6)
      .map((a) => `<li><span class="timeline-dot is-done"></span><span><strong>${a.description}</strong></span><small>${timeAgo(a.created_at)}</small></li>`)
      .join('') || '<li class="muted">Nothing yet.</li>';
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : formatDate(iso);
}

init();

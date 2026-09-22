/* ==========================================================================
   Admin login gate — a plain password box, nothing else.

   This is a DETERRENT, not a lock. It's a client-side check in a public
   GitHub repo, so anyone who reads the source can see ADMIN_PASSWORD, and
   anyone who already knows the site's Firebase config (also public, in
   lib/config.js) could still write to the database directly, bypassing this
   page entirely. What this DOES stop: someone stumbling onto /admin/ and
   poking around, or casually opening it without knowing the password.

   If you ever want the database itself to actually refuse unauthenticated
   writes, that needs real Firebase Authentication — ask and I'll set that
   version up instead.

   Setup: just change ADMIN_PASSWORD in lib/config.js. Nothing else to do.
   ========================================================================== */

import { ADMIN_PASSWORD } from './config.js';

const UNLOCK_KEY = 'dart-league-admin-unlocked';

/**
 * Resolves once the right password has been entered (or was entered on a
 * previous visit — the unlock is remembered in this browser). Until then,
 * replaces mountEl's contents with a password prompt. Reuses admin.css's
 * existing .center / .btn / .msg.err / input[type=password] styles, so no
 * new CSS file is needed.
 */
export function requireAdminLogin(mountEl) {
  return new Promise((resolve) => {
    try {
      if (localStorage.getItem(UNLOCK_KEY) === '1') { resolve(); return; }
    } catch (e) { /* private mode: fall through to the prompt every time */ }
    renderLogin(mountEl, resolve);
  });
}

function renderLogin(mountEl, resolve) {
  mountEl.innerHTML = `
    <div class="center">
      <h2>Admin sign in</h2>
      <p class="hint" style="margin-bottom:16px;">This page is restricted. Enter the admin password.</p>
      <form id="login-form">
        <input type="password" id="login-pass" placeholder="Password" autocomplete="current-password"
               style="width:100%; margin-bottom:10px; text-align:center;" autofocus>
        <button type="submit" class="btn primary" style="width:100%;">Sign in</button>
        <div class="msg err" id="login-err"></div>
      </form>
    </div>`;

  const form = mountEl.querySelector('#login-form');
  const passInput = mountEl.querySelector('#login-pass');
  const errEl = mountEl.querySelector('#login-err');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (passInput.value === ADMIN_PASSWORD) {
      try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (e2) { /* private mode: stays unlocked for this tab only */ }
      resolve();
    } else {
      errEl.textContent = 'Wrong password.';
      passInput.value = '';
      passInput.focus();
    }
  });
}

export function signOutAdmin() {
  try { localStorage.removeItem(UNLOCK_KEY); } catch (e) { /* nothing to clear */ }
  location.reload();
}

/** Small floating "Sign out" button, independent of admin.js's own render cycle. */
export function mountSignOutButton() {
  if (document.getElementById('admin-signout')) return;
  const btn = document.createElement('button');
  btn.id = 'admin-signout';
  btn.textContent = 'Sign out';
  btn.className = 'btn small';
  btn.style.cssText = 'position:fixed; right:14px; bottom:14px; z-index:40; opacity:0.85;';
  btn.addEventListener('click', () => {
    if (window.confirm('Sign out of the admin panel?')) signOutAdmin();
  });
  document.body.appendChild(btn);
}

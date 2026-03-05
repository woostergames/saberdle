const LEADERBOARD_API_URL = 'https://saberdle-key.evan758321.workers.dev';
const API_TIMEOUT         = 8000;
const COOKIE_NAME         = 'beatdle_username';

// ─── State ────────────────────────────────────────────────────────────────────
let leaderboardData    = [];
let currentUsername    = '';
let sessionToken       = null;
let heartbeatInterval  = null;
let heartbeatMs        = 3000;

// ─── Fetch interceptor ────────────────────────────────────────────────────────
;(function _installFetchInterceptor() {
  const _native = window.fetch;

  async function _refreshToken() {
    try {
      const res  = await _native(`${LEADERBOARD_API_URL}/api/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) return null;
      const d = await res.json();
      return (d.success && d.token) ? d.token : null;
    } catch { return null; }
  }

  window.fetch = async function(input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    if (!url.startsWith(LEADERBOARD_API_URL)) return _native(input, init);

    if (sessionToken) {
      init = { ...init, headers: { ...(init.headers || {}), 'x-session-token': sessionToken } };
    }

    let res = await _native(input, init);

    if (res.status === 401) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'SESSION_EXPIRED' || body.code === 'SESSION_INVALID') {
        const newToken = await _refreshToken();
        if (newToken) {
          sessionToken = newToken;
          _stopHeartbeat();
          _startHeartbeat();
          init = { ...init, headers: { ...(init.headers || {}), 'x-session-token': newToken } };
          res  = await _native(input, init);
        }
      }
    }

    return res;
  };
})();

// ─── Cookie helpers ───────────────────────────────────────────────────────────
function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Strict`;
}
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
function fetchWithTimeout(url, options = {}, timeout = API_TIMEOUT) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), timeout)
    )
  ]);
}

async function authFetch(url, options = {}) {
  if (!sessionToken) {
    window.showSessionExpired?.();
    throw new Error('No session token');
  }
  const headers = { ...(options.headers || {}), 'x-session-token': sessionToken };
  const res = await fetchWithTimeout(url, { ...options, headers });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.code === 'SESSION_EXPIRED' || body.code === 'SESSION_INVALID') {
      _stopHeartbeat();
      sessionToken = null;
      window.showSessionExpired?.();
      throw new Error('SESSION_EXPIRED');
    }
  }
  return res;
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────
function _startHeartbeat() {
  _stopHeartbeat();
  heartbeatInterval = setInterval(async () => {
    if (!sessionToken) { _stopHeartbeat(); return; }
    try {
      const res = await fetchWithTimeout(`${LEADERBOARD_API_URL}/api/session/heartbeat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken }
      }, 5000);
      if (res.status === 401) {
        const body = await res.json().catch(() => ({}));
        if (body.code === 'SESSION_EXPIRED' || body.code === 'SESSION_INVALID') {
          _stopHeartbeat();
          sessionToken = null;
          window.showSessionExpired?.();
        }
      }
    } catch { /* network blip — server has grace period */ }
  }, heartbeatMs);
}

function _stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ─── Session Token ────────────────────────────────────────────────────────────
async function fetchSessionToken() {
  window.setLoadingProgress?.(30, 'Connecting to server...');
  const res = await fetchWithTimeout(`${LEADERBOARD_API_URL}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error('Session request failed: ' + res.status);
  const data = await res.json();
  if (!data.success || !data.token) throw new Error('No token in response');
  sessionToken = data.token;
  if (data.heartbeatInterval) heartbeatMs = data.heartbeatInterval;
  return data.token;
}

// ─── Initialize ───────────────────────────────────────────────────────────────
async function initLeaderboard() {
  window.setLoadingProgress?.(10, 'Checking origin...');
  const host    = window.location.hostname;
  const allowed = ['evanblokender.org', 'www.evanblokender.org', 'localhost', '127.0.0.1'];
  if (!allowed.includes(host)) {
    console.warn('[Beatdle] Unauthorized origin — leaderboard disabled');
    window.hideLoadingScreen?.();
    return;
  }
  try {
    window.setLoadingProgress?.(20, 'Starting session...');
    await fetchSessionToken();
    window.setLoadingProgress?.(50, 'Establishing connection...');
    _startHeartbeat();
    window.setLoadingProgress?.(65, 'Loading leaderboard...');
    const saved = getCookie(COOKIE_NAME);
    if (saved) { currentUsername = saved; _applyNameLockUI(saved); }
    await loadLeaderboard();
    window.setLoadingProgress?.(90, 'Almost ready...');
  } catch (err) {
    console.error('[Beatdle] Init error:', err);
  }
  window.hideLoadingScreen?.();
  _injectAdminPanel();
}

// ─── Load Leaderboard ─────────────────────────────────────────────────────────
async function loadLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  if (list) list.innerHTML = '<div class="leaderboard-loading">Loading leaderboard...</div>';
  try {
    const res    = await authFetch(`${LEADERBOARD_API_URL}/api/leaderboard`);
    const result = await res.json();
    if (result.success && result.data) {
      leaderboardData = Array.isArray(result.data) ? result.data : [];
      updateLeaderboardDisplay();
      _updateAdminStats();
    } else {
      if (list) list.innerHTML = '<div class="leaderboard-error">Unable to load leaderboard.</div>';
    }
  } catch (err) {
    if (err.message === 'SESSION_EXPIRED') return;
    if (list) list.innerHTML = '<div class="leaderboard-error">Connection error. Try again later.</div>';
  }
}

// ─── Display ──────────────────────────────────────────────────────────────────
function updateLeaderboardDisplay() {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;
  list.innerHTML = '';
  if (!leaderboardData.length) {
    list.innerHTML = '<div class="leaderboard-empty">No scores yet. Be the first!</div>';
    return;
  }
  leaderboardData.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row';
    if (entry.username?.toLowerCase() === currentUsername.toLowerCase() && currentUsername) {
      row.classList.add('current-user');
    }
    const medal   = ['🥇','🥈','🥉'][i] || '';
    const dateStr = entry.date ? new Date(entry.date).toLocaleDateString() : 'N/A';
    row.innerHTML = `
      <span class="leaderboard-rank">${medal || '#'+(i+1)}</span>
      <span class="leaderboard-username">${escapeHtml(entry.username||'Unknown')}</span>
      <span class="leaderboard-score">${entry.score??0}</span>
      <span class="leaderboard-date">${dateStr}</span>
      ${isAdminMode() ? `<button class="leaderboard-delete" data-id="${entry.id}">🗑️</button>` : '<span></span>'}
    `;
    list.appendChild(row);
  });
  if (isAdminMode()) {
    list.querySelectorAll('.leaderboard-delete').forEach(btn => {
      btn.addEventListener('click', e => deleteEntry(e.currentTarget.dataset.id));
    });
  }
}

// ─── Submit Score ─────────────────────────────────────────────────────────────
async function submitToLeaderboard(score) {
  const lockedName = getCookie(COOKIE_NAME);
  const input      = document.getElementById('username-input');
  const username   = lockedName || (input ? input.value.trim() : '');
  if (!username)                                   { showToast('Please enter a username!');          return false; }
  if (username.length < 3 || username.length > 20) { showToast('Username must be 3–20 characters'); return false; }
  try {
    const res    = await authFetch(`${LEADERBOARD_API_URL}/api/leaderboard`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, score })
    });
    const result = await res.json();
    if (result.success) {
      if (!lockedName) { setCookie(COOKIE_NAME, username, 365); currentUsername = username; _applyNameLockUI(username); }
      showToast(result.message || 'Score submitted!');
      loadLeaderboard();
      return true;
    } else {
      showToast(result.message || 'Failed to submit score');
      return false;
    }
  } catch (err) {
    if (err.message === 'SESSION_EXPIRED') return false;
    showToast('Connection error. Please try again.');
    return false;
  }
}

// ─── Name Lock UI ─────────────────────────────────────────────────────────────
function _applyNameLockUI(name) {
  const input      = document.getElementById('username-input');
  const lockedMsg  = document.getElementById('username-locked-msg');
  const lockedName = document.getElementById('locked-name-display');
  const lockNotice = document.getElementById('username-lock-notice');
  if (input)      { input.value = name; input.disabled = true; input.style.display = 'none'; }
  if (lockedMsg)  { lockedMsg.style.display  = 'block'; }
  if (lockedName) { lockedName.textContent   = name; }
  if (lockNotice) { lockNotice.style.display = 'none'; }
}

// ─── Delete Entry ─────────────────────────────────────────────────────────────
async function deleteEntry(id) {
  const adminPassword = _getAdminPw();
  if (!adminPassword)             { _adminLog('Enter admin password first', '#ff6633'); return; }
  if (!confirm('Delete this entry?')) return;
  try {
    const res    = await authFetch(`${LEADERBOARD_API_URL}/api/leaderboard/${id}`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ adminPassword })
    });
    const result = await res.json();
    _adminLog(result.success ? '✓ Entry deleted' : (result.message || 'Delete failed'));
    if (result.success) { loadLeaderboard(); showToast('Entry deleted'); }
  } catch (err) {
    if (err.message !== 'SESSION_EXPIRED') _adminLog('Connection error.', '#ff4444');
  }
}

// ─── Admin: Unlock Name ───────────────────────────────────────────────────────
async function adminUnlockName(username) {
  const adminPassword = _getAdminPw();
  if (!adminPassword) { _adminLog('Enter admin password first', '#ff6633'); return; }
  if (!username)      { _adminLog('Enter a username to unlock', '#ff6633'); return; }
  try {
    const res    = await fetchWithTimeout(`${LEADERBOARD_API_URL}/api/admin/unlock-name`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ adminPassword, username })
    });
    const result = await res.json();
    _adminLog(result.success ? `✓ "${username}" unlocked` : (result.message || 'Failed'));
    if (result.success) showToast(`✅ "${username}" name lock removed`);
    return result.success;
  } catch {
    _adminLog('Connection error.', '#ff4444');
    return false;
  }
}

// ─── Legacy admin helpers (called from index.html) ───────────────────────────
function isAdminMode() {
  return _adminUnlocked;
}

function toggleAdminPanel() {
  const panel = document.getElementById('__adminPanel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function onAdminPasswordChange() {
  updateLeaderboardDisplay();
}

// ─── Username prompt ──────────────────────────────────────────────────────────
function showUsernamePrompt() {
  const prompt = document.getElementById('username-prompt');
  if (!prompt) return;
  prompt.style.display = 'block';
  const locked = getCookie(COOKIE_NAME);
  if (locked) {
    _applyNameLockUI(locked);
  } else {
    const input = document.getElementById('username-input');
    if (input) { input.disabled = false; input.style.display = ''; input.focus(); }
    const lockNotice = document.getElementById('username-lock-notice');
    if (lockNotice) lockNotice.style.display = 'block';
  }
}

function hideUsernamePrompt() {
  const prompt = document.getElementById('username-prompt');
  if (prompt) prompt.style.display = 'none';
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ════════════════════════════════════════════════════════════════════════════
//  ██████╗ ███████╗ █████╗ ████████╗██╗      █████╗ ███████╗
//  ██╔══██╗██╔════╝██╔══██╗╚══██╔══╝██║     ██╔══██╗██╔════╝
//  ██████╔╝█████╗  ███████║   ██║   ██║     ███████║███████╗
//  ██╔══██╗██╔══╝  ██╔══██║   ██║   ██║     ██╔══██║╚════██║
//  ██████╔╝███████╗██║  ██║   ██║   ███████╗██║  ██║███████║
//  ╚═════╝ ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝
//
//  Slither.io-style floating admin panel — orange/yellow theme
//  Password-gated: panel unlocks only after correct password entry
//  ↑↓ Navigate | ENTER Select/Toggle | ESC Back | DELETE Close
// ════════════════════════════════════════════════════════════════════════════

// ── Admin state ──────────────────────────────────────────────────────────────
let _adminUnlocked  = false;
let _adminCursor    = 0;
let _adminMenu      = 'home';
let _adminStack     = [];
let _adminToggles   = {};

function _getAdminPw() {
  return document.getElementById('__adm_pw_field')?.value || '';
}

function _adminLog(msg, col) {
  const el = document.getElementById('__adm_log');
  if (el) { el.style.color = col || '#ffcc44'; el.textContent = '► ' + msg; }
  console.log('[BEATDLE ADMIN]', msg);
}

function _updateAdminStats() {
  const el = (id) => document.getElementById(id);
  if (el('__adm_s_entries')) el('__adm_s_entries').textContent = leaderboardData.length;
  if (el('__adm_s_top'))     el('__adm_s_top').textContent = leaderboardData[0]?.score ?? '—';
  if (el('__adm_s_avg')) {
    const avg = leaderboardData.length
      ? Math.round(leaderboardData.reduce((a, e) => a + (e.score||0), 0) / leaderboardData.length)
      : '—';
    el('__adm_s_avg').textContent = avg;
  }
  if (el('__adm_s_lock')) el('__adm_s_lock').textContent = _adminUnlocked ? 'YES' : 'NO';
}

// ── Menu definitions ─────────────────────────────────────────────────────────
function _getAdminMenus() {
  return {

    // ── HOME ────────────────────────────────────────────────────────────────
    home: {
      title: '🎵 BEATDLE: ADMIN[1/1]',
      items: [
        { label: 'Panel Settings',     type: 'submenu', target: 'settings'  },
        { label: '→ Entries',          type: 'submenu', target: 'entries'   },
        { label: 'Player Tools',       type: 'submenu', target: 'players'   },
        { label: 'Leaderboard',        type: 'submenu', target: 'lb'        },
        { label: 'Session & Server',   type: 'submenu', target: 'session'   },
        { label: 'Lock & Security',    type: 'submenu', target: 'security'  },
        { label: 'Debug & Tools',      type: 'submenu', target: 'debug'     },
      ]
    },

    // ── SETTINGS ────────────────────────────────────────────────────────────
    settings: {
      title: 'Panel Settings',
      items: [
        { label: 'Ghost Mode (dim)',   type: 'toggle', id: 'ghost', action: (on) => {
            document.getElementById('__adminPanel').style.opacity = on ? '0.15' : '1';
        }},
        { label: 'Pin: Top Left',     type: 'action', action: () => _adminPin('tl') },
        { label: 'Pin: Top Right',    type: 'action', action: () => _adminPin('tr') },
        { label: 'Pin: Bot Left',     type: 'action', action: () => _adminPin('bl') },
        { label: 'Pin: Bot Right',    type: 'action', action: () => _adminPin('br') },
        { label: 'Lock Admin Panel',  type: 'action', action: () => {
            _adminUnlocked = false;
            document.getElementById('__adm_pw_field').value = '';
            _adminRender();
            _adminLog('Panel locked');
            updateLeaderboardDisplay();
        }},
        { label: '← Back',            type: 'back' },
      ]
    },

    // ── ENTRIES ─────────────────────────────────────────────────────────────
    entries: {
      title: '→ Entries',
      items: [
        { label: 'INFO: Manage leaderboard rows', type: 'info' },
        { label: 'Delete Entry by ID (prompt)',   type: 'action', action: () => {
            const id = prompt('Entry ID to delete:');
            if (id) deleteEntry(id.trim());
        }},
        { label: 'Delete #1 (top score)',         type: 'action', action: () => {
            if (!leaderboardData[0]) { _adminLog('No entries', '#ff6633'); return; }
            if (confirm('Delete top entry: ' + leaderboardData[0].username + '?')) {
                deleteEntry(leaderboardData[0].id);
            }
        }},
        { label: 'Delete #2',                     type: 'action', action: () => {
            if (!leaderboardData[1]) { _adminLog('No #2 entry', '#ff6633'); return; }
            if (confirm('Delete #2: ' + leaderboardData[1].username + '?')) deleteEntry(leaderboardData[1].id);
        }},
        { label: 'Delete #3',                     type: 'action', action: () => {
            if (!leaderboardData[2]) { _adminLog('No #3 entry', '#ff6633'); return; }
            if (confirm('Delete #3: ' + leaderboardData[2].username + '?')) deleteEntry(leaderboardData[2].id);
        }},
        { label: 'Show delete buttons in LB',     type: 'toggle', id: 'showdel', action: (on) => {
            updateLeaderboardDisplay();
            _adminLog('Delete buttons: ' + (on ? 'visible' : 'hidden'));
        }},
        { label: '← Back', type: 'back' },
      ]
    },

    // ── PLAYERS ─────────────────────────────────────────────────────────────
    players: {
      title: 'Player Tools',
      items: [
        { label: 'INFO: Name locks & player mgmt', type: 'info' },
        { label: 'Unlock Name (prompt)',            type: 'action', action: async () => {
            const u = prompt('Username to unlock name lock:');
            if (u) await adminUnlockName(u.trim());
        }},
        { label: 'Find player in LB (prompt)',     type: 'action', action: () => {
            const u = prompt('Search username:');
            if (!u) return;
            const found = leaderboardData.filter(e => e.username?.toLowerCase().includes(u.toLowerCase()));
            if (found.length) {
                found.forEach((e, i) => console.log(`[ADMIN] #${leaderboardData.indexOf(e)+1} ${e.username} — score: ${e.score} id: ${e.id}`));
                _adminLog(`Found ${found.length} match(es) → console`);
            } else {
                _adminLog('No matches for "' + u + '"', '#ff6633');
            }
        }},
        { label: 'List all usernames → console',   type: 'action', action: () => {
            console.table(leaderboardData.map((e,i) => ({ rank: i+1, username: e.username, score: e.score, id: e.id })));
            _adminLog('All players → console (F12)');
        }},
        { label: 'Count unique players',           type: 'action', action: () => {
            const unique = new Set(leaderboardData.map(e => e.username?.toLowerCase())).size;
            _adminLog('Unique players: ' + unique);
        }},
        { label: '← Back', type: 'back' },
      ]
    },

    // ── LEADERBOARD ─────────────────────────────────────────────────────────
    lb: {
      title: 'Leaderboard',
      items: [
        { label: 'Refresh leaderboard',    type: 'action', action: () => {
            loadLeaderboard();
            _adminLog('Refreshing...');
        }},
        { label: 'Log top 10 → console',   type: 'action', action: () => {
            console.log('[ADMIN] Top 10:');
            leaderboardData.slice(0,10).forEach((e,i) => console.log(`  ${i+1}. ${e.username} — ${e.score}`));
            _adminLog('Top 10 → console');
        }},
        { label: 'Log full LB → console',  type: 'action', action: () => {
            console.table(leaderboardData);
            _adminLog('Full leaderboard → console');
        }},
        { label: 'Show LB modal',          type: 'action', action: () => {
            document.getElementById('leaderboard-modal')?.classList.add('show');
            document.body.classList.add('modal-open');
            _adminLog('LB modal opened');
        }},
        { label: '← Back', type: 'back' },
      ]
    },

    // ── SESSION & SERVER ────────────────────────────────────────────────────
    session: {
      title: 'Session & Server',
      items: [
        { label: 'INFO: Session management', type: 'info' },
        { label: 'Log session token',        type: 'action', action: () => {
            console.log('[ADMIN] Session token:', sessionToken);
            _adminLog('Token → console (F12)');
        }},
        { label: 'Heartbeat: ON',            type: 'action', action: () => {
            _startHeartbeat();
            _adminLog('Heartbeat started');
        }},
        { label: 'Heartbeat: OFF (danger)',   type: 'action', action: () => {
            if (confirm('Stop heartbeat? Session will expire after grace period.')) {
                _stopHeartbeat();
                _adminLog('Heartbeat stopped!', '#ff6633');
            }
        }},
        { label: 'Refresh session token',    type: 'action', action: async () => {
            try {
                await fetchSessionToken();
                _startHeartbeat();
                _adminLog('Session token refreshed');
            } catch(e) {
                _adminLog('Refresh failed: ' + e.message, '#ff4444');
            }
        }},
        { label: 'Log API URL',              type: 'action', action: () => {
            _adminLog(LEADERBOARD_API_URL);
            console.log('[ADMIN] API:', LEADERBOARD_API_URL);
        }},
        { label: '← Back', type: 'back' },
      ]
    },

    // ── SECURITY ────────────────────────────────────────────────────────────
    security: {
      title: 'Lock & Security',
      items: [
        { label: 'INFO: Auth & cookie tools', type: 'info' },
        { label: 'Show my username cookie',   type: 'action', action: () => {
            const c = getCookie(COOKIE_NAME);
            _adminLog('Cookie: ' + (c || '(none)'));
        }},
        { label: 'Clear my username cookie',  type: 'action', action: () => {
            if (confirm('Clear your own name cookie? You can pick a new name.')) {
                document.cookie = `${COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
                currentUsername = '';
                _adminLog('Cookie cleared');
                showToast('Username cookie cleared');
            }
        }},
        { label: 'Show session expired UI',   type: 'action', action: () => {
            window.showSessionExpired?.();
            _adminLog('Session expired UI shown');
        }},
        { label: 'Log all cookies',           type: 'action', action: () => {
            console.log('[ADMIN] Cookies:', document.cookie);
            _adminLog('Cookies → console (F12)');
        }},
        { label: '← Back', type: 'back' },
      ]
    },

    // ── DEBUG ───────────────────────────────────────────────────────────────
    debug: {
      title: 'Debug & Tools',
      items: [
        { label: 'Log leaderboardData obj', type: 'action', action: () => {
            console.log('[ADMIN] leaderboardData:', leaderboardData);
            _adminLog('leaderboardData → console');
        }},
        { label: 'Log window.leaderboardAPI', type: 'action', action: () => {
            console.log('[ADMIN] leaderboardAPI:', window.leaderboardAPI);
            _adminLog('API object → console');
        }},
        { label: 'Dump all state',           type: 'action', action: () => {
            console.log('[ADMIN] State:', {
                leaderboardData, currentUsername, sessionToken: sessionToken?.slice(0,12)+'…',
                heartbeatMs, _adminUnlocked
            });
            _adminLog('State dump → console (F12)');
        }},
        { label: 'Toast test',               type: 'action', action: () => {
            showToast('Admin panel toast test ✓');
            _adminLog('Toast fired');
        }},
        { label: 'Reload page',              type: 'action', action: () => {
            if (confirm('Reload the page?')) location.reload();
        }},
        { label: '← Back', type: 'back' },
      ]
    }
  };
}

// ── Pin helper ───────────────────────────────────────────────────────────────
function _adminPin(corner) {
  const p = document.getElementById('__adminPanel');
  p.style.top = 'auto'; p.style.left = 'auto'; p.style.right = 'auto'; p.style.bottom = 'auto';
  const pad = '14px';
  if      (corner==='tl') { p.style.top=pad;    p.style.left=pad;   }
  else if (corner==='tr') { p.style.top=pad;    p.style.right=pad;  }
  else if (corner==='bl') { p.style.bottom=pad; p.style.left=pad;   }
  else if (corner==='br') { p.style.bottom=pad; p.style.right=pad;  }
  _adminLog('Pinned ' + corner.toUpperCase());
}

// ── Render ───────────────────────────────────────────────────────────────────
function _adminRender() {
  const panel = document.getElementById('__adminPanel');
  if (!panel) return;

  // Show login gate if not unlocked
  const loginGate = document.getElementById('__adm_login');
  const mainPanel = document.getElementById('__adm_main');
  if (loginGate && mainPanel) {
    loginGate.style.display = _adminUnlocked ? 'none'  : 'block';
    mainPanel.style.display = _adminUnlocked ? 'block' : 'none';
    if (!_adminUnlocked) return;
  }

  const MENUS = _getAdminMenus();
  const menu  = MENUS[_adminMenu];
  if (!menu) return;

  document.getElementById('__adm_header').textContent = menu.title;
  const list = document.getElementById('__adm_list');
  list.innerHTML = '<div class="admhint">↑↓ nav  ENTER select  ESC back  DEL close</div>';

  menu.items.forEach((item, i) => {
    const div = document.createElement('div');

    if (item.type === 'info') {
      div.className   = 'admitem adminfo';
      div.textContent = item.label;
      list.appendChild(div);
      return;
    }

    div.className = 'admitem' + (i === _adminCursor ? ' admsel' : '');

    const lbl = document.createElement('span');
    lbl.textContent = item.label;
    div.appendChild(lbl);

    if (item.type === 'toggle') {
      const b = document.createElement('span');
      b.className   = 'admbadge ' + (_adminToggles[item.id] ? 'admon' : 'admoff');
      b.textContent = _adminToggles[item.id] ? 'ON' : 'OFF';
      div.appendChild(b);
    } else if (item.type === 'submenu') {
      const b = document.createElement('span');
      b.className   = 'admbadge admsub';
      b.textContent = '»';
      div.appendChild(b);
    }

    div.addEventListener('click', () => { _adminCursor = i; _adminActivate(); });
    list.appendChild(div);
  });

  _updateAdminStats();
}

function _adminActivate() {
  const MENUS = _getAdminMenus();
  const menu  = MENUS[_adminMenu];
  const item  = menu?.items[_adminCursor];
  if (!item || item.type === 'info') return;

  if (item.type === 'back') {
    if (_adminStack.length) { _adminMenu = _adminStack.pop(); _adminCursor = 0; _adminRender(); }
    return;
  }
  if (item.type === 'submenu') {
    _adminStack.push(_adminMenu); _adminMenu = item.target; _adminCursor = 0; _adminRender(); return;
  }
  if (item.type === 'toggle') {
    _adminToggles[item.id] = !_adminToggles[item.id];
    try { item.action(_adminToggles[item.id]); } catch(e) { _adminLog('ERR: '+e.message, '#ff4444'); }
    _adminRender(); return;
  }
  if (item.type === 'action') {
    try { item.action(); } catch(e) { _adminLog('ERR: '+e.message, '#ff4444'); }
    _adminRender();
  }
}

// ── Inject panel DOM + styles ────────────────────────────────────────────────
function _injectAdminPanel() {
  if (document.getElementById('__adminPanel')) return;

  // ── Font ──────────────────────────────────────────────────────────────────
  if (!document.getElementById('__admFont')) {
    const fl = document.createElement('link');
    fl.id   = '__admFont';
    fl.rel  = 'stylesheet';
    fl.href = 'https://fonts.googleapis.com/css2?family=VT323&family=Share+Tech+Mono&display=swap';
    document.head.appendChild(fl);
  }

  // ── Panel HTML ────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = '__adminPanel';
  panel.innerHTML = `
    <div id="__adm_header">🎵 BEATDLE: ADMIN[1/1]</div>
    <div id="__adm_body">

      <!-- LOGIN GATE -->
      <div id="__adm_login">
        <div class="adm_gate_title">🔐 ADMIN ACCESS</div>
        <div class="adm_gate_sub">Enter password to unlock panel</div>
        <input id="__adm_pw_field" type="password" class="adm_pw_input" placeholder="Admin password..." autocomplete="off" />
        <button class="adm_pw_btn" id="__adm_pw_submit">UNLOCK →</button>
        <div id="__adm_gate_err" class="adm_gate_err"></div>
      </div>

      <!-- MAIN PANEL (hidden until unlocked) -->
      <div id="__adm_main" style="display:none;">
        <div id="__adm_stats">
          <div class="adms"><span class="admsl">ENTRIES</span><span id="__adm_s_entries">—</span></div>
          <div class="adms"><span class="admsl">TOP</span><span id="__adm_s_top">—</span></div>
          <div class="adms"><span class="admsl">AVG</span><span id="__adm_s_avg">—</span></div>
          <div class="adms"><span class="admsl">UNLOCKED</span><span id="__adm_s_lock">YES</span></div>
        </div>
        <div id="__adm_list"></div>
        <div id="__adm_log">► Admin panel ready</div>
      </div>

    </div>
  `;
  document.body.appendChild(panel);

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.id = '__admStyle';
  style.textContent = `
    #__adminPanel {
      position: fixed;
      top: 14px; right: 14px;
      width: 224px;
      background: rgba(10, 6, 2, 0.97);
      border: 1px solid #ff990060;
      border-left: 3px solid #ff9900;
      font-family: 'Share Tech Mono', monospace;
      font-size: 11.5px;
      color: #f5d090;
      z-index: 2147483647;
      box-shadow: 3px 3px 0 #000, 0 0 28px #ff990018;
      user-select: none;
    }
    #__adm_header {
      background: linear-gradient(90deg, #ff990030, #080400);
      color: #ff9900;
      padding: 5px 9px;
      font-family: 'VT323', monospace;
      font-size: 16px;
      letter-spacing: 1px;
      border-bottom: 1px solid #ff990030;
      text-shadow: 0 0 8px #ff990080;
      cursor: move;
    }
    #__adm_body { padding: 4px 0; }

    /* ── Login gate ── */
    #__adm_login {
      padding: 10px 10px 8px;
      text-align: center;
    }
    .adm_gate_title {
      font-family: 'VT323', monospace;
      font-size: 20px;
      color: #ff9900;
      text-shadow: 0 0 10px #ff990066;
      margin-bottom: 3px;
    }
    .adm_gate_sub {
      font-size: 9px;
      color: #99661a;
      margin-bottom: 8px;
      letter-spacing: .4px;
    }
    .adm_pw_input {
      width: 100%;
      background: #1a0e00;
      border: 1px solid #ff990040;
      border-radius: 2px;
      color: #ffcc66;
      font-family: 'Share Tech Mono', monospace;
      font-size: 11px;
      padding: 5px 7px;
      box-sizing: border-box;
      outline: none;
      margin-bottom: 6px;
    }
    .adm_pw_input:focus { border-color: #ff9900; box-shadow: 0 0 6px #ff990030; }
    .adm_pw_btn {
      width: 100%;
      background: #2a1500;
      border: 1px solid #ff9900;
      border-radius: 2px;
      color: #ff9900;
      font-family: 'VT323', monospace;
      font-size: 15px;
      letter-spacing: 1px;
      padding: 4px 0;
      cursor: pointer;
      transition: background .1s;
    }
    .adm_pw_btn:hover { background: #ff990022; }
    .adm_gate_err {
      margin-top: 5px;
      font-size: 9.5px;
      color: #ff4422;
      min-height: 13px;
    }

    /* ── Stats bar ── */
    #__adm_stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 3px;
      padding: 0 5px 4px;
      border-bottom: 1px solid #ff990020;
      margin-bottom: 3px;
    }
    .adms {
      background: #0e0700;
      border: 1px solid #ff990015;
      border-radius: 2px;
      padding: 3px 2px;
      text-align: center;
    }
    .admsl {
      display: block;
      font-size: 7px;
      color: #ff990050;
      letter-spacing: .5px;
    }
    .adms span:last-child { font-size: 10px; color: #ffcc44; }

    /* ── List items ── */
    .admitem {
      padding: 2px 10px 2px 9px;
      color: #c8943a;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
      transition: background .05s;
    }
    .admitem:hover { background: rgba(255,153,0,.1); color: #ffe0aa; }
    .admitem.admsel {
      background: rgba(255,153,0,.2);
      color: #ffcc66;
      border-left: 2px solid #ff9900;
      padding-left: 7px;
    }
    .admitem.adminfo {
      color: #ff990045;
      font-size: 10px;
      padding: 2px 10px;
      pointer-events: none;
      cursor: default;
    }
    .admbadge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 2px;
      margin-left: 5px;
      flex-shrink: 0;
    }
    .admon  { background: #aa5500; color: #fff; }
    .admoff { background: #1a0d00; color: #554422; }
    .admsub { color: #ff9900; font-size: 11px; }

    /* ── Log bar ── */
    #__adm_log {
      border-top: 1px solid #ff990020;
      padding: 3px 9px 2px;
      font-size: 9.5px;
      color: #996622;
      min-height: 15px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .admhint {
      padding: 1px 9px 2px;
      font-size: 8.5px;
      color: #1a0900;
      letter-spacing: .3px;
    }
  `;
  document.head.appendChild(style);

  // ── Password submit ───────────────────────────────────────────────────────
  async function _attemptUnlock() {
    const pw  = document.getElementById('__adm_pw_field').value;
    const err = document.getElementById('__adm_gate_err');
    if (!pw) { err.textContent = 'Enter a password'; return; }

    err.textContent = 'Checking…';

    // Validate by attempting a real admin action (delete a non-existent id)
    // If we get 403 → wrong password; if 404/200/other → correct password
    try {
      const res  = await fetchWithTimeout(`${LEADERBOARD_API_URL}/api/leaderboard/__probe__`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken || '' },
        body:    JSON.stringify({ adminPassword: pw })
      }, 5000);
      const data = await res.json().catch(() => ({}));

      if (res.status === 403 || data.message?.toLowerCase().includes('unauthorized') ||
          data.message?.toLowerCase().includes('invalid') || data.message?.toLowerCase().includes('wrong')) {
        err.textContent = '✗ Wrong password';
        document.getElementById('__adm_pw_field').value = '';
        return;
      }
      // Any other response (404 not found, 200, etc.) = password accepted
    } catch(e) {
      // Network error — still try to unlock (server might be unavailable)
      // Use a local hash check as fallback if needed
    }

    _adminUnlocked = true;
    err.textContent = '';
    _adminRender();
    _adminLog('Admin access granted ✓');
    updateLeaderboardDisplay();
    _updateAdminStats();
  }

  document.getElementById('__adm_pw_submit').addEventListener('click', _attemptUnlock);
  document.getElementById('__adm_pw_field').addEventListener('keydown', e => {
    if (e.key === 'Enter') _attemptUnlock();
  });

  // ── Drag ─────────────────────────────────────────────────────────────────
  let _drag = false, _ox = 0, _oy = 0;
  document.getElementById('__adm_header').addEventListener('mousedown', e => {
    _drag = true;
    _ox = e.clientX - panel.getBoundingClientRect().left;
    _oy = e.clientY - panel.getBoundingClientRect().top;
  });
  document.addEventListener('mousemove', e => {
    if (!_drag) return;
    panel.style.left   = (e.clientX - _ox) + 'px';
    panel.style.top    = (e.clientY - _oy) + 'px';
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => _drag = false);

  // ── Keyboard nav ─────────────────────────────────────────────────────────
  function __admKeys(e) {
    if (!document.getElementById('__adminPanel')) { document.removeEventListener('keydown', __admKeys); return; }
    if (!_adminUnlocked) return;

    const MENUS = _getAdminMenus();
    const menu  = MENUS[_adminMenu];
    function nextIdx(idx, dir) {
      let n = idx, tries = 0;
      do { n = (n + dir + menu.items.length) % menu.items.length; tries++; }
      while (menu.items[n].type === 'info' && tries < menu.items.length);
      return n;
    }

    if      (e.key === 'ArrowUp')   { e.stopPropagation(); _adminCursor = nextIdx(_adminCursor, -1); _adminRender(); }
    else if (e.key === 'ArrowDown') { e.stopPropagation(); _adminCursor = nextIdx(_adminCursor,  1); _adminRender(); }
    else if (e.key === 'Enter')     { e.stopPropagation(); _adminActivate(); }
    else if (e.key === 'Escape' || e.key === 'Backspace') {
      if (_adminStack.length) { _adminMenu = _adminStack.pop(); _adminCursor = 0; _adminRender(); }
    }
    else if (e.key === 'Delete') {
      panel.remove();
      document.getElementById('__admStyle')?.remove();
    }
  }
  document.addEventListener('keydown', __admKeys);

  // ── Initial render ────────────────────────────────────────────────────────
  _adminRender();
  _updateAdminStats();
  console.log('%c🎵 Beatdle Admin Panel loaded — top-right corner','color:#ff9900;font-size:13px;font-weight:bold');
}

// ─── Export ───────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.leaderboardAPI = {
    init:   initLeaderboard,
    load:   loadLeaderboard,
    submit: submitToLeaderboard,
    showPrompt:  showUsernamePrompt,
    hidePrompt:  hideUsernamePrompt,
    toggleAdmin: toggleAdminPanel,
    onAdminPasswordChange,
    adminUnlockName
  };
}

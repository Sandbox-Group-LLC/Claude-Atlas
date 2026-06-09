// Atlas page preload — runs in every browsed page
// Handles text selection → Claude context menu → inline overlay result

const { ipcRenderer } = require('electron');

// ── Selection tracker ──────────────────────────────────────────────────────────
let lastSelection = '';
let overlayEl = null;
let menuEl = null;

document.addEventListener('mouseup', (e) => {
  // Small delay to let selection settle
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();

    // Remove existing menu
    removeMenu();

    if (!text || text.length < 3) return;

    lastSelection = text;

    // Don't show if clicking inside our own overlay
    if (e.target.closest?.('#atlas-overlay') || e.target.closest?.('#atlas-menu')) return;

    // Get selection coords for menu placement
    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();

    showMenu(rect, text);
  }, 50);
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest?.('#atlas-menu') && !e.target.closest?.('#atlas-overlay')) {
    removeMenu();
  }
});

function showMenu(rect, text) {
  menuEl = document.createElement('div');
  menuEl.id = 'atlas-menu';
  menuEl.innerHTML = `
    <div class="atlas-menu-inner">
      <div class="atlas-menu-brand">⚡ Atlas</div>
      <button data-action="rewrite">✏️ Rewrite</button>
      <button data-action="improve">✨ Improve</button>
      <button data-action="explain">💡 Explain</button>
      <button data-action="summarize">📋 Summarize</button>
      <button data-action="reply">💬 Draft Reply</button>
      <button data-action="shorter">↩ Make Shorter</button>
      <button data-action="longer">↪ Make Longer</button>
      <button data-action="tone_pro">👔 Professional</button>
      <button data-action="tone_casual">😎 Casual</button>
    </div>`;

  // Position above/below selection
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  const menuTop = rect.top + scrollY - 8;
  const menuLeft = rect.left + scrollX;

  Object.assign(menuEl.style, {
    position: 'absolute',
    top: `${menuTop}px`,
    left: `${menuLeft}px`,
    zIndex: '2147483647',
    transform: 'translateY(-100%)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });

  // Inject styles
  if (!document.getElementById('atlas-styles')) {
    const style = document.createElement('style');
    style.id = 'atlas-styles';
    style.textContent = `
      #atlas-menu { filter: drop-shadow(0 4px 20px rgba(0,0,0,0.4)); }
      .atlas-menu-inner {
        background: #1a1b26; border: 1px solid rgba(122,162,247,0.3);
        border-radius: 10px; padding: 6px; display: flex;
        flex-wrap: wrap; gap: 4px; max-width: 280px;
      }
      .atlas-menu-brand {
        width: 100%; padding: 4px 6px 6px;
        font-size: 11px; font-weight: 700; color: #7aa2f7;
        letter-spacing: .5px; text-transform: uppercase;
        border-bottom: 1px solid rgba(255,255,255,0.07); margin-bottom: 2px;
      }
      #atlas-menu button {
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px; color: #c0caf5; font-size: 12px; padding: 5px 9px;
        cursor: pointer; transition: .12s; white-space: nowrap;
        font-family: inherit;
      }
      #atlas-menu button:hover { background: rgba(122,162,247,0.2); border-color: rgba(122,162,247,0.4); color: #fff; }
      #atlas-overlay {
        position: fixed; bottom: 20px; right: 20px; width: 360px; max-height: 400px;
        background: #1a1b26; border: 1px solid rgba(122,162,247,0.4);
        border-radius: 12px; z-index: 2147483647; overflow: hidden;
        box-shadow: 0 8px 40px rgba(0,0,0,0.6);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: flex; flex-direction: column;
      }
      #atlas-overlay-head {
        padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.07);
        display: flex; align-items: center; justify-content: space-between;
        font-size: 12px; font-weight: 700; color: #7aa2f7;
        text-transform: uppercase; letter-spacing: .5px;
      }
      #atlas-overlay-close {
        background: none; border: none; color: #565f89; cursor: pointer;
        font-size: 16px; line-height: 1; padding: 0;
      }
      #atlas-overlay-body {
        padding: 12px 14px; font-size: 13px; line-height: 1.65;
        color: #c0caf5; overflow-y: auto; flex: 1; white-space: pre-wrap;
      }
      #atlas-overlay-actions {
        padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.07);
        display: flex; gap: 6px;
      }
      #atlas-overlay-actions button {
        flex: 1; padding: 6px; border-radius: 6px; font-size: 12px;
        cursor: pointer; border: 1px solid rgba(255,255,255,0.1);
        font-family: inherit; transition: .12s;
      }
      .atlas-btn-copy { background: rgba(255,255,255,0.06); color: #c0caf5; }
      .atlas-btn-copy:hover { background: rgba(255,255,255,0.12); }
      .atlas-btn-replace { background: #7aa2f7; color: #1a1b26; border-color: transparent; font-weight: 600; }
      .atlas-btn-replace:hover { opacity: .85; }
      .atlas-cursor { display: inline-block; width: 2px; height: 14px; background: #7aa2f7; animation: blink .8s step-end infinite; vertical-align: text-bottom; margin-left: 1px; }
      @keyframes blink { 50% { opacity: 0; } }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(menuEl);

  // Button click handlers
  menuEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      removeMenu();
      runAtlasAction(action, lastSelection);
    });
  });
}

function removeMenu() {
  menuEl?.remove(); menuEl = null;
}

function removeOverlay() {
  overlayEl?.remove(); overlayEl = null;
}

const ACTION_PROMPTS = {
  rewrite:    (t) => `Rewrite this text. Keep the same meaning but improve clarity and flow. Return ONLY the rewritten text, no explanation:\n\n${t}`,
  improve:    (t) => `Improve this text — fix grammar, clarity, and style. Return ONLY the improved text:\n\n${t}`,
  explain:    (t) => `Explain this in plain language a non-expert would understand:\n\n${t}`,
  summarize:  (t) => `Summarize this concisely in 1-3 sentences:\n\n${t}`,
  reply:      (t) => `Draft a professional reply to this message/email. Return ONLY the reply text:\n\n${t}`,
  shorter:    (t) => `Make this shorter while keeping the key meaning. Return ONLY the shortened text:\n\n${t}`,
  longer:     (t) => `Expand this with more detail and context. Return ONLY the expanded text:\n\n${t}`,
  tone_pro:   (t) => `Rewrite this in a professional tone. Return ONLY the rewritten text:\n\n${t}`,
  tone_casual:(t) => `Rewrite this in a friendly, casual tone. Return ONLY the rewritten text:\n\n${t}`,
};

const ACTION_LABELS = {
  rewrite: 'Rewrite', improve: 'Improve', explain: 'Explain',
  summarize: 'Summarize', reply: 'Draft Reply', shorter: 'Shorter',
  longer: 'Longer', tone_pro: 'Professional', tone_casual: 'Casual',
};

async function runAtlasAction(action, selectedText) {
  // Show overlay with loading state
  removeOverlay();
  overlayEl = document.createElement('div');
  overlayEl.id = 'atlas-overlay';
  const canReplace = ['rewrite','improve','shorter','longer','tone_pro','tone_casual','reply'].includes(action);
  overlayEl.innerHTML = `
    <div id="atlas-overlay-head">
      <span>⚡ ${ACTION_LABELS[action] || action}</span>
      <button id="atlas-overlay-close" onclick="document.getElementById('atlas-overlay')?.remove()">×</button>
    </div>
    <div id="atlas-overlay-body"><span class="atlas-cursor"></span></div>
    <div id="atlas-overlay-actions">
      <button class="atlas-btn-copy" onclick="atlasOverlayCopy()">Copy</button>
      ${canReplace ? '<button class="atlas-btn-replace" onclick="atlasOverlayReplace()">Replace Selection</button>' : ''}
    </div>`;
  document.body.appendChild(overlayEl);

  const prompt = ACTION_PROMPTS[action]?.(selectedText) || `${action}: ${selectedText}`;

  // Send to main process for Claude call
  ipcRenderer.send('atlas-action', { prompt, action, selectedText });
}

// Receive streaming response chunks
ipcRenderer.on('atlas-action-chunk', (_, chunk) => {
  const body = document.getElementById('atlas-overlay-body');
  if (!body) return;
  // Remove cursor, append chunk, re-add cursor
  const cursor = body.querySelector('.atlas-cursor');
  cursor?.remove();
  body.insertAdjacentText('beforeend', chunk);
  const newCursor = document.createElement('span');
  newCursor.className = 'atlas-cursor';
  body.appendChild(newCursor);
  body.scrollTop = body.scrollHeight;
});

ipcRenderer.on('atlas-action-done', (_, result) => {
  const body = document.getElementById('atlas-overlay-body');
  if (!body) return;
  body.querySelector('.atlas-cursor')?.remove();
  // Store final result for copy/replace
  if (overlayEl) overlayEl.dataset.result = result;
});

ipcRenderer.on('atlas-action-error', (_, err) => {
  const body = document.getElementById('atlas-overlay-body');
  if (body) { body.querySelector('.atlas-cursor')?.remove(); body.textContent = '⚠ ' + err; }
});

// Global helpers called by overlay buttons
window.atlasOverlayCopy = () => {
  const result = overlayEl?.dataset.result || document.getElementById('atlas-overlay-body')?.textContent;
  if (result) navigator.clipboard.writeText(result).then(() => {
    const btn = overlayEl?.querySelector('.atlas-btn-copy');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); }
  });
};

window.atlasOverlayReplace = () => {
  const result = overlayEl?.dataset.result;
  if (!result) return;
  ipcRenderer.send('atlas-replace-selection', { text: result });
  removeOverlay();
};

// ─── Payment Autofill ──────────────────────────────────────────────────────
(() => {
  let autofillBtn = null, cardPicker = null;

  function detectPaymentFields() {
    const q = s => document.querySelector(s);
    const numberField =
      q('input[autocomplete="cc-number"]') ||
      q('input[name*="cardnumber" i]') || q('input[name*="card-number" i]') || q('input[name*="card_number" i]') ||
      q('input[id*="cardnumber" i]') || q('input[id*="card-number" i]') || q('input[id*="card_number" i]') ||
      q('input[data-stripe="number"]') ||
      q('input[placeholder*="card number" i]') || q('input[placeholder*="4242" i]');
    if (!numberField) return null;
    const expiryField =
      q('input[autocomplete="cc-exp"]') ||
      q('input[name*="expir" i]') || q('input[name*="cc-exp" i]') ||
      q('input[id*="expir" i]') || q('input[placeholder*="MM" i]');
    const cvvField =
      q('input[autocomplete="cc-csc"]') ||
      q('input[name*="cvv" i]') || q('input[name*="cvc" i]') || q('input[name*="csc" i]') ||
      q('input[id*="cvv" i]') || q('input[id*="cvc" i]') || q('input[id*="security" i]');
    const nameField =
      q('input[autocomplete="cc-name"]') ||
      q('input[name*="cardholder" i]') || q('input[name*="card-name" i]') || q('input[name*="ccname" i]') ||
      q('input[id*="cardholder" i]');
    return { numberField, expiryField, cvvField, nameField };
  }

  function fillField(el, value) {
    if (!el || !value) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function removeAutofillUI() {
    autofillBtn?.remove(); autofillBtn = null;
    cardPicker?.remove(); cardPicker = null;
  }

  function injectAutofillBtn(fields) {
    if (autofillBtn) return;
    const style = document.createElement('style');
    style.id = 'atlas-autofill-styles';
    if (!document.getElementById('atlas-autofill-styles')) {
      style.textContent = `
        #atlas-af-btn { position:absolute; z-index:2147483646; display:flex; align-items:center; gap:4px; padding:3px 8px; background:#1a1b26; border:1px solid rgba(122,162,247,.4); border-radius:5px; color:#7aa2f7; font-size:11px; font-family:-apple-system,sans-serif; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.3); white-space:nowrap; }
        #atlas-af-btn:hover { background:#1e2030; border-color:#7aa2f7; }
        #atlas-card-picker { position:absolute; z-index:2147483647; background:#1a1b26; border:1px solid rgba(122,162,247,.3); border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.4); overflow:hidden; min-width:200px; }
        .atlas-cp-item { display:flex; align-items:center; gap:8px; padding:8px 12px; color:#c0caf5; font-size:12px; font-family:-apple-system,sans-serif; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.05); }
        .atlas-cp-item:last-child { border-bottom:none; }
        .atlas-cp-item:hover { background:rgba(122,162,247,.1); }
        .atlas-cp-last4 { font-family:'SF Mono',monospace; color:#c0caf5; }
        .atlas-cp-label { color:#565f89; }
      `;
      document.head.appendChild(style);
    }

    autofillBtn = document.createElement('div');
    autofillBtn.id = 'atlas-af-btn';
    autofillBtn.textContent = '\uD83D\uDCB3 Autofill';
    document.body.appendChild(autofillBtn);

    // Position near the card number field
    const rect = fields.numberField.getBoundingClientRect();
    autofillBtn.style.top  = (window.scrollY + rect.top + rect.height + 4) + 'px';
    autofillBtn.style.left = (window.scrollX + rect.right - autofillBtn.offsetWidth) + 'px';

    autofillBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (cardPicker) { cardPicker.remove(); cardPicker = null; return; }
      const cards = await ipcRenderer.invoke('vault-get-cards');
      if (!cards.length) { autofillBtn.textContent = 'No saved cards'; setTimeout(() => { autofillBtn.textContent = '\uD83D\uDCB3 Autofill'; }, 2000); return; }
      if (cards.length === 1) { fillCard(cards[0].id, fields); return; }
      showCardPicker(cards, fields);
    });
  }

  function showCardPicker(cards, fields) {
    cardPicker = document.createElement('div');
    cardPicker.id = 'atlas-card-picker';
    const rect = autofillBtn.getBoundingClientRect();
    cardPicker.style.top  = (window.scrollY + rect.bottom + 4) + 'px';
    cardPicker.style.left = (window.scrollX + rect.left) + 'px';
    cards.forEach(c => {
      const item = document.createElement('div');
      item.className = 'atlas-cp-item';
      item.innerHTML = `<span>\uD83D\uDCB3</span> <span class="atlas-cp-last4">•••• ${c.last4}</span> <span class="atlas-cp-label">${c.label}</span>`;
      item.addEventListener('click', (e) => { e.stopPropagation(); fillCard(c.id, fields); });
      cardPicker.appendChild(item);
    });
    document.body.appendChild(cardPicker);
    document.addEventListener('click', () => { cardPicker?.remove(); cardPicker = null; }, { once: true });
  }

  async function fillCard(id, fields) {
    const data = await ipcRenderer.invoke('vault-fill-card', { id });
    if (!data) return;
    fillField(fields.numberField, data.number);
    fillField(fields.expiryField, data.expiry);
    fillField(fields.cvvField,    data.cvv);
    fillField(fields.nameField,   data.name);
    removeAutofillUI();
  }

  // Watch for payment forms appearing
  let checkTimer = null;
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      const fields = detectPaymentFields();
      if (fields && !autofillBtn) injectAutofillBtn(fields);
      else if (!fields) removeAutofillUI();
    }, 2000);
  }

  const observer = new MutationObserver(scheduleCheck);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleCheck();
  });
  // Initial check
  setTimeout(scheduleCheck, 1000);
})();

// ─── Login Autofill ─────────────────────────────────────────────────────────
(() => {
  let loginBtn = null, loginPicker = null, lastKey = '';

  function isVisible(el) { return el && el.offsetParent !== null && el.getClientRects().length > 0; }

  function detectLoginFields() {
    const pws = [...document.querySelectorAll('input[type="password"]')].filter(isVisible);
    // Skip credit-card CVC fields handled by the payment autofiller.
    const pw = pws.find(p => !/csc|cvv|cvc|security/i.test((p.name || '') + (p.id || '') + (p.autocomplete || '')));
    if (!pw) return null;
    const scope = pw.closest('form') || document;
    let user = null;
    const cands = scope.querySelectorAll(
      'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[id*="user" i], input[id*="email" i], input[type="text"]'
    );
    for (const el of cands) { if (el.type !== 'password' && isVisible(el)) { user = el; break; } }
    return { userField: user, pwField: pw };
  }

  function fillField(el, value) {
    if (!el || value == null) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  function removeUI() { loginBtn?.remove(); loginBtn = null; loginPicker?.remove(); loginPicker = null; }

  function ensureStyles() {
    if (document.getElementById('atlas-login-styles')) return;
    const style = document.createElement('style');
    style.id = 'atlas-login-styles';
    style.textContent = `
      #atlas-login-btn { position:absolute; z-index:2147483646; display:flex; align-items:center; gap:4px; padding:3px 8px; background:#1a1b26; border:1px solid rgba(122,162,247,.4); border-radius:5px; color:#7aa2f7; font-size:11px; font-family:-apple-system,sans-serif; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.3); white-space:nowrap; }
      #atlas-login-btn:hover { background:#1e2030; border-color:#7aa2f7; }
      #atlas-login-picker { position:absolute; z-index:2147483647; background:#1a1b26; border:1px solid rgba(122,162,247,.3); border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.4); overflow:hidden; min-width:200px; max-width:320px; }
      .atlas-lp-item { display:flex; align-items:center; gap:8px; padding:8px 12px; color:#c0caf5; font-size:12px; font-family:-apple-system,sans-serif; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.05); }
      .atlas-lp-item:last-child { border-bottom:none; }
      .atlas-lp-item:hover { background:rgba(122,162,247,.1); }
      .atlas-lp-user { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    `;
    document.head.appendChild(style);
  }

  async function injectLoginBtn(fields) {
    if (loginBtn) return;
    const logins = await ipcRenderer.invoke('vault-get-logins-for-host', { host: location.hostname });
    if (!logins || !logins.length) return; // nothing saved for this site
    ensureStyles();
    loginBtn = document.createElement('div');
    loginBtn.id = 'atlas-login-btn';
    loginBtn.textContent = '🔑 Fill login';
    document.body.appendChild(loginBtn);
    const anchor = fields.userField || fields.pwField;
    const rect = anchor.getBoundingClientRect();
    loginBtn.style.top  = (window.scrollY + rect.top + rect.height + 4) + 'px';
    loginBtn.style.left = (window.scrollX + rect.right - loginBtn.offsetWidth) + 'px';
    loginBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (loginPicker) { loginPicker.remove(); loginPicker = null; return; }
      if (logins.length === 1) { fillLogin(logins[0].id, fields); return; }
      showLoginPicker(logins, fields);
    });
  }

  function showLoginPicker(logins, fields) {
    loginPicker = document.createElement('div');
    loginPicker.id = 'atlas-login-picker';
    const rect = loginBtn.getBoundingClientRect();
    loginPicker.style.top  = (window.scrollY + rect.bottom + 4) + 'px';
    loginPicker.style.left = (window.scrollX + rect.left) + 'px';
    logins.forEach(l => {
      const item = document.createElement('div');
      item.className = 'atlas-lp-item';
      item.innerHTML = `<span>🔑</span> <span class="atlas-lp-user"></span>`;
      item.querySelector('.atlas-lp-user').textContent = l.username || l.host;
      item.addEventListener('click', (e) => { e.stopPropagation(); fillLogin(l.id, fields); });
      loginPicker.appendChild(item);
    });
    document.body.appendChild(loginPicker);
    document.addEventListener('click', () => { loginPicker?.remove(); loginPicker = null; }, { once: true });
  }

  async function fillLogin(id, fields) {
    const data = await ipcRenderer.invoke('vault-fill-login', { id });
    if (!data) return;
    fillField(fields.userField, data.username);
    fillField(fields.pwField,   data.password);
    removeUI();
  }

  let checkTimer = null;
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      const fields = detectLoginFields();
      // Re-inject only when the field set changes, so the button doesn't churn.
      const key = fields ? (fields.userField ? '1' : '0') + (fields.pwField ? '1' : '0') + location.hostname : '';
      if (fields && key !== lastKey) { removeUI(); lastKey = key; injectLoginBtn(fields); }
      else if (!fields) { removeUI(); lastKey = ''; }
    }, 1500);
  }

  const observer = new MutationObserver(scheduleCheck);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', () => { observer.observe(document.body, { childList: true, subtree: true }); scheduleCheck(); });
  setTimeout(scheduleCheck, 1000);
})();

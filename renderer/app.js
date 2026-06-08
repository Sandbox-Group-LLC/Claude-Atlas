/* ── State ─────────────────────────────────────────────────────────── */
const state = {
  tabs: {},          // tabId -> { id, url, title, favicon, loading }
  activeTab: null,
  studioOpen: false,
  activeMode: 'chat',
  apiKey: null,
  pageContext: null,  // { url, title, text, links }
  chatHistory: [],    // [{role, content}]
  sessionMemory: '',
  tabCounter: 0,
};

/* ── Helpers ───────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const genTabId = () => `tab-${++state.tabCounter}-${Date.now()}`;

function loadFromStorage() {
  state.apiKey = localStorage.getItem('atlas-api-key') || null;
  state.sessionMemory = localStorage.getItem('atlas-memory') || '';
  if ($('session-memory')) $('session-memory').value = state.sessionMemory;
}

/* ── Tab UI ────────────────────────────────────────────────────────── */
function renderTabList() {
  const list = $('tab-list');
  list.innerHTML = '';
  Object.values(state.tabs).forEach(tab => {
    const el = document.createElement('div');
    el.className = `tab-item${tab.id === state.activeTab ? ' active' : ''}`;
    el.dataset.tabId = tab.id;
    el.title = tab.title || tab.url || 'New Tab';

    if (tab.favicon) {
      el.innerHTML = `<img class="tab-favicon" src="${tab.favicon}" onerror="this.style.display='none';this.nextSibling.style.display='flex'"/>
        <div class="tab-fallback" style="display:none">${(tab.title || 'T')[0]}</div>`;
    } else {
      el.innerHTML = `<div class="tab-fallback">${(tab.title || 'T')[0]}</div>`;
    }

    const closeBtn = document.createElement('div');
    closeBtn.className = 'tab-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(closeBtn);

    el.addEventListener('click', () => activateTab(tab.id));
    list.appendChild(el);
  });
}

function updateToolbarForTab(tab) {
  if (!tab) return;
  $('url-bar').value = tab.url && tab.url !== 'about:blank' ? tab.url : '';
}

/* ── Tab Operations ────────────────────────────────────────────────── */
async function createTab(url) {
  const tabId = genTabId();
  state.tabs[tabId] = { id: tabId, url: url || 'https://www.google.com', title: 'New Tab', favicon: null, loading: false };
  await window.atlas.createTab(tabId, url || 'https://www.google.com');
  await activateTab(tabId);
  renderTabList();
}

async function activateTab(tabId) {
  state.activeTab = tabId;
  await window.atlas.activateTab(tabId, state.studioOpen);
  renderTabList();
  updateToolbarForTab(state.tabs[tabId]);
  // Clear page context when switching tabs
  state.pageContext = null;
  updateContextBadge();
}

async function closeTab(tabId) {
  await window.atlas.closeTab(tabId);
  delete state.tabs[tabId];

  if (state.activeTab === tabId) {
    const remaining = Object.keys(state.tabs);
    if (remaining.length > 0) {
      await activateTab(remaining[remaining.length - 1]);
    } else {
      state.activeTab = null;
      await createTab();
    }
  }
  renderTabList();
}

/* ── Navigation ────────────────────────────────────────────────────── */
async function navigate(url) {
  if (!state.activeTab) return;
  const result = await window.atlas.navigate(state.activeTab, url);
  if (result.success && result.url) {
    $('url-bar').value = result.url;
  }
}

/* ── Studio ────────────────────────────────────────────────────────── */
async function toggleStudio(forceOpen) {
  const shouldOpen = forceOpen !== undefined ? forceOpen : !state.studioOpen;
  state.studioOpen = shouldOpen;

  const studio = $('studio');
  const btn = $('studio-toggle-btn');

  if (shouldOpen) {
    studio.classList.add('studio-open');
    btn.classList.add('studio-active');
  } else {
    studio.classList.remove('studio-open');
    btn.classList.remove('studio-active');
  }

  await window.atlas.toggleStudio(shouldOpen);
  checkApiKey();
}

function checkApiKey() {
  const gate = $('api-key-gate');
  const chatPanel = $('mode-chat');
  const actionsPanel = $('mode-actions');
  const terminalPanel = $('mode-terminal');

  if (!state.apiKey) {
    gate.classList.remove('hidden');
    chatPanel.classList.add('hidden');
    actionsPanel.classList.add('hidden');
    terminalPanel.classList.add('hidden');
  } else {
    gate.classList.add('hidden');
    setMode(state.activeMode);
  }
}

function setMode(mode) {
  state.activeMode = mode;
  document.querySelectorAll('.mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  document.querySelectorAll('.mode-panel').forEach(p => {
    p.classList.add('hidden');
  });
  $(`mode-${mode}`)?.classList.remove('hidden');
}

/* ── Page Context ──────────────────────────────────────────────────── */
async function fetchPageContext() {
  if (!state.activeTab) return null;
  const result = await window.atlas.getPageContent(state.activeTab);
  return result.content || null;
}

function updateContextBadge() {
  const badge = $('context-badge');
  const urlEl = $('context-url');
  const btn = $('inject-page-btn');

  if (state.pageContext) {
    badge.classList.remove('hidden');
    urlEl.textContent = state.pageContext.title || state.pageContext.url;
    btn.classList.add('active');
  } else {
    badge.classList.add('hidden');
    btn.classList.remove('active');
  }
}

/* ── Claude API ────────────────────────────────────────────────────── */
function buildSystemPrompt() {
  let system = `You are Atlas, an intelligent AI browser assistant embedded in a custom Chromium browser. You are concise, sharp, and genuinely helpful. You don't pad responses. You use markdown sparingly and only when it helps.`;

  if (state.sessionMemory) {
    system += `\n\nPersistent memory from the user:\n${state.sessionMemory}`;
  }

  if (state.pageContext) {
    system += `\n\nCurrent page context:
URL: ${state.pageContext.url}
Title: ${state.pageContext.title}

Page content (truncated):
${state.pageContext.text}`;
  }

  return system;
}

async function claudeChat(userMessage) {
  if (!state.apiKey) return null;

  state.chatHistory.push({ role: 'user', content: userMessage });

  const result = await window.atlas.claudeAPI(
    state.apiKey,
    state.chatHistory,
    buildSystemPrompt()
  );

  if (result.error) {
    state.chatHistory.pop();
    return { error: result.error };
  }

  state.chatHistory.push({ role: 'assistant', content: result.content });
  return { content: result.content };
}

async function claudeAction(action) {
  if (!state.apiKey) return null;

  const ctx = await fetchPageContext();
  if (!ctx) return { error: 'Could not read page content. Try a regular web page.' };

  const prompts = {
    summarize: `Summarize this page in 3-4 sentences. Be direct.`,
    'key-points': `List the 5 most important points from this page as tight bullets.`,
    'extract-links': ctx.links?.length
      ? `Here are the links from the page:\n${ctx.links.map(l => `• ${l.text} — ${l.href}`).join('\n')}\n\nHighlight the 10 most interesting or useful ones briefly.`
      : `Extract any notable links or references from this content.`,
    explain: `Explain the main topic of this page clearly, like you're talking to a smart person who knows nothing about this subject.`,
    'find-data': `Extract all statistics, numbers, percentages, dates, and quantitative data from this page. Format as a clean list.`,
    critique: `Critically analyze this page. What's missing? What's weak? What assumptions are made? Be direct.`,
  };

  const contextMessage = `Page: ${ctx.url}\nTitle: ${ctx.title}\n\n${ctx.text}`;
  const userMsg = prompts[action] || 'Summarize this page.';

  const result = await window.atlas.claudeAPI(
    state.apiKey,
    [
      { role: 'user', content: contextMessage },
      { role: 'user', content: userMsg },
    ],
    `You are Atlas, a sharp browser AI. Be direct and concise. No fluff.`
  );

  return result;
}

/* ── Chat UI ───────────────────────────────────────────────────────── */
function appendMessage(role, content, thinking = false) {
  const container = $('chat-messages');
  const div = document.createElement('div');
  div.className = `msg ${role}${thinking ? ' thinking' : ''}`;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'You' : 'Atlas';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = content;

  div.appendChild(label);
  div.appendChild(bubble);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

async function sendChatMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.apiKey) return;

  input.value = '';
  input.style.height = 'auto';

  appendMessage('user', text);
  const thinkingEl = appendMessage('assistant', 'Thinking…', true);
  $('chat-send-btn').disabled = true;

  const result = await claudeChat(text);
  thinkingEl.remove();

  if (result?.error) {
    appendMessage('assistant', `Error: ${result.error}`);
  } else if (result?.content) {
    appendMessage('assistant', result.content);
  }

  $('chat-send-btn').disabled = false;
}

/* ── Terminal ──────────────────────────────────────────────────────── */
function terminalPrint(text, type = 'out') {
  const out = $('terminal-output');
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  line.textContent = text;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

async function terminalExecute(input) {
  const raw = input.trim();
  if (!raw) return;

  terminalPrint(`atlas> ${raw}`, 'cmd');

  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  if (cmd === 'clear') {
    $('terminal-output').innerHTML = '';
    return;
  }

  if (cmd === 'navigate') {
    if (!args) { terminalPrint('Usage: navigate <url>', 'err'); return; }
    await navigate(args);
    terminalPrint(`Navigating to ${args}…`, 'info');
    return;
  }

  if (cmd === 'summarize' || cmd === 'summary') {
    terminalPrint('Fetching page and summarizing…', 'info');
    const result = await claudeAction('summarize');
    if (result?.error) { terminalPrint(`Error: ${result.error}`, 'err'); return; }
    result.content.split('\n').forEach(l => terminalPrint(l));
    return;
  }

  if (cmd === 'extract' && args.toLowerCase().includes('link')) {
    terminalPrint('Extracting links…', 'info');
    const result = await claudeAction('extract-links');
    if (result?.error) { terminalPrint(`Error: ${result.error}`, 'err'); return; }
    result.content.split('\n').forEach(l => terminalPrint(l));
    return;
  }

  if (cmd === 'ask') {
    if (!args) { terminalPrint('Usage: ask <your question>', 'err'); return; }
    terminalPrint('Thinking…', 'info');
    const ctx = await fetchPageContext();
    if (ctx) state.pageContext = ctx;
    const result = await claudeChat(args);
    if (result?.error) { terminalPrint(`Error: ${result.error}`, 'err'); return; }
    result.content.split('\n').forEach(l => terminalPrint(l));
    return;
  }

  if (cmd === 'help') {
    ['navigate <url>', 'summarize', 'extract links', 'ask <question>', 'clear'].forEach(c =>
      terminalPrint(`  ${c}`, 'info')
    );
    return;
  }

  // Unknown: pass to Claude as a natural language command
  terminalPrint('Interpreting as natural language…', 'info');
  const ctx = await fetchPageContext();
  if (ctx) state.pageContext = ctx;
  const result = await claudeChat(raw);
  if (result?.error) { terminalPrint(`Error: ${result.error}`, 'err'); return; }
  result.content.split('\n').forEach(l => terminalPrint(l));
}

/* ── Event Listeners ───────────────────────────────────────────────── */
function bindEvents() {
  // New tab
  $('new-tab-btn').addEventListener('click', () => createTab());

  // URL bar
  $('url-bar').addEventListener('keydown', e => {
    if (e.key === 'Enter') navigate($('url-bar').value);
  });

  // Nav buttons
  $('btn-back').addEventListener('click', () => {
    if (state.activeTab) window.atlas.goBack(state.activeTab);
  });
  $('btn-forward').addEventListener('click', () => {
    if (state.activeTab) window.atlas.goForward(state.activeTab);
  });
  $('btn-reload').addEventListener('click', () => {
    if (state.activeTab) window.atlas.reload(state.activeTab);
  });

  // Studio
  $('studio-toggle-btn').addEventListener('click', () => toggleStudio());
  $('studio-close-btn').addEventListener('click', () => toggleStudio(false));

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.apiKey) setMode(btn.dataset.mode);
    });
  });

  // API key gate
  $('api-key-save-btn').addEventListener('click', () => {
    const key = $('api-key-input').value.trim();
    if (key) {
      state.apiKey = key;
      localStorage.setItem('atlas-api-key', key);
      checkApiKey();
    }
  });

  // Chat
  $('inject-page-btn').addEventListener('click', async () => {
    if (state.pageContext) {
      state.pageContext = null;
      updateContextBadge();
    } else {
      const ctx = await fetchPageContext();
      if (ctx) {
        state.pageContext = ctx;
        updateContextBadge();
      } else {
        appendMessage('assistant', 'Could not read page content. The page may still be loading.');
      }
    }
  });

  $('clear-context-btn').addEventListener('click', () => {
    state.pageContext = null;
    updateContextBadge();
  });

  $('chat-send-btn').addEventListener('click', sendChatMessage);

  $('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  $('chat-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // Actions
  document.querySelectorAll('.action-card').forEach(card => {
    card.addEventListener('click', async () => {
      const action = card.dataset.action;
      const resultEl = $('action-result');
      resultEl.textContent = 'Working…';
      resultEl.classList.remove('hidden');

      const result = await claudeAction(action);
      if (result?.error) {
        resultEl.textContent = `Error: ${result.error}`;
      } else {
        resultEl.textContent = result?.content || 'No result.';
      }
    });
  });

  // Terminal
  $('terminal-input').addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const val = $('terminal-input').value;
      $('terminal-input').value = '';
      await terminalExecute(val);
    }
  });

  // Settings
  $('settings-btn').addEventListener('click', () => {
    $('settings-modal').classList.remove('hidden');
    if (state.apiKey) $('settings-api-key').value = state.apiKey;
  });

  $('settings-modal').addEventListener('click', e => {
    if (e.target.classList.contains('modal-backdrop') || e.target.classList.contains('modal-close')) {
      $('settings-modal').classList.add('hidden');
    }
  });

  $('settings-api-save').addEventListener('click', () => {
    const key = $('settings-api-key').value.trim();
    if (key) {
      state.apiKey = key;
      localStorage.setItem('atlas-api-key', key);
      $('settings-modal').classList.add('hidden');
      checkApiKey();
    }
  });

  $('save-memory-btn').addEventListener('click', () => {
    state.sessionMemory = $('session-memory').value;
    localStorage.setItem('atlas-memory', state.sessionMemory);
    $('settings-modal').classList.add('hidden');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'k') { e.preventDefault(); toggleStudio(); }
    if (mod && e.key === 't') { e.preventDefault(); createTab(); }
    if (mod && e.key === 'w') { e.preventDefault(); if (state.activeTab) closeTab(state.activeTab); }
    if (mod && e.key === 'l') { e.preventDefault(); $('url-bar').focus(); $('url-bar').select(); }
  });

  // Main process events
  window.atlas.on('tab-navigated', ({ tabId, url }) => {
    if (state.tabs[tabId]) {
      state.tabs[tabId].url = url;
      if (tabId === state.activeTab) $('url-bar').value = url;
    }
  });

  window.atlas.on('tab-title-updated', ({ tabId, title }) => {
    if (state.tabs[tabId]) {
      state.tabs[tabId].title = title;
      renderTabList();
    }
  });

  window.atlas.on('tab-favicon-updated', ({ tabId, favicon }) => {
    if (state.tabs[tabId]) {
      state.tabs[tabId].favicon = favicon;
      renderTabList();
    }
  });

  window.atlas.on('tab-loading', ({ tabId, loading }) => {
    if (state.tabs[tabId]) {
      state.tabs[tabId].loading = loading;
    }
    if (tabId === state.activeTab) {
      const spinner = $('loading-spinner');
      spinner.classList.toggle('hidden', !loading);
    }
  });
}

/* ── Init ──────────────────────────────────────────────────────────── */
async function init() {
  loadFromStorage();
  bindEvents();
  await createTab('https://www.google.com');
  checkApiKey();

  terminalPrint('Atlas Terminal ready. Type "help" for commands.', 'info');
}

init();

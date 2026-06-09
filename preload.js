const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atlas', {
  navigate:     (url)            => ipcRenderer.invoke('navigate', url),
  goBack:       ()               => ipcRenderer.invoke('go-back'),
  goForward:    ()               => ipcRenderer.invoke('go-forward'),
  reload:       ()               => ipcRenderer.invoke('reload'),
  newTab:       (url)            => ipcRenderer.invoke('new-tab', url),
  closeTab:     (id)             => ipcRenderer.invoke('close-tab', id),
  activateTab:  (id)             => ipcRenderer.invoke('activate-tab', id),
  reorderTabs:  (ids)            => ipcRenderer.invoke('reorder-tabs', ids),
  toggleStudio: ()               => ipcRenderer.invoke('toggle-studio'),

  chat:         (msgs, key, pid) => ipcRenderer.invoke('chat',       { messages: msgs, apiKey: key, projectId: pid }),
  // Native tool-use streaming chat engine
  chatStream:   (msgs, key, pid) => ipcRenderer.invoke('chat-stream', { messages: msgs, apiKey: key, projectId: pid }),
  chatApprove:  (approvalId, outcome) => ipcRenderer.send('chat-approve', { approvalId, outcome }),
  chatCostContinue: (confirmId, outcome) => ipcRenderer.send('chat-cost-continue', { confirmId, outcome }),
  getUsageTotals:   () => ipcRenderer.invoke('get-usage-totals'),
  onChatEvent:  (cb) => { ipcRenderer.on('chat-event', (_, d) => cb(d)); },
  summarize:    (key, pid)       => ipcRenderer.invoke('summarize',   { apiKey: key, projectId: pid }),
  extract:      (key, pid)       => ipcRenderer.invoke('extract',     { apiKey: key, projectId: pid }),
  explain:      (key, pid)       => ipcRenderer.invoke('explain',     { apiKey: key, projectId: pid }),
  writeEmail:   (key, pid)       => ipcRenderer.invoke('write-email', { apiKey: key, projectId: pid }),

  getSystemStats: ()             => ipcRenderer.invoke('get-system-stats'),

  getWeather:     ()              => ipcRenderer.invoke('get-weather'),
  hideActiveView: ()              => ipcRenderer.invoke('hide-active-view'),
  showActiveView: ()              => ipcRenderer.invoke('show-active-view'),

  vaultGetCards:   ()             => ipcRenderer.invoke('vault-get-cards'),
  vaultAddCard:    (c)            => ipcRenderer.invoke('vault-add-card', c),
  vaultDeleteCard: (id)           => ipcRenderer.invoke('vault-delete-card', { id }),
  vaultFillCard:   (id)           => ipcRenderer.invoke('vault-fill-card', { id }),

  // Login vault (passwords)
  vaultGetLogins:   ()            => ipcRenderer.invoke('vault-get-logins'),
  vaultAddLogin:    (l)           => ipcRenderer.invoke('vault-add-login', l),
  vaultDeleteLogin: (id)          => ipcRenderer.invoke('vault-delete-login', { id }),
  vaultImportCsv:   (csv)         => ipcRenderer.invoke('vault-import-csv', { csv }),

  getDownloads:   ()             => ipcRenderer.invoke('get-downloads'),
  openDownload:   (p)            => ipcRenderer.invoke('open-download', p),
  showInFolder:   (p)            => ipcRenderer.invoke('show-in-folder', p),
  clearDownloads: ()             => ipcRenderer.invoke('clear-downloads'),

  find:     (t, f, n)            => ipcRenderer.invoke('find', { text: t, forward: f, findNext: n }),
  stopFind: ()                   => ipcRenderer.invoke('stop-find'),

  getSettings:  ()               => ipcRenderer.invoke('get-settings'),
  saveSettings: (s)              => ipcRenderer.invoke('save-settings', s),
  getProjects:   ()              => ipcRenderer.invoke('get-projects'),
  saveProject:   (p)             => ipcRenderer.invoke('save-project', p),
  deleteProject: (id)            => ipcRenderer.invoke('delete-project', id),
  getConversations:   ()         => ipcRenderer.invoke('get-conversations'),
  getConversation:    (id)       => ipcRenderer.invoke('get-conversation', id),
  saveConversation:   (c)        => ipcRenderer.invoke('save-conversation', c),
  deleteConversation: (id)       => ipcRenderer.invoke('delete-conversation', id),

  // GitHub
  ghListRepos:   ()                                      => ipcRenderer.invoke('gh-list-repos'),
  ghGetBranches: (owner, repo)                           => ipcRenderer.invoke('gh-get-branches', { owner, repo }),
  ghGetFile:     (owner, repo, filePath, branch)         => ipcRenderer.invoke('gh-get-file',     { owner, repo, filePath, branch }),

  // Render
  renderGetServices:   ()         => ipcRenderer.invoke('render-get-services'),
  renderGetDeploys:    (id)       => ipcRenderer.invoke('render-get-deploys',    { id }),
  renderTriggerDeploy: (id)       => ipcRenderer.invoke('render-trigger-deploy', { id }),

  // Neon / Memory
  neonQuery:     (sql, params)    => ipcRenderer.invoke('neon-query',    { sql, params }),
  memorySearch:  (query, pid)     => ipcRenderer.invoke('memory-search', { query, projectId: pid }),
  memorySave:    (content, pid, source) => ipcRenderer.invoke('memory-save', { content, projectId: pid, source }),
  memoryRecent:  (pid)            => ipcRenderer.invoke('memory-recent', { projectId: pid }),
  memoryDelete:  (id)             => ipcRenderer.invoke('memory-delete', { id }),

  clearGhCache:        ()  => ipcRenderer.invoke('clear-gh-cache'),
  getHistory:          ()  => ipcRenderer.invoke('get-history'),
  clearHistory:        ()  => ipcRenderer.invoke('clear-history'),
  getAvailableTools:   ()  => ipcRenderer.invoke('get-available-tools'),
  openOAuthWindow: (url) => ipcRenderer.invoke('open-oauth-window', url),

  // Google
  bridgeGoogleAuthStart:  ()  => ipcRenderer.invoke('bridge-google-auth-start'),
  bridgeGoogleAuthStatus: ()  => ipcRenderer.invoke('bridge-google-auth-status'),
  bridgeGmailInbox:       (p) => ipcRenderer.invoke('bridge-gmail-inbox',       p),
  bridgeGmailSend:        (p) => ipcRenderer.invoke('bridge-gmail-send',        p),
  bridgeCalendarToday:    ()  => ipcRenderer.invoke('bridge-calendar-today'),
  bridgeCalendarUpcoming: (p) => ipcRenderer.invoke('bridge-calendar-upcoming', p),
  bridgeDriveSearch:      (p) => ipcRenderer.invoke('bridge-drive-search',      p),
  bridgeDriveRead:        (p) => ipcRenderer.invoke('bridge-drive-read',        p),

  // Slack
  bridgeSlackChannels: ()    => ipcRenderer.invoke('bridge-slack-channels'),
  bridgeSlackHistory:  (p)   => ipcRenderer.invoke('bridge-slack-history',  p),
  bridgeSlackSend:     (p)   => ipcRenderer.invoke('bridge-slack-send',     p),
  bridgeSlackSearch:   (p)   => ipcRenderer.invoke('bridge-slack-search',   p),

  // HubSpot
  bridgeHsContacts:    (p)   => ipcRenderer.invoke('bridge-hs-contacts',       p),
  bridgeHsDeals:       (p)   => ipcRenderer.invoke('bridge-hs-deals',          p),
  bridgeHsContactCreate:(p)  => ipcRenderer.invoke('bridge-hs-contact-create', p),
  bridgeHsNoteCreate:  (p)   => ipcRenderer.invoke('bridge-hs-note-create',    p),

  // iMessage
  bridgeIMessageSend:  (p)   => ipcRenderer.invoke('bridge-imessage-send', p),
  bridgeIMessageRead:  (p)   => ipcRenderer.invoke('bridge-imessage-read', p),

  // MCP Bridge — real commits + Render + Neon
  bridgeGhRead:        (p) => ipcRenderer.invoke('bridge-gh-read',          p),
  bridgeGhWrite:       (p) => ipcRenderer.invoke('bridge-gh-write',         p),
  bridgeRenderServices:()  => ipcRenderer.invoke('bridge-render-services'),
  bridgeRenderDeploys: (p) => ipcRenderer.invoke('bridge-render-deploys',   p),
  bridgeRenderDeploy:  (p) => ipcRenderer.invoke('bridge-render-deploy',    p),
  bridgeRenderLogs:    (p) => ipcRenderer.invoke('bridge-render-logs',      p),
  bridgeNeonQuery:     (p) => ipcRenderer.invoke('bridge-neon-query',       p),
  bridgeDebug:        ()  => ipcRenderer.invoke('bridge-debug'),
  bridgeHealth:       ()  => ipcRenderer.invoke('bridge-health'),

  // Events
  onTabCreated:         (cb) => { ipcRenderer.on('tab-created',          (_, d) => cb(d)); },
  onTabUpdated:         (cb) => { ipcRenderer.on('tab-updated',          (_, d) => cb(d)); },
  onTabActivated:       (cb) => { ipcRenderer.on('tab-activated',        (_, d) => cb(d)); },
  onTabClosed:          (cb) => { ipcRenderer.on('tab-closed',           (_, d) => cb(d)); },
  onLoading:            (cb) => { ipcRenderer.on('loading',              (_, v) => cb(v)); },
  onDownloadStarted:    (cb) => { ipcRenderer.on('download-started',     (_, d) => cb(d)); },
  onDownloadUpdated:    (cb) => { ipcRenderer.on('download-updated',     (_, d) => cb(d)); },
  onFindResult:         (cb) => { ipcRenderer.on('find-result',          (_, d) => cb(d)); },
  urlSuggestOpen:      ()  => ipcRenderer.send('url-suggest-open'),
  urlSuggestClose:     ()  => ipcRenderer.send('url-suggest-close'),
  onHistoryInit:        (cb) => { ipcRenderer.on('history-init',    (_, d) => cb(d)); },
  onHistoryUpdated:     (cb) => { ipcRenderer.on('history-updated', (_, d) => cb(d)); },
  onAtlasTextAction:    (cb) => { ipcRenderer.on('atlas-text-action', (_, d) => cb(d)); },
  onToggleFind:         (cb) => { ipcRenderer.on('toggle-find',          ()     => cb()); },
  onFocusUrl:           (cb) => { ipcRenderer.on('focus-url',            ()     => cb()); },
  onToggleDownloads:    (cb) => { ipcRenderer.on('toggle-downloads',     ()     => cb()); },
});

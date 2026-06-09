const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, screen } = require('electron');
const path   = require('path');
// Show as "Atlas" (not generic "Electron") in the menu bar / dock when run in dev.
app.setName('Atlas');
const https  = require('https');
const fs     = require('fs');
const http   = require('http');
const { spawn } = require('child_process');

process.on('uncaughtException', err => {
  const msg = `[${new Date().toISOString()}] ${err.stack || err}\n`;
  fs.appendFileSync(path.join(require('os').homedir(), 'claude-atlas-error.log'), msg);
  console.error(msg);
});

// ─── MCP Bridge ───────────────────────────────────────────────────────────────
let bridgePort = null;
let bridgeProc = null;

function startBridge() {
  const bridgePath = path.join(__dirname, 'mcp-bridge.js');
  // Packaged: fork with ELECTRON_RUN_AS_NODE (process.execPath is the Electron binary, not Node).
  // Dev: spawn with the system Node.
  if (app.isPackaged) {
    bridgeProc = require('child_process').fork(bridgePath, [], {
      env: { ...process.env, ATLAS_SETTINGS_PATH: path.join(app.getPath('userData'), 'settings.json'), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execPath: process.execPath,
    });
  } else {
    // ELECTRON_RUN_AS_NODE: run the Electron binary as plain Node, otherwise it boots a
    // second Electron app (extra dock icon / "two instances") instead of just the bridge.
    bridgeProc = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, ATLAS_SETTINGS_PATH: path.join(app.getPath('userData'), 'settings.json'), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  let stdoutBuf = '';
  bridgeProc.stdout.on('data', data => {
    stdoutBuf += data.toString();
    const match = stdoutBuf.match(/ATLAS_BRIDGE_PORT=(\d+)/);
    if (match && !bridgePort) {
      bridgePort = parseInt(match[1]);
      console.log('[bridge] started on port', bridgePort);
      if (bridgePort !== 3847) {
        console.warn(`[bridge] WARNING: running on fallback port ${bridgePort}, not 3847. ` +
          `Google OAuth will fail because its registered redirect URI uses port 3847. ` +
          `Free up port 3847 and restart to use Google features.`);
      }
    }
  });

  bridgeProc.stderr.on('data', d => console.error('[bridge]', d.toString().trim()));
  bridgeProc.on('exit', code => {
    console.log('[bridge] exited', code);
    bridgePort = null;
    // Auto-restart after 1 second unless app is quitting
    if (!app.isQuitting) setTimeout(() => startBridge(), 1000);
  });
}

function stopBridge() { bridgeProc?.kill('SIGTERM'); }

function bridgeCall(endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (retriesLeft) => {
      if (!bridgePort) {
        if (retriesLeft <= 0) return reject(new Error('MCP bridge not running'));
        return setTimeout(() => attempt(retriesLeft - 1), 500);
      }
      const bstr = JSON.stringify(body);
      const req  = http.request({
        hostname: '127.0.0.1', port: bridgePort, path: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bstr) },
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
      });
      req.on('error', reject);
      req.write(bstr);
      req.end();
    };
    attempt(10); // retry up to 10 times (5 seconds total)
  });
}

app.commandLine.appendSwitch('disable-features', 'SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure');
app.commandLine.appendSwitch('enable-features', 'PartitionedCookies');

// Disable macOS window restoration (prevents double-window on relaunch)
if (process.platform === 'darwin') {
  const { exec } = require('child_process');
  exec(`defaults write com.atlas.browser NSQuitAlwaysKeepsWindows -bool false`);
  exec(`defaults write com.atlas.browser ApplePersistenceIgnoreState -bool true`);
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';
// Studio chat uses the native tool-use agentic engine (ported from ForgeOS "Frank").
const CHAT_MODEL = 'claude-opus-4-8';
const MAX_CHAT_ROUNDS = 20;
const READ_ONLY_CHAT_TOOLS = new Set(['gh_read', 'render_logs', 'neon_query', 'recall_tool_result']);
// Context-cost controls (the lever that prevents multi-round Opus loops from
// re-billing large tool results on every round, and big histories every turn).
const STUB_SIZE = 4000;          // tool results bigger than this are stub candidates
const STUB_AGE  = 2;             // ...once they're this many rounds old (most recent 2 rounds keep full fidelity)
const HISTORY_CHAR_BUDGET = 48000; // ~12k tokens of cross-turn history carried into a new turn
const CHROME_UA    = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const os = require('os');
const crypto = require('crypto');

const NAV_HEIGHT     = 52;
const TABSTRIP_HEIGHT = 36; // horizontal tab strip between the nav bar and the KPI bar
const KPI_HEIGHT     = 34;
const STUDIO_WIDTH   = 420;

let mainWindow, tabs = new Map(), activeTabId = null;
let studioOpen = false, downloads = new Map();

// ─── Storage ──────────────────────────────────────────────────────────────────
const ud = () => app.getPath('userData');
const fp = (...p) => path.join(ud(), ...p);
function rj(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function wj(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 2)); }

const loadSettings   = ()  => rj(fp('settings.json'), { globalSystemPrompt: '', envVars: {}, apiKey: '' });
const saveSettings   = (s) => wj(fp('settings.json'), s);
const loadSavedTabs  = ()  => rj(fp('tabs.json'), []);
const saveTabs       = (t) => wj(fp('tabs.json'), t);

// ─── Cost meter ───────────────────────────────────────────────────────────────
// Per-MTok USD rates. Cache writes bill at 1.25x input, cache reads at 0.1x.
const MODEL_PRICING = {
  'claude-opus-4-8':   { in: 5, out: 25 },
  'claude-opus-4-7':   { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5':  { in: 1, out: 5 },
};
function usageCost(model, u) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-opus-4-8'];
  const M = 1_000_000;
  return ((u.input || 0) / M) * p.in
       + ((u.cacheCreation || 0) / M) * p.in * 1.25
       + ((u.cacheRead || 0) / M) * p.in * 0.1
       + ((u.output || 0) / M) * p.out;
}
const loadUsage = () => rj(fp('usage.json'), []);
function appendUsage(rec) {
  const log = loadUsage();
  log.push(rec);
  if (log.length > 5000) log.splice(0, log.length - 5000); // bound file size
  wj(fp('usage.json'), log);
}
let sessionCost = 0; // resets on app restart
function usageTotals() {
  const log = loadUsage();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let today = 0, all = 0;
  for (const r of log) { all += r.cost || 0; if ((r.ts || 0) >= startOfDay) today += r.cost || 0; }
  return { session: sessionCost, today, all };
}
// Soft caps (USD). Configurable via settings; sensible defaults.
function costCaps() {
  const s = loadSettings();
  const perTurn = s.costCapPerTurn ?? 1.0; // blank/undefined → default
  const perDay  = s.costCapPerDay ?? 20.0;
  return { perTurn: perTurn > 0 ? perTurn : Infinity, perDay: perDay > 0 ? perDay : Infinity }; // 0 → no cap
}
const pendingCostConfirms = new Map(); // confirmId → resolver

// ─── Card Vault ──────────────────────────────────────────────────────────────
let _vaultKey = null;
function getVaultKey() {
  if (_vaultKey) return _vaultKey;
  const material = os.hostname() + os.userInfo().username + 'atlas-vault-salt';
  _vaultKey = crypto.pbkdf2Sync(material, 'atlas-card-vault', 100000, 32, 'sha512');
  return _vaultKey;
}
function encryptCard(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), data: enc.toString('hex') };
}
function decryptCard(enc) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultKey(), Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(enc.data, 'hex')), decipher.final()]).toString('utf8'));
}
function detectNetwork(num) {
  if (num.startsWith('4')) return 'visa';
  if (num.startsWith('5') || num.startsWith('2')) return 'mastercard';
  if (num.startsWith('34') || num.startsWith('37')) return 'amex';
  if (num.startsWith('6')) return 'discover';
  return 'card';
}
const loadProjects   = ()  => rj(fp('projects.json'), []);
const saveProjectList= (p) => wj(fp('projects.json'), p);
const loadConvIndex  = ()  => rj(fp('conversations', 'index.json'), []);
const saveConvIndex  = (i) => wj(fp('conversations', 'index.json'), i);
const loadConv       = (id)=> rj(fp('conversations', `${id}.json`), null);

function persistConv(conv) {
  wj(fp('conversations', `${conv.id}.json`), conv);
  const idx = loadConvIndex();
  const pos = idx.findIndex(c => c.id === conv.id);
  const entry = { id: conv.id, name: conv.name, projectId: conv.projectId || null, updatedAt: conv.updatedAt, messageCount: (conv.messages||[]).length };
  if (pos >= 0) idx[pos] = entry; else idx.push(entry);
  idx.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  saveConvIndex(idx); return idx;
}
function removeConv(id) {
  try { fs.unlinkSync(fp('conversations', `${id}.json`)); } catch {}
  const idx = loadConvIndex().filter(c => c.id !== id);
  saveConvIndex(idx); return idx;
}

// ─── Pg Pool (lazy) ───────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  const url = loadSettings().envVars?.NEON_URL;
  if (!url) return null;
  try {
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 5 });
    _pool.on('error', e => console.error('pg pool:', e.message));
    initMemoryTable().catch(e => console.error('initMemoryTable:', e.message));
    return _pool;
  } catch (e) { console.error('pg init:', e.message); return null; }
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
function ghToken(settings, owner) {
  const env = settings.envVars || {};
  // Try specific per-account keys first, then fall back to generic
  if (owner === 'BrianBMorgan') {
    return env.GITHUB_TOKEN_BRIAN || env.GITHUB_TOKEN_PERSONAL || env.GITHUB_TOKEN;
  }
  return env.GITHUB_TOKEN_SANDBOX || env.GITHUB_TOKEN_ORG || env.GITHUB_TOKEN;
}

function ghReq(method, p, token, body = null) {
  return new Promise((resolve, reject) => {
    const bstr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: p, method,
      headers: {
        'Authorization': `token ${token}`, 'User-Agent': 'Atlas-Browser/1.0',
        'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json',
        ...(bstr ? { 'Content-Length': Buffer.byteLength(bstr) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    if (bstr) req.write(bstr);
    req.end();
  });
}

async function ghGetFile(owner, repo, filePath, branch, token) {
  const r = await ghReq('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`, token).catch(() => null);
  if (!r || r.status !== 200) return null;
  return { content: Buffer.from(r.body.content, 'base64').toString('utf8'), sha: r.body.sha, path: filePath };
}

async function ghListRepos(settings) {
  const out = [];
  const st = settings.envVars?.GITHUB_TOKEN_SANDBOX;
  const bt = settings.envVars?.GITHUB_TOKEN_BRIAN;
  if (st) {
    const r = await ghReq('GET', '/orgs/Sandbox-Group-LLC/repos?per_page=100&sort=updated', st).catch(() => null);
    if (r?.status === 200 && Array.isArray(r.body)) out.push(...r.body.map(x => ({ full_name: x.full_name, owner: 'Sandbox-Group-LLC', private: x.private })));
  }
  if (bt) {
    const r = await ghReq('GET', '/user/repos?per_page=100&affiliation=owner&sort=updated', bt).catch(() => null);
    if (r?.status === 200 && Array.isArray(r.body)) out.push(...r.body.filter(x => x.owner.login === 'BrianBMorgan').map(x => ({ full_name: x.full_name, owner: 'BrianBMorgan', private: x.private })));
  }
  return out;
}

async function ghGetBranches(owner, repo, token) {
  const r = await ghReq('GET', `/repos/${owner}/${repo}/branches?per_page=50`, token).catch(() => null);
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return ['main'];
  return r.body.map(b => b.name);
}

function extractRepoInfo(systemPrompt) {
  if (!systemPrompt) return null;
  const m = systemPrompt.match(/Repo:\s*([^\n]+)/i);
  if (!m) return null;
  const [owner, name] = m[1].trim().split('/');
  if (!owner || !name) return null;
  const dev  = systemPrompt.match(/Development Branch:\s*([^\n]+)/i);
  const prod = systemPrompt.match(/Production Branch:\s*([^\n]+)/i);
  return { owner, name, full: `${owner}/${name}`, devBranch: dev?.[1]?.trim() || 'main', prodBranch: prod?.[1]?.replace(/\/tree\//g,'').trim() || 'production' };
}

// ─── GitHub file cache (in-memory, resets on restart) ────────────────────────
const ghCache = new Map(); // key: `${owner}/${repo}/${path}@${branch}` → { content, sha, fetchedAt }
const GH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function ghGetFileCached(owner, repo, filePath, branch, token) {
  const key = `${owner}/${repo}/${filePath}@${branch}`;
  const cached = ghCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < GH_CACHE_TTL) return cached;
  const result = await ghGetFile(owner, repo, filePath, branch, token).catch(() => null);
  if (result) ghCache.set(key, { ...result, fetchedAt: Date.now() });
  return result;
}
function renderReq(method, p, key, body = null) {
  return new Promise((resolve, reject) => {
    const bstr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.render.com', path: `/v1${p}`, method,
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json', 'Content-Type': 'application/json', ...(bstr ? { 'Content-Length': Buffer.byteLength(bstr) } : {}) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    if (bstr) req.write(bstr);
    req.end();
  });
}

async function getRenderServices(key) {
  const r = await renderReq('GET', '/services?limit=20', key).catch(() => null);
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body.map(item => { const s = item.service; return { id: s.id, name: s.name, type: s.type, suspended: s.suspended, url: s.serviceDetails?.url, branch: s.serviceDetails?.branch }; });
}

async function getRenderDeploys(serviceId, key) {
  const r = await renderReq('GET', `/services/${serviceId}/deploys?limit=3`, key).catch(() => null);
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body.map(i => { const d = i.deploy; return { id: d.id, status: d.status, commit: d.commit?.message, createdAt: d.createdAt, finishedAt: d.finishedAt }; });
}

async function triggerRenderDeploy(serviceId, key) {
  return renderReq('POST', `/services/${serviceId}/deploys`, key, {});
}

// ─── Neon / Memory ────────────────────────────────────────────────────────────
async function initMemoryTable() {
  const pool = getPool(); if (!pool) return;
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS atlas_memories (
    id SERIAL PRIMARY KEY, content TEXT NOT NULL,
    project_id TEXT, source TEXT DEFAULT 'conversation',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(e => console.error('create table:', e.message));
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {});
  await pool.query(`ALTER TABLE atlas_memories ADD COLUMN IF NOT EXISTS embedding vector(1536)`).catch(() => {});
}

async function neonQuery(sql, params = []) {
  const pool = getPool(); if (!pool) throw new Error('No NEON_URL configured');
  const r = await pool.query(sql, params);
  return { rows: r.rows, rowCount: r.rowCount };
}

async function searchMemories(query, projectId, limit = 5) {
  const pool = getPool(); if (!pool) return [];
  try {
    const params = [`%${query.slice(0, 200)}%`];
    let sql = `SELECT id, content, project_id, source, created_at FROM atlas_memories WHERE content ILIKE $1`;
    if (projectId) { params.push(projectId); sql += ` AND (project_id = $${params.length} OR project_id IS NULL)`; }
    sql += ` ORDER BY created_at DESC LIMIT ${limit}`;
    return (await pool.query(sql, params)).rows;
  } catch { return []; }
}

async function saveMemory(content, projectId, source = 'conversation') {
  const pool = getPool(); if (!pool) return;
  await pool.query('INSERT INTO atlas_memories (content, project_id, source) VALUES ($1, $2, $3)', [content, projectId || null, source]).catch(e => console.error('saveMemory:', e.message));
}

async function getRecentMemories(projectId, limit = 10) {
  const pool = getPool(); if (!pool) return [];
  try {
    const params = projectId ? [projectId, limit] : [limit];
    const where = projectId ? 'WHERE project_id = $1' : '';
    const lim = projectId ? '$2' : '$1';
    return (await pool.query(`SELECT id, content, project_id, source, created_at FROM atlas_memories ${where} ORDER BY created_at DESC LIMIT ${lim}`, params)).rows;
  } catch { return []; }
}

// ─── System prompt builder (async) ────────────────────────────────────────────
// ─── Tool availability helpers ────────────────────────────────────────────────
function toolConfigured(id, env) {
  switch (id) {
    case 'github':   return !!(env.GITHUB_TOKEN_SANDBOX || env.GITHUB_TOKEN_BRIAN || env.GITHUB_TOKEN);
    case 'slack':    return !!env.SLACK_TOKEN;
    case 'gmail':
    case 'calendar':
    case 'drive':    return !!env.GOOGLE_REFRESH_TOKEN;
    case 'hubspot':  return !!env.HUBSPOT_SECRET_TOKEN;
    case 'render':   return !!env.RENDER_API_KEY;
    case 'neon':     return !!env.NEON_URL;
    case 'imessage': return true;
    case 'memory':   return !!env.NEON_URL;
    default:         return false;
  }
}

const ALL_TOOLS = ['github','slack','gmail','calendar','drive','hubspot','render','neon','imessage','memory'];

function getAvailableTools(project, env) {
  const projectTools = project?.tools || null; // null = all enabled
  return ALL_TOOLS.filter(id => {
    const enabled = projectTools === null ? true : (projectTools || []).includes(id);
    return enabled && toolConfigured(id, env);
  });
}

function buildActionInstructions(tools) {
  const blocks = [];

  blocks.push(`You have access to the following tools via Atlas. To use a tool, output an action block in your response. Atlas will intercept it, show the user an approval card, and execute it on approval. Never mention tokens, credentials, or APIs directly.\n\nWhen outputting an action or commit block: keep the explanation before it to 1-2 SHORT sentences MAX. Do NOT echo or describe code in chat text — put ALL code inside commit blocks only. You have a token limit so be concise when committing.\n\nWhen the user asks for a plan, analysis, or explanation (no action block needed): respond fully and in detail — there is no brevity constraint for planning and discussion.\n\nActive tools: ${tools.join(', ')}\n`);

  if (tools.includes('github')) blocks.push(
    'GitHub — read any file (use when you need to see file content before editing):\n```action\ntype: gh_read\nowner: OWNER\nrepo: REPO\nbranch: BRANCH\npath: src/path/to/file.tsx\n```\n\nGitHub — commit a targeted change (use for small, surgical edits):\n```commit\nowner: OWNER\nrepo: REPO\nbranch: BRANCH\npath: path/to/file.tsx\nmessage: conventional commit message\nfind: exact lines to find\nreplace: new lines to replace them with\n```\n\nGitHub — full file rewrite (use for large changes, new files, or when find/replace is impractical):\n```commit\nowner: OWNER\nrepo: REPO\nbranch: BRANCH\npath: path/to/file.tsx\nmessage: conventional commit message\ncontent:\nentire file content here\n```\n\nRules for commits:\n- NEVER print code in chat — ALWAYS use a commit block (find/replace or content:)\n- Use find/replace for small targeted edits (a few lines)\n- Use content: for large changes, broken files, or new files — write the COMPLETE file\n- Make one commit per logical change\n- find string must be unique enough to locate exactly one place in the file\n- Atlas auto-continues after each approved commit so just keep going\n- If a find/replace commit fails, retry using content: with the full file instead'
  );
  if (tools.includes('slack')) blocks.push(
    'Slack — send a message:\n```action\ntype: slack_send\nchannel: #channel-name or CXXXXXXX\ntext: message content here\n```'
  );
  if (tools.includes('gmail')) blocks.push(
    'Gmail — send an email:\n```action\ntype: gmail_send\nto: email@example.com\nsubject: Subject line\nbody: Full email body here\n```'
  );
  if (tools.includes('hubspot')) blocks.push(
    'HubSpot — log a note on a contact:\n```action\ntype: hs_note\ncontactId: CONTACT_ID\nnote: Note content here\n```\nHubSpot — create a contact:\n```action\ntype: hs_contact\nemail: email@example.com\nfirstname: First\nlastname: Last\ncompany: Company Name\n```'
  );
  if (tools.includes('render')) blocks.push(
    'Render — trigger a deploy:\n```action\ntype: render_deploy\nserviceId: srv-XXXXXXXX\nserviceName: Service Display Name\n```\nRender — fetch build logs (use after a deploy fails to see the actual error):\n```action\ntype: render_logs\nserviceId: srv-XXXXXXXX\nserviceName: Service Display Name\n```\nWhen a deploy fails, ALWAYS fetch the build logs before attempting a fix. The logs show the exact error — never guess.'
  );
  if (tools.includes('imessage')) blocks.push(
    'iMessage — send a message:\n```action\ntype: imessage_send\nto: +15035551234 or email\nmessage: Message content here\n```'
  );
  if (tools.includes('neon')) blocks.push(
    'Neon DB — run a read query (SELECT only — write queries require explicit approval):\n```action\ntype: neon_query\nsql: SELECT * FROM table_name LIMIT 10\n```'
  );

  blocks.push('Rules:\n- Only output ONE action block per response\n- Keep explanations to 1-2 sentences — NEVER echo code in chat text\n- Put the action/commit block immediately after your brief explanation\n- Never fabricate data you don\'t have — if you need to look something up first, ask\n- Action blocks are stripped from the chat display — the user sees only the explanation + approval card\n- If your response might be long, SKIP the explanation entirely and just output the action block');

  return blocks.join('\n\n');
}

async function buildSystemPrompt(projectId, page, lastUserMessage = '', nativeTools = false) {
  const settings = loadSettings();
  const project = loadProjects().find(p => p.id === projectId);
  const env = settings.envVars || {};
  const parts = [];

  if (settings.globalSystemPrompt?.trim()) parts.push(settings.globalSystemPrompt.trim());

  const envEntries = Object.entries(env).filter(([k]) => k.trim());
  if (envEntries.length) parts.push('The following environment variables are silently available to you. Use them when relevant but never repeat or expose them in your responses:\n' + envEntries.map(([k, v]) => `${k}=${v}`).join('\n'));

  if (project?.systemPrompt?.trim()) parts.push(`Project (${project.name}):\n${project.systemPrompt.trim()}`);

  // Inject per-project Neon URL if set
  if (project?.neonUrl?.trim()) {
    parts.push(`This project's Neon database connection: ${project.neonUrl.trim()}\nWhen running neon_query actions for this project, use this connection.`);
  }

  // Get available tools for this project
  const availableTools = getAvailableTools(project, env);

  // Auto-inject GitHub context (if github tool enabled)
  if (availableTools.includes('github') && project?.systemPrompt) {
    const repo = extractRepoInfo(project.systemPrompt);
    if (repo) {
      const token = ghToken(settings, repo.owner);
      if (token) {
        const ghParts = [
          `--- GitHub: ${repo.full} ---`,
          `CRITICAL INSTRUCTION: Atlas has already fetched all files listed below. The SHAs are real and current. You have everything you need to read and write without making any API calls. web_fetch and all other fetch methods are blocked in this environment and will fail. Do not attempt them. Do not ask to fetch files. Just work from the content below.`
        ];

        ghParts.push(`\n## Branch: ${repo.devBranch} (development)`);
        const devReadme = await ghGetFileCached(repo.owner, repo.name, 'README.md', repo.devBranch, token).catch(() => null);
        if (devReadme) ghParts.push(`README.md (sha:${devReadme.sha}):\n${devReadme.content.slice(0, 50000)}`);
        else ghParts.push(`README.md: [not found]`);
        for (const wb of ['WHITEBOARD.md', 'WHITEPAPER.md', 'docs/WHITEBOARD.md']) {
          const f = await ghGetFileCached(repo.owner, repo.name, wb, repo.devBranch, token).catch(() => null);
          if (f) { ghParts.push(`${wb} (sha:${f.sha}):\n${f.content.slice(0, 50000)}`); break; }
          else ghParts.push(`${wb}: [not found]`);
        }

        if (repo.prodBranch !== repo.devBranch) {
          ghParts.push(`\n## Branch: ${repo.prodBranch} (production)`);
          const prodReadme = await ghGetFileCached(repo.owner, repo.name, 'README.md', repo.prodBranch, token).catch(() => null);
          if (prodReadme) ghParts.push(`README.md (sha:${prodReadme.sha}):\n${prodReadme.content.slice(0, 50000)}`);
          else ghParts.push(`README.md: [not found]`);
          for (const wb of ['WHITEBOARD.md', 'WHITEPAPER.md', 'docs/WHITEBOARD.md']) {
            const f = await ghGetFileCached(repo.owner, repo.name, wb, repo.prodBranch, token).catch(() => null);
            if (f) { ghParts.push(`${wb} (sha:${f.sha}):\n${f.content.slice(0, 50000)}`); break; }
          }
        }

        ghParts.push('\n--- End GitHub ---');
        parts.push(ghParts.join('\n'));
      } else {
        parts.push(`--- GitHub: ${repo.full} ---\n[No token configured for ${repo.owner} — cannot read repo]\n--- End GitHub ---`);
      }
    }
  }

  // Inject today's calendar (if calendar tool enabled)
  if (availableTools.includes('calendar')) {
    try {
      const r = await bridgeCall('/calendar/today');
      if (r.events?.length) {
        parts.push(`Today's calendar:\n${r.events.map(e => `- ${e.summary} at ${new Date(e.start).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`).join('\n')}`);
      }
    } catch {}
  }

  // Inject Slack mentions (if slack tool enabled)
  if (availableTools.includes('slack')) {
    try {
      const r = await bridgeCall('/slack/search', { query: 'is:mention', count: 5 });
      if (r.matches?.length) {
        parts.push(`Recent Slack mentions:\n${r.matches.map(m => `- #${m.channel} from ${m.user}: ${m.text?.slice(0,200)}`).join('\n')}`);
      }
    } catch {}
  }

  // Inject HubSpot deals (if hubspot tool enabled)
  if (availableTools.includes('hubspot')) {
    try {
      const r = await bridgeCall('/hs/deals/search', { limit: 5 });
      if (r.deals?.length) {
        parts.push(`Recent HubSpot deals:\n${r.deals.map(d => `- ${d.dealname}: ${d.dealstage} (${d.amount ? '$'+d.amount : 'no amount'})`).join('\n')}`);
      }
    } catch {}
  }

  // Inject memories (if memory tool enabled)
  if (availableTools.includes('memory')) {
    const q = lastUserMessage || page.title || '';
    if (q.trim()) {
      const memories = await searchMemories(q, projectId).catch(() => []);
      if (memories.length) parts.push('Relevant memories:\n' + memories.map(m => `- ${m.content}`).join('\n'));
    }
  }

  // Core system prompt + tool capabilities
  const corePrompt = `You are Claude, embedded in Atlas browser.\nCurrent page — Title: ${page.title}\nURL: ${page.url}\n\nContent:\n${page.body}\n\nBe concise and direct.\n\nCRITICAL: If any GitHub files above say "[fetch failed]" or "[not found]", you do NOT have that content. Never fabricate file contents, session logs, commit history, or API responses. If you can't verify something, say so plainly.`;

  // Native tool use (Frank-style engine): the model calls real tools, so skip the
  // legacy ```action/```commit prompt scaffolding and give a short capability note.
  const toolInstructions = nativeTools
    ? (availableTools.length
        ? `\n\n---\n\nYou have native tools available: ${availableTools.join(', ')}. Call them directly via tool use — do NOT paste fenced action/commit blocks. Atlas shows the user an approval card before any write or side-effecting action (commits, sends, deploys); read-only tools (gh_read, render_logs, neon_query) run automatically. Always gh_read a file before you gh_commit to it so you have the current content and SHA. Never print code in chat — make the change with gh_commit instead. Keep chat replies concise; do the detailed work through tools.\n\nContext cost: large tool results (e.g. big file reads) are kept full for the most recent couple of rounds, then replaced with a "[Stubbed to save context …]" marker. That is expected — call recall_tool_result with the given call_id only if you genuinely need the bytes back. Conversation history across turns keeps only your text, not raw tool output — so summarize the key facts you learned in your reply (e.g. "githubHeaders is on line 1190"); that cheap summary survives where the raw 47KB read does not.`
        : '')
    : (availableTools.length > 0 ? `\n\n---\n\n${buildActionInstructions(availableTools)}` : '');

  parts.push(corePrompt + toolInstructions);
  return parts.join('\n\n---\n\n');
}

// ─── Bounds ───────────────────────────────────────────────────────────────────
// Push tab down when URL suggest is open so dropdown isn't covered
ipcMain.on('url-suggest-open', () => {
  if (!tabs.has(activeTabId)) return;
  const [w, h] = mainWindow.getContentSize();
  const sw = studioOpen ? STUDIO_WIDTH : 0;
  const topY = NAV_HEIGHT + TABSTRIP_HEIGHT + KPI_HEIGHT + 300; // push down by suggest height
  tabs.get(activeTabId).view.setBounds({ x: 0, y: topY, width: Math.max(w - sw, 100), height: Math.max(h - topY, 100) });
});
ipcMain.on('url-suggest-close', () => {
  if (tabs.has(activeTabId)) tabs.get(activeTabId).view.setBounds(getTabBounds());
});

function getTabBounds() {
  const [w, h] = mainWindow.getContentSize();
  const sw = studioOpen ? STUDIO_WIDTH : 0;
  const topY = NAV_HEIGHT + TABSTRIP_HEIGHT + KPI_HEIGHT;
  return { x: 0, y: topY, width: Math.max(w - sw, 100), height: Math.max(h - topY, 100) };
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
// ─── Tab history tracking ──────────────────────────────────────────────────────
const historyFilePath = fp('history.json');
const tabHistory = new Map(
  (rj(historyFilePath, [])).map(h => [h.url, h])
);

function trackVisit(url, title) {
  if (!url || url.startsWith('about:') || url === 'about:blank') return;
  const entry = { url, title: title || url, lastVisitTime: Date.now() };
  tabHistory.set(url, entry);
  // Persist — debounced to avoid hammering disk on rapid navigation
  clearTimeout(trackVisit._timer);
  trackVisit._timer = setTimeout(() => {
    wj(historyFilePath, Array.from(tabHistory.values()).sort((a,b) => b.lastVisitTime - a.lastVisitTime).slice(0, 2000));
  }, 1000);
  // Sync to renderer for URL autocomplete
  mainWindow?.webContents.send('history-updated', entry);
}

let _tabIdCounter = 0;
function createTab(url = 'https://www.google.com') {
  const ses  = session.fromPartition('persist:atlas');
  const pagePreloadPath = path.join(__dirname, 'page-preload.js');
  console.log('[tab] page-preload path:', pagePreloadPath, 'exists:', require('fs').existsSync(pagePreloadPath));
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, session: ses, preload: pagePreloadPath } });
  view.setBackgroundColor('#ffffff');
  view.webContents.setUserAgent(CHROME_UA);
  const id = Date.now() + (++_tabIdCounter);
  tabs.set(id, { view, title: 'New Tab', url });
  mainWindow.contentView.addChildView(view);
  view.setBounds(getTabBounds());
  view.webContents.loadURL(url);
  trackVisit(url, url); // track immediately, title updates later
  view.webContents.on('page-title-updated', (_, t) => { if (tabs.has(id)) { tabs.get(id).title = t; mainWindow.webContents.send('tab-updated', { id, title: t }); if (tabs.get(id).url) trackVisit(tabs.get(id).url, t); } });
  // Real favicon from the page (more reliable than guessing from the hostname).
  view.webContents.on('page-favicon-updated', (_, favs) => { if (tabs.has(id) && favs && favs[0]) { tabs.get(id).favicon = favs[0]; mainWindow.webContents.send('tab-updated', { id, favicon: favs[0] }); } });
  // nav flag lets the renderer refresh the favicon only on a real page load, not on
  // every in-page (hash/pushState) navigation — that churn was the "haywire" bug.
  const ns = (u, nav) => { if (tabs.has(id)) { tabs.get(id).url = u; mainWindow.webContents.send('tab-updated', { id, url: u, nav }); trackVisit(u, tabs.get(id).title); } };
  view.webContents.on('did-navigate',         (_, u) => ns(u, 'full'));
  view.webContents.on('did-navigate-in-page', (_, u) => ns(u, 'inpage'));
  view.webContents.on('did-start-loading', () => { if (activeTabId === id) mainWindow.webContents.send('loading', true); });
  view.webContents.on('did-stop-loading',  () => { if (activeTabId === id) mainWindow.webContents.send('loading', false); });
  view.webContents.on('context-menu', (_, params) => {
    const selectedText = params.selectionText?.trim();
    if (!selectedText) return;

    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();

    menu.append(new MenuItem({ label: '⚡ Atlas', enabled: false }));
    menu.append(new MenuItem({ type: 'separator' }));

    const actions = [
      { label: '✏️  Rewrite',         action: 'rewrite' },
      { label: '✨  Improve',          action: 'improve' },
      { label: '💡  Explain',          action: 'explain' },
      { label: '📋  Summarize',        action: 'summarize' },
      { label: '💬  Draft Reply',      action: 'reply' },
      { label: '↩  Make Shorter',     action: 'shorter' },
      { label: '↪  Make Longer',      action: 'longer' },
      { label: '👔  Professional',     action: 'tone_pro' },
      { label: '😎  Casual',           action: 'tone_casual' },
    ];

    actions.forEach(({ label, action }) => {
      menu.append(new MenuItem({
        label,
        click: () => {
          const prompts = {
            rewrite:     `Rewrite this text. Keep the same meaning but improve clarity and flow. Return ONLY the rewritten text, no explanation:\n\n${selectedText}`,
            improve:     `Improve this text — fix grammar, clarity, and style. Return ONLY the improved text:\n\n${selectedText}`,
            explain:     `Explain this in plain language a non-expert would understand:\n\n${selectedText}`,
            summarize:   `Summarize this concisely in 1-3 sentences:\n\n${selectedText}`,
            reply:       `Draft a professional reply to this. Return ONLY the reply text:\n\n${selectedText}`,
            shorter:     `Make this shorter while keeping the key meaning. Return ONLY the shortened text:\n\n${selectedText}`,
            longer:      `Expand this with more detail and context. Return ONLY the expanded text:\n\n${selectedText}`,
            tone_pro:    `Rewrite this in a professional tone. Return ONLY the rewritten text:\n\n${selectedText}`,
            tone_casual: `Rewrite this in a friendly, casual tone. Return ONLY the rewritten text:\n\n${selectedText}`,
          };
          // Send to main window studio panel
          mainWindow.webContents.send('atlas-text-action', {
            action,
            selectedText,
            prompt: prompts[action],
          });
          // Also open studio if closed
          if (!studioOpen) {
            studioOpen = true;
            mainWindow.webContents.send('force-open-studio', { mode: 'chat' });
            if (tabs.has(activeTabId)) tabs.get(activeTabId).view.setBounds(getTabBounds());
          }
        }
      }));
    });

    menu.popup({ window: mainWindow });
  });

  view.webContents.setWindowOpenHandler(({ url: u }) => { createTab(u); return { action: 'deny' }; });
  setActiveTab(id);
  mainWindow.webContents.send('tab-created', { id, title: 'New Tab', url });
  return id;
}

function setActiveTab(id) {
  if (!tabs.has(id)) return;
  tabs.forEach((t, tid) => { if (tid !== id) t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); });
  const tab = tabs.get(id);
  tab.view.setBounds(getTabBounds());
  activeTabId = id;
  mainWindow.webContents.send('tab-activated', { id, url: tab.url, title: tab.title });
}

function closeTab(id) {
  if (!tabs.has(id)) return;
  const tab = tabs.get(id);
  mainWindow.contentView.removeChildView(tab.view);
  tab.view.webContents.destroy();
  tabs.delete(id);
  mainWindow.webContents.send('tab-closed', { id });
  if (tabs.size === 0) createTab();
  else if (activeTabId === id) { const k = [...tabs.keys()]; setActiveTab(k[k.length - 1]); }
}

// ─── Page content ─────────────────────────────────────────────────────────────
async function getPageContent() {
  if (!tabs.has(activeTabId)) return { title: '', url: '', body: '' };
  try {
    return JSON.parse(await tabs.get(activeTabId).view.webContents.executeJavaScript(`
      JSON.stringify({ title: document.title, url: window.location.href, body: (() => {
        for (const s of ['main','article','[role="main"]','#content','.content']) { const el = document.querySelector(s); if (el) return el.innerText.slice(0,15000); }
        return document.body.innerText.slice(0,15000);
      })() })`));
  } catch { return { title: '', url: '', body: '' }; }
}

// ─── Claude ───────────────────────────────────────────────────────────────────
function callClaude(system, messages, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 16000, system, messages });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { const p = JSON.parse(data); if (p.error) reject(new Error(p.error.message)); else resolve(p.content[0].text); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ─── Atlas text actions (right-click → Claude overlay) ───────────────────────
ipcMain.on('atlas-action', async (event, { prompt, action, selectedText }) => {
  const settings = loadSettings();
  const apiKey = settings.apiKey || settings.envVars?.ANTHROPIC_API_KEY || settings.envVars?.CLAUDE_API_KEY || '';
  if (!apiKey) { event.sender.send('atlas-action-error', 'No API key configured'); return; }

  const https = require('https');
  const body  = JSON.stringify({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  });

  const req = https.request({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    },
  }, res => {
    let fullText = '';
    let buffer = '';
    res.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const text = parsed.delta?.text || '';
          if (text) {
            fullText += text;
            if (!event.sender.isDestroyed()) event.sender.send('atlas-action-chunk', text);
          }
        } catch {}
      }
    });
    res.on('end', () => {
      if (!event.sender.isDestroyed()) event.sender.send('atlas-action-done', fullText);
    });
  });
  req.on('error', e => { if (!event.sender.isDestroyed()) event.sender.send('atlas-action-error', e.message); });
  req.write(body);
  req.end();
});

// Replace selection in active tab
ipcMain.on('atlas-replace-selection', (event, { text }) => {
  if (!tabs.has(activeTabId)) return;
  tabs.get(activeTabId).view.webContents.executeJavaScript(`
    (function() {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(${JSON.stringify(text)}));
      sel.removeAllRanges();
    })()
  `).catch(() => {});
});

// ─── Menu ─────────────────────────────────────────────────────────────────────
function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: 'Atlas', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'New Tab',   accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabId) },
    ]},
    { label: 'Edit', submenu: [
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: () => mainWindow.webContents.send('toggle-find') },
    ]},
    { label: 'View', submenu: [
      { label: 'Focus URL Bar', accelerator: 'CmdOrCtrl+L', click: () => mainWindow.webContents.send('focus-url') },
      { label: 'Reload',        accelerator: 'CmdOrCtrl+R', click: () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.reload() },
      { type: 'separator' },
      { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: () => { if (tabs.has(activeTabId)) { const w = tabs.get(activeTabId).view.webContents; w.setZoomLevel(w.getZoomLevel()+0.5); } } },
      { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: () => { if (tabs.has(activeTabId)) { const w = tabs.get(activeTabId).view.webContents; w.setZoomLevel(w.getZoomLevel()-0.5); } } },
      { label: 'Actual Size',accelerator: 'CmdOrCtrl+0', click: () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.setZoomLevel(0) },
      { type: 'separator' },
      { label: 'Downloads',     accelerator: 'CmdOrCtrl+J', click: () => mainWindow.webContents.send('toggle-downloads') },
      { label: 'Developer Tools',accelerator: 'CmdOrCtrl+Alt+I', click: () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.openDevTools() },
    ]},
    { label: 'History', submenu: [
      { label: 'Back',    accelerator: 'CmdOrCtrl+[', click: () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.goBack() },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.goForward() },
    ]},
  ]));
}

// ─── Window ───────────────────────────────────────────────────────────────────
let _windowReady = false;
function createWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  try {
    const preloadPath = path.join(__dirname, 'preload.js');

    mainWindow = new BrowserWindow({
      width: 1440, height: 900, minWidth: 900, minHeight: 600,
      titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 },
      backgroundColor: '#16171f',
      show: false, // Don't show until fully ready — prevents flash
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: preloadPath },
    });

    mainWindow.once('ready-to-show', () => { mainWindow.show(); _windowReady = true; });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    // Recalculate view bounds on resize, move, and display changes
    const recalcBounds = () => { if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).view.setBounds(getTabBounds()); };
    mainWindow.on('resize', recalcBounds);
    mainWindow.on('moved',  recalcBounds);
    screen.on('display-removed',        recalcBounds);
    screen.on('display-added',          recalcBounds);
    screen.on('display-metrics-changed', recalcBounds);

    let initialTabCreated = false;
    mainWindow.webContents.on('dom-ready', () => {
      if (!initialTabCreated) {
        initialTabCreated = true;
        // Restore previous session tabs, fall back to Google
        const saved = loadSavedTabs();
        if (saved.length) {
          saved.forEach(t => createTab(t.url));
        } else {
          createTab('https://google.com');
        }
        // Send full history to renderer for URL autocomplete
        const allHistory = Array.from(tabHistory.values()).sort((a,b) => b.lastVisitTime - a.lastVisitTime);
        mainWindow.webContents.send('history-init', allHistory);
      }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
  } catch(e) {
    console.error('[main] createWindow error:', e.message, e.stack);
  }
}

// OAuth window — keep module-level reference so it doesn't get GC'd
let oauthWin = null;
ipcMain.handle('open-oauth-window', (_, url) => {
  console.log('[oauth] opening window with URL:', url.slice(0, 80) + '...');
  try { if (oauthWin && !oauthWin.isDestroyed()) oauthWin.close(); } catch {}

  oauthWin = new BrowserWindow({
    width: 520, height: 700, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    title: 'Connect Google', autoHideMenuBar: true,
  });

  oauthWin.loadURL(url);
  oauthWin.show();
  oauthWin.focus();

  // Match by pathname, not host:port — the bridge may run on a fallback port (see startBridge),
  // and the redirect URI is built from the bridge's actual port.
  const isCallback = (u) => { try { return new URL(u).pathname === '/oauth/google/callback'; } catch { return false; } };

  oauthWin.webContents.on('did-navigate', (_, navUrl) => {
    console.log('[oauth] navigated to:', navUrl.slice(0, 100));
    if (isCallback(navUrl)) {
      setTimeout(() => { try { oauthWin?.close(); oauthWin = null; } catch {} }, 3000);
    }
  });

  oauthWin.webContents.on('will-redirect', (_, navUrl) => {
    console.log('[oauth] redirect to:', navUrl.slice(0, 100));
    if (isCallback(navUrl)) oauthWin.loadURL(navUrl);
  });

  oauthWin.on('closed', () => { oauthWin = null; });
  return { ok: true };
});

// Google
ipcMain.handle('bridge-google-auth-start',  ()     => bridgeCall('/google/auth/start'));
ipcMain.handle('bridge-google-auth-status', ()     => bridgeCall('/google/auth/status'));
ipcMain.handle('bridge-gmail-inbox',        (_, p) => bridgeCall('/gmail/inbox',       p));
ipcMain.handle('bridge-gmail-send',         (_, p) => bridgeCall('/gmail/send',         p));
ipcMain.handle('bridge-calendar-today',     ()     => bridgeCall('/calendar/today'));
ipcMain.handle('bridge-calendar-upcoming',  (_, p) => bridgeCall('/calendar/upcoming',  p));
ipcMain.handle('bridge-drive-search',       (_, p) => bridgeCall('/drive/search',       p));
ipcMain.handle('bridge-drive-read',         (_, p) => bridgeCall('/drive/read',         p));

// Slack
ipcMain.handle('bridge-slack-channels', ()     => bridgeCall('/slack/channels'));
ipcMain.handle('bridge-slack-history',  (_, p) => bridgeCall('/slack/history', p));
ipcMain.handle('bridge-slack-send',     (_, p) => bridgeCall('/slack/send',    p));
ipcMain.handle('bridge-slack-search',   (_, p) => bridgeCall('/slack/search',  p));

// HubSpot
ipcMain.handle('bridge-hs-contacts',    (_, p) => bridgeCall('/hs/contacts/search', p));
ipcMain.handle('bridge-hs-deals',       (_, p) => bridgeCall('/hs/deals/search',    p));
ipcMain.handle('bridge-hs-contact-create', (_, p) => bridgeCall('/hs/contact/create', p));
ipcMain.handle('bridge-hs-note-create', (_, p) => bridgeCall('/hs/note/create',    p));

// iMessage
ipcMain.handle('bridge-imessage-send',  (_, p) => bridgeCall('/imessage/send', p));
ipcMain.handle('bridge-imessage-read',  (_, p) => bridgeCall('/imessage/read', p));

// Bridge IPC — GitHub write (real commits)
ipcMain.handle('bridge-gh-read',  (_, p) => bridgeCall('/gh/read',  p));
ipcMain.handle('bridge-gh-write', (_, p) => bridgeCall('/gh/write', p));

// Bridge IPC — Render
ipcMain.handle('bridge-render-services', ()    => bridgeCall('/render/services'));
ipcMain.handle('bridge-render-deploys',  (_, p) => bridgeCall('/render/deploys', p));
ipcMain.handle('bridge-render-deploy',   (_, p) => bridgeCall('/render/deploy',  p));
ipcMain.handle('bridge-render-logs',     (_, p) => bridgeCall('/render/logs',    p));

// Bridge IPC — Neon via bridge (uses bridge's pool)
ipcMain.handle('bridge-neon-query', (_, p) => bridgeCall('/neon/query', p)); // p may include neonUrl override

// Bridge health
ipcMain.handle('bridge-debug', () => bridgeCall('/debug'));
ipcMain.handle('bridge-health', () => bridgePort ? bridgeCall('/health') : { ok: false, error: 'Bridge not running' });

// ─── IPC ──────────────────────────────────────────────────────────────────────
// Nav
ipcMain.handle('navigate', async (_, url) => {
  if (!tabs.has(activeTabId)) return;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = (u.includes('.') && !u.includes(' ')) ? `https://${u}` : `https://www.google.com/search?q=${encodeURIComponent(u)}`;
  tabs.get(activeTabId).view.webContents.loadURL(u);
});
ipcMain.handle('go-back',    () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.goBack());
ipcMain.handle('go-forward', () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.goForward());
ipcMain.handle('reload',     () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.reload());
ipcMain.handle('new-tab',       (_, url) => createTab(url || 'https://google.com'));
ipcMain.handle('close-tab',     (_, id)  => closeTab(id));
ipcMain.handle('activate-tab',  (_, id)  => setActiveTab(id));
// Reorder: rebuild the tabs Map in the renderer's new visual order so it persists
// (the saved-tabs order on quit follows Map insertion order).
ipcMain.handle('reorder-tabs',  (_, ids) => {
  const reordered = new Map();
  (ids || []).forEach(id => { if (tabs.has(id)) reordered.set(id, tabs.get(id)); });
  tabs.forEach((v, k) => { if (!reordered.has(k)) reordered.set(k, v); }); // keep any not listed
  tabs = reordered;
});
ipcMain.handle('toggle-studio', () => { studioOpen = !studioOpen; if (tabs.has(activeTabId)) tabs.get(activeTabId).view.setBounds(getTabBounds()); return studioOpen; });

// System stats for KPI bar
let prevCpuIdle = 0, prevCpuTotal = 0;
ipcMain.handle('get-system-stats', () => {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  cpus.forEach(c => { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle; });
  const idleDelta = idle - prevCpuIdle;
  const totalDelta = total - prevCpuTotal;
  prevCpuIdle = idle; prevCpuTotal = total;
  const cpuPercent = totalDelta > 0 ? Math.round(100 - (idleDelta / totalDelta * 100)) : 0;
  const memPercent = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  return { cpuPercent, memPercent };
});

// Weather — fetch via main process (renderer fetch can hit CORS issues)
ipcMain.handle('get-weather', () => {
  return new Promise(resolve => {
    http.get('http://ip-api.com/json/', res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const geo = JSON.parse(data);
          if (geo.status !== 'success') { resolve(null); return; }
          const lat = geo.lat, lon = geo.lon, city = geo.city || '';
          https.get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&temperature_unit=fahrenheit`, wxRes => {
            let wxData = '';
            wxRes.on('data', c => wxData += c);
            wxRes.on('end', () => {
              try {
                const wx = JSON.parse(wxData);
                const temp = Math.round(wx.current_weather.temperature);
                const code = wx.current_weather.weathercode;
                resolve({ temp, code, city });
              } catch { resolve(null); }
            });
          }).on('error', () => resolve(null));
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
});

// View visibility (for modals that need to appear above the WebContentsView)
ipcMain.handle('hide-active-view', () => { if (tabs.has(activeTabId)) tabs.get(activeTabId).view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); });
ipcMain.handle('show-active-view', () => { if (tabs.has(activeTabId)) tabs.get(activeTabId).view.setBounds(getTabBounds()); });

// Card vault
ipcMain.handle('vault-get-cards', () => {
  const cards = loadSettings().savedCards || [];
  return cards.map(c => ({ id: c.id, label: c.label, last4: c.last4, network: c.network }));
});
ipcMain.handle('vault-add-card', (_, { number, expiry, cvv, name, label }) => {
  const num = number.replace(/\s/g, '');
  const s = loadSettings();
  if (!s.savedCards) s.savedCards = [];
  s.savedCards.push({
    id: Date.now().toString(),
    label: label || detectNetwork(num).toUpperCase(),
    last4: num.slice(-4),
    network: detectNetwork(num),
    encrypted: encryptCard({ number: num, expiry, cvv, name }),
  });
  saveSettings(s);
  return s.savedCards.map(c => ({ id: c.id, label: c.label, last4: c.last4, network: c.network }));
});
ipcMain.handle('vault-delete-card', (_, { id }) => {
  const s = loadSettings();
  s.savedCards = (s.savedCards || []).filter(c => c.id !== id);
  saveSettings(s);
  return s.savedCards.map(c => ({ id: c.id, label: c.label, last4: c.last4, network: c.network }));
});
ipcMain.handle('vault-fill-card', (_, { id }) => {
  const cards = loadSettings().savedCards || [];
  const card = cards.find(c => c.id === id);
  if (!card) return null;
  const data = decryptCard(card.encrypted);
  return { ...data, label: card.label, network: card.network };
});

// Downloads
ipcMain.handle('get-downloads',   ()     => [...downloads.values()]);
ipcMain.handle('open-download',   (_, p) => shell.openPath(p));
ipcMain.handle('show-in-folder',  (_, p) => shell.showItemInFolder(p));
ipcMain.handle('clear-downloads', ()     => { downloads.clear(); return []; });

// Find
ipcMain.handle('find', (_, { text, forward = true, findNext = false }) => {
  if (!tabs.has(activeTabId)) return;
  if (!text) { tabs.get(activeTabId).view.webContents.stopFindInPage('clearSelection'); return; }
  tabs.get(activeTabId).view.webContents.findInPage(text, { forward, findNext });
});
ipcMain.handle('stop-find', () => tabs.has(activeTabId) && tabs.get(activeTabId).view.webContents.stopFindInPage('clearSelection'));

// Settings / Projects / Convs
ipcMain.handle('get-settings',   ()     => loadSettings());
ipcMain.handle('save-settings',  (_, s) => { saveSettings(s); _pool = null; return s; }); // reset pool on settings change
ipcMain.handle('get-projects',   ()     => loadProjects());
ipcMain.handle('get-history', () => {
  return Array.from(tabHistory.values())
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
    .slice(0, 500);
});

ipcMain.handle('clear-history', () => {
  tabHistory.clear();
  wj(historyFilePath, []);
  return true;
});

ipcMain.handle('clear-gh-cache', () => { ghCache.clear(); return true; });
ipcMain.handle('get-available-tools', () => {
  const settings = loadSettings();
  const env = settings.envVars || {};
  return ALL_TOOLS.map(id => ({ id, configured: toolConfigured(id, env) }));
});

ipcMain.handle('save-project',   (_, p) => { const list = loadProjects(); const i = list.findIndex(x => x.id === p.id); if (i >= 0) list[i] = p; else list.push(p); saveProjectList(list); return list; });
ipcMain.handle('delete-project', (_, id)=> { const list = loadProjects().filter(p => p.id !== id); saveProjectList(list); return list; });
ipcMain.handle('get-conversations',   ()      => loadConvIndex());
ipcMain.handle('get-conversation',    (_, id) => loadConv(id));
ipcMain.handle('save-conversation',   (_, c)  => persistConv(c));
ipcMain.handle('delete-conversation', (_, id) => removeConv(id));

// GitHub
ipcMain.handle('gh-list-repos',   async ()                                     => ghListRepos(loadSettings()));
ipcMain.handle('gh-get-branches', async (_, { owner, repo })                   => ghGetBranches(owner, repo, ghToken(loadSettings(), owner)));
ipcMain.handle('gh-get-file',     async (_, { owner, repo, filePath, branch }) => {
  const t = ghToken(loadSettings(), owner); if (!t) throw new Error('No token for ' + owner);
  return ghGetFileCached(owner, repo, filePath, branch, t);
});

// Render
ipcMain.handle('render-get-services',    async ()               => { const k = loadSettings().envVars?.RENDER_API_KEY; if (!k) throw new Error('No RENDER_API_KEY'); return getRenderServices(k); });
ipcMain.handle('render-get-deploys',     async (_, { id })      => { const k = loadSettings().envVars?.RENDER_API_KEY; if (!k) throw new Error('No RENDER_API_KEY'); return getRenderDeploys(id, k); });
ipcMain.handle('render-trigger-deploy',  async (_, { id })      => { const k = loadSettings().envVars?.RENDER_API_KEY; if (!k) throw new Error('No RENDER_API_KEY'); const r = await triggerRenderDeploy(id, k); return { status: r.status }; });

// Neon / Memory
ipcMain.handle('neon-query',     async (_, { sql, params })             => neonQuery(sql, params || []));
ipcMain.handle('memory-search',  async (_, { query, projectId })        => searchMemories(query, projectId));
ipcMain.handle('memory-save',    async (_, { content, projectId, source }) => saveMemory(content, projectId, source));
ipcMain.handle('memory-recent',  async (_, { projectId })               => getRecentMemories(projectId));
ipcMain.handle('memory-delete',  async (_, { id })                      => { const pool = getPool(); if (pool) await pool.query('DELETE FROM atlas_memories WHERE id=$1', [id]).catch(()=>{}); });

// Claude
ipcMain.handle('chat', async (_, { messages, apiKey, projectId }) => {
  const page = await getPageContent();
  const lastMsg = messages[messages.length - 1]?.content || '';
  const system = await buildSystemPrompt(projectId, page, lastMsg);
  const response = await callClaude(system, messages, apiKey);
  // Auto-save memory (fire and forget)
  if (messages.length >= 2 && response) {
    const mem = `Q: ${lastMsg.slice(0, 300)}\nA: ${response.slice(0, 500)}`;
    saveMemory(mem, projectId, 'conversation').catch(() => {});
  }
  return response;
});

// ─── Studio chat: native tool-use agentic engine (ported from ForgeOS "Frank") ──
// Streams text + tool activity to the renderer over the 'chat-event' channel and
// runs a real tool_use/tool_result loop instead of regex-scraping fenced blocks.

function buildChatTools(availableTools) {
  const tools = [];
  if (availableTools.includes('github')) {
    tools.push({
      name: 'gh_read',
      description: 'Read a file from a GitHub repo. Always read a file before committing to it so you have its current content and SHA. Returns the file content prefixed with its SHA.',
      input_schema: { type: 'object', properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string', description: 'path within the repo, e.g. src/app.js' },
        branch: { type: 'string', description: 'branch name (defaults to main)' },
      }, required: ['owner', 'repo', 'path'] },
    });
    tools.push({
      name: 'gh_commit',
      description: 'Commit a change to a file in a GitHub repo. Provide find+replace for a targeted edit, or content for a full-file rewrite/new file. gh_read the file first. The user approves before it lands.',
      input_schema: { type: 'object', properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' },
        branch: { type: 'string', description: 'branch (defaults to main)' },
        message: { type: 'string', description: 'commit message' },
        find: { type: 'string', description: 'exact text to find (targeted edit)' },
        replace: { type: 'string', description: 'replacement text for find' },
        content: { type: 'string', description: 'complete new file content (large changes / new files)' },
      }, required: ['owner', 'repo', 'path', 'message'] },
    });
  }
  if (availableTools.includes('slack')) tools.push({
    name: 'slack_send', description: 'Send a Slack message to a channel.',
    input_schema: { type: 'object', properties: { channel: { type: 'string', description: '#channel-name or a channel ID' }, text: { type: 'string' } }, required: ['channel', 'text'] },
  });
  if (availableTools.includes('gmail')) tools.push({
    name: 'gmail_send', description: 'Send an email via the connected Gmail account.',
    input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
  });
  if (availableTools.includes('hubspot')) {
    tools.push({ name: 'hs_note', description: 'Log a note on a HubSpot contact.', input_schema: { type: 'object', properties: { contactId: { type: 'string' }, note: { type: 'string' } }, required: ['contactId', 'note'] } });
    tools.push({ name: 'hs_contact', description: 'Create a HubSpot contact.', input_schema: { type: 'object', properties: { email: { type: 'string' }, firstname: { type: 'string' }, lastname: { type: 'string' }, company: { type: 'string' } }, required: ['email'] } });
  }
  if (availableTools.includes('render')) {
    tools.push({ name: 'render_deploy', description: 'Trigger a Render deploy for a service.', input_schema: { type: 'object', properties: { serviceId: { type: 'string' }, serviceName: { type: 'string' } }, required: ['serviceId'] } });
    tools.push({ name: 'render_logs', description: 'Fetch Render build logs for a service/deploy. Use after a failed deploy to read the real error before fixing.', input_schema: { type: 'object', properties: { serviceId: { type: 'string' }, deployId: { type: 'string' }, serviceName: { type: 'string' } }, required: ['serviceId'] } });
  }
  if (availableTools.includes('imessage')) tools.push({
    name: 'imessage_send', description: 'Send an iMessage.',
    input_schema: { type: 'object', properties: { to: { type: 'string', description: 'phone number or email' }, message: { type: 'string' } }, required: ['to', 'message'] },
  });
  if (availableTools.includes('neon')) tools.push({
    name: 'neon_query', description: 'Run a SQL query against the project\'s Neon Postgres database. SELECT only unless the user explicitly asks for a write.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
  });
  // Always available: pull back a tool result that was stubbed to save context.
  if (tools.length) tools.push({
    name: 'recall_tool_result',
    description: 'Pull back the full content of an earlier tool result that was stubbed to save context. When you see "[Stubbed to save context — … call_id=\"toolu_…\"]", call this with that call_id to retrieve the original content. Only call it if you actually need the bytes; otherwise leave the stub alone. Works only within the current turn.',
    input_schema: { type: 'object', properties: { call_id: { type: 'string', description: 'the tool_use_id from the stub, e.g. toolu_01…' } }, required: ['call_id'] },
  });
  return tools;
}

async function executeChatTool(name, input, projectId) {
  switch (name) {
    case 'gh_read': {
      const file = await bridgeCall('/gh/read', { owner: input.owner, repo: input.repo, path: input.path, branch: input.branch || 'main' });
      if (file.error) throw new Error(file.error);
      return `File: ${input.path} (sha:${file.sha})\n\n${file.content}`;
    }
    case 'gh_commit': {
      const file = await bridgeCall('/gh/read', { owner: input.owner, repo: input.repo, path: input.path, branch: input.branch || 'main' });
      if (file.error) throw new Error(file.error);
      const fileContent = (file.content || '').replace(/\r\n/g, '\n');
      let newContent = fileContent;
      if (input.content) {
        newContent = input.content.replace(/\r\n/g, '\n');
      } else if (input.find && input.replace !== undefined) {
        const find = input.find.replace(/\r\n/g, '\n');
        const repl = input.replace.replace(/\r\n/g, '\n');
        if (fileContent.includes(find)) {
          newContent = fileContent.replace(find, repl);
        } else {
          // Fuzzy fallback: match ignoring trailing whitespace per line
          const fileLines = fileContent.split('\n');
          const findLines = find.split('\n').map(l => l.trimEnd());
          let startIdx = -1;
          for (let i = 0; i <= fileLines.length - findLines.length; i++) {
            let match = true;
            for (let j = 0; j < findLines.length; j++) {
              if (fileLines[i + j].trimEnd() !== findLines[j]) { match = false; break; }
            }
            if (match) { startIdx = i; break; }
          }
          if (startIdx >= 0) {
            const before = fileLines.slice(0, startIdx);
            const after = fileLines.slice(startIdx + findLines.length);
            newContent = [...before, ...repl.split('\n'), ...after].join('\n');
          } else {
            throw new Error(`Could not find "${find.slice(0, 80)}…" in ${input.path} — the file may have changed since it was read. Re-read it and retry.`);
          }
        }
      } else {
        throw new Error('gh_commit needs either content (full rewrite) or find+replace (targeted edit).');
      }
      const r = await bridgeCall('/gh/write', { owner: input.owner, repo: input.repo, path: input.path, content: newContent, sha: file.sha, message: input.message, branch: input.branch || 'main' });
      if (!r.ok) throw new Error(r.error || 'commit failed');
      return `Committed ${input.path} — ${(r.sha || '').slice(0, 7)}`;
    }
    case 'slack_send': {
      let channel = input.channel;
      if (channel && channel.startsWith('#')) {
        const chans = await bridgeCall('/slack/channels');
        const found = chans.channels?.find(c => c.name === channel.slice(1));
        if (found) channel = found.id;
      }
      const r = await bridgeCall('/slack/send', { channel, text: input.text });
      if (r.error) throw new Error(r.error);
      return `Sent to ${input.channel}`;
    }
    case 'gmail_send': {
      const r = await bridgeCall('/gmail/send', { to: input.to, subject: input.subject, body: input.body });
      if (r.error) throw new Error(r.error);
      return `Email sent to ${input.to}`;
    }
    case 'hs_note': {
      const r = await bridgeCall('/hs/note/create', { contactId: input.contactId, note: input.note });
      if (r.error) throw new Error(r.error);
      return `Note logged on contact ${input.contactId}`;
    }
    case 'hs_contact': {
      const r = await bridgeCall('/hs/contact/create', { email: input.email, firstname: input.firstname, lastname: input.lastname, company: input.company });
      if (r.error) throw new Error(r.error);
      return `Contact created: ${input.email}`;
    }
    case 'render_deploy': {
      const r = await bridgeCall('/render/deploy', { serviceId: input.serviceId });
      if (!r.ok) throw new Error(r.error || 'deploy failed');
      return `Deploy triggered — ${r.deployId}`;
    }
    case 'render_logs': {
      const r = await bridgeCall('/render/logs', { serviceId: input.serviceId, deployId: input.deployId });
      if (r.error) throw new Error(r.error);
      const logText = r.logs || (r.events ? r.events.map(e => `[${e.type}] ${e.details || JSON.stringify(e)}`).join('\n') : 'No logs available');
      return `Build logs for deploy ${r.deployId || ''}${r.note ? ' (' + r.note + ')' : ''}:\n${logText.slice(-8000)}`;
    }
    case 'imessage_send': {
      await bridgeCall('/imessage/send', { recipient: input.to, message: input.message });
      return `iMessage sent to ${input.to}`;
    }
    case 'neon_query': {
      const proj = loadProjects().find(p => p.id === projectId);
      const neonUrl = proj?.neonUrl || undefined;
      const sql = String(input.sql || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
      const r = await bridgeCall('/neon/query', { sql, ...(neonUrl ? { neonUrl } : {}) });
      if (r.error) throw new Error(r.error);
      return `${r.rowCount} row(s):\n${JSON.stringify(r.rows?.slice(0, 20), null, 2)}`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const pendingChatApprovals = new Map(); // approvalId → resolver
ipcMain.on('chat-approve', (_, { approvalId, outcome }) => {
  const resolve = pendingChatApprovals.get(approvalId);
  if (resolve) { pendingChatApprovals.delete(approvalId); resolve(outcome); }
});
ipcMain.on('chat-cost-continue', (_, { confirmId, outcome }) => {
  const resolve = pendingCostConfirms.get(confirmId);
  if (resolve) { pendingCostConfirms.delete(confirmId); resolve(outcome); }
});
ipcMain.handle('get-usage-totals', () => usageTotals());

ipcMain.handle('chat-stream', async (event, { messages, apiKey, projectId }) => {
  const settings = loadSettings();
  const key = apiKey || settings.apiKey || settings.envVars?.ANTHROPIC_API_KEY || settings.envVars?.CLAUDE_API_KEY || '';
  if (!key) return { ok: false, error: 'No API key configured' };
  const send = (m) => { try { if (!event.sender.isDestroyed()) event.sender.send('chat-event', m); } catch {} };

  try {
    const page = await getPageContent().catch(() => ({ title: '', url: '', body: '' }));
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const systemPrompt = await buildSystemPrompt(projectId, page, lastUser, true);
    const project = loadProjects().find(p => p.id === projectId);
    const availableTools = getAvailableTools(project, settings.envVars || {});
    const tools = buildChatTools(availableTools);

    const Anthropic = require('@anthropic-ai/sdk');
    const Client = Anthropic.default || Anthropic;
    const client = new Client({ apiKey: key });

    // Cross-turn cost control: cap the carried history by characters (keeping the
    // most recent messages), so a long conversation of large assistant texts isn't
    // re-sent in full on every round of every future turn.
    const trimmed = [];
    let acc = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const len = String(messages[i].content).length;
      if (acc + len > HISTORY_CHAR_BUDGET && trimmed.length) break;
      trimmed.unshift({ role: messages[i].role, content: String(messages[i].content) });
      acc += len;
    }
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();

    // conv is the canonical full history for this turn; tool_use/tool_result blocks
    // are appended as the loop runs and never persisted beyond it.
    const conv = trimmed;
    let finalText = '';
    let autoApprove = false;

    // Within-turn cost control: cache each tool result; stub stale large ones when
    // rebuilding the outgoing messages so Opus doesn't re-bill a 47KB read every round.
    const toolResultCache = new Map(); // tool_use_id → { round, content, toolName, policy }
    const buildOutgoing = (currentRound) => conv.map(msg => {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
      if (!msg.content.some(b => b && b.type === 'tool_result')) return msg;
      return { role: 'user', content: msg.content.map(block => {
        if (!block || block.type !== 'tool_result') return block;
        const cached = toolResultCache.get(block.tool_use_id);
        if (!cached || cached.policy === 'never') return block;
        if (cached.content.length <= STUB_SIZE) return block;
        if (currentRound - cached.round < STUB_AGE) return block;
        return { type: 'tool_result', tool_use_id: block.tool_use_id,
          content: `[Stubbed to save context — ${cached.toolName} returned ${cached.content.length} chars. Call recall_tool_result with call_id="${block.tool_use_id}" if you need it back.]` };
      }) };
    });

    const callCounts = new Map(); // loop detection: name+input → consecutive count
    let aborted = false;

    // Cost meter: accumulate this turn's token usage and dollar cost across rounds.
    const turnUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    let turnCost = 0, capAcked = false;
    const caps = costCaps();

    for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
      // Prompt caching: breakpoint on the system prompt and the last tool def, so
      // every round after the first reads the stable prefix at ~10% input cost.
      const cachedSystem = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
      const cachedTools = tools.map((t, i) => i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t);

      let stream;
      try {
        stream = await client.messages.stream({
          model: CHAT_MODEL, max_tokens: 16000,
          system: cachedSystem, tools: cachedTools, messages: buildOutgoing(round),
        });
      } catch (e) {
        send({ type: 'error', error: e.message });
        return { ok: false, error: e.message };
      }

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          send({ type: 'chunk', text: ev.delta.text });
        }
      }
      const finalMsg = await stream.finalMessage();
      conv.push({ role: 'assistant', content: finalMsg.content });

      // Cost meter: fold this round's usage into the turn and tick the live meter.
      const u = finalMsg.usage || {};
      turnUsage.input += u.input_tokens || 0;
      turnUsage.output += u.output_tokens || 0;
      turnUsage.cacheCreation += u.cache_creation_input_tokens || 0;
      turnUsage.cacheRead += u.cache_read_input_tokens || 0;
      turnCost = usageCost(CHAT_MODEL, turnUsage);
      {
        const t = usageTotals();
        send({ type: 'usage', turnCost, tokens: { ...turnUsage }, session: t.session + turnCost, today: t.today + turnCost, all: t.all + turnCost });
      }

      const assistantText = finalMsg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const toolBlocks = finalMsg.content.filter(b => b.type === 'tool_use');

      if (toolBlocks.length === 0) { finalText = assistantText; break; }
      send({ type: 'round_break' }); // assistant paused to call tools; start a fresh bubble next round

      // Soft spend cap: pause for confirmation when this turn or today's total crosses a threshold.
      if (!capAcked) {
        const dayProjected = usageTotals().today + turnCost;
        if (turnCost >= caps.perTurn || dayProjected >= caps.perDay) {
          const confirmId = `cost-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          send({ type: 'cost_warn', confirmId, turnCost, dayProjected, caps });
          const outcome = await new Promise(res => pendingCostConfirms.set(confirmId, res));
          if (outcome !== 'continue') {
            finalText = assistantText || finalText;
            aborted = true;
            send({ type: 'tool_status', content: 'Stopped at spend cap.' });
            break;
          }
          capAcked = true;
        }
      }

      const toolResults = [];
      for (const tu of toolBlocks) {
        send({ type: 'tool_start', tool: tu.name, input: tu.input });

        // Loop detection: auto-stop if the exact same call repeats 3×.
        const callKey = tu.name + ':' + JSON.stringify(tu.input || {});
        const n = (callCounts.get(callKey) || 0) + 1;
        callCounts.set(callKey, n);
        if (n >= 3) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true,
            content: 'ABORTED: this exact tool call has run 3 times. Stop retrying — tell the user what is stuck and what you need from them.' });
          send({ type: 'tool_error', tool: tu.name, error: 'repeated 3× — auto-stopped' });
          aborted = true;
          finalText = assistantText || finalText;
          continue;
        }

        const needsApproval = !READ_ONLY_CHAT_TOOLS.has(tu.name) && !autoApprove;
        if (needsApproval) {
          const approvalId = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          send({ type: 'approval', approvalId, tool: tu.name, input: tu.input });
          const outcome = await new Promise(res => { pendingChatApprovals.set(approvalId, res); });
          if (outcome === 'approve_all') {
            autoApprove = true;
          } else if (outcome !== 'approved') {
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'User cancelled this action.' });
            send({ type: 'tool_done', tool: tu.name, result: 'Cancelled', cancelled: true });
            continue;
          }
        }

        try {
          let result, policy = 'normal';
          if (tu.name === 'recall_tool_result') {
            const cached = toolResultCache.get(tu.input?.call_id);
            if (!cached) {
              result = `recall_tool_result: no cached result for call_id="${tu.input?.call_id}". Results don't persist across turns — re-run the original tool for fresh data.`;
            } else {
              result = cached.content; policy = 'never'; cached.policy = 'never';
              send({ type: 'tool_done', tool: tu.name, result: `recalled ${cached.toolName} (${cached.content.length} chars)` });
            }
          } else {
            result = await executeChatTool(tu.name, tu.input, projectId);
            send({ type: 'tool_done', tool: tu.name, result: String(result).split('\n')[0].slice(0, 160) });
          }
          const resultStr = String(result);
          toolResultCache.set(tu.id, { round, content: resultStr, toolName: tu.name, policy });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultStr });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${e.message}`, is_error: true });
          send({ type: 'tool_error', tool: tu.name, error: e.message });
        }
      }
      conv.push({ role: 'user', content: toolResults });
      if (aborted) break;
    }

    // Cost meter: persist this turn's spend, then push an accurate final total.
    if (turnCost > 0) {
      sessionCost += turnCost;
      appendUsage({ ts: Date.now(), model: CHAT_MODEL, ...turnUsage, cost: turnCost, projectId: projectId || null });
    }
    {
      const t = usageTotals();
      send({ type: 'usage', turnCost, tokens: { ...turnUsage }, session: t.session, today: t.today, all: t.all, final: true });
    }

    send({ type: 'done', text: finalText });
    if (finalText && lastUser) {
      saveMemory(`Q: ${String(lastUser).slice(0, 300)}\nA: ${finalText.slice(0, 500)}`, projectId, 'conversation').catch(() => {});
    }
    return { ok: true, text: finalText };
  } catch (e) {
    send({ type: 'error', error: e.message });
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('summarize',   async (_, { apiKey, projectId }) => { const p = await getPageContent(); return callClaude(await buildSystemPrompt(projectId, p), [{ role:'user', content:`Summarize in 3-5 bullets:\n${p.title}\n${p.url}\n\n${p.body}` }], apiKey); });
ipcMain.handle('extract',     async (_, { apiKey, projectId }) => { const p = await getPageContent(); return callClaude(await buildSystemPrompt(projectId, p), [{ role:'user', content:`Extract key data:\n${p.title}\n${p.url}\n\n${p.body}` }], apiKey); });
ipcMain.handle('explain',     async (_, { apiKey, projectId }) => { const p = await getPageContent(); return callClaude(await buildSystemPrompt(projectId, p), [{ role:'user', content:`Explain in plain language:\n${p.title}\n${p.url}\n\n${p.body}` }], apiKey); });
ipcMain.handle('write-email', async (_, { apiKey, projectId }) => { const p = await getPageContent(); return callClaude(await buildSystemPrompt(projectId, p), [{ role:'user', content:`Draft a professional email:\n${p.title}\n${p.url}\n\n${p.body}` }], apiKey); });

// Handle open-url for default browser — macOS sends URLs here when Atlas is default
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    createTab(url);
  }
});

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

// ─── Move to Applications (if running from DMG) ────────────────────────────
function checkMoveToApplications() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  const appPath = app.getAppPath();
  // Detect running from DMG mount or Downloads
  if (appPath.startsWith('/Volumes/') || appPath.includes('/Downloads/')) {
    const { dialog } = require('electron');
    const dest = '/Applications/Atlas.app';
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Move to Applications', 'Run from here'],
      defaultId: 0,
      title: 'Move Atlas to Applications?',
      message: 'Atlas is running from a temporary location. Move it to Applications for the best experience.',
      detail: 'Running from a DMG can cause launch issues and performance problems.',
    });
    if (choice === 0) {
      const src = path.resolve(appPath, '..', '..');
      try {
        // Remove old install if exists
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        // Copy app bundle to /Applications
        require('child_process').execSync(`cp -R "${src}" "${dest}"`);
        // Relaunch from /Applications
        require('child_process').exec(`open "${dest}"`);
        app.quit();
        process.exit(0);
      } catch (e) {
        dialog.showMessageBoxSync({ type: 'error', message: 'Could not move Atlas. Please drag it to Applications manually.', detail: e.message });
      }
    }
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Dev dock icon (otherwise it shows Electron's default atom icon).
  if (process.platform === 'darwin' && app.dock) { try { app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png')); } catch {} }
  checkMoveToApplications();
  startBridge();
  const ses = session.fromPartition('persist:atlas');
  ses.on('will-download', (_, item) => {
    const id = Date.now();
    const dl = { id, filename: item.getFilename(), url: item.getURL(), totalBytes: item.getTotalBytes(), receivedBytes: 0, state: 'progressing', savePath: null };
    downloads.set(id, dl);
    mainWindow?.webContents.send('download-started', { ...dl });
    item.on('updated',  (_, state) => { dl.state=state; dl.receivedBytes=item.getReceivedBytes(); dl.totalBytes=item.getTotalBytes(); mainWindow?.webContents.send('download-updated', {...dl}); });
    item.once('done',   (_, state) => { dl.state=state; dl.savePath=item.getSavePath(); mainWindow?.webContents.send('download-updated', {...dl}); });
  });
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => { stopBridge(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  // Save open tabs for restore on next launch — use tracked URL, filter junk
  const openTabs = [];
  tabs.forEach((t) => {
    const url = t.url;
    if (!url || url === 'about:blank' || url.startsWith('about:')) return;
    // Skip widget/embed/popup URLs — only save real page URLs
    try {
      const u = new URL(url);
      if (u.pathname.includes('/widget/') || u.pathname.includes('/embed/') || u.pathname.includes('/_/scs/')) return;
    } catch {}
    openTabs.push({ url, title: t.title || '' });
  });
  if (openTabs.length) saveTabs(openTabs);
  stopBridge();
});
app.on('activate', () => {
  if (!_windowReady && mainWindow) return; // Still initializing — don't race
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else createWindow();
});

/**
 * Atlas MCP Bridge
 * Spawned by main.js on startup, killed on quit.
 * Exposes local HTTP API for GitHub write, Render, Neon.
 * Port is written to stdout on start so main.js can pick it up.
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { Pool } = require('pg');

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  const candidates = [
    process.env.ATLAS_SETTINGS_PATH,
    path.join(process.env.HOME || '', 'Library', 'Application Support', 'claude-atlas', 'settings.json'),
    path.join(process.env.APPDATA || '', 'claude-atlas', 'settings.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return { envVars: {} };
}

// ─── pg pool ──────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  const url = loadSettings().envVars?.NEON_URL;
  if (!url) return null;
  _pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  return _pool;
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────
function ghToken(env, owner) {
  return owner === 'BrianBMorgan'
    ? env.GITHUB_TOKEN_BRIAN || env.GITHUB_TOKEN_PERSONAL || env.GITHUB_TOKEN
    : env.GITHUB_TOKEN_SANDBOX || env.GITHUB_TOKEN_ORG    || env.GITHUB_TOKEN;
}

function ghReq(method, p, token, body = null) {
  return new Promise((resolve, reject) => {
    const bstr = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'api.github.com', path: p, method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent':    'Atlas-MCP-Bridge/1.0',
        'Accept':        'application/vnd.github.v3+json',
        'Content-Type':  'application/json',
        ...(bstr ? { 'Content-Length': Buffer.byteLength(bstr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bstr) req.write(bstr);
    req.end();
  });
}

async function ghGetFile(owner, repo, filePath, branch, token) {
  const r = await ghReq('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`, token);
  if (r.status !== 200) return { error: `GitHub ${r.status}: ${r.body?.message || 'unknown'}` };
  return {
    content: Buffer.from(r.body.content, 'base64').toString('utf8'),
    sha:     r.body.sha,
    path:    filePath,
  };
}

async function ghPutFile(owner, repo, filePath, content, sha, message, branch, token) {
  const body = { message, content: Buffer.from(content).toString('base64'), sha, branch };
  const r    = await ghReq('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, token, body);
  return {
    ok:      r.status === 200 || r.status === 201,
    status:  r.status,
    sha:     r.body?.content?.sha,
    message: r.body?.commit?.message,
    url:     r.body?.content?.html_url,
    error:   r.status >= 400 ? (r.body?.message || 'unknown') : undefined,
  };
}

// ─── Render helpers ───────────────────────────────────────────────────────────
function renderReq(method, p, key, body = null) {
  return new Promise((resolve, reject) => {
    const bstr = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'api.render.com', path: `/v1${p}`, method,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        ...(bstr ? { 'Content-Length': Buffer.byteLength(bstr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bstr) req.write(bstr);
    req.end();
  });
}

// ─── Slack helpers ────────────────────────────────────────────────────────────
function slackReq(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const bstr = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'slack.com', path: `/api/${endpoint}`, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json; charset=utf-8',
        ...(bstr ? { 'Content-Length': Buffer.byteLength(bstr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: data }); } });
    });
    req.on('error', reject);
    if (bstr) req.write(bstr);
    req.end();
  });
}

// ─── HubSpot helpers ──────────────────────────────────────────────────────────
function hsReq(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const bstr = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'api.hubapi.com', path, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        ...(bstr ? { 'Content-Length': Buffer.byteLength(bstr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    if (bstr) req.write(bstr);
    req.end();
  });
}

// ─── iMessage (AppleScript) ───────────────────────────────────────────────────
const { execFile } = require('child_process');
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function sendIMessage(recipient, message) {
  // recipient can be phone number or email
  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy "${recipient.replace(/"/g, '\\"')}" of targetService
      send "${message.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" to targetBuddy
    end tell
  `;
  return runAppleScript(script);
}

async function getIMessages(contact, limit = 10) {
  const { promisify } = require('util');
  const sqlite3 = require('sqlite3');
  // Read from Messages DB
  const dbPath = path.join(process.env.HOME, 'Library', 'Messages', 'chat.db');
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => {
      if (err) return reject(new Error('Cannot open Messages DB — grant Full Disk Access in System Preferences'));
    });
    const sql = `
      SELECT m.text, m.is_from_me, datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as sent_at
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE h.id LIKE ?
      ORDER BY m.date DESC LIMIT ?
    `;
    db.all(sql, [`%${contact}%`, limit], (err, rows) => {
      db.close();
      if (err) reject(err);
      else resolve(rows.reverse());
    });
  });
}


// ─── Google OAuth + API ───────────────────────────────────────────────────────
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

function saveGoogleTokens(tokens) {
  const s = loadSettings();
  s.envVars = s.envVars || {};
  s.envVars.GOOGLE_ACCESS_TOKEN  = tokens.access_token;
  if (tokens.refresh_token) s.envVars.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
  s.envVars.GOOGLE_TOKEN_EXPIRY  = String(Date.now() + (tokens.expires_in || 3600) * 1000);
  const p = process.env.ATLAS_SETTINGS_PATH ||
    path.join(process.env.HOME || '', 'Library', 'Application Support', 'claude-atlas', 'settings.json');
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
}

function googleHttpReq(method, hostname, urlPath, token, body = null) {
  return new Promise((resolve, reject) => {
    const bstr = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname, path: urlPath, method,
      headers: {
        'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(bstr ? { 'Content-Length': Buffer.byteLength(bstr) } : {}),
      },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject); if (bstr) req.write(bstr); req.end();
  });
}

function googleFormPost(hostname, urlPath, formData) {
  return new Promise((resolve, reject) => {
    const bstr = Object.entries(formData).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const req  = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bstr) },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject); req.write(bstr); req.end();
  });
}

async function getGoogleToken() {
  const env    = loadSettings().envVars || {};
  const expiry = parseInt(env.GOOGLE_TOKEN_EXPIRY || '0');
  if (env.GOOGLE_ACCESS_TOKEN && Date.now() < expiry - 60000) return env.GOOGLE_ACCESS_TOKEN;
  if (!env.GOOGLE_REFRESH_TOKEN) throw new Error('Google not connected — click Connect Google in Atlas Settings');
  const r = await googleFormPost('oauth2.googleapis.com', '/token', {
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
  });
  if (!r.body.access_token) throw new Error('Token refresh failed');
  saveGoogleTokens(r.body);
  return r.body.access_token;
}

async function gapi(method, hostname, urlPath, body = null) {
  const token = await getGoogleToken();
  return googleHttpReq(method, hostname, urlPath, token, body);
}

// OAuth flow — uses main bridge server, no separate port needed
let pendingOAuthResolve = null;

function startGoogleOAuth(clientId, clientSecret, bridgePort) {
  return new Promise((resolve, reject) => {
    // Store resolver so the /oauth/google/callback route can call it
    pendingOAuthResolve = async (code) => {
      pendingOAuthResolve = null;
      try {
        const r = await googleFormPost('oauth2.googleapis.com', '/token', {
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: `http://localhost:${bridgePort}/oauth/google/callback`,
          grant_type: 'authorization_code',
        });
        if (!r.body.access_token) throw new Error(JSON.stringify(r.body));
        saveGoogleTokens(r.body);
        resolve({ ok: true, connected: true });
      } catch (e) { reject(e); }
    };

    const redirectUri = encodeURIComponent(`http://localhost:${bridgePort}/oauth/google/callback`);
    const scope       = encodeURIComponent(GOOGLE_SCOPES);
    const authUrl     = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;
    resolve({ ok: true, authUrl });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // CORS for Electron renderer if needed
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url  = new URL(req.url, 'http://localhost');
  const body = req.method === 'POST' ? await readBody(req) : {};
  const s    = loadSettings();
  const env  = s.envVars || {};

  try {
    // ── GitHub ────────────────────────────────────────────────────────────────
    if (url.pathname === '/gh/read') {
      const { owner, repo, path: filePath, branch = 'main' } = body;
      if (!owner || !repo || !filePath) return send(res, 400, { error: 'owner, repo, path required' });
      const token = ghToken(env, owner);
      if (!token) return send(res, 401, { error: `No GitHub token for ${owner}` });
      return send(res, 200, await ghGetFile(owner, repo, filePath, branch, token));
    }

    if (url.pathname === '/gh/write') {
      const { owner, repo, path: filePath, content, sha, message, branch = 'main' } = body;
      if (!owner || !repo || !filePath || !content || !sha || !message)
        return send(res, 400, { error: 'owner, repo, path, content, sha, message required' });
      const token = ghToken(env, owner);
      if (!token) return send(res, 401, { error: `No GitHub token for ${owner}` });
      return send(res, 200, await ghPutFile(owner, repo, filePath, content, sha, message, branch, token));
    }

    // ── Render ────────────────────────────────────────────────────────────────
    if (url.pathname === '/render/services') {
      const key = env.RENDER_API_KEY;
      if (!key) return send(res, 401, { error: 'No RENDER_API_KEY' });
      const r = await renderReq('GET', '/services?limit=20', key);
      if (r.status !== 200) return send(res, r.status, { error: r.body?.message });
      const services = r.body.map(i => {
        const svc = i.service;
        return { id: svc.id, name: svc.name, type: svc.type, suspended: svc.suspended, url: svc.serviceDetails?.url, branch: svc.serviceDetails?.branch };
      });
      return send(res, 200, { services });
    }

    if (url.pathname === '/render/deploy') {
      const { serviceId } = body;
      if (!serviceId) return send(res, 400, { error: 'serviceId required' });
      const key = env.RENDER_API_KEY;
      if (!key) return send(res, 401, { error: 'No RENDER_API_KEY' });
      const r = await renderReq('POST', `/services/${serviceId}/deploys`, key, {});
      return send(res, 200, { ok: r.status < 300, status: r.status, deployId: r.body?.deploy?.id });
    }

    if (url.pathname === '/render/deploys') {
      const { serviceId } = body;
      if (!serviceId) return send(res, 400, { error: 'serviceId required' });
      const key = env.RENDER_API_KEY;
      if (!key) return send(res, 401, { error: 'No RENDER_API_KEY' });
      const r = await renderReq('GET', `/services/${serviceId}/deploys?limit=5`, key);
      if (r.status !== 200) return send(res, r.status, { error: r.body?.message });
      return send(res, 200, { deploys: r.body.map(i => ({ id: i.deploy.id, status: i.deploy.status, commit: i.deploy.commit?.message, createdAt: i.deploy.createdAt, finishedAt: i.deploy.finishedAt })) });
    }

    if (url.pathname === '/render/logs') {
      const { serviceId, deployId } = body;
      if (!serviceId) return send(res, 400, { error: 'serviceId required' });
      const key = env.RENDER_API_KEY;
      if (!key) return send(res, 401, { error: 'No RENDER_API_KEY' });

      // If no deployId, find the latest failed deploy
      let targetDeployId = deployId;
      if (!targetDeployId) {
        const d = await renderReq('GET', `/services/${serviceId}/deploys?limit=10`, key);
        if (d.status === 200 && d.body?.length) {
          const failed = d.body.find(i => i.deploy.status === 'build_failed' || i.deploy.status === 'update_failed' || i.deploy.status === 'deactivated');
          targetDeployId = failed ? failed.deploy.id : d.body[0].deploy.id;
        }
      }
      if (!targetDeployId) return send(res, 404, { error: 'No deploys found' });

      // Fetch deploy logs via Render API
      const r = await renderReq('GET', `/services/${serviceId}/deploys/${targetDeployId}/logs`, key);
      if (r.status !== 200) {
        // Fallback: try the events endpoint for error details
        const ev = await renderReq('GET', `/services/${serviceId}/events?limit=20`, key);
        const events = (ev.status === 200 && Array.isArray(ev.body)) ? ev.body : [];
        const buildEvents = events.filter(e => e.details?.toLowerCase?.()?.includes('fail') || e.details?.toLowerCase?.()?.includes('error') || e.type === 'deploy');
        return send(res, 200, { deployId: targetDeployId, logs: null, events: buildEvents.slice(0, 10), note: 'Direct log endpoint returned ' + r.status + ', showing events instead' });
      }
      // Logs may be an array of {timestamp, text} objects — flatten to text
      const logLines = Array.isArray(r.body) ? r.body.map(l => (l.text || l.message || JSON.stringify(l))).join('\n') : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      return send(res, 200, { deployId: targetDeployId, logs: logLines });
    }

    // ── Neon ──────────────────────────────────────────────────────────────────
    if (url.pathname === '/neon/query') {
      const { sql: rawSql, params = [], neonUrl } = body;
      if (!rawSql) return send(res, 400, { error: 'sql required' });
      // Normalize Unicode curly/smart quotes to ASCII (Claude outputs these)
      const sql = rawSql
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u0060\u00B4]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
      // Use per-request neonUrl if provided, else fall back to global
      let pool;
      if (neonUrl) {
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: neonUrl, ssl: { rejectUnauthorized: false }, max: 3 });
      } else {
        pool = getPool();
      }
      if (!pool) return send(res, 401, { error: 'No NEON_URL configured' });
      const result = await pool.query(sql, params);
      if (neonUrl) pool.end().catch(() => {}); // clean up ad-hoc pool
      return send(res, 200, { rows: result.rows, rowCount: result.rowCount });
    }

    // ── Slack ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/slack/channels') {
      const token = env.SLACK_TOKEN;
      if (!token) return send(res, 401, { error: 'No SLACK_TOKEN' });
      const r = await slackReq('GET', 'conversations.list?types=public_channel,private_channel&limit=100&exclude_archived=true', token);
      if (!r.ok) return send(res, 400, { error: r.error });
      return send(res, 200, { channels: r.channels.map(c => ({ id: c.id, name: c.name, is_private: c.is_private, unread: c.unread_count_display || 0 })) });
    }

    if (url.pathname === '/slack/history') {
      const { channel, limit = 20 } = body;
      if (!channel) return send(res, 400, { error: 'channel required' });
      const token = env.SLACK_TOKEN;
      if (!token) return send(res, 401, { error: 'No SLACK_TOKEN' });
      const r = await slackReq('GET', `conversations.history?channel=${channel}&limit=${limit}`, token);
      if (!r.ok) return send(res, 400, { error: r.error });
      // Get user info for display names
      const messages = r.messages.reverse().map(m => ({
        user: m.user, text: m.text, ts: m.ts,
        time: new Date(parseFloat(m.ts) * 1000).toLocaleTimeString(),
      }));
      return send(res, 200, { messages });
    }

    if (url.pathname === '/slack/send') {
      const { channel, text } = body;
      if (!channel || !text) return send(res, 400, { error: 'channel and text required' });
      const token = env.SLACK_TOKEN;
      if (!token) return send(res, 401, { error: 'No SLACK_TOKEN' });
      const r = await slackReq('POST', 'chat.postMessage', token, { channel, text });
      return send(res, 200, { ok: r.ok, ts: r.ts, error: r.error });
    }

    if (url.pathname === '/slack/search') {
      const { query, count = 10 } = body;
      if (!query) return send(res, 400, { error: 'query required' });
      const token = env.SLACK_TOKEN;
      if (!token) return send(res, 401, { error: 'No SLACK_TOKEN' });
      const r = await slackReq('GET', `search.messages?query=${encodeURIComponent(query)}&count=${count}`, token);
      if (!r.ok) return send(res, 400, { error: r.error });
      const matches = (r.messages?.matches || []).map(m => ({
        channel: m.channel?.name, user: m.username, text: m.text,
        time: new Date(parseFloat(m.ts) * 1000).toLocaleString(),
        permalink: m.permalink,
      }));
      return send(res, 200, { matches });
    }

    // ── HubSpot ───────────────────────────────────────────────────────────────
    if (url.pathname === '/hs/contacts/search') {
      const { query, limit = 10 } = body;
      if (!query) return send(res, 400, { error: 'query required' });
      const token = env.HUBSPOT_SECRET_TOKEN;
      if (!token) return send(res, 401, { error: 'No HUBSPOT_SECRET_TOKEN' });
      const r = await hsReq('POST', '/crm/v3/objects/contacts/search', token, {
        query,
        limit,
        properties: ['firstname', 'lastname', 'email', 'company', 'phone', 'hs_lead_status'],
      });
      if (r.status !== 200) return send(res, r.status, { error: r.body?.message });
      const contacts = r.body.results.map(c => ({ id: c.id, ...c.properties }));
      return send(res, 200, { contacts, total: r.body.total });
    }

    if (url.pathname === '/hs/deals/search') {
      const { query, limit = 10 } = body;
      const token = env.HUBSPOT_SECRET_TOKEN;
      if (!token) return send(res, 401, { error: 'No HUBSPOT_SECRET_TOKEN' });
      const r = await hsReq('POST', '/crm/v3/objects/deals/search', token, {
        query: query || '',
        limit,
        properties: ['dealname', 'amount', 'dealstage', 'closedate', 'pipeline'],
        sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
      });
      if (r.status !== 200) return send(res, r.status, { error: r.body?.message });
      return send(res, 200, { deals: r.body.results.map(d => ({ id: d.id, ...d.properties })), total: r.body.total });
    }

    if (url.pathname === '/hs/contact/create') {
      const { email, firstname, lastname, company, phone } = body;
      if (!email) return send(res, 400, { error: 'email required' });
      const token = env.HUBSPOT_SECRET_TOKEN;
      if (!token) return send(res, 401, { error: 'No HUBSPOT_SECRET_TOKEN' });
      const r = await hsReq('POST', '/crm/v3/objects/contacts', token, {
        properties: { email, firstname, lastname, company, phone },
      });
      return send(res, 200, { ok: r.status === 201, id: r.body.id, error: r.body?.message });
    }

    if (url.pathname === '/hs/note/create') {
      const { contactId, note } = body;
      if (!contactId || !note) return send(res, 400, { error: 'contactId and note required' });
      const token = env.HUBSPOT_SECRET_TOKEN;
      if (!token) return send(res, 401, { error: 'No HUBSPOT_SECRET_TOKEN' });
      // Create note engagement
      const r = await hsReq('POST', '/crm/v3/objects/notes', token, {
        properties: { hs_note_body: note, hs_timestamp: Date.now() },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
      });
      return send(res, 200, { ok: r.status === 201, id: r.body.id, error: r.body?.message });
    }

    // ── iMessage ──────────────────────────────────────────────────────────────
    if (url.pathname === '/imessage/send') {
      const { recipient, message } = body;
      if (!recipient || !message) return send(res, 400, { error: 'recipient and message required' });
      await sendIMessage(recipient, message);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/imessage/read') {
      const { contact, limit = 10 } = body;
      if (!contact) return send(res, 400, { error: 'contact required' });
      try {
        const messages = await getIMessages(contact, limit);
        return send(res, 200, { messages });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // ── Google OAuth ──────────────────────────────────────────────────────────
    if (url.pathname === '/google/auth/start') {
      const env = loadSettings().envVars || {};
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
        return send(res, 400, { error: 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to settings' });
      const { port } = server.address();
      const result = await startGoogleOAuth(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, port);
      return send(res, 200, result);
    }

    if (url.pathname === '/oauth/google/callback') {
      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error || !code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2 style="font-family:sans-serif;color:#f7768e;padding:40px">Auth failed: ${error || 'no code'}</h2>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;color:#7aa2f7;padding:40px">✓ Google connected! You can close this window.</h2>');
      if (pendingOAuthResolve) pendingOAuthResolve(code).catch(console.error);
      return;
    }

    if (url.pathname === '/google/auth/status') {
      const env = loadSettings().envVars || {};
      const connected = !!(env.GOOGLE_REFRESH_TOKEN);
      return send(res, 200, { connected });
    }

    // ── Gmail ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/gmail/inbox') {
      const { limit = 10, query = 'is:unread' } = body;
      const r = await gapi('GET', 'gmail.googleapis.com', `/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(query)}`);
      if (r.status !== 200) return send(res, r.status, { error: r.body?.error?.message });
      const messages = await Promise.all((r.body.messages || []).slice(0, limit).map(async m => {
        const detail = await gapi('GET', 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
        const headers = detail.body.payload?.headers || [];
        const get = name => headers.find(h => h.name === name)?.value || '';
        return { id: m.id, subject: get('Subject'), from: get('From'), date: get('Date'), snippet: detail.body.snippet };
      }));
      return send(res, 200, { messages });
    }

    if (url.pathname === '/gmail/send') {
      const { to, subject, body: msgBody } = body;
      if (!to || !subject || !msgBody) return send(res, 400, { error: 'to, subject, body required' });
      const raw = Buffer.from(
        `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${msgBody}`
      ).toString('base64url');
      const r = await gapi('POST', 'gmail.googleapis.com', '/gmail/v1/users/me/messages/send', { raw });
      return send(res, 200, { ok: r.status === 200, id: r.body.id, error: r.body?.error?.message });
    }

    // ── Google Calendar ───────────────────────────────────────────────────────
    if (url.pathname === '/calendar/today') {
      const now   = new Date();
      const start = new Date(now.setHours(0,0,0,0)).toISOString();
      const end   = new Date(now.setHours(23,59,59,999)).toISOString();
      const r = await gapi('GET', 'www.googleapis.com', `/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true&orderBy=startTime`);
      if (r.status !== 200) return send(res, r.status, { error: r.body?.error?.message });
      const events = (r.body.items || []).map(e => ({
        id: e.id, summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end:   e.end?.dateTime   || e.end?.date,
        location: e.location, description: e.description?.slice(0,200),
      }));
      return send(res, 200, { events });
    }

    if (url.pathname === '/calendar/upcoming') {
      const { days = 7 } = body;
      const start = new Date().toISOString();
      const end   = new Date(Date.now() + days * 86400000).toISOString();
      const r = await gapi('GET', 'www.googleapis.com', `/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true&orderBy=startTime&maxResults=20`);
      if (r.status !== 200) return send(res, r.status, { error: r.body?.error?.message });
      const events = (r.body.items || []).map(e => ({
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end:   e.end?.dateTime   || e.end?.date,
      }));
      return send(res, 200, { events });
    }

    // ── Google Drive ──────────────────────────────────────────────────────────
    if (url.pathname === '/drive/search') {
      const { query, limit = 10 } = body;
      if (!query) return send(res, 400, { error: 'query required' });
      const r = await gapi('GET', 'www.googleapis.com', `/drive/v3/files?q=${encodeURIComponent(`fullText contains '${query.replace(/'/g,"\\'")}' and trashed=false`)}&pageSize=${limit}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`);
      if (r.status !== 200) return send(res, r.status, { error: r.body?.error?.message });
      return send(res, 200, { files: r.body.files || [] });
    }

    if (url.pathname === '/drive/read') {
      const { fileId } = body;
      if (!fileId) return send(res, 400, { error: 'fileId required' });
      // Export Google Docs as plain text
      const r = await gapi('GET', 'www.googleapis.com', `/drive/v3/files/${fileId}/export?mimeType=text/plain`);
      if (r.status !== 200) return send(res, r.status, { error: 'Could not read file' });
      return send(res, 200, { content: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) });
    }

    // ── Debug ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/debug') {
      const settingsPath = process.env.ATLAS_SETTINGS_PATH ||
        path.join(process.env.HOME || '', 'Library', 'Application Support', 'claude-atlas', 'settings.json');
      const s = loadSettings();
      return send(res, 200, {
        settingsPath,
        envVarKeys: Object.keys(s.envVars || {}),
        hasGoogleClientId: !!s.envVars?.GOOGLE_CLIENT_ID,
        ATLAS_SETTINGS_PATH: process.env.ATLAS_SETTINGS_PATH,
      });
    }

    // ── Health ────────────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, pid: process.pid });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// Find a free port and start — try fixed 3847 first for stable OAuth redirect URIs
server.listen(3847, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`ATLAS_BRIDGE_PORT=${port}\n`);
}).on('error', () => {
  // 3847 in use, fall back to random
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    process.stdout.write(`ATLAS_BRIDGE_PORT=${port}\n`);
  });
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });

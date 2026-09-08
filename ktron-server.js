#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Minimal .env loader (local dev convenience; Render injects real env vars).
   Never overrides values that are already set in the environment. */
(function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1] in process.env) continue;
    let v = m[2];
    v = v.replace(/^["']|["']$/g, '');
    v = v.replace(/#.*$/, '').trimEnd();
    process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const MODEL = process.env.KTRON_MODEL || 'openai/gpt-4o-mini';
const MAX_TOKENS = Number(process.env.KTRON_MAX_TOKENS || 900);

const API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000);
const SESSION_COOKIE = 'ktron_session';

const ROOT = __dirname;
const FRONTEND = path.join(ROOT, 'ktron.html');
const KRYPTON_FRONTEND = path.join(ROOT, 'krypton.html');
const ADMIN_FRONTEND = path.join(ROOT, 'admin.html');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const { sendConfirmation } = require('./apply-mail');
const store = require('./store');
const APPLY_DELAY_MS = Number(process.env.APPLY_DELAY_MS || 3000);

const applyQueue = [];
const loginAttempts = new Map(); // ip -> { fails, lockedUntil }

const SYSTEM_PROMPT =
  'You are K-Tron, a focused web-agency assistant for Krypton, a one-person design studio. ' +
  'You answer conversationally and concisely in plain text. You can help scope small websites, ' +
  'price packages, plan features, and advise on web projects. Keep replies under 4 short sentences ' +
  'unless asked for detail. Never claim to have access to files or personal user data.';

function serveFile(res, file, code = 200) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500).end('Server error'); return; }
    res.writeHead(code, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* Background queue: sends confirmation email a few seconds after submission. */
function processApplyQueue() {
  if (!applyQueue.length) return;
  const job = applyQueue.shift();
  setTimeout(() => {
    sendConfirmation(job)
      .then(() => {})
      .catch((err) => console.error('[apply] confirmation failed:', err.message));
  }, APPLY_DELAY_MS);
}

/* ---------- auth helpers ---------- */

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

function isSecureRequest(req) {
  return process.env.RENDER === 'true' || req.headers['x-forwarded-proto'] === 'https';
}

function cookieHeader(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function setSessionCookie(res, token, maxAgeMs, secure) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, secure) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function verifyAdminPassword(input) {
  if (!ADMIN_PASSWORD || !input) return false;
  const a = crypto.scryptSync(String(input), 'krypton', 32);
  const b = crypto.scryptSync(ADMIN_PASSWORD, 'krypton', 32);
  return crypto.timingSafeEqual(a, b);
}

function rateLimited(ip) {
  const entry = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  if (entry.lockedUntil > Date.now()) return true;
  return false;
}

function recordFailure(ip) {
  const entry = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= 5) { entry.fails = 0; entry.lockedUntil = Date.now() + 60_000; }
  loginAttempts.set(ip, entry);
}

function recordSuccess(ip) { loginAttempts.delete(ip); }

async function currentSession(req, res) {
  const token = cookieHeader(req)[SESSION_COOKIE];
  if (!token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not authenticated' })); return null; }
  const session = await store.getSession(token);
  if (!session) { clearSessionCookie(res, isSecureRequest(req)); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not authenticated' })); return null; }
  return token;
}

/* ---------- routes ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }).end();
    return;
  }

  /* application intake */
  if (url.pathname === '/api/apply' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.founderEmail || !body.theme) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Application requires founderEmail and theme.' }));
      return;
    }
    const seg = () => Math.floor(0x10000 * Math.random()).toString(16).toUpperCase().padStart(4, '0');
    const yr = String(new Date().getFullYear()).slice(-2);
    const appNo = `KR-${yr}-${Math.floor(100000 + Math.random() * 900000)}`;
    const appId = `KRY-${seg()}-${seg()}`;
    const appCode = Math.floor(100000 + Math.random() * 900000);
    const job = Object.assign({}, body, { appNo, appId, appCode });

    let record;
    try {
      record = await store.insertApplication(job);
    } catch (err) {
      console.error('[apply] store insert failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not save application.' }));
      return;
    }
    applyQueue.push(job);
    processApplyQueue();
    console.log(`[apply] ${appNo} (#${record.id}) from ${job.founderEmail} (${job.company || 'company?'}) — stored + queued for confirmation email.`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, queued: true, application: { id: record.id, appNo, appId, appCode } }));
    return;
  }

  /* admin auth */
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!ADMIN_PASSWORD) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Admin auth is not configured (ADMIN_PASSWORD missing).' }));
      return;
    }
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many attempts. Try again in a minute.' }));
      return;
    }
    const body = await readBody(req);
    if (!verifyAdminPassword(body.password)) {
      recordFailure(ip);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Incorrect password.' }));
      return;
    }
    recordSuccess(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createSession(token, SESSION_TTL_MS);
    setSessionCookie(res, token, SESSION_TTL_MS, isSecureRequest(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = cookieHeader(req)[SESSION_COOKIE];
    if (token) await store.deleteSession(token);
    clearSessionCookie(res, isSecureRequest(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/session' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /* admin data */
  if (url.pathname === '/api/applications' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    const apps = await store.listApplications();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, applications: apps }));
    return;
  }

  const appMatch = url.pathname.match(/^\/api\/applications\/(\d+)(?:\/(resend))?$/);
  if (appMatch && (req.method === 'GET' || req.method === 'DELETE' || req.method === 'POST')) {
    const token = await currentSession(req, res);
    if (!token) return;
    const id = Number(appMatch[1]);
    const action = appMatch[2];
    if (action === 'resend') {
      const app = await store.getApplication(id);
      if (!app) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Application not found.' })); return; }
      try {
        await sendConfirmation(app);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, resent: true }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Resend failed: ${err.message}` }));
      }
      return;
    }
    if (req.method === 'DELETE') {
      const ok = await store.deleteApplication(id);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, deleted: ok }));
      return;
    }
    const app = await store.getApplication(id);
    if (!app) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Application not found.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, application: app }));
    return;
  }

  /* chat */
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    if (!API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server has no OPENAI_API_KEY set. See .env.example.' }));
      return;
    }
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    if (!messages.length) { res.writeHead(400).end(JSON.stringify({ error: 'messages required' })); return; }

    const payload = {
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: MAX_TOKENS,
      stream: false,
    };

    try {
      const upstream = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify(payload),
      });
      const data = await upstream.json();
      if (!upstream.ok) {
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: data?.error?.message || data?.error || 'Upstream error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not reach the model provider.' }));
    }
    return;
  }

  /* static pages */
  if (url.pathname === '/' || url.pathname === '/ktron.html') {
    if (!fs.existsSync(FRONTEND)) { res.writeHead(404).end('ktron.html not found'); return; }
    serveFile(res, FRONTEND);
    return;
  }

  if (url.pathname === '/krypton.html') {
    if (!fs.existsSync(KRYPTON_FRONTEND)) { res.writeHead(404).end('krypton.html not found'); return; }
    serveFile(res, KRYPTON_FRONTEND);
    return;
  }

  if (url.pathname === '/admin' || url.pathname === '/admin.html') {
    if (!fs.existsSync(ADMIN_FRONTEND)) { res.writeHead(404).end('admin.html not found'); return; }
    serveFile(res, ADMIN_FRONTEND);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

(async function boot() {
  try {
    await store.init();
  } catch (err) {
    console.error('[boot] Failed to initialize store:', err.message);
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`K-Tron running → http://${HOST}:${PORT}`);
    console.log(`  · Krypton application page → http://${HOST}:${PORT}/krypton.html`);
    console.log(`  · Admin dashboard → http://${HOST}:${PORT}/admin`);
    if (!ADMIN_PASSWORD) console.log('  ⚠  No ADMIN_PASSWORD set — admin login is disabled. Add it to .env.');
    if (!API_KEY) console.log('  ⚠  No OPENAI_API_KEY set. Add it to .env (see .env.example) and restart.');
    const mail = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? 'SMTP' :
      process.env.BREVO_API_KEY ? 'Brevo' : process.env.RESEND_API_KEY ? 'Resend' : null;
    console.log(mail ? `  · Confirmation emails → ${mail} (sender: ${process.env.FROM_NAME || 'K-Tron'} <${process.env.FROM_EMAIL || 'onboarding@krypton.studio'}>)` : '  ⚠  No SMTP / BREVO_API_KEY / RESEND_API_KEY configured — confirmation emails will be skipped.');
  });
})();
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

const API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000);
const SESSION_COOKIE = 'ktron_session';

/* Admin-tuned prod settings — overridable live from the panel. */
function activeModel() {
  const m = String((process.env.KTRON_MODEL || 'openrouter/auto') || '');
  return m.trim() || 'openrouter/auto';
}
function activeMaxTokens() {
  const v = Number(process.env.KTRON_MAX_TOKENS || 1400);
  return Number.isFinite(v) ? Math.max(1, Math.min(10000, Math.round(v))) : 1400;
}
async function master(store) {
  const model = String((await store.getSetting('master_model')) || '').trim() || activeModel();
  const maxTokens = Number(Number(await store.getSetting('master_max_tokens')) || activeMaxTokens());
  const directive = await store.getSetting('master_directive') || '';
  const greeting = await store.getSetting('master_greeting') || '';
  const rate = await store.getSetting('master_rate') || '';
  const rateNum = Number(await store.getSetting('master_rate_num'));
  const persona = await store.getSetting('master_persona') || '';
  return { model, maxTokens: Math.max(1, maxTokens), directive, greeting, rate, rateNum: Number.isFinite(rateNum) && rateNum > 0 ? rateNum : 87, persona };
}
async function publicSystem() {
  const m = await master(store);
  const extra = [];
  if (m.directive) extra.push('Additional operating directive from the studio: ' + m.directive);
  if (m.rate) extra.push('Current rate card information:\n' + m.rate);
  return extra.length ? SYSTEM_PROMPT + '\n\n' + extra.join('\n\n') : SYSTEM_PROMPT;
}

const ROOT = __dirname;
const FRONTEND = path.join(ROOT, 'ktron.html');
const KRYPTON_FRONTEND = path.join(ROOT, 'krypton.html');
const ADMIN_FRONTEND = path.join(ROOT, 'admin.html');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const { sendConfirmation } = require('./apply-mail');
const store = require('./store');

process.on('unhandledRejection', (err) => {
  console.error('[ktron] unhandled rejection:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('[ktron] uncaught exception:', err && err.message ? err.message : err);
});
const APPLY_DELAY_MS = Number(process.env.APPLY_DELAY_MS || 3000);

const applyQueue = [];
const loginAttempts = new Map(); // ip -> { fails, lockedUntil }

let SYSTEM_PROMPT =
  'You are K-Tron, the courteous AI co-pilot of Krypton, a one-person design studio. Polished, warm and highly ' +
  'respectful; use a refined register (e.g. courteous greetings, measured phrasing) without being sycophantic. ' +
  'You answer conversationally and concisely in plain text, scoping small websites, pricing packages, ' +
  'and planning features. Keep replies under 4 short sentences unless asked for detail. Never claim to ' +
  'have access to files or personal user data. ' +
  'KNOW YOUR PRICING (quote these exact numbers, always compute total): ' +
  'site base price $300–$340 depending on the theme. Delivery speed adds: +$0 for 1 Month, +$500 for 1 Week, ' +
  '+$1,000 for 3 Days. Optional add-on features (CMS, blog, shop, booking, etc.) add on top, plus an optional ' +
  '10% tip. Final price = base + speed + add-ons + tip. So a landing page at $340 at 1-week speed is $840, and ' +
  'at standard 1-month speed it is $340.';

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

/* ---------- panel key file (file-based passkey) ---------- */

const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — easy to read
function generateKeyFile(host) {
  let secret = '';
  for (let i = 0; i < 18; i++) secret += KEY_ALPHABET[Math.floor(Math.random() * KEY_ALPHABET.length)];
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  const base = host ? `https://${host}` : '';
  const content =
    '#!/bin/bash\n' +
    '# KRYPTON PANEL MASTER KEY — Admin-Passkey\n' +
    '# Double-click this file to open the admin panel — it unlocks itself.\n' +
    '# You can also upload it on the panel login screen ("unlock with key file").\n\n' +
    ': secret: ' + secret + '\n' +
    (base ? `open "https://${host}/admin?key=${secret}"` : `open "/admin?key=${secret}"`) + '\n';
  return { secret, hash, content };
}

function extractKeySecret(text) {
  const m = String(text || '').match(/secret:\s*([A-Z2-9]{18})/);
  return m ? m[1] : null;
}

function storeHash(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

async function getPanelKeyHash() { return store.getSetting('panel_key_hash'); }

async function verifyKeySecretStored(secret) {
  const stored = await getPanelKeyHash();
  if (!stored) return false;
  const a = Buffer.from(storeHash(secret), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function truthy(v) { return v === true || v === 'true'; }

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

/* 3-step gate — a session only opens the panel after ALL of these factors are earned */
const FULL_FACTORS = ['password', 'fingerprint', 'keyfile'];

async function currentSession(req, res, minFactors = FULL_FACTORS) {
  const token = cookieHeader(req)[SESSION_COOKIE];
  if (!token || token.length > 200) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not authenticated' })); return null; }
  const session = await store.getSession(token);
  if (!session) { clearSessionCookie(res, isSecureRequest(req)); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not authenticated' })); return null; }
  const factors = session.factors || [];
  const missing = minFactors.filter((f) => !factors.includes(f));
  if (missing.length) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Verification incomplete', missing })); return null; }
  return token;
}

/* ---------- AI helpers ---------- */

async function callModel(messages, systemPrompt = SYSTEM_PROMPT, modelOverride) {
  const payload = {
    model: modelOverride || activeModel(),
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_tokens: activeMaxTokens(),
    stream: false,
  };
  try {
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    if (!upstream.ok) return { httpStatus: upstream.status, error: data?.error?.message || data?.error || 'Upstream error' };
    return data;
  } catch (e) {
    return { httpStatus: 502, error: 'Could not reach the model provider.' };
  }
}

/* Compact, live digest of everything the admin can see — becomes the co-pilot's brain. */
async function adminBrain() {
  const apps = await store.listApplications();
  const totals = { new: 0, 'in-progress': 0, delivered: 0, paid: 0, cancelled: 0 };
  let pipelineUSD = 0;
  for (const a of apps) { totals[a.status] = (totals[a.status] || 0) + 1; pipelineUSD += Number(a.totalUSD) || 0; }
  const announcementEnabled = (await store.getSetting('announce_enabled')) === 'true';
  const announcementMessage = announcementEnabled ? (await store.getSetting('announce_message')) : '';
  const evs = await store.recentEvents(8);
  const chat = await store.recentChat(6);
  const site = {
    maintenance: (await store.getSetting('site_maintenance')) === 'true',
    applyOpen: (await store.getSetting('site_apply_open')) !== 'false',
    chatOpen: (await store.getSetting('site_chat_open')) !== 'false',
  };
  return {
    studio: 'Krypton — one-person premium site studio.',
    stats: { total: apps.length, byStatus: totals, pipelineUSD, pipelineINR: Math.round(pipelineUSD * (await master(store)).rateNum) },
    announcement: { enabled: announcementEnabled, message: announcementMessage },
    recentAdminActions: evs.map((e) => `${e.kind}: ${e.detail || ''}`),
    recentVisitorChat: chat.map((c) => `[${c.role}${c.page ? '/' + c.page : ''}] ${(c.content || '').slice(0, 120)}`),
    siteLocks: site,
    programs: apps.map((a) => ({
      id: a.id,
      ref: a.appNo,
      company: a.company || a.applicant,
      applicant: a.applicant,
      email: a.founderEmail,
      theme: a.theme,
      status: a.status,
      totalUSD: Number(a.totalUSD) || 0,
      speed: a.deliverySpeed,
      pinned: !!a.pinned,
      notes: a.notes || '',
      createdAt: a.createdAt,
    })),
  };
}

const updateAdminSystemPrompt = (ctx) =>
  'You are K-Tron, the AI co-pilot inside the Krypton admin panel. You address the operator respectfully and always as ' +
  '"Admin" (never by name or as "user"). You are polished, deferential, and precise. You have complete, current visibility ' +
  'of the studio: every application, its status, price, client, the live site broadcast, the latest admin actions, system ' +
  'health, and recent visitor conversations. Answer plainly and directly, with exact numbers from the data you are given — ' +
  'never invent clients, prices, or statuses that are not in the data. You can draft client emails, summarize the pipeline, ' +
  'flag stuck projects, and suggest next best actions. Use a respectful register ("With respect, Admin…") sparingly, never ' +
  'sycophantically. Keep replies tight unless asked for more.\n\n' +
  'LIVE STUDIO CONTEXT:\n' + JSON.stringify(ctx) +
  '\n\nPRICING RULES (for estimates): site base $300–$340 by theme; speed adds +$0 (1 Month), +$500 (1 Week), +$1,000 (3 Days); ' +
  'plus optional add-ons and an optional 10% tip. Final price = base + speed + add-ons + tip.';

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

  /* applicant lookup (client portal) */
  if (url.pathname === '/api/client/login' && req.method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    const code = String(body.appCode || body.code || '').trim();
    if (!email || !code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Email and passcode are required.' }));
      return;
    }
    const app = await store.getApplicationByEmailAndCode(email, code);
    if (!app) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No application matches that email + passcode.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, application: app }));
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
    await store.createSession(token, SESSION_TTL_MS, ['password']);
    setSessionCookie(res, token, SESSION_TTL_MS, isSecureRequest(req));
    await store.insertEvent('login', 'STEP 1/3 — Admin typed the password (from ' + ip + ')');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, step: 1 }));
    return;
  }

  /* step 2 — fingerprint scan (session must already carry the password factor) */
  if (url.pathname === '/api/auth/fingerprint' && req.method === 'POST') {
    const token = await currentSession(req, res, ['password']);
    if (!token) return;
    await store.markFactor(token, 'fingerprint', SESSION_TTL_MS);
    await store.insertEvent('login', 'STEP 2/3 — fingerprint verified');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, step: 2 }));
    return;
  }

  /* step 3 — upload the Admin-Passkey file (must already have password + fingerprint factors) */
  if (url.pathname === '/api/login-key' && req.method === 'POST') {
    const token = await currentSession(req, res, ['password', 'fingerprint']);
    if (!token) return;
    const body = await readBody(req);
    const secret = extractKeySecret(body.key);
    const hash = await getPanelKeyHash();
    if (!hash) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No panel key file has been generated yet. Log in with the password and mint one from ⚡ POWERS.' }));
      return;
    }
    const ip = clientIp(req);
    if (secret && await verifyKeySecretStored(secret)) {
      recordSuccess(ip);
      await store.markFactor(token, 'keyfile', SESSION_TTL_MS);
      await store.insertEvent('login', 'STEP 3/3 — Admin-Passkey file accepted · all three steps complete');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, step: 3 }));
      return;
    }
    recordFailure(ip);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Key file rejected.' }));
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
    const token = cookieHeader(req)[SESSION_COOKIE];
    if (!token) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, missing: FULL_FACTORS })); return; }
    const session = await store.getSession(token);
    if (!session) { clearSessionCookie(res, isSecureRequest(req)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, missing: FULL_FACTORS })); return; }
    const factors = session.factors || [];
    const missing = FULL_FACTORS.filter((f) => !factors.includes(f));
    if (missing.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, missing, have: factors })); return; }
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

  const patchMatch = url.pathname.match(/^\/api\/applications\/(\d+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const token = await currentSession(req, res);
    if (!token) return;
    const body = await readBody(req);
    const ALLOWED = ['new', 'in-progress', 'delivered', 'paid', 'cancelled'];
    const fields = {};
    if ('status' in body) {
      const status = String(body.status).trim().toLowerCase();
      if (!ALLOWED.includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `status must be one of: ${ALLOWED.join(', ')}` }));
        return;
      }
      fields.status = status;
    }
    if ('totalUSD' in body) {
      const n = Number(body.totalUSD);
      if (!Number.isFinite(n) || n < 0 || n > 10000000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'totalUSD must be a number between 0 and 10,000,000.' }));
        return;
      }
      fields.totalUSD = Math.round(n);
    }
    if ('notes' in body) fields.notes = String(body.notes).slice(0, 2000);
    if ('pinned' in body) fields.pinned = Boolean(body.pinned);
    const app = await store.updateApplication(Number(patchMatch[1]), fields);
    if (!app) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Application not found.' })); return; }
    const logBits = [];
    if (fields.status) logBits.push('status → ' + fields.status);
    if ('totalUSD' in fields) logBits.push('price → $' + fields.totalUSD);
    if (fields.notes) logBits.push('notes added');
    if ('pinned' in fields) logBits.push('pinned ' + (fields.pinned ? 'ON' : 'OFF'));
    if (logBits.length) await store.insertEvent('application', app.appNo + ': ' + logBits.join(', '));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, application: app }));
    return;
  }

  const reissueMatch = url.pathname.match(/^\/api\/applications\/(\d+)\/reissue$/);
  if (reissueMatch && req.method === 'POST') {
    const token = await currentSession(req, res);
    if (!token) return;
    const out = await store.reissueApplicationCode(Number(reissueMatch[1]));
    if (!out.ok) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Application not found.' })); return; }
    await store.insertEvent('application', (await store.getApplication(Number(reissueMatch[1])))?.appNo + ': passcode reissued');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, appCode: out.appCode }));
    return;
  }

  /* global broadcast — the public site shows whatever the admin transmits */
  if (url.pathname === '/api/settings/announcement' && req.method === 'GET') {
    const enabled = (await store.getSetting('announce_enabled')) === 'true';
    const message = await store.getSetting('announce_message');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ enabled, message: enabled ? (message || '') : '' }));
    return;
  }

  if (url.pathname === '/api/settings/announcement' && req.method === 'PUT') {
    const token = await currentSession(req, res);
    if (!token) return;
    const body = await readBody(req);
    const message = String(body.message || '').slice(0, 500);
    const enabled = Boolean(body.enabled);
    await store.setSetting('announce_message', message);
    await store.setSetting('announce_enabled', String(enabled));
    await store.insertEvent('announce', (enabled ? 'broadcast ON: ' : 'broadcast OFF: ') + message.slice(0, 120));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, enabled, message }));
    return;
  }

  /* visitor analytics — anonymous presence ping from the public site */
  if (url.pathname === '/api/analytics/ping' && req.method === 'POST') {
    const body = await readBody(req);
    const vid = String(body.vid || '').slice(0, 40);
    const page = String(body.page || 'krypton').slice(0, 40);
    if (vid) await store.pingVisit(vid, page);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /* public site leash — flags the public funnel obeys (maintenance / apply / chat) + main-site hero wording */
  if (url.pathname === '/api/settings/site' && req.method === 'GET') {
    const maintenance = (await store.getSetting('site_maintenance')) === 'true';
    const applyOpen = (await store.getSetting('site_apply_open')) !== 'false';
    const chatOpen = (await store.getSetting('site_chat_open')) !== 'false';
    const heroRaw = (await store.getSetting('ktron_hero')) || '';
    let mainHero = null;
    if (heroRaw) { try { mainHero = JSON.parse(heroRaw); } catch { mainHero = null; } }
    const keyArmed = Boolean(await store.getSetting('panel_key_hash'));
    const greeting = (await store.getSetting('master_greeting')) || '';
    const directive = (await store.getSetting('master_directive')) || '';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ maintenance, applyOpen, chatOpen, mainHero, keyArmed, greeting, directive, now: new Date().toISOString() }));
    return;
  }

  /* admin: read site leash + live visitor street + main-site hero */
  if (url.pathname === '/api/admin/site' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    const maintenance = (await store.getSetting('site_maintenance')) === 'true';
    const applyOpen = (await store.getSetting('site_apply_open')) !== 'false';
    const chatOpen = (await store.getSetting('site_chat_open')) !== 'false';
    const hasKeyFile = Boolean(await store.getSetting('panel_key_hash'));
    const heroRaw = (await store.getSetting('ktron_hero')) || '';
    let mainHero = null;
    if (heroRaw) { try { mainHero = JSON.parse(heroRaw); } catch { mainHero = null; } }
    const visits = await store.getVisits();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ maintenance, applyOpen, chatOpen, hasKeyFile, mainHero, visits, now: new Date().toISOString() }));
    return;
  }

  /* admin: pull the leash — toggle maintenance / apply / chat / rewrite the main-site hero */
  if (url.pathname === '/api/admin/site' && req.method === 'PUT') {
    const token = await currentSession(req, res);
    if (!token) return;
    const body = await readBody(req);
    if ('maintenance' in body) { await store.setSetting('site_maintenance', String(Boolean(body.maintenance))); await store.insertEvent('leash', 'maintenance ' + (body.maintenance ? 'ON' : 'OFF')); }
    if ('applyOpen' in body) { await store.setSetting('site_apply_open', String(Boolean(body.applyOpen))); await store.insertEvent('leash', 'apply ' + (body.applyOpen ? 'OPEN' : 'PAUSED')); }
    if ('chatOpen' in body) { await store.setSetting('site_chat_open', String(Boolean(body.chatOpen))); await store.insertEvent('leash', 'public K-Tron ' + (body.chatOpen ? 'ON' : 'OFF')); }
    if (body.mainHero && typeof body.mainHero === 'object' && typeof body.mainHero.title === 'string') {
      const hero = { title: body.mainHero.title.slice(0, 80), sub: String(body.mainHero.sub || '').slice(0, 160) };
      await store.setSetting('ktron_hero', JSON.stringify(hero));
      await store.insertEvent('hero', 'main K-Tron site retitled: ' + hero.title);
    }
    const maintenance = (await store.getSetting('site_maintenance')) === 'true';
    const applyOpen = (await store.getSetting('site_apply_open')) !== 'false';
    const chatOpen = (await store.getSetting('site_chat_open')) !== 'false';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, maintenance, applyOpen, chatOpen }));
    return;
  }

  /* admin: command archive — audit trail of every pull of the leash */
  if (url.pathname === '/api/admin/events' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    const events = await store.recentEvents(60);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events }));
    return;
  }

  /* admin: K-Tron oversight — recent visitor conversations from the main site */
  if (url.pathname === '/api/admin/chatlog' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    const chat = await store.recentChat(80);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chat }));
    return;
  }

  /* admin: system health — mode, process, model, email, locks */
  if (url.pathname === '/api/admin/health' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    const m = await master(store);
    const health = {
      mode: store.hasDb ? 'Postgres (live)' : 'Memory',
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      model: m.model,
      maxTokens: m.maxTokens,
      email: process.env.SMTP_HOST ? (process.env.SMTP_USER || 'configured') : 'disabled',
      openaiKey: Boolean(process.env.OPENAI_API_KEY),
      maintenance: (await store.getSetting('site_maintenance')) === 'true',
      applyOpen: (await store.getSetting('site_apply_open')) !== 'false',
      chatOpen: (await store.getSetting('site_chat_open')) !== 'false',
      keyFile: Boolean(await store.getSetting('panel_key_hash')),
      now: new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, health }));
    return;
  }

  /* admin: mint the Admin-Passkey file (step 3 itself — password + fingerprint already earned) */
  if (url.pathname === '/api/admin/keyfile' && req.method === 'POST') {
    const token = await currentSession(req, res, ['password', 'fingerprint']);
    if (!token) return;
    const kf = generateKeyFile(req.headers.host);
    await store.setSetting('panel_key_hash', kf.hash);
    await store.markFactor(token, 'keyfile', SESSION_TTL_MS);
    await store.insertEvent('keyfile', 'Admin-Passkey minted at ' + new Date().toISOString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, filename: 'Admin-Passkey.command', content: kf.content }));
    return;
  }

  /* admin: revoke the panel key file — the file stops working immediately */
  if (url.pathname === '/api/admin/keyfile' && req.method === 'DELETE') {
    const token = await currentSession(req, res);
    if (!token) return;
    await store.setSetting('panel_key_hash', '');
    await store.insertEvent('keyfile', 'panel key file revoked');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    const m = await master(store);
    const data = await callModel(messages, await publicSystem(), m.model);
    if (data.httpStatus) { res.writeHead(data.httpStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: data.error })); return; }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const reply = data.choices?.[0]?.message?.content?.trim?.();
    if (reply) {
      await store.logChat('user', lastUser ? String(lastUser.content).slice(0, 400) : '(empty)', 'k-tron');
      await store.logChat('k-tron', reply.slice(0, 4000), 'k-tron');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
    return;
  }

  /* admin powers — batch operations */
  if (url.pathname === '/api/admin/commands' && req.method === 'POST') {
    const token = await currentSession(req, res);
    if (!token) return;
    const body = await readBody(req);
    const cmd = String(body.command || '');
    let done = 0;
    if (cmd === 'deliver-in-progress') { done = await store.bulkUpdateStatus('in-progress', 'delivered'); await store.insertEvent('command', 'delivered ' + done + ' in-progress'); }
    else if (cmd === 'clear-cancelled') { done = await store.deleteApplications('cancelled'); await store.insertEvent('command', 'purged ' + done + ' cancelled'); }
    else if (cmd === 'clear-all') { done = await store.deleteApplications('all'); await store.insertEvent('command', 'zeroed the board (' + done + ')'); }
    else if (cmd === 'mark-all-paid') { done = await store.bulkSetStatus(['new', 'in-progress', 'delivered'], 'paid'); await store.insertEvent('command', 'marked ' + done + ' as paid'); }
    else if (cmd === 'advance-all') { done = await store.bulkSetStatus(['new'], 'in-progress'); await store.insertEvent('command', 'advanced ' + done + ' new → in-progress'); }
    else if (cmd === 'reset-board') { done = await store.bulkSetStatus(['new', 'in-progress', 'delivered', 'paid'], 'new'); await store.insertEvent('command', 'reset ' + done + ' to new'); }
    else if (cmd === 'unpin-all') { done = await store.unpinAll(); await store.insertEvent('command', 'unpinned ' + done + ' dossiers'); }
    else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unknown command.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, command: cmd, done }));
    return;
  }

  /* admin brain — live studio context for the admin co-pilot */
  if (url.pathname === '/api/admin/brain' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ context: await adminBrain() }));
    return;
  }

  /* admin co-pilot chat — K-Tron with full visibility of the studio */
  if (url.pathname === '/api/admin/chat' && req.method === 'POST') {
    const token = await currentSession(req, res);
    if (!token) return;
    if (!API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server has no OPENAI_API_KEY set. See .env.example.' }));
      return;
    }
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    if (!messages.length) { res.writeHead(400).end(JSON.stringify({ error: 'messages required' })); return; }
    const ctx = await adminBrain();
    const m = await master(store);
    const persona = m.persona ? ('Additional persona instruction: ' + m.persona + '\n\n') : '';
    const data = await callModel(messages, persona + updateAdminSystemPrompt(ctx), m.model);
    if (data.httpStatus) { res.writeHead(data.httpStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: data.error })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  /* master settings — live-overridable model, directive, greeting, rate card, persona */
  const SETTINGS_KEYS = ['master_model', 'master_directive', 'master_greeting', 'master_rate', 'master_rate_num', 'master_persona'];
  const SETTINGS_PUBLIC_KEYS = ['master_greeting', 'master_directive', 'master_rate'];
  const PUBLIC_SETTINGS_MAP = { master_greeting: 'greeting', master_directive: 'directive', master_rate: 'rate' };

  async function loadMasterSettings(vals = {}) {
    for (const k of SETTINGS_KEYS) { const v = await store.getSetting(k); if (v != null) vals[k] = v; }
    return vals;
  }

  async function saveMasterSettings(body) {
    for (const k of SETTINGS_KEYS) {
      if (k in body) await store.setSetting(k, String(body[k] ?? ''));
    }
  }
  function masterSettingsSanitized(vals) {
    const o = {};
    for (const k of SETTINGS_KEYS) o[k] = vals[k] || '';
    return o;
  }

  if (url.pathname === '/api/admin/settings' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    const vals = await loadMasterSettings();
    const m = await master(store);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, settings: masterSettingsSanitized(vals), resolved: { model: m.model, maxTokens: m.maxTokens } }));
    return;
  }

  if (url.pathname === '/api/admin/settings' && req.method === 'PUT') {
    const token = await currentSession(req, res);
    if (!token) return;
    const body = await readBody(req);
    await saveMasterSettings(body);
    await store.insertEvent('settings', 'master settings updated: ' + Object.keys(body || {}).join(', ') || 'none');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, settings: masterSettingsSanitized(await loadMasterSettings()) }));
    return;
  }

  if (url.pathname === '/api/admin/sessions' && req.method === 'GET') {
    const token = await currentSession(req, res);
    if (!token) return;
    const sessions = await store.listSessions(100);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions, selfHash: cookieHeader(req)[SESSION_COOKIE] || '' }));
    return;
  }

  if (url.pathname === '/api/admin/sessions' && req.method === 'DELETE') {
    const token = await currentSession(req, res);
    if (!token) return;
    const myHash = store.hashToken(cookieHeader(req)[SESSION_COOKIE] || '');
    const cleared = await store.clearSessions();
    await store.createSession(cookieHeader(req)[SESSION_COOKIE] || token, SESSION_TTL_MS, FULL_FACTORS);
    await store.insertEvent('security', 'signed out ' + cleared + ' session(s)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared, selfHash: myHash }));
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
    const keyParam = url.searchParams.get('key');
    if (keyParam) {
      const clean = String(keyParam).slice(0, 32).trim();
      if (await verifyKeySecretStored(clean)) {
        const token = crypto.randomBytes(32).toString('base64url');
        await store.createSession(token, SESSION_TTL_MS, FULL_FACTORS);
        setSessionCookie(res, token, SESSION_TTL_MS, isSecureRequest(req));
        res.writeHead(302, { Location: '/admin' });
        res.end();
        return;
      }
      res.writeHead(302, { Location: '/admin?rejected=1' });
      res.end();
      return;
    }
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
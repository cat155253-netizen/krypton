#!/usr/bin/env node
/*
 * store.js — persistence for Krypton.
 *
 * Uses Postgres when DATABASE_URL is set (production, e.g. Render).
 * Falls back to an in-memory store when no DATABASE_URL is present
 * (local dev). The API is identical for both.
 */

const { Pool } = require('pg');
const crypto = require('crypto');

const hasDb = Boolean(process.env.DATABASE_URL);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  app_no TEXT NOT NULL,
  app_id TEXT NOT NULL,
  app_code TEXT NOT NULL,
  company TEXT,
  applicant TEXT,
  post TEXT,
  founder_email TEXT NOT NULL,
  theme TEXT,
  theme_length TEXT,
  length_selection TEXT,
  style_selection TEXT,
  delivery_format TEXT,
  project_description TEXT,
  add_ons JSONB NOT NULL DEFAULT '[]',
  delivery_speed TEXT,
  total_usd NUMERIC DEFAULT 0,
  currency TEXT DEFAULT 'usd',
  privacy_consent BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  factors TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS visits (
  vis_id TEXT NOT NULL,
  page TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vis_id, page)
);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_log (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT,
  page TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool = null;
let memory = { applications: [], sessions: new Map(), settings: new Map(), visits: new Map(), events: [], chatLog: [], seq: 0 };

async function init() {
  if (!hasDb) {
    console.log('[store] No DATABASE_URL — using in-memory store (local dev).');
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /sslmode=require|host=/.test(process.env.DATABASE_URL) && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await pool.query(SCHEMA);
  // Progressive upgrades so existing production DBs gain new powers.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS factors TEXT[] NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS notes TEXT`);
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`);
  console.log('[store] Postgres connected. Schema ready.');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function insertApplication(app) {
  const row = {
    app_no: app.appNo,
    app_id: app.appId,
    app_code: String(app.appCode),
    company: app.company || null,
    applicant: app.applicant || null,
    post: app.post || null,
    founder_email: app.founderEmail,
    theme: app.theme || null,
    theme_length: app.themeLength || null,
    length_selection: app.lengthSelection || null,
    style_selection: app.styleSelection || null,
    delivery_format: app.deliveryFormat || null,
    project_description: app.projectDescription || null,
    add_ons: JSON.stringify(app.addOns || []),
    delivery_speed: app.deliverySpeed || null,
    total_usd: app.totalUSD || 0,
    currency: app.currency || 'usd',
    privacy_consent: Boolean(app.privacyConsent),
    status: app.status || 'new',
  };
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO applications
       (app_no, app_id, app_code, company, applicant, post, founder_email, theme,
        theme_length, length_selection, style_selection, delivery_format, project_description,
        add_ons, delivery_speed, total_usd, currency, privacy_consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [row.app_no, row.app_id, row.app_code, row.company, row.applicant, row.post, row.founder_email,
       row.theme, row.theme_length, row.length_selection, row.style_selection, row.delivery_format,
       row.project_description, row.add_ons, row.delivery_speed, row.total_usd, row.currency, row.privacy_consent]
    );
    return mapRow(rows[0]);
  }
  const rec = mapRow(Object.assign({ id: ++memory.seq, created_at: new Date().toISOString() }, row));
  memory.applications.push(rec);
  return rec;
}

function mapRow(r) {
  return {
    id: r.id,
    appNo: r.app_no,
    appId: r.app_id,
    appCode: r.app_code,
    company: r.company,
    applicant: r.applicant,
    post: r.post,
    founderEmail: r.founder_email,
    theme: r.theme,
    themeLength: r.theme_length,
    lengthSelection: r.length_selection,
    styleSelection: r.style_selection,
    deliveryFormat: r.delivery_format,
    projectDescription: r.project_description,
    addOns: (() => { try { return JSON.parse(r.add_ons); } catch { return []; } })(),
    deliverySpeed: r.delivery_speed,
    totalUSD: Number(r.total_usd || 0),
    currency: r.currency,
    privacyConsent: r.privacy_consent,
    status: r.status,
    notes: r.notes || null,
    pinned: Boolean(r.pinned),
    createdAt: r.created_at,
  };
}

async function listApplications() {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT * FROM applications ORDER BY pinned DESC, created_at DESC');
    return rows.map(mapRow);
  }
  return [...memory.applications]
    .sort((a, b) => (b.pinned - a.pinned) || (new Date(b.created_at) - new Date(a.created_at)));
}

async function getApplication(id) {
  if (pool) {
    const { rows } = await pool.query('SELECT * FROM applications WHERE id=$1', [Number(id)]);
    return rows[0] ? mapRow(rows[0]) : null;
  }
  return memory.applications.find((a) => a.id === Number(id)) || null;
}

async function getApplicationByEmailAndCode(email, code) {
  const em = String(email).trim().toLowerCase();
  const co = String(code).trim().toUpperCase();
  if (pool) {
    const { rows } = await pool.query(
      'SELECT * FROM applications WHERE LOWER(founder_email)=$1 AND UPPER(app_code)=$2 LIMIT 1',
      [em, co]);
    return rows[0] ? mapRow(rows[0]) : null;
  }
  return memory.applications.find(
    (a) => String(a.founderEmail).toLowerCase() === em && String(a.appCode) === co
  ) || null;
}

async function deleteApplication(id) {
  if (pool) {
    const { rows } = await pool.query('DELETE FROM applications WHERE id=$1 RETURNING id', [Number(id)]);
    return rows.length > 0;
  }
  const i = memory.applications.findIndex((a) => a.id === Number(id));
  if (i === -1) return false;
  memory.applications.splice(i, 1);
  return true;
}

async function bulkUpdateStatus(fromStatus, toStatus) {
  if (pool) {
    const { rowCount } = await pool.query(
      'UPDATE applications SET status=$1 WHERE status=$2', [toStatus, fromStatus]);
    return rowCount;
  }
  let n = 0;
  for (const a of memory.applications) { if (a.status === fromStatus) { a.status = toStatus; n++; } }
  return n;
}

async function deleteApplications(status) {
  if (pool) {
    if (status === 'all') {
      const { rowCount } = await pool.query('DELETE FROM applications');
      return rowCount;
    }
    const { rowCount } = await pool.query('DELETE FROM applications WHERE status=$1', [status]);
    return rowCount;
  }
  const before = memory.applications.length;
  memory.applications = status === 'all'
    ? []
    : memory.applications.filter((a) => a.status !== status);
  return before - memory.applications.length;
}

/* ---------- audit trail + chat oversight ---------- */

async function insertEvent(kind, detail) {
  const row = { kind: String(kind || '').slice(0, 60), detail: String(detail || '').slice(0, 400) };
  if (pool) {
    await pool.query('INSERT INTO events (kind, detail) VALUES ($1,$2)', [row.kind, row.detail]);
    await pool.query(`DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id DESC OFFSET 300)`);
    return;
  }
  memory.events.push({ kind: row.kind, detail: row.detail, at: new Date() });
  if (memory.events.length > 300) memory.events.splice(0, memory.events.length - 300);
}

async function recentEvents(limit = 40) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT kind, detail, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT $1`, [limit]);
    return rows.map(r => ({ kind: r.kind, detail: r.detail, at: r.created_at }));
  }
  return [...memory.events].reverse().slice(0, limit);
}

async function logChat(role, content, page) {
  const row = { role: String(role || 'system').slice(0,20), content: String(content || '').slice(0, 4000), page: String(page || 'k-tron').slice(0, 40) };
  if (pool) {
    await pool.query('INSERT INTO chat_log (role, content, page) VALUES ($1,$2,$3)', [row.role, row.content, row.page]);
    await pool.query(`DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log ORDER BY id DESC OFFSET 400)`);
    return;
  }
  memory.chatLog.push(row);
  if (memory.chatLog.length > 400) memory.chatLog.splice(0, memory.chatLog.length - 400);
}

async function recentChat(limit = 60) {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT role, content, page, created_at FROM chat_log ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
    return rows.map(r => ({ role: r.role, content: r.content, page: r.page, at: r.created_at }));
  }
  return [...memory.chatLog].reverse().slice(0, limit);
}

module.exports = { init, hasDb, insertApplication, listApplications, getApplication, getApplicationByEmailAndCode, deleteApplication, bulkUpdateStatus, deleteApplications, updateApplicationStatus, updateApplication, reissueApplicationCode, getSetting, setSetting, pingVisit, getVisits, insertEvent, recentEvents, logChat, recentChat, createSession, markFactor, getSession, deleteSession, hashToken };

async function updateApplicationStatus(id, status) {
  if (pool) {
    const { rows } = await pool.query(
      'UPDATE applications SET status=$1 WHERE id=$2 RETURNING *', [status, Number(id)]);
    return rows[0] ? mapRow(rows[0]) : null;
  }
  const app = memory.applications.find((a) => a.id === Number(id));
  if (!app) return null;
  app.status = status;
  return app;
}

async function updateApplication(id, fields) {
  const idNum = Number(id);
  if (pool) {
    const sets = [];
    const vals = [];
    if ('status' in fields) { sets.push(`status=$${vals.length + 1}`); vals.push(fields.status); }
    if ('totalUSD' in fields) { sets.push(`total_usd=$${vals.length + 1}`); vals.push(Number(fields.totalUSD) || 0); }
    if ('notes' in fields) { sets.push(`notes=$${vals.length + 1}`); vals.push(String(fields.notes || '')); }
    if ('pinned' in fields) { sets.push(`pinned=$${vals.length + 1}`); vals.push(Boolean(fields.pinned)); }
    if (!sets.length) return getApplication(idNum);
    vals.push(idNum);
    const { rows } = await pool.query(
      `UPDATE applications SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    return rows[0] ? mapRow(rows[0]) : null;
  }
  const app = memory.applications.find((a) => a.id === idNum);
  if (!app) return null;
  if ('status' in fields) app.status = fields.status;
  if ('totalUSD' in fields) app.totalUSD = Number(fields.totalUSD) || 0;
  if ('notes' in fields) app.notes = String(fields.notes || '');
  if ('pinned' in fields) app.pinned = Boolean(fields.pinned);
  return app;
}

async function reissueApplicationCode(id) {
  const code = Math.floor(100000 + Math.random() * 900000);
  if (pool) {
    const { rows } = await pool.query(
      'UPDATE applications SET app_code=$1 WHERE id=$2 RETURNING *', [String(code), Number(id)]);
    return rows[0] ? { appCode: rows[0].app_code, ok: true } : { ok: false };
  }
  const app = memory.applications.find((a) => a.id === Number(id));
  if (!app) return { ok: false };
  app.appCode = String(code);
  return { appCode: app.appCode, ok: true };
}

async function getSetting(key) {
  if (pool) {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
    return rows.length ? rows[0].value : null;
  }
  return memory.settings.get(key) ?? null;
}

async function setSetting(key, value) {
  if (pool) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
      [key, value]);
    return;
  }
  memory.settings.set(key, value);
}

/* ---------- visitor analytics ---------- */

async function pingVisit(visId, page) {
  if (pool) {
    await pool.query(
      `INSERT INTO visits (vis_id, page) VALUES ($1,$2)
       ON CONFLICT (vis_id, page) DO UPDATE SET seen_at=now()`,
      [visId, page]);
    await pool.query(`DELETE FROM visits WHERE seen_at < now() - interval '30 days'`);
    return;
  }
  memory.visits.set(`${visId}|${page}`, { page, seenAt: Date.now() });
}

async function getVisits() {
  let rows;
  if (pool) {
    const fiveSec = new Date(Date.now() - 5 * 60 * 1000);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const { rows: r } = await pool.query(`SELECT vis_id, page, seen_at FROM visits`);
    rows = r;
    const q = (clause, params) => pool.query(`SELECT COUNT(*) c, COUNT(DISTINCT vis_id) d FROM visits WHERE ${clause}`, params);
    const now = await q(`seen_at > $1`, [fiveSec]); const today = await q(`seen_at >= $1`, [dayStart]);
    const pages = await pool.query(`SELECT page, COUNT(DISTINCT vis_id) d, MAX(seen_at) last FROM visits GROUP BY page ORDER BY d DESC`);
    return { now: Number(now.rows[0].d), today: Number(today.rows[0].d), total: rows.length, pages: pages.rows.map(x => ({ page: x.page, visitors: Number(x.d), last: x.last })), recent: rows.sort((a,b)=>new Date(b.seen_at)-new Date(a.seen_at)).slice(0,15) };
  }
  const list = [...memory.visits.values()];
  const fiveSec = Date.now() - 5 * 60 * 1000;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const nr = list.filter(v => v.seenAt > fiveSec).length;
  const tr = list.filter(v => v.seenAt >= dayStart.getTime()).length;
  const byPage = {};
  for (const v of list) { if (!byPage[v.page]) byPage[v.page] = { visitors: 0, last: 0 }; byPage[v.page].visitors++; byPage[v.page].last = Math.max(byPage[v.page].last, v.seenAt); }
  return { now: nr, today: tr, total: list.length, pages: Object.entries(byPage).map(([page, s]) => ({ page, visitors: s.visitors, last: new Date(s.last) })), recent: [...list].sort((a,b)=>b.seenAt-a.seenAt).slice(0,15) };
}

async function createSession(token, ttlMs, factors = []) {
  const hash = hashToken(token);
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const f = factors.filter((x) => typeof x === 'string');
  if (pool) {
    await pool.query(
      'INSERT INTO sessions (token_hash, expires_at, factors) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO UPDATE SET expires_at=$2, factors=$3',
      [hash, expires, f]);
    return;
  }
  memory.sessions.set(hash, { expires_at: expires, factors: f });
}

async function markFactor(token, name, ttlMs, initFactors = []) {
  const hash = hashToken(token);
  const s = await getSession(token);
  const cur = s && (s.factors || []).length ? s.factors : initFactors;
  if (!cur.includes(name)) cur.push(name);
  const expires = new Date(Date.now() + ttlMs).toISOString();
  if (pool) {
    await pool.query(
      'INSERT INTO sessions (token_hash, expires_at, factors) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO UPDATE SET expires_at=$2, factors=$3',
      [hash, expires, cur]);
    return cur;
  }
  memory.sessions.set(hash, { expires_at: expires, factors: cur });
  return cur;
}

async function getSession(token) {
  const hash = hashToken(token);
  if (pool) {
    const { rows } = await pool.query('SELECT * FROM sessions WHERE token_hash=$1', [hash]);
    if (!rows.length) return null;
    const s = rows[0];
    if (new Date(s.expires_at) < new Date()) { await deleteSession(token); return null; }
    return s;
  }
  const s = memory.sessions.get(hash);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { memory.sessions.delete(hash); return null; }
  return s;
}

async function deleteSession(token) {
  const hash = hashToken(token);
  if (pool) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash]);
  else memory.sessions.delete(hash);
}
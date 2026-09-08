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
  expires_at TIMESTAMPTZ NOT NULL
);
`;

let pool = null;
let memory = { applications: [], sessions: new Map(), seq: 0 };

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
    createdAt: r.created_at,
  };
}

async function listApplications() {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT * FROM applications ORDER BY created_at DESC');
    return rows.map(mapRow);
  }
  return [...memory.applications].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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

async function createSession(token, ttlMs) {
  const hash = hashToken(token);
  const expires = new Date(Date.now() + ttlMs).toISOString();
  if (pool) {
    await pool.query(
      'INSERT INTO sessions (token_hash, expires_at) VALUES ($1,$2) ON CONFLICT (token_hash) DO UPDATE SET expires_at=$2',
      [hash, expires]);
    return;
  }
  memory.sessions.set(hash, { expires_at: expires });
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

module.exports = { init, hasDb, insertApplication, listApplications, getApplication, getApplicationByEmailAndCode, deleteApplication, createSession, getSession, deleteSession, hashToken };
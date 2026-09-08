#!/usr/bin/env node
/*
 * apply-mail.js — Krypton application confirmation emailer
 *
 * Sends a Krypton-branded confirmation email to a company after they submit an
 * application, via the Resend REST API (https://resend.com/docs/api-reference/emails/send-email).
 * Uses native fetch — no extra dependencies.
 *
 * All credentials are read from the environment (see .env); never hardcode secrets.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@krypton.studio';
const FROM_NAME = process.env.FROM_NAME || 'K-Tron';
const RESEND_URL = 'https://api.resend.com/emails';
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const SMTP_CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

/* Krypton design tokens (mirror krypton.html) */
const C = {
  deep: '#124a5e',
  ink: '#2c5f72',
  soft: '#5e8ea0',
  neon: '#3fa7c9',
  mint: '#7fd0b5',
  paper: '#f2f7f9',
  hair: '#e6eef2',
};
const SERIF = "Georgia, 'Times New Roman', serif";
const MONO = "'Courier New', Courier, monospace";
const SANS = "Arial, Helvetica, sans-serif";
const HFONT = {
  'font-family': SANS,
  color: C.deep,
  'font-size': '15px',
  'line-height': '1.6',
};

function fmtMoney(usd) {
  if (usd === 0 || usd === null || usd === undefined) return '$0';
  return '$' + Number(usd).toLocaleString('en-US');
}

function addOnsList(addOns) {
  if (!Array.isArray(addOns) || !addOns.length) return '—';
  return addOns.map((a) => `${a.name} (+${fmtMoney(a.cost)})`).join(', ');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cardNumber(p) {
  const code = String(p && p.appCode != null ? p.appCode : '000000');
  return code.split('').join(' ');
}

function summaryRows(p) {
  const rows = [
    ['Company', p.company || '—'],
    ['Applicant', p.applicant || '—'],
    ['Position', p.post || '—'],
    ['Theme', p.theme || '—'],
    ['Theme length', p.themeLength || '—'],
    ['Pages', p.lengthSelection || '—'],
    ['Style', p.styleSelection || '—'],
    ['Delivery format', p.deliveryFormat || '—'],
    ['Add-ons', addOnsList(p.addOns)],
    ['Delivery speed', p.deliverySpeed || '—'],
    ['Tip', fmtMoney(p.tipUSD)],
    ['Total investment', fmtMoney(p.totalUSD)],
  ];
  return rows.map(([k, v]) =>
    `<tr>
      <td style="padding:9px 12px;font-family:${MONO};font-size:11px;color:${C.neon};text-transform:uppercase;letter-spacing:1px;white-space:nowrap;vertical-align:top;border-bottom:1px solid ${C.hair}">${escapeHtml(k)}</td>
      <td style="padding:9px 12px;font-family:${SANS};font-size:14px;color:${C.deep};vertical-align:top;border-bottom:1px solid ${C.hair}">${escapeHtml(v)}</td>
    </tr>`).join('');
}

function deliveryCard(p) {
  const no = p && p.appNo ? escapeHtml(p.appNo) : `KR-${String(new Date().getFullYear()).slice(-2)}-000000`;
  const id = p && p.appId ? escapeHtml(p.appId) : 'KRY-0000-0000';
  const code = cardNumber(p);
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr><td style="background:linear-gradient(135deg,${C.deep},${C.neon});border-radius:18px;padding:22px 24px;border:1px solid rgba(63,167,201,.45)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-family:${SANS};font-size:14px;font-weight:bold;letter-spacing:2px;color:#ffffff">KRYPTON<span style="color:${C.mint}"> STUDIO</span></td>
          <td align="right" style="font-family:${MONO};font-size:10px;letter-spacing:2px;color:${C.mint}">K-TRON · 001</td>
        </tr>
        <tr><td colspan="2" style="padding-top:18px">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:44px;height:30px;border-radius:7px;background:#d9b96a;border:1px solid #c7a24d">
                <table role="presentation" width="100%" height="100%" cellpadding="0" cellspacing="0">
                  <tr><td style="width:50%;border-right:1.5px solid #b7903f">&nbsp;</td><td style="width:50%">&nbsp;</td></tr>
                </table>
              </td>
              <td style="padding-left:14px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:#a8d8e8;white-space:nowrap">RESERVED · WEBSITE DELIVERY</td>
            </tr>
          </table>
        </td></tr>

        <tr><td colspan="2" style="padding-top:22px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${C.mint}">APPLICATION NO.</td></tr>
        <tr><td colspan="2" style="padding-top:4px;font-family:${MONO};font-size:19px;letter-spacing:2px;color:#ffffff">${no}</td></tr>

        <tr><td colspan="2" style="padding-top:16px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${C.mint}">APPLICATION ID</td></tr>
        <tr><td colspan="2" style="padding-top:4px;font-family:${MONO};font-size:16px;letter-spacing:2px;color:#ffffff">${id}</td></tr>

        <tr><td colspan="2" style="padding-top:16px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${C.mint}">DELIVERY PASSCODE</td></tr>
        <tr><td colspan="2" style="padding-top:5px;font-family:${MONO};font-size:24px;font-weight:bold;letter-spacing:8px;color:#ffffff">${code}</td></tr>
      </table>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px">
    <tr><td style="background:${C.paper};border:1px solid ${C.hair};border-radius:14px;padding:14px 18px">
      <div style="font-family:${MONO};font-size:10px;letter-spacing:2px;color:${C.neon}">KEEP THIS CARD SAFE</div>
      <p style="font-family:${SANS};font-size:13px;color:${C.ink};line-height:1.6;margin:6px 0 0">
        The <strong>Delivery Passcode</strong> above is <strong>reserved for the delivery of your website</strong>.
        If the passcode is lost, reissuing a new one takes time and a reissue charge applies. Don't share it.
      </p>
    </td></tr>
  </table>`;
}

function buildSubject(p) {
  return `Your Krypton application ${(p && p.appNo) || ''} — ${(p && p.company) || 'welcome'} (${(p && p.theme) || 'theme'})`;
}

function buildPlain(p) {
  return [
    `Dear ${p.applicant || 'team'} at ${p.company || 'your company'},`,
    '',
    `Thank you for reaching out to Krypton Studio. We've received your application and it's now in our queue.`,
    '',
    'Here is a quick recap of what you requested:',
    `  Theme:            ${p.theme || '—'} (${p.themeLength || '—'})`,
    `  Pages:            ${p.lengthSelection || '—'}`,
    `  Style:            ${p.styleSelection || '—'}`,
    `  Delivery format:  ${p.deliveryFormat || '—'}`,
    `  Add-ons:          ${addOnsList(p.addOns)}`,
    `  Delivery speed:   ${p.deliverySpeed || '—'}`,
    `  Total:            ${fmtMoney(p.totalUSD)}`,
    '',
    '— — — YOUR DELIVERY CARD — — —',
    `  Application No.:   ${(p && p.appNo) || '—'}`,
    `  Application ID:    ${(p && p.appId) || '—'}`,
    `  Delivery Passcode: ${p && p.appCode != null ? p.appCode : '—'}`,
    '',
    'KEEP THIS CARD SAFE. The Delivery Passcode is reserved for the delivery of your',
    'website. If the passcode is lost, reissuing a new one takes time and a reissue',
    'charge applies. Don\'t share it.',
    '',
    `A member of Krypton Studio will contact you at ${p.founderEmail || 'your email'} shortly to confirm the next steps.`,
    '',
    'We look forward to building with you.',
    '— by Krypton Studio',
  ].join('\n');
}

function buildHtml(p) {
  const greetingName = p.applicant ? `<strong>${escapeHtml(p.applicant)}</strong>` : 'there';
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:${C.paper}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${C.paper}">
    <tr><td align="center" style="padding:32px 12px">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid ${C.hair};box-shadow:0 12px 40px rgba(18,74,94,.10)">
        <!-- header -->
        <tr>
          <td style="background:linear-gradient(135deg,${C.deep},${C.neon});padding:30px 34px;color:#ffffff;border-bottom:3px solid ${C.mint}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-family:${SANS};font-size:25px;font-weight:bold;letter-spacing:2px;color:#ffffff">KRYPTON<span style="color:${C.mint}"> STUDIO</span></td>
                <td align="right" style="font-family:${MONO};font-size:10px;letter-spacing:2px;color:${C.mint};white-space:nowrap">PREMIUM SITES · TRANSACTIONAL</td>
              </tr>
            </table>
            <div style="height:1px;background:linear-gradient(90deg,${C.mint},rgba(127,208,181,0));margin-top:16px"></div>
            <div style="font-family:${SERIF};font-style:italic;font-weight:600;font-size:22px;color:#ffffff;margin-top:16px">Thanks for reaching out ✦</div>
          </td>
        </tr>

        <!-- body -->
        <tr><td style="padding:30px 34px">
          <p style="font-family:${SANS};font-size:15px;color:${C.ink};line-height:1.65;margin:0 0 22px">
            Dear ${greetingName} at <strong>${escapeHtml(p.company || 'your company')}</strong> — we've received your
            application and it's now in our queue. A member of Krypton Studio will contact you shortly to confirm the next steps.
          </p>

          <div style="font-family:${MONO};font-size:11px;letter-spacing:2px;color:${C.neon};text-transform:uppercase;margin:0 0 10px">Your request</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.hair}">
            ${summaryRows(p)}
          </table>

          <div style="height:22px"></div>
          ${deliveryCard(p)}

          <p style="font-family:${SANS};font-size:14px;color:${C.ink};line-height:1.65;margin:24px 0 6px">
            We'll be in touch at <strong>${escapeHtml(p.founderEmail || 'your email')}</strong> very soon.
            If anything changes in the meantime, just reply to this email.
          </p>
          <p style="font-family:${SERIF};font-style:italic;font-weight:600;font-size:16px;color:${C.deep};margin:6px 0 0">We look forward to building with you.</p>
        </td></tr>

        <!-- footer -->
        <tr><td style="background:${C.paper};padding:18px 34px;border-top:1px solid ${C.hair};color:${C.soft};font-family:${SANS};font-size:12px;text-align:center">
          — by <strong style="color:${C.deep}">Krypton Studio</strong> &nbsp;·&nbsp; Application <span style="font-family:${MONO};color:${C.neon}">${escapeHtml((p && p.appNo) || '')}</span> generated for <span style="font-family:${MONO};color:${C.neon}">${escapeHtml(p.company || '')}</span>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <tr><td align="center" style="padding:14px 0 0;color:${C.soft};font-family:${MONO};font-size:10px;letter-spacing:1px">
          KRYPTON STUDIO · K-TRON · delivery passcode reserved for website delivery · reissue charge applies if lost
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const nodemailer = require('nodemailer');

async function sendSmtp(p, to) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  const info = await transporter.sendMail({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject: buildSubject(p),
    text: buildPlain(p),
    html: buildHtml(p),
  });
  if (!info.accepted || !info.accepted.length) {
    throw new Error('SMTP send accepted none');
  }
  console.log(`[apply-mail] SMTP: confirmation email accepted for ${to} → ${info.messageId} (${(p && p.appNo) || ''})`);
  return { sent: true, id: info.messageId, via: 'smtp' };
}

async function sendBrevo(p, to) {
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY, 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject: buildSubject(p),
      textContent: buildPlain(p),
      htmlContent: buildHtml(p),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Brevo error ${res.status}: ${JSON.stringify(data)}`);
  }
  console.log(`[apply-mail] Brevo: confirmation email accepted for ${to} → ${data.messageId || 'id-unknown'} (${(p && p.appNo) || ''})`);
  return { sent: true, id: data.messageId || null, via: 'brevo' };
}

async function sendResend(p, to) {
  const payload = {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [to],
    subject: buildSubject(p),
    text: buildPlain(p),
    html: buildHtml(p),
  };
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend error ${res.status}: ${JSON.stringify(data)}`);
  }
  console.log(`[apply-mail] Confirmation email queued/sent to ${to} → ${data.id || 'id-unknown'} (${(p && p.appNo) || ''})`);
  return { sent: true, id: data.id || null, via: 'resend' };
}

async function sendConfirmation(p) {
  const via = SMTP_CONFIGURED ? 'smtp' : BREVO_API_KEY ? 'brevo' : RESEND_API_KEY ? 'resend' : null;
  if (!via) {
    console.warn('[apply-mail] No SMTP, BREVO_API_KEY or RESEND_API_KEY configured — confirmation email skipped.');
    return { sent: false, reason: 'missing-key' };
  }
  const to = (p && p.founderEmail) || '';
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    console.warn('[apply-mail] Invalid recipient email:', to);
    return { sent: false, reason: 'invalid-recipient' };
  }
  if (via === 'smtp') return sendSmtp(p, to);
  return via === 'brevo' ? sendBrevo(p, to) : sendResend(p, to);
}

module.exports = { sendConfirmation, buildSubject, buildPlain, buildHtml, summaryRows, deliveryCard, escapeHtml, fmtMoney };
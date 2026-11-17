// סוכן רכבים - יד 2: גרסת ענן (GitHub Actions). הלוגיקה של זיהוי המודעות, השדות והמייל מועתקת מהתוסף (background.js 2.4.2).
'use strict';
const fs = require('fs');
const path = require('path');

const ALARM = 'yad2-agent';
const MIN_INTERVAL = 2;       // דקות. מתחת לזה יש סיכון לחסימה מצד יד2
const MAX_NEW_PER_RUN = 10;
const MAX_DETAIL_FETCH = 25;   // כמה מודעות בלי תאריך ברשימה בודקים בכל סריקה (השאר נבדקות בסריקה הבאה)
const MAX_DATE_ATTEMPTS = 3;   // אחרי כמה ניסיונות כושלים מודעה נחשבת "ללא תאריך"
const ITEM_API = (t) => 'https://gw.yad2.co.il/vehicles-item/' + encodeURIComponent(t);
const ITEM_URL = (t) => 'https://www.yad2.co.il/vehicles/item/' + encodeURIComponent(t);
const DEFAULT_ALERTS = { alertSound: true, alertNotify: true, alertEmail: false, emailTo: '', alertUndated: false };
const MAIL_DEFAULTS = { mailMode: 'script', scriptUrl: '', scriptSecret: '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- כלים לשליפת שדות ----------
function bfsFind(root, re, conv, maxDepth) {
  const q = [[root, 0]];
  for (let i = 0; i < q.length; i++) {
    const [o, d] = q[i];
    if (!o || typeof o !== 'object') continue;
    const keys = Object.keys(o);
    if (!Array.isArray(o)) {
      for (const k of keys) {
        if (re.test(k)) { const r = conv(o[k]); if (r !== null) return r; }
      }
    }
    if (d < maxDepth) {
      for (const k of keys) { const v = o[k]; if (v && typeof v === 'object') q.push([v, d + 1]); }
    }
  }
  return null;
}
const toNum = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v.replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : null; }
  return null;
};
const convNum = (v) => { const n = toNum(v); return n !== null && n >= 0 ? n : null; };
const convText = (v) => {
  if (typeof v === 'string') return v.trim() !== '' ? v.trim() : null;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['text', 'name', 'title', 'value', 'textEng']) {
      if (typeof v[k] === 'string' && v[k].trim() !== '') return v[k].trim();
    }
  }
  return null;
};
const toTs = (v) => {
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim() !== '') {
    let s = v.trim();
    if (/^\d{9,13}$/.test(s)) return toTs(Number(s));
    if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};
const PHONE_VAL = (v) => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  const digits = s.replace(/[\s\-().]/g, '');
  return /^(\+?972|0)\d{8,10}$/.test(digits) ? s : null;
};

const KM_KEY = /^(km|kms|kilometers|kilometres|kilometrage|mileage)$/i;
const DATE_KEY = /^(createdAt|created_at|dateAdded|date_added|dateOfAdding|publishDate|publishedAt|created|createdDate|creationDate|dateCreated|date_created|publishedDate|datePublished|firstPublishedAt|adCreatedAt)$/i;
const VIEWS_KEY = /^(views|viewCount|view_count|viewsCount|numberOfViews|totalViews|pageViews|totalViewsCount)$/i;
const SAVES_KEY = /^(likes|likeCount|like_count|likesCount|favorites|favoriteCount|favoritesCount|favouriteCount|savedCount|saves|savesCount|numberOfLikes|numberOfFavorites|wishlistCount)$/i;
const PHONE_IN_TEXT = /(?<!\d)(?:\+?972[-\s.]?|0)(?:5\d|7\d|[2-489])[-\s.]?\d{3}[-\s.]?\d{4}(?!\d)/;
const PHONE_KEY = /(phone|mobile|cell|^tel$|telephone|whatsapp)/i;

const BOOL_KEYS = /^(isAgent|isAgency|isCommercial|isDealer|isTrade|isMerchant|isBusiness|isCommercialAd|isAgencyAd)$/i;
const STR_KEYS = /^(adType|sellerType|customerType|ownerType|merchantType|advertiserType|sourceType|userType|publisherType)$/i;
const PRESENCE_KEYS = /^(agencyName|agencyLogo|agency_logo|agencyId|agency_id|merchantName|tradeMiniSite|dealerName|businessName)$/i;
const AGENCY_RE = /agenc|commercial|dealer|trade|business|merchant|סוכנות|סוחר|מסחר/i;
const PRIVATE_RE = /^(private|פרטי)$/i;
function classify(root, maxDepth) {
  const q = [[root, 0]];
  for (let i = 0; i < q.length; i++) {
    const [o, d] = q[i];
    if (!o || typeof o !== 'object') continue;
    const keys = Object.keys(o);
    if (!Array.isArray(o)) {
      for (const k of keys) {
        const v = o[k];
        if (BOOL_KEYS.test(k) && typeof v === 'boolean') return v;
        if (STR_KEYS.test(k) && typeof v === 'string') {
          if (PRIVATE_RE.test(v.trim())) return false;
          if (AGENCY_RE.test(v)) return true;
        }
        if (PRESENCE_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '') return true;
      }
    }
    if (d < maxDepth) for (const k of keys) { const v = o[k]; if (v && typeof v === 'object') q.push([v, d + 1]); }
  }
  return null;
}

// אזורים בתשובת השרת שאינם תוצאות החיפוש עצמו (מפה, "דומות", המלצות, באנרים...)
const NON_RESULT_KEY = /marker|similar|recommend|related|expanded|suggest|nearby|banner|sponsor|campaign|alternativ|moreResults|otherResults|outOfFilter/i;

// אוסף מהתשובה את כל המודעות (אובייקטים עם token) מתוך תוצאות החיפוש בלבד, לפי סדר הופעתן
function collectItems(json) {
  const out = [];
  const seen = new Set();
  (function walk(n, depth) {
    if (!n || typeof n !== 'object' || depth > 14) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof n.token === 'string' && /^[A-Za-z0-9]{5,12}$/.test(n.token) && !seen.has(n.token)) {
      seen.add(n.token);
      out.push(n);
    }
    for (const k in n) {
      if (NON_RESULT_KEY.test(k)) continue;
      const v = n[k];
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  })(json, 0);
  return out;
}

// ---------- בניית נתוני מודעה ----------
const FIELD_DEFS = [
  ['manufacturer', 'יצרן', /^(manufacturer|manufacturerName|make)$/i, convText],
  ['model', 'דגם', /^(model|modelName)$/i, convText],
  ['subModel', 'תת-דגם', /^(subModel|subModelName|submodel|trim)$/i, convText],
  ['year', 'שנה', /^(year|yearOfProduction|manufactureYear|carYear|productionYear|vehicleYear)$/i, convText],
  ['km', 'ק״מ', KM_KEY, convNum],
  ['hand', 'יד', /^(hand|handNumber|ownerNumber|previousOwners|owner)$/i, convText],
  ['price', 'מחיר', /^(price|askingPrice)$/i, convNum],
  ['city', 'עיר / אזור', /^(city|cityName|area|areaName|region)$/i, convText],
  ['gearBox', 'תיבת הילוכים', /^(gearBox|gearbox|gear|transmission)$/i, convText],
  ['engineType', 'סוג מנוע', /^(engineType|fuelType|fuel)$/i, convText],
  ['engineVolume', 'נפח מנוע', /^(engineVolume|engineCapacity)$/i, convText],
  ['horsePower', 'כוח סוס', /^(horsePower|hp)$/i, convText],
  ['color', 'צבע', /^(color|colour|colorName)$/i, convText],
  ['testDate', 'טסט עד', /^(testDate|testUntil|testExpiry|testDateUntil)$/i, convText],
  ['contactName', 'איש קשר', /^(contactName|sellerName|customerName|advertiserName)$/i, convText],
  ['phone', 'טלפון', PHONE_KEY, PHONE_VAL],
  ['created', 'תאריך פרסום', DATE_KEY, toTs],
  ['views', 'צפיות', VIEWS_KEY, convNum],
  ['saves', 'שמירות', SAVES_KEY, convNum],
  ['description', 'תיאור', /^(description|searchText|info|remarks|comments)$/i, convText],
];

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTs(ts) {
  const d = new Date(ts);
  return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function extractAd(token, feedItem, itemJson) {
  const sources = [itemJson, feedItem].filter(Boolean);
  const f = {};
  for (const [key, , re, conv] of FIELD_DEFS) {
    for (const src of sources) {
      const v = bfsFind(src, re, conv, key === 'phone' || key === 'description' ? 8 : 6);
      if (v !== null) { f[key] = v; break; }
    }
  }
  // אם יד2 לא החזירה טלפון, מחפשים מספר בטקסט החופשי של המפרסם (תיאור / כותרת)
  if (!f.phone) {
    const free = [f.description, bfsFind(feedItem || {}, /^(title|searchText|info|remarks|comments)$/i, convText, 6)].filter(Boolean).join(' ');
    const m = PHONE_IN_TEXT.exec(free);
    if (m) { f.phone = m[0].trim(); f.phoneFromText = true; }
  }
  let agency = null;
  for (const src of sources) { agency = classify(src, 4); if (agency !== null) break; }
  f.seller = agency === true ? 'סוכנות / סוחר' : agency === false ? 'פרטי' : undefined;
  const title = [f.manufacturer, f.model, f.subModel, f.year].filter(Boolean).join(' ') || ('מודעה ' + token);
  return { token, url: ITEM_URL(token), title, fields: f, feedItem, itemJson };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// כל הערכים הסקלריים של המודעה (למקרה ששדה לא מופה למעלה)
function flatten(obj, prefix, out, depth) {
  if (out.length > 160 || depth > 6 || obj === null || obj === undefined) return;
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      if (obj.length && obj.every((x) => typeof x !== 'object')) {
        const s = obj.join(', ');
        if (s && !/^https?:/i.test(obj[0]) ) out.push([prefix, s]);
      } else obj.slice(0, 8).forEach((x, i) => flatten(x, prefix + '[' + i + ']', out, depth + 1));
      return;
    }
    for (const k of Object.keys(obj)) flatten(obj[k], prefix ? prefix + '.' + k : k, out, depth + 1);
    return;
  }
  if (obj === '' || typeof obj === 'boolean' && obj === false) return;
  if (/image|img|photo|cover|thumb|logo|icon|video|pic/i.test(prefix)) return;
  out.push([prefix, String(obj).slice(0, 220)]);
}

function formatField(key, v) {
  if (key === 'km') return Number(v).toLocaleString('he-IL') + ' ק״מ';
  if (key === 'price') return Number(v).toLocaleString('he-IL') + ' ₪';
  if (key === 'created') return fmtTs(v);
  return String(v);
}

function buildEmail(ad, agentName) {
  const f = ad.fields;
  const rows = FIELD_DEFS.concat([['seller', 'סוג מפרסם']])
    .filter(([key]) => f[key] !== undefined && key !== 'description')
    .map(([key, label]) => '<tr><td style="padding:6px 10px;color:#666;border-bottom:1px solid #eee;white-space:nowrap">' + esc(label) +
      '</td><td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:bold">' + esc(formatField(key, f[key])) + '</td></tr>').join('');
  const phoneNote = f.phone ? (f.phoneFromText ? '<p style="color:#666;font-size:12px;margin:8px 0 0">הטלפון נשלף מתוך טקסט המודעה.</p>' : '') :
    '<p style="color:#b45309;margin:12px 0 0">מספר הטלפון לא הופיע בנתוני המודעה (יד2 חושפת אותו רק לאחר לחיצה באתר). לחיצה על הכפתור תפתח את המודעה.</p>';
  const flat = [];
  flatten(ad.itemJson || ad.feedItem, '', flat, 0);
  const flatRows = flat.map(([k, v]) => '<tr><td style="padding:3px 8px;color:#888;border-bottom:1px solid #f0f0f0;font-size:12px">' + esc(k) +
    '</td><td style="padding:3px 8px;border-bottom:1px solid #f0f0f0;font-size:12px">' + esc(v) + '</td></tr>').join('');

  const html = '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#222">' +
    '<h2 style="margin:0 0 4px">מודעה חדשה ביד2: ' + esc(ad.title) + '</h2>' +
    (agentName ? '<div style="color:#888;font-size:12px;margin-bottom:6px">סוכן: ' + esc(agentName) + '</div>' : '') +
    (f.price !== undefined ? '<div style="font-size:20px;color:#d35400;font-weight:bold;margin-bottom:10px">' + esc(formatField('price', f.price)) + '</div>' : '') +
    '<table style="border-collapse:collapse;width:100%;font-size:14px">' + rows + '</table>' +
    (f.description ? '<h3 style="margin:16px 0 4px">תיאור</h3><div style="white-space:pre-wrap;font-size:14px">' + esc(f.description) + '</div>' : '') +
    phoneNote +
    '<p style="margin:16px 0"><a href="' + esc(ad.url) + '" style="background:#ff7a00;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">פתח את המודעה ביד2</a></p>' +
    (flatRows ? '<details><summary style="cursor:pointer;color:#666">כל הנתונים הגולמיים של המודעה</summary><table style="border-collapse:collapse;width:100%;margin-top:6px" dir="ltr">' + flatRows + '</table></details>' : '') +
    '<p style="color:#999;font-size:11px;margin-top:20px">נשלח אוטומטית מסוכן הרכבים (ענן)</p></div>';
  const priceTxt = f.price !== undefined ? ' – ' + formatField('price', f.price) : '';
  return { subject: '🚗 מודעה חדשה ביד2: ' + ad.title + priceTxt + (agentName ? ' [' + agentName + ']' : ''), html };
}

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

function pageUrlFor(feedUrl, p) {
  const u = new URL(feedUrl);
  u.searchParams.set('page', String(p));
  return u.toString();
}

// כתובת החיפוש בלי מספר עמוד ובסדר קבוע, לזיהוי כפילויות
function normalizePage(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('page');
    u.searchParams.sort();
    return u.origin + u.pathname + '?' + u.searchParams.toString();
  } catch (e) { return String(url); }
}

// ---------- התאמה לחיפוש השמור ----------
// טווחים מתוך כתובת החיפוש (מחיר / שנה / ק״מ), למשל year=2016-2020 או price=-1-50000 (-1 = ללא הגבלה)
const RANGE_PARAMS = ['price', 'year', 'km'];
function parseRange(v) {
  const m = /^(-?\d+)?-(-?\d+)?$/.exec(String(v || ''));
  if (!m) return null;
  const f = (x) => { if (x === undefined || x === '') return null; const n = Number(x); return n < 0 ? null : n; };
  return [f(m[1]), f(m[2])];
}
function searchRanges(pageUrl) {
  const out = {};
  try {
    const sp = new URL(pageUrl).searchParams;
    for (const k of RANGE_PARAMS) {
      const r = parseRange(sp.get(k));
      if (r && (r[0] !== null || r[1] !== null)) out[k] = r;
    }
  } catch (e) {}
  return out;
}
function matchesRanges(ranges, f) {
  for (const k of Object.keys(ranges)) {
    if (f[k] === undefined) continue;
    const v = Number(f[k]);
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = ranges[k];
    if (lo !== null && v < lo) return false;
    if (hi !== null && v > hi) return false;
  }
  return true;
}

// תאריך הפרסום המקורי של המודעה (לא תאריך ההקפצה/עדכון)
const CREATED_STRICT = /^(createdAt|created_at|created|createdDate|creationDate|dateCreated|date_created|adCreatedAt)$/i;
function adCreated(obj, depth) {
  const v = bfsFind(obj, CREATED_STRICT, toTs, depth);
  return v !== null ? v : bfsFind(obj, DATE_KEY, toTs, depth);
}

// =====================================================================
// מכאן: החלק של גרסת הענן (במקום chrome.storage / alarms / tabs)
// =====================================================================
const CONFIG = (() => { try { return JSON.parse(process.env.CONFIG_JSON || '{}'); } catch (e) { return {}; } })();
const STATE_FILE = process.env.STATE_FILE || path.join('state', 'state.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H_JSON = {
  'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  Referer: 'https://www.yad2.co.il/', Origin: 'https://www.yad2.co.il',
};
const H_HTML = {
  'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  Referer: 'https://www.yad2.co.il/',
};
const FRESH_GRACE_MS = 60 * 60 * 1000;   // מודעה נחשבת חדשה רק אם פורסמה אחרי (הקמת הסוכן פחות שעה)
const SEEN_LIMIT = 8000;
const ALL_PAGES_CAP = 300;
const FAIL_ALERT_AT = 3;        // אחרי כמה כשלונות רצופים שולחים התראת תקלה (פעם אחת)
const MAX_SEND_ATTEMPTS = 4;    // כמה פעמים מנסים שוב לשלוח התראה שנכשלה
const log = (s) => console.log(s);

// ---------- שליפה ----------
async function httpGet(url, headers) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000), redirect: 'follow' });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error('http ' + res.status); await sleep(2500); continue; }
      return res;
    } catch (e) { lastErr = new Error('network: ' + ((e && e.cause && e.cause.code) || (e && e.message) || e)); await sleep(2500); }
  }
  throw lastErr;
}
async function getJson(url) {
  const res = await httpGet(url, H_JSON);
  if (!res.ok) throw new Error('http ' + res.status);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { throw new Error('התשובה אינה JSON (בדיקת בוט?)'); }
}
async function pageJson(token) {
  const res = await httpGet(ITEM_URL(token), H_HTML);
  if (!res.ok) throw new Error('http ' + res.status);
  const m = NEXT_DATA_RE.exec(await res.text());
  if (!m) throw new Error('בדף המודעה אין נתונים (בדיקת בוט?)');
  return JSON.parse(m[1]);
}
// פרטי מודעה: קודם ה-API, ואם אין בו תאריך פרסום - דף המודעה עצמו
async function getItemJson(token) {
  let api = null, apiErr = null;
  try { api = await getJson(ITEM_API(token)); } catch (e) { apiErr = e; }
  if (api && adCreated(api, 8) !== null) return api;
  try {
    const pg = await pageJson(token);
    if (pg && (adCreated(pg, 10) !== null || !api)) return pg;
  } catch (e) { if (!api) throw apiErr || e; }
  return api;
}

// ---------- בחירת מודעות חדשות באמת ----------
async function pickFresh(agent, st, unseen) {
  const cutoff = (st.createdAt || 0) - FRESH_GRACE_MS;
  const ranges = searchRanges(agent.pageUrl || agent.feedUrl);
  const fresh = [];
  const cache = new Map();
  const retry = [];
  const retries = {};
  const prev = st.retries || {};
  const counts = { stale: 0, offSearch: 0, undated: 0, deferred: 0 };
  let fetched = 0;
  for (const it of unseen) {
    if (!matchesRanges(ranges, extractAd(it.token, it, null).fields)) { counts.offSearch++; continue; }
    let created = adCreated(it, 4);
    if (created === null) {
      if (fetched >= MAX_DETAIL_FETCH) { retry.push(it.token); counts.deferred++; continue; }
      try {
        const j = await getItemJson(it.token);
        cache.set(it.token, j);
        created = adCreated(j, 10);
      } catch (e) { /* ננסה שוב בסריקה הבאה */ }
      fetched++;
      await sleep(700);
      if (created === null) {
        const n = (prev[it.token] || 0) + 1;
        if (n < MAX_DATE_ATTEMPTS) { retry.push(it.token); retries[it.token] = n; counts.deferred++; continue; }
      }
    }
    if (created === null) {
      if (CONFIG.alertUndated) fresh.push(it); else counts.undated++;
      continue;
    }
    if (created < cutoff) { counts.stale++; continue; }
    fresh.push(it);
  }
  return { fresh, cache, counts, retry, retries };
}

// ---------- שליחת התראות: מייל (Apps Script) ו/או טלגרם ----------
const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+\/|macros\/)s\/[^/]+\/exec/;
function mailConfigured() { const m = CONFIG.mail || {}; return !!(m.scriptUrl && m.emailTo); }
function telegramConfigured() { const t = CONFIG.telegram || {}; return !!(t.token && t.chatId); }

async function sendMail(subject, html) {
  const m = CONFIG.mail || {};
  if (!SCRIPT_URL_RE.test(m.scriptUrl || '')) throw new Error('כתובת Apps Script לא תקינה (צריכה להסתיים ב-/exec)');
  const res = await fetch(m.scriptUrl, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: m.scriptSecret, to: m.emailTo, subject, html }), redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error('Apps Script ' + res.status);
  if (text !== 'ok') throw new Error(text.startsWith('<') ? 'הסקריפט החזיר דף שגיאה (בדוק פריסה: Web app, Execute as Me, Anyone)' : 'Apps Script: ' + text.slice(0, 120));
}
async function sendTelegram(text) {
  const t = CONFIG.telegram || {};
  const res = await fetch('https://api.telegram.org/bot' + t.token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: t.chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Telegram ' + res.status);
}
function telegramText(ad, agentName) {
  const f = ad.fields;
  const bits = [f.km !== undefined ? formatField('km', f.km) : null, f.hand ? 'יד ' + f.hand : null, f.city || null,
    f.phone ? '☎ ' + f.phone : null].filter(Boolean).join(' · ');
  return '🚗 <b>' + esc(ad.title) + '</b>' + (f.price !== undefined ? '\n' + esc(formatField('price', f.price)) : '') +
    (bits ? '\n' + esc(bits) : '') + (agentName ? '\nסוכן: ' + esc(agentName) : '') + '\n' + ad.url;
}
// מחזיר true אם לפחות ערוץ אחד הצליח (ואם אין ערוצים מוגדרים - false, כדי שלא נאבד מודעות בשקט)
async function notifyAd(ad, agentName) {
  let ok = false;
  if (mailConfigured()) {
    try { const mail = buildEmail(ad, agentName); await sendMail(mail.subject, mail.html); ok = true; }
    catch (e) { log('  שליחת מייל נכשלה: ' + (e && e.message)); }
  }
  if (telegramConfigured()) {
    try { await sendTelegram(telegramText(ad, agentName)); ok = true; }
    catch (e) { log('  שליחת טלגרם נכשלה: ' + (e && e.message)); }
  }
  return ok;
}
async function notifyText(subject, text) {
  if (mailConfigured()) { try { await sendMail(subject, '<div dir="rtl" style="font-family:Arial">' + esc(text) + '</div>'); } catch (e) { /* */ } }
  if (telegramConfigured()) { try { await sendTelegram('⚠️ ' + esc(subject) + '\n' + esc(text)); } catch (e) { /* */ } }
}

// ---------- מצב (נשמר בין ריצות ב-Actions cache) ----------
function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return s && typeof s === 'object' ? s : { agents: {} }; }
  catch (e) { return { agents: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}

const isDue = (a, st, now) => now - (st.lastRun || 0) >= Math.max(MIN_INTERVAL, Number(a.interval) || 5) * 60000 - 150000;

// ---------- סריקה של סוכן אחד ----------
async function runAgent(agent, st, label) {
  const now = Date.now();
  try {
    const items = [];
    const tokens = new Set();
    const allPages = agent.pages === 0;
    const maxPages = allPages ? ALL_PAGES_CAP : Math.max(1, Math.floor(agent.pages) || 2);
    for (let p = 1; p <= maxPages; p++) {
      const json = await getJson(pageUrlFor(agent.feedUrl, p));
      const found = collectItems(json);
      if (!found.length) break;
      let added = 0;
      found.forEach((it) => { if (!tokens.has(it.token)) { tokens.add(it.token); items.push(it); added++; } });
      if (allPages && !added) break;
      const total = bfsFind(json, /^(totalPages|lastPage|pagesCount|pageCount)$/i, convNum, 4);
      if (total && p >= total) break;
      if (p < maxPages) await sleep(900);
    }
    if (!items.length) throw new Error('לא נמצאו מודעות בתשובת השרת');

    const seen = Object.assign({}, st.seen);
    const unseen = items.filter((it) => !seen[it.token]);
    items.forEach((it) => { if (!seen[it.token]) seen[it.token] = now; });
    const keys = Object.keys(seen);
    if (keys.length > SEEN_LIMIT) keys.slice(0, keys.length - SEEN_LIMIT).forEach((k) => delete seen[k]);

    let status;
    let newRetries = {};
    const sendFails = Object.assign({}, st.sendFails);
    if (!st.baselineDone) {
      st.createdAt = now;
      status = 'נשמר בסיס התחלתי: ' + items.length + ' מודעות קיימות. מעכשיו תתקבל התראה רק על מודעות חדשות.';
    } else if (!unseen.length) {
      status = 'נסרקו ' + items.length + ' מודעות, אין חדשות.';
    } else {
      const { fresh, cache, counts, retry, retries } = await pickFresh(agent, st, unseen);
      newRetries = retries;
      retry.forEach((t) => { delete seen[t]; });
      const skipped = [];
      if (counts.stale) skipped.push(counts.stale + ' ישנות שהוקפצו');
      if (counts.offSearch) skipped.push(counts.offSearch + ' לא תואמות');
      if (counts.undated) skipped.push(counts.undated + ' ללא תאריך');
      if (counts.deferred) skipped.push(counts.deferred + ' ממתינות');
      let sent = 0;
      const list = fresh.slice(0, MAX_NEW_PER_RUN);
      fresh.slice(list.length).forEach((it) => { delete seen[it.token]; });   // יטופלו בסריקה הבאה
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        let itemJson = cache.get(it.token) || null;
        if (!itemJson) { try { itemJson = await getItemJson(it.token); } catch (e) { /* נשלח לפחות את נתוני הרשימה */ } }
        const ad = extractAd(it.token, it, itemJson);
        if (await notifyAd(ad, agent.name)) { sent++; delete sendFails[it.token]; }
        else {
          const n = (sendFails[it.token] || 0) + 1;
          if (n < MAX_SEND_ATTEMPTS) { sendFails[it.token] = n; delete seen[it.token]; }   // ננסה לשלוח שוב בסריקה הבאה
        }
        if (i < list.length - 1) await sleep(900);
      }
      status = (fresh.length ? 'נמצאו ' + fresh.length + ' מודעות חדשות, נשלחו ' + sent + '.' : 'נסרקו ' + items.length + ' מודעות, אין חדשות.') +
        (skipped.length ? ' (דולגו: ' + skipped.join(', ') + ')' : '');
    }
    Object.assign(st, { seen, retries: newRetries, sendFails, baselineDone: true, lastRun: now, failures: 0, lastError: '' });
    log(label + ': ' + status);
    return { ok: true, status };
  } catch (e) {
    const msg = String((e && e.message) || e);
    st.lastRun = now; st.lastError = msg; st.failures = (st.failures || 0) + 1;
    log(label + ': שגיאה: ' + msg + ' (כשלון רצוף ' + st.failures + ')');
    if (st.failures === FAIL_ALERT_AT) await notifyText('הסוכן "' + shortName(agent.name) + '" מתקשה לסרוק', msg + '\nייתכן שיד2 חוסמת את השרת.');
    return { ok: false, error: msg };
  }
}
function shortName(n) { n = String(n || '').trim(); return n.length > 40 ? n.slice(0, 38) + '…' : n; }

// ---------- מצבי הפעלה ----------
async function modeScan() {
  const agents = (CONFIG.agents || []).filter((a) => a && a.enabled !== false && a.feedUrl);
  if (!agents.length) { log('אין סוכנים בהגדרות (CONFIG_JSON).'); return; }
  const state = loadState();
  state.agents = state.agents || {};
  const now = Date.now();
  let first = true;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const id = a.id || ('a' + i);
    const st = state.agents[id] = state.agents[id] || {};
    if (!isDue(a, st, now)) { log('סוכן ' + (i + 1) + ': עדיין לא הגיע זמנו.'); continue; }
    if (!first) await sleep(2000);
    first = false;
    await runAgent(a, st, 'סוכן ' + (i + 1));
    saveState(state);   // שומרים אחרי כל סוכן, למקרה שהריצה תיקטע
  }
  saveState(state);
}

// בדיקה שיד2 עונה לשרת הזה: לא שולחת התראות ולא נוגעת במצב
async function modeCheck() {
  const agents = (CONFIG.agents || []).filter((a) => a && a.feedUrl);
  if (!agents.length) { log('אין סוכנים בהגדרות.'); process.exitCode = 1; return; }
  let okAll = true;
  for (let i = 0; i < agents.length; i++) {
    try {
      const json = await getJson(pageUrlFor(agents[i].feedUrl, 1));
      const items = collectItems(json);
      const created = items.map((it) => adCreated(it, 4)).filter((x) => x !== null).length;
      log('סוכן ' + (i + 1) + ': תקין. התקבלו ' + items.length + ' מודעות (' + created + ' עם תאריך פרסום ברשימה).');
      if (items[0]) {
        try { const j = await getItemJson(items[0].token); log('  דף מודעה בודד: תקין' + (adCreated(j, 10) !== null ? ', כולל תאריך פרסום.' : ', אבל בלי תאריך פרסום.')); }
        catch (e) { log('  דף מודעה בודד: נכשל (' + e.message + ')'); okAll = false; }
      }
    } catch (e) { log('סוכן ' + (i + 1) + ': נכשל: ' + e.message); okAll = false; }
    await sleep(1000);
  }
  log(okAll ? 'סיכום: יד2 עונה לשרת הזה. אפשר להפעיל את הסוכן.' : 'סיכום: יש בעיה. ראה למעלה (אם 403/429 או "בדיקת בוט" - יד2 חוסמת את השרת).');
  if (!okAll) process.exitCode = 1;
}

async function modeTestNotify() {
  if (!mailConfigured() && !telegramConfigured()) { log('לא הוגדר מייל או טלגרם.'); process.exitCode = 1; return; }
  const sample = extractAd('TEST123', {
    token: 'TEST123', manufacturer: { text: 'טויוטה' }, model: { text: 'קורולה' }, subModel: { text: 'GLI' },
    price: 85000, km: 42000, hand: 2, year: 2021, city: 'תל אביב', contactName: 'ישראל ישראלי',
    dates: { createdAt: new Date().toISOString() },
  }, null);
  const ok = await notifyAd(sample, 'בדיקה');
  log(ok ? 'נשלחה התראת בדיקה.' : 'שליחת הבדיקה נכשלה (ראה למעלה).');
  if (!ok) process.exitCode = 1;
}

async function main() {
  const mode = (process.argv[2] || process.env.MODE || 'scan').trim();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (mode === 'check') return modeCheck();
  if (mode === 'testnotify') return modeTestNotify();
  return modeScan();
}

if (require.main === module) main().catch((e) => { console.error('שגיאה כללית:', e && e.message); process.exitCode = 1; });
module.exports = { runAgent, pickFresh, loadState, saveState, collectItems, extractAd, isDue, setConfig: (c) => { Object.keys(CONFIG).forEach((k) => delete CONFIG[k]); Object.assign(CONFIG, c); } };

// Wedding photo collector — one Cloudflare Worker + one R2 bucket.
// No database: guest name + original filename live in R2 customMetadata.
// Heavy work (thumbnails, zipping) happens in the browser because the free
// plan only gives the Worker ~10 ms of CPU per request. Streaming bytes from
// the request into R2 costs almost no CPU.

import defaults from "./config.js";

const MiB = 1024 * 1024;
const SINGLE_MAX = 95 * MiB; // Workers cap request bodies at 100 MB
const PART_MAX = 30 * MiB; // client sends 25 MiB parts
const FILE_MAX = 5 * 1024 * MiB; // 5 GiB per file
const THUMB_MAX = 2 * MiB;
const HEADER_MAX = 15 * MiB;
const SESSION_DAYS = 30;
const COOKIE = "wp_admin";
const HEADER_KEY = "site/header";
// Wedding date chosen on the admin page. When present it beats the config.
const SETTINGS_KEY = "site/settings.json";
// Monogram / logo and browser icons, uploaded from the admin page.
const BRAND = {
  logo: { key: "site/logo", path: "/logo", types: ["image/png", "image/webp", "image/jpeg"] },
  favicon: { key: "site/favicon.ico", path: "/favicon.ico", types: ["image/x-icon", "image/vnd.microsoft.icon", "image/png"] },
  apple: { key: "site/apple-touch-icon.png", path: "/apple-touch-icon.png", types: ["image/png"] },
};
const BRAND_MAX = 5 * MiB;
// The couple's own photos, shown as polaroids on the guest page.
const POLAROID_PREFIX = "site/polaroids/";
const POLAROID_RE = /^site\/polaroids\/([a-z0-9]{6,12}-[a-z0-9]{10})$/;
const POLAROID_MAX = 4 * MiB; // the admin page shrinks photos before sending
const POLAROID_COUNT = 12;
const POLAROID_TYPES = ["image/jpeg", "image/webp", "image/png"];

const KEY_RE = /^uploads\/([a-z0-9]{6,12}-[a-z0-9]{10})(\.[a-z0-9]{1,8})?$/;
const MSG_RE = /^messages\/[a-z0-9]{6,12}-[a-z0-9]{10}\.json$/;
const MSG_MAX = 1000; // characters per guest message

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  // ---- pages ---------------------------------------------------------------
  if (method === "GET" || method === "HEAD") {
    if (path === "/") return page(env, url, "guest.html");
    if (path === "/admin") return page(env, url, "admin.html");
    if (path === "/admin/card") {
      if (!(await isAdmin(request, env))) return Response.redirect(new URL("/admin?next=card", url), 302);
      return page(env, url, "card.html");
    }
    if (path === "/header-photo") return siteFile(env, HEADER_KEY);
    for (const b of Object.values(BRAND)) if (path === b.path) return siteFile(env, b.key);
    if (path.startsWith("/polaroid/")) {
      const key = POLAROID_PREFIX + path.slice(10);
      return POLAROID_RE.test(key) ? siteFile(env, key) : new Response("Not found", { status: 404 });
    }
  }
  if (path.startsWith("/pages")) return new Response("Not found", { status: 404 });

  // ---- public API ----------------------------------------------------------
  if (path === "/api/status" && method === "GET") {
    const cfg = await siteConfig(env);
    return json({ ...windowState(cfg), isAdmin: await isAdmin(request, env) });
  }
  if (path === "/api/upload" && method === "PUT") return singleUpload(request, env, url);
  if (path === "/api/mpu/create" && method === "POST") return mpuCreate(request, env);
  if (path === "/api/mpu/part" && method === "PUT") return mpuPart(request, env, url);
  if (path === "/api/mpu/complete" && method === "POST") return mpuComplete(request, env);
  if (path === "/api/mpu/abort" && method === "POST") return mpuAbort(request, env);
  if (path === "/api/thumb" && method === "PUT") return thumbUpload(request, env, url);
  if (path === "/api/message" && method === "POST") return postMessage(request, env);

  // ---- admin API -----------------------------------------------------------
  if (path === "/api/admin/login" && method === "POST") return login(request, env, url);
  if (path === "/api/admin/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie(url, "", 0) });
  }
  if (path.startsWith("/api/admin/")) {
    if (!(await isAdmin(request, env))) return json({ error: "Please log in." }, 401);
    if (path === "/api/admin/files" && method === "GET") return listFiles(env);
    if (path === "/api/admin/file" && method === "GET") return getFile(request, env, url);
    if (path === "/api/admin/file" && method === "DELETE") return deleteFile(env, url);
    if (path === "/api/admin/thumb" && method === "GET") return getThumb(env, url);
    if (path === "/api/admin/messages" && method === "GET") return listMessages(env);
    if (path === "/api/admin/message" && method === "DELETE") return deleteMessage(env, url);
    if (path === "/api/admin/delete-all" && method === "POST") return deleteAll(request, env);
    if (path === "/api/admin/header" && method === "PUT") return putHeader(request, env);
    if (path === "/api/admin/header" && method === "DELETE") {
      await env.BUCKET.delete(HEADER_KEY);
      return json({ ok: true });
    }
    if (path === "/api/admin/polaroid" && method === "PUT") return putPolaroid(request, env, url);
    if (path === "/api/admin/polaroid" && method === "PATCH") return captionPolaroid(request, env, url);
    if (path === "/api/admin/polaroid" && method === "DELETE") {
      const key = url.searchParams.get("key");
      if (!POLAROID_RE.test(String(key))) return json({ error: "Bad key." }, 400);
      await env.BUCKET.delete(key);
      return json({ ok: true });
    }
    if (path === "/api/admin/brand" && method === "PUT") return putBrand(request, env, url);
    if (path === "/api/admin/date" && method === "PUT") return putDate(request, env);
    if (path === "/api/admin/date" && method === "DELETE") {
      await env.BUCKET.delete(SETTINGS_KEY);
      settingsCache = { at: 0, value: null };
      return json(publicDates(await siteConfig(env)));
    }
    if (path === "/api/admin/brand" && method === "DELETE") {
      await env.BUCKET.delete(Object.values(BRAND).map((b) => b.key));
      return json({ ok: true });
    }
  }
  if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

  // ---- static files (fonts, scripts, styles) -------------------------------
  return env.ASSETS.fetch(request);
}

// ===========================================================================
//  Config
// ===========================================================================

const OVERRIDES = {
  COUPLE_NAMES: "coupleNames",
  WEDDING_DAY: "weddingDay",
  UPLOAD_OPENS_AT: "uploadOpensAt",
  UPLOAD_DAYS: "uploadDays",
  WEDDING_DATE: "weddingDate",
  VENUE: "venue",
  WELCOME_MESSAGE: "welcomeMessage",
  UPLOAD_OPENS: "uploadOpens",
  UPLOAD_CLOSES: "uploadCloses",
  TIMEZONE: "timezone",
  FONT: "font",
  HEADER_PHOTO: "headerPhoto",
  SITE_URL: "siteUrl",
  STORAGE_LIMIT_GB: "storageLimitGB",
  WIFI_NAME: "wifiName",
  WIFI_PASSWORD: "wifiPassword",
  WIFI_SECURITY: "wifiSecurity",
};
const COLOR_OVERRIDES = { COLOR_BACKGROUND: "background", COLOR_PRIMARY: "primary", COLOR_TEXT: "text", COLOR_ACCENT: "accent" };

function config(env) {
  const cfg = { ...defaults, colors: { ...defaults.colors } };
  for (const [name, field] of Object.entries(OVERRIDES)) {
    if (typeof env[name] === "string" && env[name].trim() !== "") cfg[field] = env[name].trim();
  }
  for (const [name, field] of Object.entries(COLOR_OVERRIDES)) {
    if (typeof env[name] === "string" && env[name].trim() !== "") cfg.colors[field] = env[name].trim();
  }
  for (const k of Object.keys(cfg.colors)) {
    if (!/^#[0-9a-fA-F]{3,8}$/.test(cfg.colors[k])) cfg.colors[k] = defaults.colors[k];
  }
  cfg.storageLimitGB = Number(cfg.storageLimitGB) || 10;
  if (cfg.font !== "modern") cfg.font = "serif";
  // Older setups give exact upload times but no WEDDING_DAY: take the day from UPLOAD_OPENS.
  const opensDay = String(cfg.uploadOpens || "").slice(0, 10);
  if (!String(env.WEDDING_DAY || "").trim() && validDay(opensDay)) cfg.weddingDay = opensDay;
  return cfg;
}

// The config plus the wedding date saved on the admin page, with the shown date
// and the upload window worked out from the wedding day where they aren't given.
async function siteConfig(env) {
  const cfg = config(env);
  const saved = await savedSettings(env);
  cfg.dateSource = "config";
  if (saved && validDay(saved.weddingDay)) {
    cfg.dateSource = "admin";
    cfg.weddingDay = saved.weddingDay;
    cfg.uploadOpensAt = saved.uploadOpensAt;
    cfg.uploadDays = saved.uploadDays;
    // A date picked on the admin page replaces any exact values in the config.
    cfg.weddingDate = cfg.uploadOpens = cfg.uploadCloses = "";
  }
  if (!validTime(cfg.uploadOpensAt)) cfg.uploadOpensAt = "12:00";
  cfg.uploadDays = cleanDays(cfg.uploadDays);
  if (validDay(cfg.weddingDay)) {
    if (!cfg.weddingDate) cfg.weddingDate = longDate(cfg.weddingDay);
    if (!cfg.uploadOpens) cfg.uploadOpens = zonedIso(cfg.weddingDay, cfg.uploadOpensAt + ":00", cfg.timezone);
    if (!cfg.uploadCloses) cfg.uploadCloses = zonedIso(addDays(cfg.weddingDay, cfg.uploadDays), "23:59:59", cfg.timezone);
  }
  return cfg;
}

// Read at most every few seconds per Worker instance, since every upload checks the window.
let settingsCache = { at: 0, value: null };
async function savedSettings(env) {
  if (Date.now() - settingsCache.at < 10_000) return settingsCache.value;
  let value = null;
  const obj = await env.BUCKET.get(SETTINGS_KEY);
  if (obj) {
    try {
      value = await obj.json();
    } catch {
      value = null;
    }
  }
  settingsCache = { at: Date.now(), value };
  return value;
}

function validDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const cleanDays = (n) => Math.min(60, Math.max(1, Math.round(Number(n)) || 7));

function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// "2027-09-18" -> "September 18, 2027"
function longDate(day) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(day + "T12:00:00Z"));
}

// How far the time zone is ahead of UTC at that moment, in ms.
function tzOffset(utcMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return 0; // unknown time zone: treat as UTC
  }
}

// A wall-clock time on a day in a time zone, as "YYYY-MM-DDTHH:MM:SS+HH:MM".
function zonedIso(day, time, timeZone) {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  let off = tzOffset(wall, timeZone);
  off = tzOffset(wall - off, timeZone); // a second pass settles daylight-saving edges
  const mins = Math.round(Math.abs(off) / 60000);
  const two = (n) => String(n).padStart(2, "0");
  return `${day}T${time}${off < 0 ? "-" : "+"}${two(Math.floor(mins / 60))}:${two(mins % 60)}`;
}

function publicDates(cfg) {
  return {
    weddingDay: cfg.weddingDay,
    weddingDate: cfg.weddingDate,
    uploadOpensAt: cfg.uploadOpensAt,
    uploadDays: cfg.uploadDays,
    uploadOpens: cfg.uploadOpens,
    uploadCloses: cfg.uploadCloses,
    dateSource: cfg.dateSource,
  };
}

async function putDate(request, env) {
  const body = await readJson(request);
  if (!validDay(body.weddingDay)) return json({ error: "Please pick the wedding day." }, 400);
  const at = body.uploadOpensAt === undefined || body.uploadOpensAt === "" ? "12:00" : String(body.uploadOpensAt).slice(0, 5);
  if (!validTime(at)) return json({ error: "Please pick the time uploads open." }, 400);
  const value = { weddingDay: body.weddingDay, uploadOpensAt: at, uploadDays: cleanDays(body.uploadDays) };
  await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
  settingsCache = { at: Date.now(), value };
  return json(publicDates(await siteConfig(env)));
}

function windowState(cfg) {
  const now = Date.now();
  const opens = Date.parse(cfg.uploadOpens);
  const closes = Date.parse(cfg.uploadCloses);
  let state = "open";
  if (!Number.isNaN(opens) && now < opens) state = "before";
  else if (!Number.isNaN(closes) && now >= closes) state = "after";
  return { state, open: state === "open", opens: cfg.uploadOpens, closes: cfg.uploadCloses, now };
}

async function canUpload(request, env) {
  if (windowState(await siteConfig(env)).open) return true;
  return isAdmin(request, env);
}

async function closedResponse(env) {
  const w = windowState(await siteConfig(env));
  const msg = w.state === "before" ? "Uploads aren't open yet." : "Uploads are closed.";
  return json({ error: msg, state: w.state }, 403);
}

// ===========================================================================
//  Pages
// ===========================================================================

async function page(env, url, file) {
  const res = await env.ASSETS.fetch(new Request(new URL("/pages/" + file, url)));
  if (!res.ok) return new Response("Page missing: " + file, { status: 500 });
  const cfg = await siteConfig(env);

  // One list call tells us which site images (header, logo, icons) exist.
  const site = {};
  const polaroids = [];
  const listed = await env.BUCKET.list({ prefix: "site/", include: ["customMetadata"] });
  for (const o of listed.objects) {
    site[o.key] = encodeURIComponent(o.etag);
    const m = POLAROID_RE.exec(o.key);
    if (m) polaroids.push({ src: "/polaroid/" + m[1] + "?v=" + site[o.key], caption: decode(o.customMetadata && o.customMetadata.caption) });
  }
  const ver = (key, path) => (site[key] ? path + "?v=" + site[key] : "");
  const header = cfg.headerPhoto || ver(HEADER_KEY, "/header-photo");
  const logo = ver(BRAND.logo.key, BRAND.logo.path);
  const pub = {
    coupleNames: cfg.coupleNames,
    ...publicDates(cfg),
    venue: cfg.venue,
    welcomeMessage: cfg.welcomeMessage,
    timezone: cfg.timezone,
    font: cfg.font,
    headerPhoto: header || "",
    headerFromBucket: !cfg.headerPhoto && !!header,
    siteUrl: cfg.siteUrl,
    storageLimitGB: cfg.storageLimitGB,
    logo,
    polaroids, // oldest first: ids start with the upload time
  };
  // Wi-Fi details only go to the QR card page, which is admin-only.
  if (file === "card.html") {
    pub.wifiName = cfg.wifiName || "";
    pub.wifiPassword = cfg.wifiPassword || "";
    pub.wifiSecurity = cfg.wifiSecurity || "WPA";
  }
  const c = cfg.colors;
  const inject =
    `<script>window.WEDDING=${JSON.stringify(pub).replace(/</g, "\\u003c")};</script>` +
    `<style>:root{--bg:${c.background};--primary:${c.primary};--text:${c.text};--accent:${c.accent};}</style>` +
    (site[BRAND.favicon.key] ? `<link rel="icon" href="${ver(BRAND.favicon.key, BRAND.favicon.path)}" sizes="any">` : "") +
    (site[BRAND.apple.key] ? `<link rel="apple-touch-icon" href="${ver(BRAND.apple.key, BRAND.apple.path)}">` : "");
  let html = await res.text();
  html = html.replace("<!--WEDDING-->", inject).replaceAll("{{COUPLE}}", escapeHtml(cfg.coupleNames));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}

async function siteFile(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("ETag", obj.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

// ===========================================================================
//  Guest uploads
// ===========================================================================

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let rand = "";
  for (const b of bytes) rand += alphabet[b % 36];
  return Date.now().toString(36) + "-" + rand;
}

function cleanText(s, max) {
  return String(s || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanFilename(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  return cleanText(base.replace(/[<>:"|?*]/g, "_"), 90) || "file";
}

function extOf(filename) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return m ? "." + m[1].toLowerCase() : "";
}

function cleanType(t) {
  t = String(t || "").toLowerCase();
  return /^(image|video)\/[a-z0-9.+-]+$/.test(t) ? t : "application/octet-stream";
}

function newObject(filename, guest, type) {
  const name = cleanFilename(filename);
  const id = newId();
  return {
    id,
    key: "uploads/" + id + extOf(name),
    httpMetadata: { contentType: cleanType(type) },
    // Encoded so names like "Niño" survive every R2 API path unchanged.
    customMetadata: {
      guest: encodeURIComponent(cleanText(guest, 50)),
      filename: encodeURIComponent(name),
      uploadedAt: new Date().toISOString(),
    },
  };
}

// Every upload must say who sent it.
const NAME_MISSING = () => json({ error: "Please enter your name first." }, 400);

function contentLength(request) {
  const n = Number(request.headers.get("Content-Length"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function singleUpload(request, env, url) {
  if (!(await canUpload(request, env))) return closedResponse(env);
  const len = contentLength(request);
  if (!len) return json({ error: "Empty upload." }, 411);
  if (len > SINGLE_MAX) return json({ error: "File too large for a single upload." }, 413);
  if (!cleanText(url.searchParams.get("guest"), 50)) return NAME_MISSING();

  const obj = newObject(url.searchParams.get("name"), url.searchParams.get("guest"), request.headers.get("Content-Type"));
  await env.BUCKET.put(obj.key, request.body, {
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata,
  });
  return json({ id: obj.id, key: obj.key });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function mpuCreate(request, env) {
  if (!(await canUpload(request, env))) return closedResponse(env);
  const body = await readJson(request);
  const size = Number(body.size) || 0;
  if (size > FILE_MAX) return json({ error: "Files can be at most 5 GB." }, 413);
  if (!cleanText(body.guest, 50)) return NAME_MISSING();
  const obj = newObject(body.name, body.guest, body.type);
  const mpu = await env.BUCKET.createMultipartUpload(obj.key, {
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata,
  });
  return json({ id: obj.id, key: obj.key, uploadId: mpu.uploadId });
}

function validKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

async function mpuPart(request, env, url) {
  if (!(await canUpload(request, env))) return closedResponse(env);
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  const part = Number(url.searchParams.get("part"));
  if (!validKey(key) || !uploadId || !Number.isInteger(part) || part < 1 || part > 10000) {
    return json({ error: "Bad part request." }, 400);
  }
  const len = contentLength(request);
  if (!len) return json({ error: "Empty part." }, 411);
  if (len > PART_MAX) return json({ error: "Part too large." }, 413);
  const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
  const uploaded = await mpu.uploadPart(part, request.body);
  return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

async function mpuComplete(request, env) {
  // No window check here: if every part arrived in time, let the file finish.
  const { key, uploadId, parts } = await readJson(request);
  if (!validKey(key) || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return json({ error: "Bad complete request." }, 400);
  }
  const clean = parts
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || "") }))
    .sort((a, b) => a.partNumber - b.partNumber);
  const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
  const obj = await mpu.complete(clean);
  return json({ key, size: obj.size });
}

async function mpuAbort(request, env) {
  const { key, uploadId } = await readJson(request);
  if (!validKey(key) || !uploadId) return json({ error: "Bad abort request." }, 400);
  try {
    await env.BUCKET.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    /* already gone */
  }
  return json({ ok: true });
}

async function thumbUpload(request, env, url) {
  if (!(await canUpload(request, env))) return closedResponse(env);
  const key = url.searchParams.get("key");
  const m = validKey(key) && KEY_RE.exec(key);
  if (!m) return json({ error: "Bad thumbnail request." }, 400);
  const len = contentLength(request);
  if (!len) return json({ error: "Empty thumbnail." }, 411);
  if (len > THUMB_MAX) return json({ error: "Thumbnail too large." }, 413);
  if (!(await env.BUCKET.head(key))) return json({ error: "Original not found." }, 404);
  await env.BUCKET.put("thumbs/" + m[1] + ".jpg", request.body, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  return json({ ok: true });
}

// ===========================================================================
//  Admin auth (stateless signed cookie — no database needed)
// ===========================================================================

const enc = new TextEncoder();

async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookie(url, value, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function login(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return json({ error: "ADMIN_PASSWORD is not set. See the README, step 'Set the admin password'." }, 500);
  }
  const { password } = await readJson(request);
  // Compare hashes so the comparison time doesn't depend on the password.
  const ok = safeEqual(await hmac("pw", String(password || "")), await hmac("pw", env.ADMIN_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return json({ error: "Wrong password." }, 401);
  }
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const token = exp + "." + (await hmac(env.ADMIN_PASSWORD, "admin:" + exp));
  return json({ ok: true }, 200, { "Set-Cookie": cookie(url, token, SESSION_DAYS * 86400) });
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const raw = request.headers.get("Cookie") || "";
  const m = new RegExp("(?:^|;\\s*)" + COOKIE + "=(\\d+)\\.([a-f0-9]{64})").exec(raw);
  if (!m) return false;
  if (Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], await hmac(env.ADMIN_PASSWORD, "admin:" + m[1]));
}

// ===========================================================================
//  Admin: files
// ===========================================================================

function decode(s) {
  try {
    return decodeURIComponent(s || "");
  } catch {
    return s || "";
  }
}

async function listAll(env, options) {
  const out = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ ...options, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function listFiles(env) {
  const cfg = config(env);
  const objects = await listAll(env, { include: ["customMetadata", "httpMetadata"] });
  const thumbs = new Set();
  let totalBytes = 0;
  for (const o of objects) {
    totalBytes += o.size;
    if (o.key.startsWith("thumbs/")) thumbs.add(o.key.slice(7, -4));
  }
  const files = [];
  const guests = new Set();
  let photos = 0;
  let videos = 0;
  for (const o of objects) {
    const m = KEY_RE.exec(o.key);
    if (!m) continue;
    const meta = o.customMetadata || {};
    const type = (o.httpMetadata && o.httpMetadata.contentType) || "";
    const guest = decode(meta.guest);
    guests.add(guest || "(no name)");
    if (type.startsWith("video/")) videos++;
    else photos++;
    files.push({
      key: o.key,
      id: m[1],
      size: o.size,
      type,
      guest,
      filename: decode(meta.filename) || o.key.slice(8),
      uploadedAt: meta.uploadedAt || o.uploaded,
      hasThumb: thumbs.has(m[1]),
    });
  }
  files.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  return json({
    files,
    stats: {
      totalBytes,
      limitBytes: cfg.storageLimitGB * 1e9,
      fileCount: files.length,
      guestCount: guests.size,
      photos,
      videos,
    },
  });
}

async function getFile(request, env, url) {
  const key = url.searchParams.get("key");
  if (!validKey(key)) return json({ error: "Bad key." }, 400);
  const obj = await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return json({ error: "Not found." }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
  const filename = decode(obj.customMetadata && obj.customMetadata.filename) || key.slice(8);
  const disposition = url.searchParams.get("dl") ? "attachment" : "inline";
  headers.set(
    "Content-Disposition",
    `${disposition}; filename="${filename.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );

  if (!("body" in obj) || !obj.body) return new Response(null, { status: 304, headers });

  let status = 200;
  if (obj.range && request.headers.has("Range")) {
    let offset;
    let length;
    if (typeof obj.range.suffix === "number") {
      length = Math.min(obj.range.suffix, obj.size);
      offset = obj.size - length;
    } else {
      offset = obj.range.offset || 0;
      length = obj.range.length ?? obj.size - offset;
    }
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(obj.size));
  }
  return new Response(obj.body, { status, headers });
}

async function getThumb(env, url) {
  const key = url.searchParams.get("key");
  const m = validKey(key) && KEY_RE.exec(key);
  if (!m) return json({ error: "Bad key." }, 400);
  const obj = await env.BUCKET.get("thumbs/" + m[1] + ".jpg");
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}

async function deleteFile(env, url) {
  const key = url.searchParams.get("key");
  const m = validKey(key) && KEY_RE.exec(key);
  if (!m) return json({ error: "Bad key." }, 400);
  await env.BUCKET.delete([key, "thumbs/" + m[1] + ".jpg"]);
  return json({ ok: true });
}

async function deleteAll(request, env) {
  const { confirm } = await readJson(request);
  if (confirm !== "DELETE") return json({ error: 'Type DELETE to confirm.' }, 400);
  let deleted = 0;
  for (const prefix of ["uploads/", "thumbs/", "messages/"]) {
    const objects = await listAll(env, { prefix });
    for (let i = 0; i < objects.length; i += 1000) {
      const keys = objects.slice(i, i + 1000).map((o) => o.key);
      await env.BUCKET.delete(keys);
      deleted += keys.length;
    }
  }
  return json({ ok: true, deleted });
}

// ===========================================================================
//  Guest messages: one small JSON file per message under messages/.
// ===========================================================================

// Like cleanText, but keeps line breaks so a note can have paragraphs.
function cleanMessage(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MSG_MAX);
}

async function postMessage(request, env) {
  if (!(await canUpload(request, env))) return closedResponse(env);
  const body = await readJson(request);
  const guest = cleanText(body.guest, 50);
  if (!guest) return NAME_MISSING();
  const text = cleanMessage(body.text);
  if (!text) return json({ error: "Your message is empty." }, 400);
  const id = newId();
  const at = new Date().toISOString();
  await env.BUCKET.put("messages/" + id + ".json", JSON.stringify({ guest, text, at }), {
    httpMetadata: { contentType: "application/json" },
  });
  return json({ ok: true, id });
}

async function listMessages(env) {
  const objects = await listAll(env, { prefix: "messages/" });
  const messages = [];
  // Read in small batches so a big guestbook doesn't open hundreds of reads at once.
  for (let i = 0; i < objects.length; i += 25) {
    const batch = await Promise.all(
      objects.slice(i, i + 25).map(async (o) => {
        const obj = await env.BUCKET.get(o.key);
        if (!obj) return null;
        try {
          const m = await obj.json();
          return { key: o.key, guest: String(m.guest || ""), text: String(m.text || ""), at: m.at || o.uploaded };
        } catch {
          return null;
        }
      }),
    );
    messages.push(...batch.filter(Boolean));
  }
  messages.sort((a, b) => (a.at < b.at ? 1 : -1));
  return json({ messages });
}

async function deleteMessage(env, url) {
  const key = url.searchParams.get("key");
  if (typeof key !== "string" || !MSG_RE.test(key)) return json({ error: "Bad key." }, 400);
  await env.BUCKET.delete(key);
  return json({ ok: true });
}

async function putHeader(request, env) {
  const len = contentLength(request);
  const type = String(request.headers.get("Content-Type") || "");
  if (!len) return json({ error: "Empty image." }, 411);
  if (len > HEADER_MAX) return json({ error: "Header photo must be under 15 MB." }, 413);
  if (!type.startsWith("image/")) return json({ error: "Please choose an image." }, 415);
  await env.BUCKET.put(HEADER_KEY, request.body, { httpMetadata: { contentType: type } });
  return json({ ok: true });
}

async function putBrand(request, env, url) {
  const b = BRAND[url.searchParams.get("kind")];
  if (!b) return json({ error: "Unknown kind." }, 400);
  const len = contentLength(request);
  const type = String(request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!len) return json({ error: "Empty image." }, 411);
  if (len > BRAND_MAX) return json({ error: "Image must be under 5 MB." }, 413);
  if (!b.types.includes(type)) return json({ error: "Please choose a PNG, WebP or JPEG image." }, 415);
  await env.BUCKET.put(b.key, request.body, { httpMetadata: { contentType: type } });
  return json({ ok: true });
}

async function putPolaroid(request, env, url) {
  const len = contentLength(request);
  const type = String(request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!len) return json({ error: "Empty image." }, 411);
  if (len > POLAROID_MAX) return json({ error: "Image must be under 4 MB." }, 413);
  if (!POLAROID_TYPES.includes(type)) return json({ error: "Please choose a JPEG, WebP or PNG photo." }, 415);
  const existing = await env.BUCKET.list({ prefix: POLAROID_PREFIX });
  if (existing.objects.length >= POLAROID_COUNT) return json({ error: `You can show up to ${POLAROID_COUNT} photos. Remove one first.` }, 409);
  const id = newId();
  await env.BUCKET.put(POLAROID_PREFIX + id, request.body, {
    httpMetadata: { contentType: type },
    customMetadata: { caption: encodeURIComponent(cleanText(url.searchParams.get("caption"), 60)) },
  });
  return json({ ok: true, key: POLAROID_PREFIX + id });
}

// R2 can't edit metadata in place, so the (small) photo is written again with the new caption.
async function captionPolaroid(request, env, url) {
  const key = url.searchParams.get("key");
  if (!POLAROID_RE.test(String(key))) return json({ error: "Bad key." }, 400);
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: "Not found." }, 404);
  const { caption } = await readJson(request);
  await env.BUCKET.put(key, await obj.arrayBuffer(), {
    httpMetadata: obj.httpMetadata,
    customMetadata: { caption: encodeURIComponent(cleanText(caption, 60)) },
  });
  return json({ ok: true });
}

// ===========================================================================
//  Helpers
// ===========================================================================

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

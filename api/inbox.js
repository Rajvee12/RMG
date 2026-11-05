// Inbox for files pushed by Power Automate (or any scheduled job) when a sheet can't be shared by link.
//
//   POST /api/inbox?key=indigo     Power Automate sends the file here every time it changes.
//        header  x-rmg-token: <RMG_PUSH_TOKEN>
//        body    the file itself (application/octet-stream), or JSON {"$content": "<base64>"} as
//                Power Automate's "Get file content" returns it, or JSON {"file": "<base64>"}.
//   GET  /api/inbox?key=indigo     The site reads the latest file (signed-in @aionos.ai users only).
//   GET  /api/inbox                Lists what has been received (signed-in users only).
//   GET  /api/inbox?config=1       Setup state for the site's Automation tab (signed-in users only).
//   POST /api/inbox?key=indigo     with a signed-in user's Authorization header instead of x-rmg-token:
//                                  a test upload from the Automation tab.
//
// Files are kept in the private Supabase Storage bucket "inbox" (created on first use), one file per key.
// Env vars: RMG_PUSH_TOKEN (any long random string, also pasted into the flow),
//           SUPABASE_SERVICE_ROLE_KEY (Supabase → Project settings → API keys → service_role / secret).

const crypto = require("crypto");
const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_JuFmt8_yIAtaks9226AGcw_kf_6oUXS";
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PUSH_TOKEN = process.env.RMG_PUSH_TOKEN || "";
const ALLOWED_DOMAIN = "aionos.ai";
const BUCKET = "inbox";
const MAX_BYTES = 4 * 1024 * 1024; // Vercel caps request and response bodies at 4.5 MB

const fail = (res, status, message) => res.status(status).json({ error: true, message });
const svc = extra => Object.assign({ apikey: SB_SERVICE, authorization: "Bearer " + SB_SERVICE }, extra || {});
const cleanKey = k => String(k || "").trim().toLowerCase();
const KEY_OK = /^[a-z0-9][a-z0-9-]{0,39}$/;

function sameToken(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function signedInUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u.email || "").toLowerCase().endsWith("@" + ALLOWED_DOMAIN) ? u : null;
}

// The file from the request, whatever shape Power Automate sent it in
async function fileFrom(req) {
  let b;
  try { b = req.body; } catch (_) { b = undefined; } // Vercel throws on invalid JSON
  if (b === undefined || b === null) {
    // Vercel has already read the stream; for content types it doesn't parse (e.g. an Excel file's own type)
    // it replays the raw bytes only to "data"/"end" listeners, so read them that way.
    b = await new Promise((resolve, reject) => {
      const parts = [];
      req.on("data", c => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(parts)));
      req.on("error", reject);
    });
  }
  if (Buffer.isBuffer(b)) {
    const s = b.slice(0, 1).toString();
    if (s !== "{") return b;
    try { b = JSON.parse(b.toString("utf8")); } catch (_) { return b; }
  }
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (_) { return Buffer.from(b, "base64"); }
  }
  if (b && typeof b === "object") {
    const v = b.$content || b.file || b.content || (b.body && (b.body.$content || b.body));
    if (typeof v === "string") return Buffer.from(v, "base64");
  }
  return null;
}

async function ensureBucket() {
  const r = await fetch(`${SB_URL}/storage/v1/bucket/${BUCKET}`, { headers: svc() });
  if (r.ok) return;
  const c = await fetch(`${SB_URL}/storage/v1/bucket`, {
    method: "POST", headers: svc({ "content-type": "application/json" }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (!c.ok && c.status !== 409) throw new Error("Couldn't create the inbox storage bucket (" + c.status + ").");
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const isConfig = req.method === "GET" && !!req.query.config;
  if (!SB_SERVICE && !isConfig) return fail(res, 503, "The inbox isn't set up yet: add SUPABASE_SERVICE_ROLE_KEY in Vercel and redeploy.");
  const key = cleanKey(req.query.key);

  if (req.method === "POST") {
    const viaToken = req.headers["x-rmg-token"] !== undefined;
    if (viaToken) {
      if (!PUSH_TOKEN) return fail(res, 503, "The inbox isn't set up yet: add RMG_PUSH_TOKEN in Vercel and redeploy.");
      if (!sameToken(req.headers["x-rmg-token"], PUSH_TOKEN)) return fail(res, 401, "Wrong x-rmg-token.");
    } else {
      let user = null;
      try { user = await signedInUser(req); } catch (_) {}
      if (!user) return fail(res, 401, "Send the x-rmg-token header (or sign in to the site).");
    }
    if (!KEY_OK.test(key)) return fail(res, 400, "Add ?key=<name> to the address: lowercase letters, digits and dashes, e.g. ?key=indigo.");
    let buf;
    try { buf = await fileFrom(req); } catch (_) { buf = null; }
    if (!buf || !buf.length) return fail(res, 400, "No file in the request body. Send the file content from 'Get file content'.");
    if (buf.length > MAX_BYTES) return fail(res, 413, "That file is over 4 MB. Send a smaller file or a single tab.");
    try {
      await ensureBucket();
      const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${key}.bin`, {
        method: "POST", headers: svc({ "content-type": "application/octet-stream", "x-upsert": "true" }), body: buf,
      });
      if (!r.ok) return fail(res, 502, "Storage refused the file (" + r.status + ").");
      return res.status(200).json({ ok: true, key, bytes: buf.length, received: new Date().toISOString() });
    } catch (e) {
      return fail(res, 502, e && e.message ? e.message : "Couldn't store the file.");
    }
  }

  if (req.method !== "GET") return fail(res, 405, "Use GET or POST.");
  try {
    if (!(await signedInUser(req))) return fail(res, 401, "Sign in with your @" + ALLOWED_DOMAIN + " account.");
  } catch (_) {
    return fail(res, 502, "Couldn't check your sign-in. Try again.");
  }

  if (isConfig) { // what the Automation tab needs to show the flow settings
    const missing = [!SB_SERVICE && "SUPABASE_SERVICE_ROLE_KEY", !PUSH_TOKEN && "RMG_PUSH_TOKEN"].filter(Boolean);
    return res.status(200).json({ ready: !missing.length, missing, token: PUSH_TOKEN || "" });
  }
  if (!key) { // list what has arrived
    const r = await fetch(`${SB_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: svc({ "content-type": "application/json" }), body: JSON.stringify({ prefix: "", limit: 200 }),
    });
    const d = r.ok ? await r.json() : [];
    return res.status(200).json({ files: (Array.isArray(d) ? d : []).filter(f => /\.bin$/.test(f.name)).map(f => ({ key: f.name.replace(/\.bin$/, ""), updated: f.updated_at, bytes: f.metadata && f.metadata.size })) });
  }
  if (!KEY_OK.test(key)) return fail(res, 400, "That inbox name isn't valid.");
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${key}.bin`, { headers: svc() });
  if (r.status === 400 || r.status === 404) return fail(res, 404, `Nothing received for "${key}" yet. Run the Power Automate flow once (or save the file) and sync again.`);
  if (!r.ok) return fail(res, 502, "Storage answered " + r.status + ".");
  res.setHeader("content-type", "application/octet-stream");
  return res.status(200).send(Buffer.from(await r.arrayBuffer()));
};

// Recruiter nudges: a short motivational email to each recruiter with their own numbers.
//
//   GET  /api/recruiter-nudges                      Authorization: Bearer <CRON_SECRET>  (Vercel Cron, weekdays ~9:30 am IST)
//        -> sends to every recruiter switched on, if nudges are on and today is one of the chosen days
//   POST /api/recruiter-nudges?test=1&key=<team|name>   (signed-in @aionos.ai user) -> that recruiter's nudge, to you only
//   POST /api/recruiter-nudges?now=1&team=ta|ig         (signed-in @aionos.ai user) -> send today's nudges to that team now
//
// The site saves every recruiter's nudge to ledger_docs "report/nudges" while a team member has it open
// (same pattern as the leadership email). Settings live in "app/nudges".
// Env: CRON_SECRET, MAIL_FLOW_URL, SUPABASE_SERVICE_ROLE_KEY, optional NUDGE_EXTRA_DOMAINS (comma list, e.g. "goindigo.in").

const crypto = require("crypto");
const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_JuFmt8_yIAtaks9226AGcw_kf_6oUXS";
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const FLOW = process.env.MAIL_FLOW_URL || "";
const DOMAIN = "aionos.ai";
const DOMAINS = [DOMAIN, ...String(process.env.NUDGE_EXTRA_DOMAINS || "").split(/[,;\s]+/).map(d => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)];
const STALE_DAYS = 3;

const fail = (res, status, error, message) => res.status(status).json({ error, message });
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const okMail = a => { const m = /^[^@\s,;]+@([^@\s,;]+)$/.exec(String(a || "").trim().toLowerCase()); return !!m && DOMAINS.includes(m[1]); };
const okAionos = a => /^[^@\s,;]+@aionos\.ai$/i.test(String(a || "").trim());
const istNow = () => new Date(Date.now() + 5.5 * 36e5);
const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 36e5).toISOString().slice(0, 10);

async function readDoc(path) {
  const r = await fetch(`${SB_URL}/rest/v1/ledger_docs?path=eq.${encodeURIComponent(path)}&select=data`, {
    headers: { apikey: SB_SERVICE, authorization: "Bearer " + SB_SERVICE },
  });
  if (!r.ok) throw new Error("Database answered " + r.status);
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || null;
}
async function mergeDoc(path, patch) {
  const cur = (await readDoc(path)) || {};
  const r = await fetch(`${SB_URL}/rest/v1/ledger_docs?on_conflict=path`, {
    method: "POST",
    headers: { apikey: SB_SERVICE, authorization: "Bearer " + SB_SERVICE, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ path, data: Object.assign({}, cur, patch) }),
  });
  if (!r.ok) throw new Error("Database answered " + r.status);
}
async function signedInUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u.email || "").toLowerCase().endsWith("@" + DOMAIN) ? u : null;
}
async function sendOne(to, cc, subject, html, who) {
  const r = await fetch(FLOW, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, cc, subject, html, sentBy: who }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`The Power Automate mail flow answered ${r.status}${t ? ": " + t.slice(0, 160) : ""}`); }
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (!SB_SERVICE) return fail(res, 503, "setup", "Add SUPABASE_SERVICE_ROLE_KEY in Vercel.");
  if (!FLOW) return fail(res, 503, "email_not_setup", "Email isn't set up yet: add MAIL_FLOW_URL in Vercel.");

  const test = String(req.query.test || "") === "1", now = String(req.query.now || "") === "1";
  let who = "RMG scheduler", user = null;
  try {
    if (test || now) {
      if (req.method !== "POST") return fail(res, 405, "method", "Use POST.");
      user = await signedInUser(req);
      if (!user) return fail(res, 401, "signin", "Sign in with your @" + DOMAIN + " account.");
      who = user.email.toLowerCase();
    } else {
      if (!CRON_SECRET) return fail(res, 503, "setup", "Add CRON_SECRET in Vercel so the scheduled send can run.");
      if (!same(req.headers.authorization, "Bearer " + CRON_SECRET)) return fail(res, 401, "auth", "Not allowed.");
    }

    const cfg = (await readDoc("app/nudges")) || {};
    const saved = await readDoc("report/nudges");
    if (!saved || !saved.items) return fail(res, 404, "no_report", "No nudges saved yet. Open the Recruiters tab once so the site can build them.");
    const age = saved.at ? (Date.now() - Date.parse(saved.at)) / 864e5 : 99;

    if (test) {
      const key = String(req.query.key || ""), it = saved.items[key];
      if (!it) return fail(res, 404, "no_person", "No nudge saved for that recruiter yet.");
      await sendOne(who, "", "[Test] " + it.subject, it.html, who);
      return res.status(200).json({ ok: true, to: [who] });
    }

    if (!now) {
      if (!cfg.on) return res.status(200).json({ skipped: "Automatic nudges are off." });
      const day = istNow().getUTCDay();
      if (!(cfg.days || []).map(Number).includes(day)) return res.status(200).json({ skipped: "Not a nudge day." });
      if (cfg.lastAuto && istDate(new Date(cfg.lastAuto)) === istDate()) return res.status(200).json({ skipped: "Already sent today." });
      if (age > STALE_DAYS) return res.status(200).json({ skipped: `Saved nudges are ${Math.round(age)} days old; not sending stale numbers.` });
    }

    const team = String(req.query.team || "");
    const cc = (cfg.cc || []).map(x => String(x).trim().toLowerCase()).filter(okAionos).join(";");
    const people = cfg.people || {};
    let sent = 0; const skipped = [];
    for (const [key, p] of Object.entries(people)) {
      if (now && team && !key.startsWith(team + "|")) continue;
      if (!p || p.on === false || !p.email) continue;
      const name = key.split("|").slice(1).join("|");
      if (!okMail(p.email)) { skipped.push(`${name}: ${p.email} is outside the allowed domains`); continue; }
      const it = saved.items[key];
      if (!it) { skipped.push(`${name}: not in the latest tracker`); continue; }
      try { await sendOne(String(p.email).toLowerCase(), cc, it.subject, it.html, who); sent++; }
      catch (e) { skipped.push(`${name}: ${e.message}`); }
    }
    const stamp = { lastSent: new Date().toISOString(), lastCount: sent };
    if (!now) stamp.lastAuto = new Date().toISOString();
    await mergeDoc("app/nudges", stamp);
    return res.status(200).json({ ok: true, sent, skipped, figuresAt: saved.at || null });
  } catch (e) {
    return fail(res, 502, "error", e && e.message ? e.message : "Couldn't send the nudges.");
  }
};

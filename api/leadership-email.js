// Weekly leadership email, sent by the server on a schedule (Vercel Cron, Monday morning IST).
//
//   GET /api/leadership-email                Authorization: Bearer <CRON_SECRET>   (Vercel Cron)
//       -> sends the saved leadership email to the Leadership list, if "Send every Monday" is on
//   POST /api/leadership-email?test=1        Authorization: Bearer <Supabase session of an @aionos.ai user>
//       -> sends the same saved email only to the signed-in person, to check the automatic send
//
// The site saves the latest email to ledger_docs "report/leadership" whenever a team member has it open
// (same pattern as the SLA digest). Recipients and the on/off switch live in "app/report-mail-leader".
// Env: CRON_SECRET, MAIL_FLOW_URL, SUPABASE_SERVICE_ROLE_KEY.

const crypto = require("crypto");
const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_JuFmt8_yIAtaks9226AGcw_kf_6oUXS";
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const FLOW = process.env.MAIL_FLOW_URL || "";
const DOMAIN = "aionos.ai";
const STALE_DAYS = 4; // a weekly report may be from Friday; older than this gets a warning line

const fail = (res, status, error, message) => res.status(status).json({ error, message });
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const okMail = a => /^[^@\s,;]+@aionos\.ai$/i.test(String(a || "").trim());
const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 36e5).toISOString().slice(0, 10);
const istLabel = (d = new Date()) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

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

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (!SB_SERVICE) return fail(res, 503, "setup", "Add SUPABASE_SERVICE_ROLE_KEY in Vercel.");
  if (!FLOW) return fail(res, 503, "email_not_setup", "Email isn't set up yet: add MAIL_FLOW_URL in Vercel.");

  const test = String(req.query.test || "") === "1";
  let to = [], cc = [], who = "RMG scheduler";
  try {
    if (test) {
      if (req.method !== "POST") return fail(res, 405, "method", "Use POST for a test send.");
      const u = await signedInUser(req);
      if (!u) return fail(res, 401, "signin", "Sign in with your @" + DOMAIN + " account.");
      to = [u.email.toLowerCase()]; who = u.email.toLowerCase();
    } else {
      if (!CRON_SECRET) return fail(res, 503, "setup", "Add CRON_SECRET in Vercel so the Monday send can run.");
      if (!same(req.headers.authorization, "Bearer " + CRON_SECRET)) return fail(res, 401, "auth", "Not allowed.");
    }

    const list = (await readDoc("app/report-mail-leader")) || {};
    if (!test) {
      if (!list.weekly) return res.status(200).json({ skipped: "Send every Monday is off." });
      if (list.lastAutoSent && istDate(new Date(list.lastAutoSent)) === istDate()) return res.status(200).json({ skipped: "Already sent today." });
      to = (list.to || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
      cc = (list.cc || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
      if (!to.length) return res.status(200).json({ skipped: "The Leadership list is empty." });
      const bad = [...to, ...cc].filter(x => !okMail(x));
      if (bad.length) return fail(res, 400, "domain", "Only @" + DOMAIN + " addresses can receive email: " + bad.join(", "));
    }

    const saved = await readDoc("report/leadership");
    if (!saved || !saved.html) return fail(res, 404, "no_report", "No leadership email saved yet. Open the site once so it can build one.");
    const days = saved.at ? (Date.now() - Date.parse(saved.at)) / 864e5 : 99;
    const stale = days > STALE_DAYS
      ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;background:#FFF4D6;border-left:4px solid #D99A00;padding:10px 14px;margin:0 auto 12px;max-width:640px">These figures are from ${Math.round(days)} days ago, the last time someone from the RMG team had the app open.</div>`
      : "";
    const subject = `${test ? "[Test] " : ""}RMG leadership summary, ${istLabel()}`;

    const r = await fetch(FLOW, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: to.join(";"), cc: cc.join(";"), subject, html: stale + saved.html, sentBy: who }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return fail(res, 502, "flow", `The Power Automate mail flow answered ${r.status}${t ? ": " + t.slice(0, 200) : ""}`);
    }
    if (!test) await mergeDoc("app/report-mail-leader", { lastSent: new Date().toISOString(), lastTo: to.join(", "), lastAutoSent: new Date().toISOString() });
    return res.status(200).json({ ok: true, to, cc, figuresAt: saved.at || null });
  } catch (e) {
    return fail(res, 502, "error", "Couldn't send the leadership email.");
  }
};

// SLA Watchdog digest for the daily email. A Power Automate flow (Recurrence -> HTTP GET -> Send an email)
// calls this every morning and mails the HTML body to the RMG team.
//
//   GET /api/sla        header x-rmg-token: <RMG_PUSH_TOKEN>   ->  text/html digest
//   GET /api/sla?format=json                                   ->  { at, counts, html }
//
// The site saves the digest to ledger_docs "sla/digest" whenever a team member has it open.

const crypto = require("crypto");
const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PUSH_TOKEN = process.env.RMG_PUSH_TOKEN || "";

const fail = (res, status, message) => res.status(status).json({ error: true, message });
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "GET") return fail(res, 405, "Use GET.");
  if (!SB_SERVICE || !PUSH_TOKEN) return fail(res, 503, "Add SUPABASE_SERVICE_ROLE_KEY and RMG_PUSH_TOKEN in Vercel.");
  if (!same(req.headers["x-rmg-token"], PUSH_TOKEN)) return fail(res, 401, "Wrong or missing x-rmg-token.");
  try {
    const r = await fetch(`${SB_URL}/rest/v1/ledger_docs?path=eq.${encodeURIComponent("sla/digest")}&select=data`, {
      headers: { apikey: SB_SERVICE, authorization: "Bearer " + SB_SERVICE },
    });
    if (!r.ok) return fail(res, 502, "Database answered " + r.status);
    const rows = await r.json();
    const d = rows && rows[0] && rows[0].data;
    if (!d || !d.html) return fail(res, 404, "No digest saved yet. Open the site once so it can build one.");
    // warn in the email when the figures are old (nobody from the team has opened the site since)
    const hours = d.at ? (Date.now() - Date.parse(d.at)) / 36e5 : 999;
    const stale = hours > 30 ? `<p style="font-family:Arial,sans-serif;font-size:13px;background:#FFF4D6;border-left:4px solid #D99A00;padding:8px 12px;margin:0 0 12px">These figures are from ${Math.round(hours / 24)} day(s) ago — nobody has opened the RMG site since. Open it to refresh them.</p>` : "";
    if (req.query.format === "json") return res.status(200).json({ at: d.at, counts: d.counts || {}, html: stale + d.html });
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.status(200).send(stale + d.html);
  } catch (e) {
    return fail(res, 502, "Couldn't load the digest.");
  }
};

// Sends an email from the site (recruiter report, and anything else that calls it) through a
// Power Automate flow, so mail goes out from the team's own Outlook with no extra email service.
//
//   POST /api/send-report   Authorization: Bearer <Supabase session>   { to:[], cc:[], subject, html }
//
// Env: MAIL_FLOW_URL = the "HTTP URL" of a Power Automate flow
//      (When an HTTP request is received -> Send an email (V2) -> Response).
// Only signed-in @aionos.ai users can send, and only to @aionos.ai addresses.

const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_JuFmt8_yIAtaks9226AGcw_kf_6oUXS";
const FLOW = process.env.MAIL_FLOW_URL || "";
const DOMAIN = "aionos.ai";
const MAX_HTML = 900 * 1024; // keep well under Power Automate's request limits

const fail = (res, status, error, message) => res.status(status).json({ error, message });
const okMail = a => /^[^@\s,;]+@aionos\.ai$/i.test(String(a || "").trim());

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
  if (req.method !== "POST") return fail(res, 405, "method", "Use POST.");
  if (!FLOW) return fail(res, 503, "email_not_setup", "Email isn't set up yet: add MAIL_FLOW_URL in Vercel.");
  let user = null;
  try { user = await signedInUser(req); } catch (_) {}
  if (!user) return fail(res, 401, "signin", "Sign in with your @" + DOMAIN + " account.");

  const b = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch (_) { return {}; } })() : (req.body || {});
  const list = v => (Array.isArray(v) ? v : String(v || "").split(/[,;]/)).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const to = list(b.to), cc = list(b.cc);
  if (!to.length) return fail(res, 400, "to", "Add at least one recipient.");
  const bad = [...to, ...cc].filter(x => !okMail(x));
  if (bad.length) return fail(res, 400, "domain", "Only @" + DOMAIN + " addresses can receive email from the site: " + bad.join(", "));
  const subject = String(b.subject || "RMG report").slice(0, 200);
  const html = String(b.html || "");
  if (!html) return fail(res, 400, "body", "The email has no content.");
  if (html.length > MAX_HTML) return fail(res, 413, "size", "The email is too large to send.");

  try {
    const r = await fetch(FLOW, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: to.join(";"), cc: cc.join(";"), subject, html, sentBy: user.email }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return fail(res, 502, "flow", `The Power Automate mail flow answered ${r.status}${t ? ": " + t.slice(0, 200) : ""}`);
    }
    return res.status(200).json({ ok: true, to, cc });
  } catch (e) {
    return fail(res, 502, "flow", "Couldn't reach the Power Automate mail flow.");
  }
};

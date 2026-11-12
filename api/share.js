// Public, no-login Leadership view: returns the saved leadership totals (no names, no IDs) to anyone
// holding the current share key. The team creates, resets or turns off the key on the Leadership view.
//
//   GET /api/share?k=<key>   ->  { at, data }   or 404 when the key is wrong, reset or turned off
//
// The totals are saved to ledger_docs "share/leadership" by the site whenever a team member has it open.
// Needs SUPABASE_SERVICE_ROLE_KEY (already set for the inbox).

const crypto = require("crypto");
const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const fail = (res, status, message) => res.status(status).json({ error: true, message });
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length >= 16 && x.length === y.length && crypto.timingSafeEqual(x, y); };

async function doc(path) {
  const r = await fetch(`${SB_URL}/rest/v1/ledger_docs?path=eq.${encodeURIComponent(path)}&select=data`, {
    headers: { apikey: SB_SERVICE, authorization: "Bearer " + SB_SERVICE },
  });
  if (!r.ok) throw new Error("Database answered " + r.status);
  const rows = await r.json();
  return rows && rows[0] ? rows[0].data : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  if (req.method !== "GET") return fail(res, 405, "Use GET.");
  if (!SB_SERVICE) return fail(res, 503, "Sharing isn't set up on the site yet.");
  const k = String(req.query.k || "").trim();
  if (!k) return fail(res, 400, "This link is missing its key.");
  try {
    const keyDoc = await doc("share/leadership-key");
    if (!keyDoc || !keyDoc.key || !same(k, keyDoc.key)) return fail(res, 404, "This link isn't valid any more. Ask the RMG team for a new one.");
    const snap = await doc("share/leadership");
    if (!snap || !snap.data) return fail(res, 404, "No figures have been shared yet. Try again in a few minutes.");
    return res.status(200).json({ at: snap.at || "", data: snap.data });
  } catch (e) {
    return fail(res, 502, "Couldn't load the figures. Try again shortly.");
  }
};

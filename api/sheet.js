// Downloads a linked client demand sheet (Google Sheets / Drive, OneDrive, SharePoint) for the RMG site.
// The browser can't fetch these directly (CORS, sign-in), so it asks this function, which returns the raw
// .xlsx/.csv bytes. Only signed-in @aionos.ai users can call it, and only for the hosts below.
//
// Optional env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY            defaults match index.html
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET  Entra app with Graph Files.Read.All / Sites.Read.All
//     (application) permission. Without them, OneDrive/SharePoint links must be shared as "Anyone with the link".

const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_JuFmt8_yIAtaks9226AGcw_kf_6oUXS";
const ALLOWED_DOMAIN = "aionos.ai";
const MAX_BYTES = 4 * 1024 * 1024; // Vercel caps function responses at 4.5 MB
const HOSTS = /(^|\.)(docs\.google\.com|drive\.google\.com|sharepoint\.com|onedrive\.live\.com|1drv\.ms)$/i;

const fail = (res, status, message) => res.status(status).json({ error: true, message });

async function signedInUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u.email || "").toLowerCase().endsWith("@" + ALLOWED_DOMAIN) ? u : null;
}

// Graph and the OneDrive API address a sharing link as "u!" + unpadded base64url of the URL
const shareId = url => "u!" + Buffer.from(url).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");

let msToken = null;
async function graphToken() {
  if (msToken && msToken.exp > Date.now() + 60e3) return msToken.value;
  const { MS_TENANT_ID: t, MS_CLIENT_ID: id, MS_CLIENT_SECRET: secret } = process.env;
  const r = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "https://graph.microsoft.com/.default" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("Microsoft sign-in for the site failed. Check MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET.");
  msToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return msToken.value;
}

// Turns a pasted sheet link into a direct download request
async function downloadRequest(u) {
  const host = u.hostname.toLowerCase();
  if (host === "docs.google.com") {
    const pub = u.pathname.match(/\/spreadsheets\/d\/e\/([\w-]+)/);
    if (pub) return { url: `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=xlsx` };
    const id = (u.pathname.match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1];
    if (!id) throw new Error("That Google link isn't a spreadsheet.");
    const gid = u.searchParams.get("gid") || (u.hash.match(/gid=(\d+)/) || [])[1];
    // a gid in the link means one specific tab: export just that tab
    return { url: `https://docs.google.com/spreadsheets/d/${id}/export?` + (gid ? `format=csv&gid=${gid}` : "format=xlsx") };
  }
  if (host === "drive.google.com") {
    const id = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || u.searchParams.get("id");
    if (!id) throw new Error("That Google Drive link isn't a file.");
    return { url: `https://drive.google.com/uc?export=download&id=${id}` };
  }
  // OneDrive / SharePoint
  if (process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET) {
    return { url: `https://graph.microsoft.com/v1.0/shares/${shareId(u.href)}/driveItem/content`, headers: { authorization: "Bearer " + (await graphToken()) } };
  }
  if (host.endsWith("sharepoint.com")) { const d = new URL(u.href); d.searchParams.set("download", "1"); return { url: d.href }; }
  return { url: `https://api.onedrive.com/v1.0/shares/${shareId(u.href)}/root/content` };
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "GET") return fail(res, 405, "Use GET.");
  try {
    if (!(await signedInUser(req))) return fail(res, 401, "Sign in with your @" + ALLOWED_DOMAIN + " account.");
  } catch (e) {
    return fail(res, 502, "Couldn't check your sign-in. Try again.");
  }

  let u;
  try { u = new URL(String(req.query.url || "")); } catch (_) { return fail(res, 400, "That isn't a valid link."); }
  if (u.protocol !== "https:" || !HOSTS.test(u.hostname)) return fail(res, 400, "Only Google Sheets, Google Drive, OneDrive and SharePoint links can be linked.");

  try {
    const dl = await downloadRequest(u);
    const r = await fetch(dl.url, { headers: dl.headers || {}, redirect: "follow" });
    const type = r.headers.get("content-type") || "";
    if (r.status === 401 || r.status === 403 || r.status === 404 || /text\/html/i.test(type)) {
      return fail(res, 403, /google/.test(u.hostname)
        ? "Google wants a sign-in for this sheet. Share it as “Anyone with the link can view”."
        : "Microsoft wants a sign-in for this file. Share it as “Anyone with the link”, or set up Microsoft access for the site.");
    }
    if (!r.ok) return fail(res, 502, `The sheet host answered ${r.status}. Try again later.`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return fail(res, 413, "That sheet is over 4 MB. Link a smaller file or a single tab.");
    res.setHeader("content-type", "application/octet-stream");
    return res.status(200).send(buf);
  } catch (e) {
    return fail(res, 502, e && e.message ? e.message : "Couldn't download the sheet.");
  }
};

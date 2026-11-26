// Passes Ask AI questions to the RMG Agent on Meridian and returns its answer. The Meridian key stays here;
// the browser never sees it. Only signed-in @aionos.ai users can call it.
//
// POST { message, conversation_id?, context? }  -> { conversation_id, status, reply, context_used }
//   context: live figures from the site (headcount, bench, demand, recruiters, IndiGo, sourcing, SLA), sent with
//   the question so the agent can answer about data its database views don't hold. If Meridian rejects the longer
//   message, the question is sent again on its own.
// GET  ?conversation_id=…             -> the same, for an answer that took longer than one call (status "pending")
//
// Env vars:
//   MERIDIAN_PRIVATE_KEY  the private key (.pem) of the system added on the agent's Invoke page (Add a system →
//                         Generate a key pair). Each call carries a short ES256 token signed with it.
//   MERIDIAN_KEY_ID       the key id shown next to "Key pair" in the Callers list (e.g. TYfcCmMoLX7f)
//   MERIDIAN_TOKEN_STYLE  optional: the token layout that worked (Check connection reports it), to skip trying
//   MERIDIAN_KEY          older plain key, used only when no private key is set
//   MERIDIAN_URL    default https://meridian.southindia.cloudapp.azure.com:8443
//   MERIDIAN_AGENT  default rmg-agent-2
//   SUPABASE_URL, SUPABASE_ANON_KEY  defaults match index.html
//
// GET  ?ping=1                        -> { ok, agent } when Meridian accepts the key (opens a conversation, sends nothing)

const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_JuFmt8_yIAtaks9226AGcw_kf_6oUXS";
const ALLOWED_DOMAIN = "aionos.ai";
const MD_URL = (process.env.MERIDIAN_URL || "https://meridian.southindia.cloudapp.azure.com:8443").replace(/\/+$/, "");
const MD_AGENT = process.env.MERIDIAN_AGENT || "rmg-agent-2";
const ANSWER_WAIT_MS = 50e3; // stay under the function's 60 s limit; longer answers are picked up with GET

const fail = (res, status, error, message) => res.status(status).json({ error, message });

/* ---------- Signed tokens for Meridian (system key pair) ---------- */
const crypto = require("crypto");
const KID = String(process.env.MERIDIAN_KEY_ID || "").trim();
let PRIV;
function privKey() {
  if (PRIV !== undefined) return PRIV;
  // accept the .pem however it was pasted: real line breaks, \\n, spaces instead of line breaks, or the bare base64
  const raw = String(process.env.MERIDIAN_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim().replace(/^["']|["']$/g, "");
  const m = raw.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  const kind = m ? m[1] : "PRIVATE KEY", body = (m ? m[2] : raw).replace(/[^A-Za-z0-9+/=]/g, "");
  const pem = body ? `-----BEGIN ${kind}-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END ${kind}-----\n` : "";
  try { PRIV = pem ? crypto.createPrivateKey(pem) : null; } catch (_) { PRIV = null; }
  return PRIV;
}
function thumbprint() { // RFC 7638 JWK thumbprint of the public key
  const j = crypto.createPublicKey(privKey()).export({ format: "jwk" });
  return crypto.createHash("sha256").update(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y })).digest("base64url");
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const AGENT_URL = `${MD_URL}/api/agents/${MD_AGENT}`;
// Meridian doesn't document the token's fields, so the common layouts are tried in turn and the one it accepts is kept
// Meridian names a system by its key's full fingerprint (RFC 7638 thumbprint), so those layouts go first
const STYLES = [
  { n: "thumb-agent", kid: "thumb", aud: AGENT_URL },
  { n: "thumb-name", kid: "thumb", aud: MD_AGENT },
  { n: "thumb-host", kid: "thumb", aud: MD_URL },
  { n: "thumb-host-slash", kid: "thumb", aud: MD_URL + "/" },
  { n: "thumb-api", kid: "thumb", aud: MD_URL + "/api" },
  { n: "thumb-conv", kid: "thumb", aud: AGENT_URL + "/conversations" },
  { n: "thumb-agentpath", kid: "thumb", aud: "/api/agents/" + MD_AGENT },
  { n: "thumb-plain", kid: "thumb" },
  { n: "thumb-iss-agent", kid: "thumb", aud: AGENT_URL, iss: AGENT_URL },
  { n: "thumb-iss-name", kid: "thumb", aud: MD_AGENT, iss: MD_AGENT },
  { n: "kid-agent", kid: "id", aud: AGENT_URL },
  { n: "kid-host", kid: "id", aud: MD_URL },
  { n: "kid-name", kid: "id", aud: MD_AGENT },
  { n: "kid-plain", kid: "id" },
  { n: "kid-conv", kid: "id", aud: AGENT_URL + "/conversations" },
];
let styleIx = Math.max(-1, STYLES.findIndex(x => x.n === String(process.env.MERIDIAN_TOKEN_STYLE || "").trim()));
function token(st) {
  const now = Math.floor(Date.now() / 1000), kid = st.kid === "thumb" ? thumbprint() : KID;
  const head = { alg: "ES256", typ: "JWT" }; if (kid) head.kid = kid;
  const body = { iat: now, nbf: now - 30, exp: now + 300, jti: crypto.randomUUID() };
  if (kid) { body.iss = st.iss || kid; body.sub = kid; }
  if (st.aud) body.aud = st.aud;
  const data = b64(head) + "." + b64(body);
  return data + "." + crypto.sign("sha256", Buffer.from(data), { key: privKey(), dsaEncoding: "ieee-p1363" }).toString("base64url");
}
const signing = () => !!privKey();
let refusals = [];

async function signedInUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u.email || "").toLowerCase().endsWith("@" + ALLOWED_DOMAIN) ? u : null;
}

async function meridian(path, { method = "GET", body, timeout = 15e3 } = {}) {
  const call = bearer => fetch(`${MD_URL}/api/agents/${encodeURIComponent(MD_AGENT)}/conversations${path}`, {
    method,
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!signing()) return call(process.env.MERIDIAN_KEY);
  if (styleIx >= 0) {
    const r = await call(token(STYLES[styleIx]));
    if (r.status !== 401 && r.status !== 403) return r;
  }
  // find the token layout Meridian accepts (a refused token does nothing on Meridian's side)
  let last; refusals = [];
  for (let i = 0; i < STYLES.length; i++) {
    if (i === styleIx) continue;
    last = await call(token(STYLES[i]));
    if (last.status !== 401 && last.status !== 403) { styleIx = i; return last; }
    // keep Meridian's reason for each refusal, so Check connection can show it
    const why = (await last.clone().text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    refusals.push(`${STYLES[i].n}: ${last.status}${why ? " " + why : ""}${last.headers.get("www-authenticate") ? " [" + last.headers.get("www-authenticate").slice(0, 160) + "]" : ""}`);
  }
  return last;
}

async function startConversation(email) {
  const r = await meridian("", { method: "POST", body: { customer_id: email } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.conversation_id) throw Object.assign(new Error(`Meridian refused a new conversation (${r.status}).`), { status: r.status });
  return d.conversation_id;
}

// The newest turn of a conversation, as { status, reply }; "pending" while it is still running or waiting for a sign-off
async function latestTurn(conv) {
  const r = await meridian(`/${encodeURIComponent(conv)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Meridian answered ${r.status} reading the conversation.`), { status: r.status });
  if (d.running) return { status: "pending", reply: "" };
  const turns = d.turns || [], t = turns[turns.length - 1] || {};
  return { status: t.status || "pending", reply: t.reply || "" };
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (!signing() && process.env.MERIDIAN_PRIVATE_KEY) return fail(res, 503, "meridian_off", "MERIDIAN_PRIVATE_KEY in Vercel isn't a valid private key. Paste the whole .pem file, including the BEGIN and END lines.");
  if (!signing() && !process.env.MERIDIAN_KEY) return fail(res, 503, "meridian_off", "Add MERIDIAN_PRIVATE_KEY and MERIDIAN_KEY_ID in Vercel to connect the RMG Agent.");
  let user;
  try { user = await signedInUser(req); } catch (_) { return fail(res, 502, "auth", "Couldn't check your sign-in. Try again."); }
  if (!user) return fail(res, 401, "auth", "Sign in with your @" + ALLOWED_DOMAIN + " account.");

  const idOk = v => typeof v === "string" && /^[\w-]{1,100}$/.test(v);
  try {
    if (req.method === "GET" && String(req.query.ping || "") === "1") {
      await startConversation(user.email);
      const info = { ok: true, agent: MD_AGENT };
      if (signing()) { info.style = styleIx >= 0 ? STYLES[styleIx].n : ""; info.keyId = KID || ""; info.thumbMatchesKeyId = !!KID && thumbprint().startsWith(KID); }
      return res.status(200).json(info);
    }
    if (req.method === "GET") {
      const conv = String(req.query.conversation_id || "");
      if (!idOk(conv)) return fail(res, 400, "bad_request", "Missing conversation id.");
      return res.status(200).json(Object.assign({ conversation_id: conv }, await latestTurn(conv)));
    }
    if (req.method !== "POST") return fail(res, 405, "bad_request", "Use POST.");

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const question = String(body.message || "").trim().slice(0, 4000);
    if (!question) return fail(res, 400, "bad_request", "Ask a question.");
    const context = String(body.context || "").trim().slice(0, 20000);
    const withContext = context
      ? `${question}\n\n---\nA guide to the AIONOS RMG app (for how-to questions and for sending the user to the right screen) and live figures from it, for answering the question above. They are current and cover data your database views may not hold (IndiGo recruiters, sourcing, bench utilisation, new billable joiners, SLA items). Prefer them for those topics, use your database for anything more detailed, and say which you used. Keep later answers in this conversation consistent with them.\n\n${context}`
      : question;
    let conv = idOk(body.conversation_id) ? body.conversation_id : await startConversation(user.email);

    let used = !!context;
    const send = message => meridian(`/${encodeURIComponent(conv)}/messages`, { method: "POST", body: { message }, timeout: ANSWER_WAIT_MS });
    let r;
    try {
      r = await send(withContext);
      // 409: the conversation ended (30 minutes idle); 404: it no longer exists. Start a fresh one once.
      if (r.status === 409 || r.status === 404) { conv = await startConversation(user.email); r = await send(withContext); }
      // a message too long for Meridian: ask the question on its own
      if (used && [400, 413, 422].includes(r.status)) { used = false; r = await send(question); }
    } catch (e) { if (e && e.name === "TimeoutError") return res.status(200).json({ conversation_id: conv, status: "pending", reply: "", context_used: used }); throw e; }
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return fail(res, 502, "meridian_key", `Meridian refused the request (${r.status}). Run Check connection in Ask AI.`);
    if (!r.ok) return fail(res, 502, "meridian", (d && (d.message || d.error)) || `Meridian answered ${r.status}.`);
    return res.status(200).json({ conversation_id: conv, status: d.status === "paused" ? "pending" : d.status || "pending", reply: d.reply || "", context_used: used });
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) return fail(res, 502, "meridian_key", signing()
      ? `Meridian refused the signed token (${e.status}) in every layout tried.${refusals.length ? " Meridian said: " + (() => { const seen = new Map(); refusals.forEach(x => { const m = x.match(/^([^:]+): (.*)$/) || [0, "?", x]; const k = m[2].replace(/"[^"]{20,}"/g, '"…"'); if (!seen.has(k)) seen.set(k, []); seen.get(k).push(m[1]); }); return [...seen].map(([k, v]) => `${v.join(", ")} → ${k}`).join(" | "); })() + "." : ""} Check MERIDIAN_KEY_ID matches the Callers list${KID && thumbprint().startsWith(KID) ? " (it matches this key's fingerprint)" : ""} and that the private key is the one from RMG WEB APP.`
      : `Meridian refused the key (${e.status}). Add MERIDIAN_PRIVATE_KEY and MERIDIAN_KEY_ID in Vercel and redeploy.`);
    const unreachable = e && (e.name === "TimeoutError" || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(e.message) + String(e.cause && e.cause.code)));
    return fail(res, 502, "meridian", unreachable ? "Couldn't reach Meridian from the site. It may only accept office or VPN traffic." : (e && e.message) || "Meridian didn't answer.");
  }
};

module.exports.config = { maxDuration: 60 };

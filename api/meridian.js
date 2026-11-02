// Passes Ask AI questions to the RMG Agent on Meridian and returns its answer. The Meridian key stays here;
// the browser never sees it. Only signed-in @aionos.ai users can call it.
//
// POST { message, conversation_id? }  -> { conversation_id, status, reply }
// GET  ?conversation_id=…             -> the same, for an answer that took longer than one call (status "pending")
//
// Env vars:
//   MERIDIAN_KEY    required: the key from the agent's Invoke page (Add a system)
//   MERIDIAN_URL    default https://meridian.southindia.cloudapp.azure.com:8443
//   MERIDIAN_AGENT  default rmg-agent-2
//   SUPABASE_URL, SUPABASE_ANON_KEY  defaults match index.html

const SB_URL = process.env.SUPABASE_URL || "https://ixkgcggnfcjsmdbxgbro.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_JuFmt8_yIAtaks9226AGcw_kf_6oUXS";
const ALLOWED_DOMAIN = "aionos.ai";
const MD_URL = (process.env.MERIDIAN_URL || "https://meridian.southindia.cloudapp.azure.com:8443").replace(/\/+$/, "");
const MD_AGENT = process.env.MERIDIAN_AGENT || "rmg-agent-2";
const ANSWER_WAIT_MS = 50e3; // stay under the function's 60 s limit; longer answers are picked up with GET

const fail = (res, status, error, message) => res.status(status).json({ error, message });

async function signedInUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u.email || "").toLowerCase().endsWith("@" + ALLOWED_DOMAIN) ? u : null;
}

function meridian(path, { method = "GET", body, timeout = 15e3 } = {}) {
  return fetch(`${MD_URL}/api/agents/${encodeURIComponent(MD_AGENT)}/conversations${path}`, {
    method,
    headers: { authorization: "Bearer " + process.env.MERIDIAN_KEY, "content-type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
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
  if (!process.env.MERIDIAN_KEY) return fail(res, 503, "meridian_off", "Add MERIDIAN_KEY in Vercel to connect the RMG Agent.");
  let user;
  try { user = await signedInUser(req); } catch (_) { return fail(res, 502, "auth", "Couldn't check your sign-in. Try again."); }
  if (!user) return fail(res, 401, "auth", "Sign in with your @" + ALLOWED_DOMAIN + " account.");

  const idOk = v => typeof v === "string" && /^[\w-]{1,100}$/.test(v);
  try {
    if (req.method === "GET") {
      const conv = String(req.query.conversation_id || "");
      if (!idOk(conv)) return fail(res, 400, "bad_request", "Missing conversation id.");
      return res.status(200).json(Object.assign({ conversation_id: conv }, await latestTurn(conv)));
    }
    if (req.method !== "POST") return fail(res, 405, "bad_request", "Use POST.");

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const message = String(body.message || "").trim().slice(0, 4000);
    if (!message) return fail(res, 400, "bad_request", "Ask a question.");
    let conv = idOk(body.conversation_id) ? body.conversation_id : await startConversation(user.email);

    const send = () => meridian(`/${encodeURIComponent(conv)}/messages`, { method: "POST", body: { message }, timeout: ANSWER_WAIT_MS });
    let r;
    try { r = await send(); }
    catch (e) { if (e && e.name === "TimeoutError") return res.status(200).json({ conversation_id: conv, status: "pending", reply: "" }); throw e; }
    // 409: the conversation ended (30 minutes idle); 404: it no longer exists. Start a fresh one once.
    if (r.status === 409 || r.status === 404) { conv = await startConversation(user.email); r = await send(); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return fail(res, 502, "meridian", (d && (d.message || d.error)) || `Meridian answered ${r.status}.`);
    return res.status(200).json({ conversation_id: conv, status: d.status === "paused" ? "pending" : d.status || "pending", reply: d.reply || "" });
  } catch (e) {
    const unreachable = e && (e.name === "TimeoutError" || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(e.message) + String(e.cause && e.cause.code)));
    return fail(res, 502, "meridian", unreachable ? "Couldn't reach Meridian from the site. It may only accept office or VPN traffic." : (e && e.message) || "Meridian didn't answer.");
  }
};

module.exports.config = { maxDuration: 60 };

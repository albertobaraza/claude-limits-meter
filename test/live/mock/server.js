// The mock Claude for the live environment (scripts/run.sh): the fake API of the integration tests (../../integration/fake-api.js),
// answering over TLS on 443 under the real hostnames, which the compose file gives this container as network aliases, so
// the unmodified extension in the VS Code container asks it where it would ask Anthropic. Next to it, on a second
// port, the control page (ui.html) and the routes behind it, to change live what the API answers and what login the
// machine has.
//
// Nothing here is real: the login is a file with fake tokens, in a volume shared with the VS Code container.

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { FAKE_TOKENS, createFakeApi, listener, send } = require("../../integration/fake-api");

const env = (name, fallback) => process.env[name] || fallback;
const CERT_DIR = env("MOCK_CERT_DIR", "/mock-certs");
const HTTPS_PORT = Number(env("MOCK_HTTPS_PORT", "443"));
const CONTROL_PORT = Number(env("MOCK_CONTROL_PORT", "4010"));
/** The `.claude` folder of the VS Code container's user, a volume both containers mount. */
const CLAUDE_HOME = env("MOCK_CLAUDE_HOME", "/claude");
/** The user the VS Code container runs as: it has to own the login to rewrite it when it renews it. */
const CLAUDE_UID = Number(env("MOCK_CLAUDE_UID", "1000"));
const VSCODE_URL = env("MOCK_VSCODE_URL", "http://localhost:8788");

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (message) => console.log(`${stamp()} ${message}`);

// ── the login on the machine ──

const loginFile = path.join(CLAUDE_HOME, ".credentials.json");

function writeLogin(mode) {
  if (mode === "none") {
    fs.rmSync(loginFile, { force: true });
    return;
  }
  const expiresAt = Date.now() + (mode === "expired" ? -60_000 : 365 * 24 * 3_600_000);
  const login = { claudeAiOauth: { accessToken: FAKE_TOKENS.access, refreshToken: FAKE_TOKENS.refresh, expiresAt } };
  fs.writeFileSync(loginFile, JSON.stringify(login), { mode: 0o600 });
  fs.chownSync(loginFile, CLAUDE_UID, CLAUDE_UID);
}

/** `none`, `valid` or `expired`, and whether what is there is a login the extension renewed. */
function readLogin() {
  try {
    const { accessToken, expiresAt } = JSON.parse(fs.readFileSync(loginFile, "utf8")).claudeAiOauth;
    return { mode: expiresAt > Date.now() ? "valid" : "expired", renewed: accessToken === FAKE_TOKENS.renewedAccess };
  } catch {
    return { mode: "none", renewed: false };
  }
}

// ── the routes only the live mock has ──

async function page(req, res, pathname) {
  if (pathname !== "/" || req.method !== "GET") return false;
  const html = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8").replaceAll("__VSCODE_URL__", VSCODE_URL);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

async function login(req, res, pathname, text) {
  if (pathname !== "/__control/login") return false;
  if (req.method === "PUT") {
    const { mode } = JSON.parse(text);
    if (["none", "valid", "expired"].includes(mode)) {
      writeLogin(mode);
      say(`login on the machine: ${mode}`);
      send(res, 204);
    } else {
      send(res, 400, { error: "mode is none, valid or expired" });
    }
  } else {
    send(res, 200, readLogin());
  }
  return true;
}

/** Says what the control page changed, so the terminal running scripts/run.sh follows along. */
function announce(handler) {
  return async (req, res, pathname, text) => {
    const handled = await handler(req, res, pathname, text);
    if (handled && pathname === "/__control/script" && req.method === "PUT") {
      const { status, usage, headers } = JSON.parse(text);
      const what = usage ? `${usage.fiveHour}% session, ${usage.sevenDay}% week` : (headers?.["retry-after"] ? `Retry-After ${headers["retry-after"]}` : "");
      say(`usage endpoint now answers ${status}${what ? ` (${what})` : ""}`);
    }
    return handled;
  };
}

// ── start ──

const fake = createFakeApi({
  // Before anyone asks: a reading to show (and, below, a valid login to read it with).
  script: { status: 200, usage: { fiveHour: 42, sevenDay: 13, fiveHourResetsInMinutes: 150, sevenDayResetsInMinutes: 4 * 24 * 60 } },
  onRequest: (r) => {
    if (r.endpoint === "usage") say(`GET /api/oauth/usage -> ${r.answered}`);
    else say(`POST /v1/oauth/token -> ${r.answered} (the extension renewed the login)`);
  },
});
writeLogin("valid");

https
  .createServer(
    { key: fs.readFileSync(path.join(CERT_DIR, "key.pem")), cert: fs.readFileSync(path.join(CERT_DIR, "cert.pem")) },
    listener(fake.api),
  )
  .listen(HTTPS_PORT, "0.0.0.0", () => say(`API on https://api.anthropic.com and https://console.anthropic.com (this network only), port ${HTTPS_PORT}`));

http
  .createServer(listener(page, login, announce(fake.control)))
  .listen(CONTROL_PORT, "0.0.0.0", () => say(`control page on port ${CONTROL_PORT}`));

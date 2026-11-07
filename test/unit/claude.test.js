// Run with `npm test`. Exercises out/claude.js against a local mock server, a temp
// credentials file and a stubbed `security` command. Runs on Linux, macOS and Windows.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const c = require("../../out/claude.js");

const NOW = 1_800_000_000_000;
const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function tmpCreds(oauth, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-test-"));
  const file = path.join(dir, ".credentials.json");
  fs.writeFileSync(file, JSON.stringify({ ...extra, claudeAiOauth: oauth }), { mode: 0o600 });
  return file;
}

/** Mock of the token + usage endpoints; records requests. */
async function mockServer(handlers = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      const h = handlers[req.url] ?? ((_, r) => ((r.statusCode = 404), r.end()));
      h(req, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

const json = (obj, status = 200) => (_, res) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
};

/** Client wired to the mock server. `over` overrides any option. */
function makeClient(credsPath, base, over = {}) {
  const warnings = [];
  const execCalls = [];
  const opts = {
    credsPath,
    tokenUrl: `${base}/token`,
    usageUrl: `${base}/usage`,
    userAgent: "test-agent/1.0",
    platform: "linux",
    username: "tester",
    exec: async (file, args) => {
      execCalls.push([file, ...args]);
      throw new Error("no keychain");
    },
    refreshEnabled: () => false,
    clientId: async () => "client-123",
    onWarn: (m) => warnings.push(m),
    now: () => NOW,
    ...over,
  };
  return { client: new c.ClaudeClient(opts), warnings, execCalls };
}

const FRESH = { accessToken: "A", refreshToken: "R", expiresAt: NOW + 3_600_000 };
const EXPIRED = { accessToken: "OLD", refreshToken: "R1", expiresAt: NOW - 1 };

// ── Linux / Windows / WSL / remote: credentials file ─────────────────────────

test("fresh token is returned without touching the network", async () => {
  const srv = await mockServer();
  const { client } = makeClient(tmpCreds(FRESH), srv.base, { refreshEnabled: () => true });
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "A" });
  assert.equal(srv.requests.length, 0);
  srv.close();
});

test("no credentials file gives 'none'", async () => {
  const srv = await mockServer();
  const { client } = makeClient(path.join(os.tmpdir(), "does-not-exist", "creds.json"), srv.base);
  assert.deepEqual(await client.getToken(), { kind: "none" });
  srv.close();
});

test("an expired token is reported, not refreshed, unless refreshing is switched on", async () => {
  const file = tmpCreds(EXPIRED);
  const srv = await mockServer();
  const { client } = makeClient(file, srv.base); // refreshEnabled: false
  assert.deepEqual(await client.getToken(), { kind: "expired" });
  assert.equal(srv.requests.length, 0, "no refresh request");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth.accessToken, "OLD", "file untouched");
  srv.close();
});

test("a picked-up token that Claude Code refreshed meanwhile is used on the next check", async () => {
  const file = tmpCreds(EXPIRED);
  const srv = await mockServer();
  const { client } = makeClient(file, srv.base);
  assert.equal((await client.getToken()).kind, "expired");
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { ...FRESH, accessToken: "CC-REFRESHED" } }));
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "CC-REFRESHED" });
  srv.close();
});

test("expired with no refresh token is 'expired' even when refreshing is on", async () => {
  const srv = await mockServer();
  const { client } = makeClient(tmpCreds({ accessToken: "OLD", expiresAt: NOW - 1 }), srv.base, { refreshEnabled: () => true });
  assert.deepEqual(await client.getToken(), { kind: "expired" });
  assert.equal(srv.requests.length, 0);
  srv.close();
});

test("with refreshing on, an expired token is renewed and written back (other fields and file mode kept)", async () => {
  const file = tmpCreds({ ...EXPIRED, scopes: ["x"] }, { other: 1 });
  const srv = await mockServer({ "/token": json({ access_token: "NEW", refresh_token: "R2", expires_in: 3600 }) });
  const { client, warnings } = makeClient(file, srv.base, { refreshEnabled: () => true });
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "NEW" });

  assert.deepEqual(JSON.parse(srv.requests[0].body), { grant_type: "refresh_token", refresh_token: "R1", client_id: "client-123" });
  assert.equal(srv.requests[0].headers["user-agent"], "test-agent/1.0");

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.other, 1);
  assert.deepEqual(saved.claudeAiOauth.scopes, ["x"]);
  assert.equal(saved.claudeAiOauth.accessToken, "NEW");
  assert.equal(saved.claudeAiOauth.refreshToken, "R2");
  assert.equal(saved.claudeAiOauth.expiresAt, NOW + 3_600_000);
  if (!isWindows) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [".credentials.json"], "no temp file left behind");
  assert.deepEqual(warnings, []);
  srv.close();
});

test("a rotated-out refresh token is not fatal if another process already refreshed", async () => {
  const file = tmpCreds(EXPIRED);
  const srv = await mockServer({
    "/token": (_, res) => {
      // Claude Code wins the race: it rewrites the file, our request is rejected
      fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "THEIRS", refreshToken: "R9", expiresAt: NOW + 3_600_000 } }));
      res.statusCode = 400;
      res.end("invalid_grant");
    },
  });
  const { client } = makeClient(file, srv.base, { refreshEnabled: () => true });
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "THEIRS" });
  srv.close();
});

test("refresh failure with nothing fresh on disk throws, without leaking the response body", async () => {
  const srv = await mockServer({ "/token": (_, res) => ((res.statusCode = 401), res.end("secret-body")) });
  const { client } = makeClient(tmpCreds(EXPIRED), srv.base, { refreshEnabled: () => true });
  await assert.rejects(client.getToken(), (e) => {
    assert.ok(e instanceof c.HttpError);
    assert.equal(e.status, 401);
    assert.ok(!e.message.includes("secret-body"));
    return true;
  });
  srv.close();
});

test("a renewed login that cannot be saved is kept in memory and the user is warned", { skip: isWindows || isRoot }, async () => {
  const file = tmpCreds(EXPIRED);
  const dir = path.dirname(file);
  const srv = await mockServer({ "/token": json({ access_token: "NEW", refresh_token: "R2", expires_in: 3600 }) });
  const { client, warnings } = makeClient(file, srv.base, { refreshEnabled: () => true });
  fs.chmodSync(dir, 0o500); // readable, not writable: the temp file cannot be created
  try {
    assert.deepEqual(await client.getToken(), { kind: "ok", token: "NEW" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not save/);
    // The file still holds the dead refresh token, but the next check must not use it again.
    assert.deepEqual(await client.getToken(), { kind: "ok", token: "NEW" });
    assert.equal(srv.requests.length, 1, "no second refresh with the rotated-out token");
  } finally {
    fs.chmodSync(dir, 0o700);
    srv.close();
  }
});

test("a symlinked credentials file stays a symlink after a renewal", { skip: isWindows }, async () => {
  const real = tmpCreds(EXPIRED);
  const link = path.join(path.dirname(real), "link.json");
  fs.symlinkSync(real, link);
  const srv = await mockServer({ "/token": json({ access_token: "NEW", expires_in: 60 }) });
  const { client } = makeClient(link, srv.base, { refreshEnabled: () => true });
  assert.equal((await client.getToken()).kind, "ok");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).claudeAiOauth.refreshToken, "R1", "old refresh token kept when none returned");
  srv.close();
});

test("the Keychain is never consulted off macOS", async () => {
  const srv = await mockServer();
  for (const platform of ["linux", "win32"]) {
    const { client, execCalls } = makeClient(tmpCreds(FRESH), srv.base, { platform });
    assert.equal((await client.getToken()).kind, "ok");
    assert.deepEqual(execCalls, []);
  }
  srv.close();
});

// ── macOS: Keychain ──────────────────────────────────────────────────────────

const keychainJson = (oauth) => JSON.stringify({ claudeAiOauth: oauth });

test("macOS reads the login from the Keychain (account name first)", async () => {
  const srv = await mockServer();
  const calls = [];
  const { client } = makeClient("/nonexistent/creds.json", srv.base, {
    platform: "darwin",
    exec: async (file, args) => (calls.push([file, ...args]), keychainJson(FRESH) + "\n"),
  });
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "A" });
  assert.deepEqual(calls[0], ["security", "find-generic-password", "-a", "tester", "-s", "Claude Code-credentials", "-w"]);
  srv.close();
});

test("macOS falls back to the account-less Keychain query, and decodes hex output", async () => {
  const srv = await mockServer();
  const { client } = makeClient("/nonexistent/creds.json", srv.base, {
    platform: "darwin",
    exec: async (_file, args) => {
      if (args.includes("-a")) throw new Error("item not found");
      return Buffer.from(keychainJson(FRESH), "utf8").toString("hex");
    },
  });
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "A" });
  srv.close();
});

test("macOS falls back to the credentials file when the Keychain has nothing", async () => {
  const srv = await mockServer();
  const { client } = makeClient(tmpCreds(FRESH), srv.base, {
    platform: "darwin",
    exec: async () => {
      throw new Error("item not found");
    },
  });
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "A" });
  srv.close();
});

test("an expired Keychain login is never refreshed by us, even with refreshing on", async () => {
  const srv = await mockServer({ "/token": json({ access_token: "NEW", expires_in: 60 }) });
  const { client } = makeClient("/nonexistent/creds.json", srv.base, {
    platform: "darwin",
    refreshEnabled: () => true,
    exec: async () => keychainJson(EXPIRED),
  });
  assert.deepEqual(await client.getToken(), { kind: "expired" });
  assert.equal(srv.requests.length, 0, "rotating the refresh token would log Claude Code out");
  srv.close();
});

test("garbage from the Keychain is ignored", async () => {
  const srv = await mockServer();
  const { client } = makeClient("/nonexistent/creds.json", srv.base, { platform: "darwin", exec: async () => "not json" });
  assert.deepEqual(await client.getToken(), { kind: "none" });
  srv.close();
});

// ── usage API ────────────────────────────────────────────────────────────────

test("fetchUsage sends the expected headers and parses the body", async () => {
  const body = { five_hour: { utilization: 42.5, resets_at: "2026-01-01T00:00:00+00:00" }, seven_day: { utilization: 7 } };
  const srv = await mockServer({ "/usage": json(body) });
  const { client } = makeClient("unused", srv.base);
  assert.deepEqual(await client.fetchUsage("TOK"), body);
  const h = srv.requests[0].headers;
  assert.equal(h.authorization, "Bearer TOK");
  assert.equal(h["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(h["user-agent"], "test-agent/1.0");
  srv.close();
});

test("fetchUsage surfaces HTTP errors by status", async () => {
  const srv = await mockServer({ "/usage": json({}, 429) });
  const { client } = makeClient("unused", srv.base);
  await assert.rejects(client.fetchUsage("TOK"), (e) => e instanceof c.HttpError && e.status === 429);
  srv.close();
});

test("findClientId reads CLIENT_ID from the first extension dir that has it", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ext-a-"));
  const withId = fs.mkdtempSync(path.join(os.tmpdir(), "ext-b-"));
  fs.writeFileSync(path.join(withId, "extension.js"), 'x={CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",y:1}');
  assert.equal(await c.findClientId([empty, path.join(os.tmpdir(), "nonexistent-ext"), withId]), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(await c.findClientId([empty]), undefined);
});

// ── formatting ───────────────────────────────────────────────────────────────

test("bar / pctText / timeLeft", () => {
  assert.equal(c.bar(0), "░░░░░░░░░░");
  assert.equal(c.bar(42), "████░░░░░░");
  assert.equal(c.bar(100), "██████████");
  assert.equal(c.bar(250), "██████████", "clamped");
  assert.equal(c.pctText(7.9), "  7%");
  assert.equal(c.pctText(100), "100%");

  const iso = (ms) => new Date(NOW + ms).toISOString();
  assert.equal(c.timeLeft(undefined, NOW), "?");
  assert.equal(c.timeLeft("garbage", NOW), "?");
  assert.equal(c.timeLeft(iso(-5000), NOW), "now");
  assert.equal(c.timeLeft(iso(5 * 60_000), NOW), "5m");
  assert.equal(c.timeLeft(iso((2 * 60 + 13) * 60_000), NOW), "2h 13m");
  assert.equal(c.timeLeft(iso((4 * 24 + 2) * 3_600_000), NOW), "4d 2h");
  const micros = new Date(NOW + 90 * 60_000).toISOString().replace("Z", "123+00:00"); // API timestamps carry microseconds
  assert.equal(c.timeLeft(micros, NOW), "1h 30m");
});

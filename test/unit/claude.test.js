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

test("a redirect from the token endpoint is not followed: the refresh token goes nowhere else", async () => {
  const elsewhere = await mockServer({ "/other": json({ access_token: "X", expires_in: 3600 }) });
  for (const status of [301, 302, 307, 308]) {
    const file = tmpCreds(EXPIRED);
    const srv = await mockServer({ "/token": (_, res) => ((res.statusCode = status), res.setHeader("location", `${elsewhere.base}/other`), res.end()) });
    const { client } = makeClient(file, srv.base, { refreshEnabled: () => true });
    await assert.rejects(client.getToken(), (e) => e instanceof c.HttpError && e.status === status, `HTTP ${status}`);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth.accessToken, "OLD", "the login is untouched");
    srv.close();
  }
  assert.deepEqual(elsewhere.requests, [], "the other host was never contacted, so it never saw the refresh token");
  elsewhere.close();
});

test("a redirect from the usage endpoint is not followed either", async () => {
  const elsewhere = await mockServer({ "/other": json({}) });
  const srv = await mockServer({ "/usage": (_, res) => ((res.statusCode = 307), res.setHeader("location", `${elsewhere.base}/other`), res.end()) });
  const { client } = makeClient("unused", srv.base);
  await assert.rejects(client.fetchUsage("TOK"), (e) => e instanceof c.HttpError && e.status === 307);
  assert.deepEqual(elsewhere.requests, []);
  elsewhere.close();
  srv.close();
});

test("a token answer that is not the documented shape is an error and leaves the login on disk alone", async () => {
  const answers = [
    ["{}", (_, res) => res.end("{}")],
    ["an error object", json({ error: "invalid_grant" })],
    ["no expiry", json({ access_token: "NEW" })],
    ["a zero expiry", json({ access_token: "NEW", expires_in: 0 })],
    ["an expiry that is not a number", json({ access_token: "NEW", expires_in: "3600" })],
    ["an empty access token", json({ access_token: "", expires_in: 3600 })],
    ["an access token with a newline", json({ access_token: "NEW\nTOKEN", expires_in: 3600 })],
    ["an access token with a space", json({ access_token: "NEW TOKEN", expires_in: 3600 })],
    ["an access token that is not ASCII", json({ access_token: "NEW\u00e9", expires_in: 3600 })],
    ["a refresh token that is not a string", json({ access_token: "NEW", refresh_token: 7, expires_in: 3600 })],
    ["null", (_, res) => res.end("null")],
    ["an array", (_, res) => res.end("[]")],
  ];
  for (const [what, handler] of answers) {
    const file = tmpCreds(EXPIRED);
    const before = fs.readFileSync(file, "utf8");
    const srv = await mockServer({ "/token": handler });
    const { client, warnings } = makeClient(file, srv.base, { refreshEnabled: () => true });
    await assert.rejects(client.getToken(), (e) => e instanceof c.BadResponseError && e.message === "Token refresh failed: unexpected response", what);
    assert.equal(fs.readFileSync(file, "utf8"), before, `${what}: the file is byte for byte as it was`);
    assert.deepEqual(warnings, []);
    srv.close();
  }
});

test("a body that is not JSON is reported without quoting any of it", async () => {
  const body = "<html>captive portal secret-body</html>";
  const srv = await mockServer({ "/token": (_, res) => res.end(body), "/usage": (_, res) => res.end(body) });
  const { client } = makeClient(tmpCreds(EXPIRED), srv.base, { refreshEnabled: () => true });
  for (const call of [() => client.getToken(), () => client.fetchUsage("TOK")]) {
    await assert.rejects(call(), (e) => {
      assert.ok(e instanceof c.BadResponseError);
      assert.ok(/: unexpected response$/.test(e.message));
      assert.ok(!e.message.includes("html") && !e.message.includes("secret-body") && !e.message.includes("portal"), e.message);
      return true;
    });
  }
  srv.close();
});

test("a usage answer that is not an object is an error", async () => {
  for (const body of ["null", "[]", '"text"', "7"]) {
    const srv = await mockServer({ "/usage": (_, res) => res.end(body) });
    const { client } = makeClient("unused", srv.base);
    await assert.rejects(client.fetchUsage("TOK"), (e) => e instanceof c.BadResponseError, body);
    srv.close();
  }
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
  await assert.rejects(client.fetchUsage("TOK"), (e) => e instanceof c.HttpError && e.status === 429 && e.retryAfterMs === undefined);
  srv.close();
});

test("a 429 carries the server's Retry-After, and never its body", async () => {
  const srv = await mockServer({
    "/usage": (_, res) => {
      res.statusCode = 429;
      res.setHeader("retry-after", "90");
      res.end("secret-body");
    },
  });
  const { client } = makeClient("unused", srv.base);
  await assert.rejects(client.fetchUsage("TOK"), (e) => {
    assert.ok(e instanceof c.HttpError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterMs, 90_000);
    assert.ok(!e.message.includes("secret-body"));
    return true;
  });
  srv.close();
});

test("parseRetryAfter reads seconds or an HTTP date, clamps them, and ignores anything else", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(c.parseRetryAfter("90", now), 90_000);
  assert.equal(c.parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(c.parseRetryAfter("Thu, 01 Jan 2026 00:03:00 GMT", now), 180_000);
  assert.equal(c.parseRetryAfter("0", now), 5_000, "never a tight loop");
  assert.equal(c.parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now), 5_000, "a date in the past");
  assert.equal(c.parseRetryAfter("999999", now), 3_600_000, "never parks the bar for hours");
  for (const bad of [undefined, null, "", "soon"]) assert.equal(c.parseRetryAfter(bad, now), undefined, String(bad));
});

test("an access token that cannot be a header value reads as an expired login, and fetch never sees it", async () => {
  for (const bad of ["A\nB", "A\r\nX-Evil: 1", "A\u0000B", "A B", "A\u00e9", "", 7, null, ["A"]]) {
    const srv = await mockServer();
    const { client } = makeClient(tmpCreds({ accessToken: bad, refreshToken: "R", expiresAt: NOW + 3_600_000 }), srv.base);
    assert.deepEqual(await client.getToken(), { kind: "expired" }, JSON.stringify(bad));
    assert.equal(srv.requests.length, 0);
    srv.close();
  }
});

test("a malformed access token does not stop a permitted renewal, and the renewed login replaces it", async () => {
  const file = tmpCreds({ accessToken: "A\nB", refreshToken: "R1", expiresAt: NOW + 3_600_000 });
  const srv = await mockServer({ "/token": json({ access_token: "NEW", refresh_token: "R2", expires_in: 3600 }) });
  const { client } = makeClient(file, srv.base, { refreshEnabled: () => true });
  assert.deepEqual(await client.getToken(), { kind: "ok", token: "NEW" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth.accessToken, "NEW");
  srv.close();
});

test("real Claude Code tokens (printable ASCII) pass", async () => {
  const srv = await mockServer();
  const token = "sk-ant-oat01-AbC_dEf-123~456.789=";
  const { client } = makeClient(tmpCreds({ accessToken: token, refreshToken: "R", expiresAt: NOW + 3_600_000 }), srv.base);
  assert.deepEqual(await client.getToken(), { kind: "ok", token });
  srv.close();
});

test("findClientId reads CLIENT_ID from the first extension dir that has it", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ext-a-"));
  const withId = fs.mkdtempSync(path.join(os.tmpdir(), "ext-b-"));
  fs.writeFileSync(path.join(withId, "extension.js"), 'x={CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",y:1}');
  assert.equal(await c.findClientId([empty, path.join(os.tmpdir(), "nonexistent-ext"), withId]), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(await c.findClientId([empty]), undefined);
});

// The shape of Claude Code's bundle: configurations side by side, each with a suffix; production has an empty one.
const LOCAL = 'CLIENT_ID:"22422756-60c9-4084-8eb7-27705fd5cf9a",DESIGN_CLIENT_ID:"00000000-0000-4000-8000-000000000000",OAUTH_FILE_SUFFIX:"-local-oauth",MCP_PROXY_URL:"http://localhost:8205"';
const PROD = 'CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",DESIGN_CLIENT_ID:"59637612-477b-4836-a601-b0589eda7704",OAUTH_FILE_SUFFIX:"",MCP_PROXY_URL:"https://mcp-proxy.example"';
const extDir = (js) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ext-c-"));
  fs.writeFileSync(path.join(d, "extension.js"), js);
  return d;
};

test("findClientId picks the production client id, whatever order the bundle lists its configurations in", async () => {
  const prod = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  assert.equal(await c.findClientId([extDir(`a={${LOCAL}};b={${PROD}}`)]), prod, "local first (Claude Code 2.1.319)");
  assert.equal(await c.findClientId([extDir(`a={${PROD}};b={${LOCAL}}`)]), prod, "production first");
  assert.equal(await c.findClientId([extDir(`a={${LOCAL}};b={${PROD}};c={${PROD}};d={${LOCAL}}`)]), prod, "each configuration twice");
  assert.equal(await c.findClientId([extDir(`a={${LOCAL}};b={${LOCAL.replace("-local-oauth", "-custom-oauth")}};c={${PROD}}`)]), prod, "any non-empty suffix is not production");
});

test("findClientId never returns a configuration with a suffix, a DESIGN_CLIENT_ID, or nothing at all", async () => {
  const onlyLocal = extDir(`a={${LOCAL}}`);
  assert.equal(await c.findClientId([onlyLocal]), undefined, "only a local configuration");
  const production = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  assert.equal(await c.findClientId([onlyLocal, extDir(`a={${PROD}}`)]), production, "an older extension directory is tried next");
  assert.equal(await c.findClientId([extDir('a={DESIGN_CLIENT_ID:"59637612-477b-4836-a601-b0589eda7704"}')]), undefined, "DESIGN_CLIENT_ID is not CLIENT_ID");
  assert.equal(await c.findClientId([extDir('a={MY_CLIENT_ID:"59637612-477b-4836-a601-b0589eda7704"}')]), undefined, "nor is any other name that ends the same way");
  assert.equal(await c.findClientId([extDir('a={CLIENT_ID:"not-a-uuid"}')]), undefined);
  assert.equal(await c.findClientId([extDir('x={CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}')]), production, "a bundle that names no suffix at all (an older shape) still works");
});

// ── formatting ───────────────────────────────────────────────────────────────

test("clockTime is the local 24-hour time, zero-padded", () => {
  assert.equal(c.clockTime(new Date(2026, 0, 1, 14, 32, 59).getTime()), "14:32");
  assert.equal(c.clockTime(new Date(2026, 0, 1, 0, 5).getTime()), "00:05");
  assert.equal(c.clockTime(new Date(2026, 0, 1, 9, 0).getTime()), "09:00");
});

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

// ── the test seam ────────────────────────────────────────────────────────────

test("a test host can point the extension at a fake API on this machine", () => {
  const over = c.testOverrides({
    [c.TEST_ENV.usageUrl]: "http://127.0.0.1:4567/api/oauth/usage",
    [c.TEST_ENV.tokenUrl]: "http://localhost:4567/v1/oauth/token",
  });
  assert.equal(over.usageUrl, "http://127.0.0.1:4567/api/oauth/usage");
  assert.equal(over.tokenUrl, "http://localhost:4567/v1/oauth/token");
  assert.equal(over.exec, undefined, "the Keychain is left alone unless asked");
  assert.equal(c.testOverrides({ [c.TEST_ENV.usageUrl]: "http://[::1]:1/x" }).usageUrl, "http://[::1]:1/x");
});

test("with nothing set, the seam changes nothing", () => {
  assert.deepEqual(c.testOverrides({}), {});
  assert.deepEqual(c.testOverrides({ [c.TEST_ENV.usageUrl]: "", [c.TEST_ENV.noKeychain]: "" }), {}, "empty means unset");
});

test("the login can only be sent to the loopback, however the environment is set", () => {
  for (const url of [
    "https://api.anthropic.com/api/oauth/usage",
    "http://api.anthropic.com/api/oauth/usage",
    "https://127.0.0.1:4567/", // not http: the fake API does not speak TLS
    "http://127.0.0.1.evil.example/",
    "http://evil.example/?h=127.0.0.1",
    "not a url",
  ]) {
    for (const name of [c.TEST_ENV.usageUrl, c.TEST_ENV.tokenUrl]) {
      assert.throws(() => c.testOverrides({ [name]: url }), new RegExp(`${name} must be an http URL on 127.0.0.1`), url);
    }
  }
});

test("the Keychain switch makes `security` fail without running anything, so a test never reads a real login", async () => {
  const srv = await mockServer();
  const { exec } = c.testOverrides({ [c.TEST_ENV.noKeychain]: "1" });
  const { client } = makeClient(tmpCreds(FRESH), srv.base, { platform: "darwin", exec });
  const token = await client.getToken();
  assert.deepEqual(token, { kind: "ok", token: FRESH.accessToken }, "falls through to the credentials file");
  await assert.rejects(exec("security", ["find-generic-password"]), /switched off in tests/);
  srv.close();
});

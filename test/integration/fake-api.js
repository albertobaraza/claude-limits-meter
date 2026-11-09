// A fake of the two Anthropic endpoints the extension talks to, on the loopback, for the integration tests.
// It answers the real paths (/api/oauth/usage, /v1/oauth/token) so the URLs in the environment are the real
// ones with another origin, and it is steered over HTTP, because the test that steers it runs in another
// process (VS Code's extension host) than the one that started it.
//
//   PUT    /__control/script   {status, headers?, body?}  what the usage endpoint answers from now on
//   GET    /__control/log                                 what the endpoints were asked, oldest first
//   DELETE /__control/log                                 forget it
//
// Everything here is fake: the tokens are strings that only mean something to this file.

const http = require("node:http");

const FAKE_TOKENS = {
  access: "fake-access-token",
  refresh: "fake-refresh-token",
  renewedAccess: "fake-renewed-access-token",
  renewedRefresh: "fake-renewed-refresh-token",
};

/** A reading the usage endpoint can answer with. `resets` are ISO timestamps. */
const usageBody = ({ fiveHour, sevenDay, fiveHourResets, sevenDayResets }) => ({
  five_hour: { utilization: fiveHour, resets_at: fiveHourResets },
  seven_day: { utilization: sevenDay, resets_at: sevenDayResets },
});

function readBody(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

/** Starts the server on a free loopback port. Resolves with its origin, a `close()`, and the URLs to hand to the extension. */
async function startFakeApi() {
  let script = { status: 200, body: usageBody({ fiveHour: 0, sevenDay: 0 }) };
  let log = [];

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://fake");
    const text = await readBody(req);

    if (pathname === "/__control/script" && req.method === "PUT") {
      script = JSON.parse(text);
      return send(res, 204);
    }
    if (pathname === "/__control/log") {
      if (req.method !== "DELETE") return send(res, 200, log);
      log = [];
      return send(res, 204);
    }

    if (pathname === "/api/oauth/usage" && req.method === "GET") {
      log.push({
        endpoint: "usage",
        bearer: /^Bearer (.*)$/.exec(req.headers.authorization ?? "")?.[1],
        userAgent: req.headers["user-agent"],
        beta: req.headers["anthropic-beta"],
      });
      return send(res, script.status, script.body, script.headers);
    }

    if (pathname === "/v1/oauth/token" && req.method === "POST") {
      const body = JSON.parse(text || "{}");
      log.push({ endpoint: "token", grantType: body.grant_type, refreshToken: body.refresh_token, clientId: body.client_id });
      return send(res, 200, {
        access_token: FAKE_TOKENS.renewedAccess,
        refresh_token: FAKE_TOKENS.renewedRefresh,
        expires_in: 3600,
      });
    }

    send(res, 404);
  });

  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    usageUrl: `${origin}/api/oauth/usage`,
    tokenUrl: `${origin}/v1/oauth/token`,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

module.exports = { FAKE_TOKENS, startFakeApi, usageBody };

// A fake of the two Anthropic endpoints the extension talks to, for the integration tests and for the live
// environment (scripts/run.sh). It answers the real paths (/api/oauth/usage, /v1/oauth/token), and it is steered over
// HTTP, because whoever steers it (VS Code's extension host, a browser) is not in the process that runs it.
//
//   PUT    /__control/script   what the usage endpoint answers from now on, one of
//                                {status, headers?, body?}   a literal answer
//                                {status: 200, usage: {fiveHour, sevenDay, fiveHourResetsInMinutes, sevenDayResetsInMinutes}}
//                                                            a reading, its reset times counted from the moment it is asked
//   GET    /__control/script   the script now
//   GET    /__control/log      what the endpoints were asked, oldest first
//   DELETE /__control/log      forget it
//
// `startFakeApi()` serves all of it on one loopback port (the integration tests). The live mock serves the API over TLS
// and the control routes on another port (test/live/mock/server.js), from the same `createFakeApi()`.
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

/**
 * The fake's state, as two request handlers: `api` answers the endpoints the extension calls, `control` is how it is
 * steered. A handler is `(req, res, pathname, text) => handled`, so several can be chained with `listener`.
 * `onRequest` is told about every request the extension makes (not the control ones), and `script` is what the usage
 * endpoint answers until it is steered.
 */
function createFakeApi({ onRequest = () => {}, script: initialScript } = {}) {
  let script = initialScript ?? { status: 200, body: usageBody({ fiveHour: 0, sevenDay: 0 }) };
  let log = [];

  const record = (entry) => {
    log.push({ at: Date.now(), ...entry });
    onRequest(log[log.length - 1]);
  };

  /** What the usage endpoint answers now; a script with `usage` gets its reset times from the moment of the request. */
  function usageAnswer() {
    if (!script.usage) return script;
    const { fiveHour, sevenDay, fiveHourResetsInMinutes = 0, sevenDayResetsInMinutes = 0 } = script.usage;
    const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
    return {
      ...script,
      body: usageBody({
        fiveHour,
        sevenDay,
        fiveHourResets: inMinutes(fiveHourResetsInMinutes),
        sevenDayResets: inMinutes(sevenDayResetsInMinutes),
      }),
    };
  }

  async function api(req, res, pathname, text) {
    if (pathname === "/api/oauth/usage" && req.method === "GET") {
      const answer = usageAnswer();
      record({
        endpoint: "usage",
        bearer: /^Bearer (.*)$/.exec(req.headers.authorization ?? "")?.[1],
        userAgent: req.headers["user-agent"],
        beta: req.headers["anthropic-beta"],
        answered: answer.status,
      });
      send(res, answer.status, answer.body, answer.headers);
      return true;
    }

    if (pathname === "/v1/oauth/token" && req.method === "POST") {
      const body = JSON.parse(text || "{}");
      record({ endpoint: "token", grantType: body.grant_type, refreshToken: body.refresh_token, clientId: body.client_id, answered: 200 });
      send(res, 200, {
        access_token: FAKE_TOKENS.renewedAccess,
        refresh_token: FAKE_TOKENS.renewedRefresh,
        expires_in: 3600,
      });
      return true;
    }
    return false;
  }

  async function control(req, res, pathname, text) {
    if (pathname === "/__control/script") {
      if (req.method === "PUT") {
        script = JSON.parse(text);
        send(res, 204);
      } else {
        send(res, 200, script);
      }
      return true;
    }
    if (pathname === "/__control/log") {
      if (req.method === "DELETE") {
        log = [];
        send(res, 204);
      } else {
        send(res, 200, log);
      }
      return true;
    }
    return false;
  }

  return { api, control };
}

/** A request listener that offers each request to the handlers in turn and answers 404 when none takes it. */
function listener(...handlers) {
  return async (req, res) => {
    const { pathname } = new URL(req.url, "http://fake");
    const text = await readBody(req);
    for (const handler of handlers) if (await handler(req, res, pathname, text)) return;
    send(res, 404);
  };
}

/** Starts the fake on a free loopback port. Resolves with its origin, a `close()`, and the URLs to hand to the extension. */
async function startFakeApi() {
  const fake = createFakeApi();
  const server = http.createServer(listener(fake.control, fake.api));

  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    usageUrl: `${origin}/api/oauth/usage`,
    tokenUrl: `${origin}/v1/oauth/token`,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

module.exports = { FAKE_TOKENS, createFakeApi, listener, send, startFakeApi, usageBody };

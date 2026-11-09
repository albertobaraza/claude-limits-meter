// What each state looks like (src/view.ts): status-bar text, tooltip Markdown and the click menu.
const test = require("node:test");
const assert = require("node:assert/strict");
const { statusView, menuEntries, escapeMarkdown, SETTINGS } = require("../../out/view.js");

const NOW = Date.parse("2026-01-01T00:00:00Z");
const COMMANDS = { refresh: "ext.refresh", openCredentials: "ext.openCreds" };
const SNAPSHOT = {
  fiveHour: 42.9,
  fiveHourReset: "2026-01-01T02:13:00+00:00",
  sevenDay: 18,
  sevenDayReset: "2026-01-05T02:00:00+00:00",
  checkedAt: new Date(2026, 0, 1, 14, 32).getTime(), // local time, so "14:32" in any time zone
};
const view = (state) => statusView(state, COMMANDS, NOW);

test("every state links to the refresh and credentials commands", () => {
  for (const status of ["loading", "ok", "noCreds", "expired", "rateLimited", "error"]) {
    const { markdown } = view({ status, snapshot: SNAPSHOT, error: "x" });
    assert.match(markdown, /\[Refresh Now\]\(command:ext\.refresh\)/, status);
    assert.match(markdown, /\[Open Credentials File\]\(command:ext\.openCreds\)/, status);
  }
});

test("ok shows the 5-hour percentage, truncated, in the status bar", () => {
  assert.equal(view({ status: "ok", snapshot: SNAPSHOT }).text, "$(sparkle) 42%");
});

test("the hover is a short summary of both windows and when they were last checked, with no bars", () => {
  const { markdown } = view({ status: "ok", snapshot: SNAPSHOT });
  assert.match(markdown, /Session \(5h\) \*\*42%\*\* · Weekly \(7d\) \*\*18%\*\*/);
  assert.match(markdown, /_Last checked 14:32_/);
  assert.doesNotMatch(markdown, /[█░⏱]/, "bars and reset times are in the click menu");
  assert.doesNotMatch(markdown, /```/);
});

test("loading", () => {
  const { text, markdown } = view({ status: "loading" });
  assert.equal(text, "$(sparkle) …");
  assert.match(markdown, /Loading/);
});

test("noCreds says how to sign in, and shows no old reading", () => {
  const { text, markdown } = view({ status: "noCreds", snapshot: SNAPSHOT });
  assert.equal(text, "$(sparkle) —");
  assert.match(markdown, /No Claude Code login found/);
  assert.doesNotMatch(markdown, /Session \(5h\)/);
});

test("expired explains the way out, names the setting and still shows the last reading", () => {
  const { text, markdown } = view({ status: "expired", snapshot: SNAPSHOT });
  assert.equal(text, "$(sparkle) !");
  assert.match(markdown, new RegExp(`${SETTINGS}\\.refreshExpiredToken`));
  assert.match(markdown, /Session \(5h\)/);
});

test("rateLimited shows a clock, the last reading, and when the next check can happen", () => {
  const state = { status: "rateLimited", snapshot: SNAPSHOT, retryAt: NOW + 2 * 60_000 };
  const { text, markdown } = view(state);
  assert.equal(text, "$(clock) 42%");
  assert.match(markdown, /rate limiting requests\. The next check is in 2m; Refresh Now will not ask sooner/);
  assert.match(markdown, /Session \(5h\)/);
  assert.equal(view({ status: "rateLimited", retryAt: NOW + 1000 }).text, "$(clock) —", "no reading yet");
  assert.match(view({ status: "rateLimited", retryAt: NOW - 1 }).markdown, /next check is in now/);
});

test("the menu says when the rate limit ends, between the usage lines and the actions", () => {
  const entries = menuEntries({ status: "rateLimited", snapshot: SNAPSHOT, retryAt: NOW + 3 * 60_000 }, NOW);
  assert.deepEqual(
    entries.map((e) => e.label),
    [
      "$(pulse) Session (5h)",
      "$(pulse) Weekly (7d)",
      "$(clock) Rate limited",
      "$(history) Last checked",
      "",
      "$(refresh) Refresh Now",
      "$(key) Open Credentials File",
    ],
  );
  assert.equal(entries[2].description, "next check in 3m");
  assert.equal(entries[2].action, undefined, "informational");
});

test("error shows the message and the last reading if there is one", () => {
  const withReading = view({ status: "error", error: "Usage fetch failed: HTTP 500", snapshot: SNAPSHOT });
  assert.equal(withReading.text, "$(sparkle) ✗");
  assert.match(withReading.markdown, /\$\(error\) Usage fetch failed: HTTP 500/);
  assert.match(withReading.markdown, /Session \(5h\)/);
  assert.doesNotMatch(view({ status: "error", error: "x" }).markdown, /Session \(5h\)/);
});

test("an error message cannot inject Markdown or a command link into the tooltip", () => {
  const { markdown } = view({ status: "error", error: "[click](command:workbench.action.reloadWindow) `x` <b>" });
  assert.doesNotMatch(markdown, /\[click\]\(command:workbench/);
  assert.match(markdown, /\\\[click\\\]\\\(command:workbench/);
  assert.equal(escapeMarkdown("a_b*c"), "a\\_b\\*c");
});

test("the menu lists both windows with bars and reset times, when they were checked, then the actions", () => {
  const entries = menuEntries({ status: "ok", snapshot: SNAPSHOT }, NOW);
  assert.deepEqual(
    entries.map((e) => e.label),
    [
      "$(pulse) Session (5h)",
      "$(pulse) Weekly (7d)",
      "$(history) Last checked",
      "",
      "$(refresh) Refresh Now",
      "$(key) Open Credentials File",
    ],
  );
  assert.equal(entries[0].description, "████░░░░░░ 42%   ⏱ 2h 13m");
  assert.equal(entries[1].description, "██░░░░░░░░ 18%   ⏱ 4d 2h");
  assert.equal(entries[2].description, "14:32");
  assert.equal(entries[3].separator, true);
  assert.deepEqual(entries.filter((e) => e.action).map((e) => e.action), ["refresh", "openCredentials"]);
  assert.equal(entries[0].action, undefined, "usage lines are informational");
  assert.equal(entries[2].action, undefined, "so is the last-checked line");
});

test("the menu with no reading says why, and has no last-checked line", () => {
  assert.equal(menuEntries({ status: "noCreds" }, NOW)[0].description, "no credentials");
  assert.equal(menuEntries({ status: "loading" }, NOW)[0].description, "—");
  assert.ok(!menuEntries({ status: "loading" }, NOW).some((e) => e.label.includes("Last checked")));
});

test("the menu explains a state that needs it, as plain text, between the usage and the actions", () => {
  const labels = (state) => menuEntries(state, NOW).map((e) => e.label);

  const noCreds = menuEntries({ status: "noCreds" }, NOW)[1];
  assert.equal(noCreds.label, "$(warning) No Claude Code login found");
  assert.match(noCreds.detail, /Sign in to Claude Code first/);

  const expired = menuEntries({ status: "expired", snapshot: SNAPSHOT }, NOW)[2];
  assert.equal(expired.label, "$(warning) Token expired");
  assert.match(expired.detail, new RegExp(`${SETTINGS}\\.refreshExpiredToken`));
  assert.doesNotMatch(expired.detail, /`/, "no Markdown in a QuickPick");

  const error = menuEntries({ status: "error", error: "Usage fetch failed: HTTP 500", snapshot: SNAPSHOT }, NOW)[2];
  assert.equal(error.label, "$(error) Error");
  assert.equal(error.detail, "Usage fetch failed: HTTP 500", "the message as it is, not escaped for Markdown");
  assert.equal(menuEntries({ status: "error" }, NOW)[1].detail, "Unknown error");

  assert.equal(labels({ status: "ok", snapshot: SNAPSHOT }).length, 6, "an ok state needs no explanation");
});

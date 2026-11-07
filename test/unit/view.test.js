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
};
const view = (state) => statusView(state, COMMANDS, NOW);

test("every state links to the refresh and credentials commands", () => {
  for (const status of ["loading", "ok", "noCreds", "expired", "error"]) {
    const { markdown } = view({ status, snapshot: SNAPSHOT, error: "x" });
    assert.match(markdown, /\[Refresh Now\]\(command:ext\.refresh\)/, status);
    assert.match(markdown, /\[Open Credentials File\]\(command:ext\.openCreds\)/, status);
  }
});

test("ok shows the 5-hour percentage, truncated, and both windows with reset countdowns", () => {
  const { text, markdown } = view({ status: "ok", snapshot: SNAPSHOT });
  assert.equal(text, "$(sparkle) 42%");
  assert.match(markdown, /Session \(5h\)  ████░░░░░░  42% {3}⏱ 2h 13m/);
  assert.match(markdown, /Weekly {2}\(7d\) {2}██░░░░░░░░ {2}18% {3}⏱ 4d 2h/);
  assert.match(markdown, /```text\n.*\n.*\n```/);
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

test("the menu lists both windows, then Refresh Now and Open Credentials File", () => {
  const entries = menuEntries({ status: "ok", snapshot: SNAPSHOT }, NOW);
  assert.deepEqual(
    entries.map((e) => e.label),
    ["$(pulse) Session (5h)", "$(pulse) Weekly (7d)", "", "$(refresh) Refresh Now", "$(key) Open Credentials File"],
  );
  assert.equal(entries[0].description, "████░░░░░░ 42%   ⏱ 2h 13m");
  assert.equal(entries[2].separator, true);
  assert.deepEqual(entries.filter((e) => e.action).map((e) => e.action), ["refresh", "openCredentials"]);
  assert.equal(entries[0].action, undefined, "usage lines are informational");
});

test("the menu with no reading says why", () => {
  assert.equal(menuEntries({ status: "noCreds" }, NOW)[0].description, "no credentials");
  assert.equal(menuEntries({ status: "loading" }, NOW)[0].description, "—");
});

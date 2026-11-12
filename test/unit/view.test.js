// What each state looks like (src/view.ts): status-bar text, tooltip Markdown and the click menu.
const test = require("node:test");
const assert = require("node:assert/strict");
const { statusView, menuEntries, devView, escapeMarkdown, SETTINGS } = require("../../out/view.js");

const NOW = Date.parse("2026-01-01T00:00:00Z");
const COMMANDS = { refresh: "ext.refresh", openCredentials: "ext.openCreds", openSettings: "ext.openSettings" };
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
    assert.match(markdown, /\[Settings\]\(command:ext\.openSettings\)/, status);
  }
});

test("ok shows the 5-hour percentage, truncated, in the status bar", () => {
  assert.equal(view({ status: "ok", snapshot: SNAPSHOT }).text, "$(sparkle) 42%");
});

test("showWeekly puts the 7-day week next to the 5-hour session in the status-bar text", () => {
  const both = (state) => statusView(state, COMMANDS, NOW, { showWeekly: true });
  assert.equal(both({ status: "ok", snapshot: SNAPSHOT }).text, "$(sparkle) 5h 42% · 7d 18%");
  assert.equal(both({ status: "rateLimited", snapshot: SNAPSHOT, retryAt: NOW + 1000 }).text, "$(clock) 5h 42% · 7d 18%");
  assert.equal(both({ status: "rateLimited", retryAt: NOW + 1000 }).text, "$(clock) —", "no reading yet");
  assert.equal(both({ status: "ok" }).text, "$(sparkle) 5h 0% · 7d 0%");
  // The states that show a symbol instead of numbers are the same with the setting on.
  for (const status of ["loading", "noCreds", "expired", "error"]) {
    const state = { status, snapshot: SNAPSHOT, error: "x" };
    assert.equal(both(state).text, view(state).text, status);
  }
  // Off is the default, whether the option is left out, empty or false, and the hover is the same either way.
  assert.equal(statusView({ status: "ok", snapshot: SNAPSHOT }, COMMANDS, NOW, {}).text, "$(sparkle) 42%");
  assert.equal(statusView({ status: "ok", snapshot: SNAPSHOT }, COMMANDS, NOW, { showWeekly: false }).text, "$(sparkle) 42%");
  assert.equal(both({ status: "ok", snapshot: SNAPSHOT }).markdown, view({ status: "ok", snapshot: SNAPSHOT }).markdown);
});

test("the hover is a short summary of both windows and when they were last checked, with no bars", () => {
  const { markdown } = view({ status: "ok", snapshot: SNAPSHOT });
  assert.match(markdown, /Session \(5h\) \*\*42%\*\* · Weekly \(7d\) \*\*18%\*\*/);
  assert.match(markdown, /_Last checked 14:32_/);
  assert.doesNotMatch(markdown, /[█░⏱]/, "bars and reset times are in the click menu");
  assert.doesNotMatch(markdown, /```/);
});

test("a development build marks the text and the tooltip, and keeps everything else", () => {
  const plain = view({ status: "ok", snapshot: SNAPSHOT });
  const dev = devView(plain);
  assert.equal(dev.text, "$(sparkle) 42% DEV");
  assert.match(dev.markdown, /^\$\(beaker\) \*\*Development build\*\*, not the installed extension\n\n/);
  assert.ok(dev.markdown.endsWith(plain.markdown), "the tooltip is the normal one underneath");
  assert.equal(plain.text, "$(sparkle) 42%", "devView does not change its input");
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

test("rateLimited shows a clock, the last reading, and that the extension retries by itself", () => {
  const state = { status: "rateLimited", snapshot: SNAPSHOT, retryAt: NOW + 2 * 60_000 };
  const { text, markdown } = view(state);
  assert.equal(text, "$(clock) 42%");
  assert.match(markdown, /rate limiting requests\. The extension will retry automatically\./);
  assert.match(markdown, /Session \(5h\)/);
  assert.equal(view({ status: "rateLimited", retryAt: NOW + 1000 }).text, "$(clock) —", "no reading yet");
});

test("a rate limit shows no countdown, which read \"0m\" for the last minute of a wait", () => {
  for (const left of [3 * 60_000, 59_000, 30_000, 5_000, -1]) {
    const state = { status: "rateLimited", snapshot: SNAPSHOT, retryAt: NOW + left };
    const hover = view(state).markdown;
    assert.doesNotMatch(hover, /next check|\b0m\b|in now/i, `hover, ${left} ms left`);
    // A button's name is not in the sentence: "Refresh Now" appears once, as the link in the footer.
    assert.equal(hover.match(/Refresh Now/g).length, 1, `hover, ${left} ms left`);
    const notice = menuEntries(state, NOW).find((e) => e.label === "$(clock) Rate limited");
    assert.equal(notice.description, "retrying automatically", `menu, ${left} ms left`);
  }
});

test("the menu says Claude is rate limiting and that it retries by itself, between the usage lines and the actions", () => {
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
      "$(gear) Settings",
    ],
  );
  assert.equal(entries[2].description, "retrying automatically");
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

test("an error message is one line, and the marks that open a fence, a heading or an entity are escaped", () => {
  const out = escapeMarkdown("first\n~~~\n# heading\r\n=====\n  $(error) &lt; x\ttab");
  assert.doesNotMatch(out, /[\n\r\t]/, "no line break survives, so nothing can start a block");
  assert.equal(out, String.raw`first \~\~\~ \# heading \=\=\=\=\= \$\(error\) \&lt; x tab`);
  const { markdown } = view({ status: "error", error: "boom\n[x](command:claudeLimitsMeter.openCredentials)" });
  assert.equal(markdown.split("\n").filter((l) => l.includes("boom")).length, 1, "the whole message sits on one line");
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
      "$(gear) Settings",
    ],
  );
  assert.equal(entries[0].description, "████░░░░░░ 42%   ⏱ 2h 13m");
  assert.equal(entries[1].description, "██░░░░░░░░ 18%   ⏱ 4d 2h");
  assert.equal(entries[2].description, "14:32");
  assert.equal(entries[3].separator, true);
  assert.deepEqual(entries.filter((e) => e.action).map((e) => e.action), ["refresh", "openCredentials", "openSettings"]);
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

  assert.equal(labels({ status: "ok", snapshot: SNAPSHOT }).length, 7, "an ok state needs no explanation");
});

// Runs the extension host suite and the UI run in a clean Linux container (test/ui/Dockerfile): the same tests
// as `npm run test:integration` and `npm run test:ui`, on a machine with nothing of yours on it. A convenience
// for a reproducible local run; CI runs them on the native runners, where macOS and Windows are covered too.
//
//   npm run test:integration:docker
//   VSCODE_VERSION=1.85.0 npm run test:integration:docker      the oldest VS Code package.json promises
//
// The container is started with no mounts, so it can never see your ~/.claude. Screenshots are copied out of it to
// .vscode-test/screenshots-docker. The image caches VS Code: run `docker build --no-cache` (or change
// VSCODE_VERSION) to pick up a newer stable.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const IMAGE = "claude-limits-meter-it";
const CONTAINER = `${IMAGE}-${process.pid}`;
const version = process.env.VSCODE_VERSION || "stable";

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) {
    console.error(`could not run docker: ${result.error.message}`);
    process.exit(1);
  }
  return result.status;
}

function main() {
  if (docker(["build", "--tag", IMAGE, "--file", "test/ui/Dockerfile", "--build-arg", `VSCODE_VERSION=${version}`, "."]) !== 0) {
    return 1;
  }

  // No --volume and no --mount, on purpose. A shared memory size above Docker's 64 MB default keeps Chromium from crashing.
  const status = docker(["run", "--name", CONTAINER, "--shm-size=1g", IMAGE]);

  const shots = path.join(root, ".vscode-test", "screenshots-docker");
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(shots), { recursive: true });
  if (docker(["cp", `${CONTAINER}:/app/.vscode-test/screenshots`, shots], { stdio: "ignore" }) === 0) {
    console.log(`screenshots: ${shots}`);
  }
  docker(["rm", "--force", CONTAINER], { stdio: "ignore" });
  return status;
}

process.exit(main());

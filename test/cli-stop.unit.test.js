import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "maven-proxy.js");
const tempHomes = [];

afterEach(async () => {
  while (tempHomes.length > 0) {
    const homeDir = tempHomes.pop();
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

async function createTempHome() {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "maven-proxy-cli-stop-"));
  tempHomes.push(homeDir);
  return homeDir;
}

function getPidFilePath(homeDir) {
  return path.join(homeDir, "maven-proxy", "maven-proxy.pid");
}

async function writePidFile(homeDir, content) {
  const pidFile = getPidFilePath(homeDir);
  await fsp.mkdir(path.dirname(pidFile), { recursive: true });
  await fsp.writeFile(pidFile, content, "utf8");
  return pidFile;
}

function runCli(args, homeDir) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
  });
}

function assertCliSuccess(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
}

describe("CLI stop", () => {
  test("removes invalid pid file directly", async () => {
    const homeDir = await createTempHome();
    const pidFile = await writePidFile(homeDir, "not-a-pid\n");

    const result = runCli(["stop"], homeDir);

    assertCliSuccess(result);
    assert.equal(fs.existsSync(pidFile), false);
    assert.match(result.stdout, /stale pid file removed/i);
  });

  test("removes stale pid file when process does not exist", async () => {
    const homeDir = await createTempHome();
    const pidFile = await writePidFile(homeDir, "999999\n");

    const result = runCli(["stop"], homeDir);

    assertCliSuccess(result);
    assert.equal(fs.existsSync(pidFile), false);
    assert.match(result.stdout, /stale pid removed: 999999/i);
  });
});



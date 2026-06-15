import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseArgs, resolveCliCommand } from "../bin/maven-proxy.js";

describe("CLI command resolution", () => {
  test("no args resolves to foreground start", () => {
    const options = parseArgs([]);
    assert.equal(resolveCliCommand(options), "__start-foreground");
  });

  test("explicit start keeps background command", () => {
    const options = parseArgs(["start"]);
    assert.equal(resolveCliCommand(options), "start");
  });
});
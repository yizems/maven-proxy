import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseDurationToMs, formatBytes } from "../src/common/format-utils.js";

describe("parseDurationToMs", () => {
  test("parses seconds, minutes, hours, days", () => {
    assert.equal(parseDurationToMs("1s", 0), 1000);
    assert.equal(parseDurationToMs("2m", 0), 2 * 60 * 1000);
    assert.equal(parseDurationToMs("3h", 0), 3 * 60 * 60 * 1000);
    assert.equal(parseDurationToMs("1d", 0), 24 * 60 * 60 * 1000);
  });

  test("returns fallback for invalid", () => {
    assert.equal(parseDurationToMs("", 12345), 12345);
    assert.equal(parseDurationToMs("10x", 7), 7);
  });
});

describe("formatBytes", () => {
  test("formats bytes, KB, MB, GB, TB", () => {
    assert.equal(formatBytes(0), "0B");
    assert.equal(formatBytes(500), "500B");
    assert.equal(formatBytes(1024), "1.00KB");
    assert.equal(formatBytes(1024 ** 2), "1.00MB");
    assert.equal(formatBytes(1024 ** 3), "1.00GB");
  });

  test("returns 0B for negative or invalid", () => {
    assert.equal(formatBytes(-1), "0B");
    assert.equal(formatBytes(NaN), "0B");
  });
});

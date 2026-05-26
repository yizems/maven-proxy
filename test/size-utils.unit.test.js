import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseSizeToBytes } from "../src/common/size-utils.js";

describe("parseSizeToBytes", () => {
  test("parses plain numbers as bytes", () => {
    assert.equal(parseSizeToBytes("123"), 123);
  });

  test("parses K/M/G/T units (case-insensitive)", () => {
    assert.equal(parseSizeToBytes("1K"), 1024);
    assert.equal(parseSizeToBytes("1k"), 1024);
    assert.equal(parseSizeToBytes("1M"), 1024 * 1024);
    assert.equal(parseSizeToBytes("2G"), 2 * 1024 ** 3);
    assert.equal(parseSizeToBytes("3T"), 3 * 1024 ** 4);
  });

  test("returns fallback for empty or invalid input", () => {
    assert.equal(parseSizeToBytes("", 42), 42);
    assert.equal(parseSizeToBytes("abc", 7), 7);
  });
});

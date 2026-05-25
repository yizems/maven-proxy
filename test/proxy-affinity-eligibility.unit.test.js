import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPositiveAffinityEligible } from "../src/proxy/proxy-http-handler.js";

describe("proxy positive affinity eligibility", () => {
  test("allows binary artifacts and their checksum/signature files", () => {
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.jar"), true);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.aar"), true);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.war"), true);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.jar.sha1"), true);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.aar.md5"), true);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.war.asc"), true);
  });

  test("rejects metadata files", () => {
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.pom"), false);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.module"), false);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.pom.sha1"), false);
    assert.equal(isPositiveAffinityEligible("demo-1.0.0.module.sha256"), false);
  });
});

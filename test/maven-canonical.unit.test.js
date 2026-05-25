import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMavenReleaseCanonical } from "../src/common/maven-canonical.js";

describe("maven canonical parser", () => {
  test("parses maven2 style release path", () => {
    const url = new URL("https://repo1.maven.org/maven2/com/google/guava/guava/33.0.0-jre/guava-33.0.0-jre.pom");
    const parsed = parseMavenReleaseCanonical(url);

    assert.ok(parsed);
    assert.equal(
      parsed.canonicalKey,
      "com/google/guava/guava/33.0.0-jre/guava-33.0.0-jre.pom",
    );
    assert.equal(parsed.isRelease, true);
  });

  test("normalizes repository prefix path to the same canonical key", () => {
    const urlA = new URL("https://repo1.maven.org/maven2/com/google/guava/guava/33.0.0-jre/guava-33.0.0-jre.pom");
    const urlB = new URL("https://nexus.example.com/repository/maven-public/com/google/guava/guava/33.0.0-jre/guava-33.0.0-jre.pom");

    const a = parseMavenReleaseCanonical(urlA);
    const b = parseMavenReleaseCanonical(urlB);

    assert.ok(a);
    assert.ok(b);
    assert.equal(a.canonicalKey, b.canonicalKey);
  });

  test("rejects snapshot version directory", () => {
    const url = new URL("https://repo1.maven.org/maven2/com/acme/demo/1.0.0-SNAPSHOT/demo-1.0.0-SNAPSHOT.pom");
    const parsed = parseMavenReleaseCanonical(url);
    assert.equal(parsed, null);
  });

  test("rejects filename with artifact mismatch", () => {
    const url = new URL("https://repo1.maven.org/maven2/com/acme/demo/1.0.0/another-1.0.0.jar");
    const parsed = parseMavenReleaseCanonical(url);
    assert.equal(parsed, null);
  });
});

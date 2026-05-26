import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import {
  buildMavenHostlessPathCandidates,
  getCacheFilePath,
  parseMavenCacheIgnorePathPrefixes,
  stripMavenIgnoredPathPrefix,
} from "../src/cache/cache-path.js";

describe("maven cache ignore path prefixes", () => {
  test("parses host/path and host:port/path rules", () => {
    const rules = parseMavenCacheIgnorePathPrefixes(
      "repo1.maven.org/maven2,repo.example.com:8443/repository/maven-public,invalid-rule",
    );

    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0], {
      hostname: "repo1.maven.org",
      port: "",
      pathPrefix: "/maven2",
      raw: "repo1.maven.org/maven2",
    });
    assert.deepEqual(rules[1], {
      hostname: "repo.example.com",
      port: "8443",
      pathPrefix: "/repository/maven-public",
      raw: "repo.example.com:8443/repository/maven-public",
    });
  });

  test("strips matching prefix by host", () => {
    const rules = parseMavenCacheIgnorePathPrefixes("repo1.maven.org/maven2");
    const url = new URL("https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom");

    const stripped = stripMavenIgnoredPathPrefix(url.pathname, url, rules);
    assert.equal(stripped, "/junit/junit/4.13.2/junit-4.13.2.pom");
  });

  test("strips matching prefix by host and port", () => {
    const rules = parseMavenCacheIgnorePathPrefixes("repo.example.com:8443/repository/maven-public");
    const url = new URL("https://repo.example.com:8443/repository/maven-public/com/acme/demo/1.0.0/demo-1.0.0.jar");

    const stripped = stripMavenIgnoredPathPrefix(url.pathname, url, rules);
    assert.equal(stripped, "/com/acme/demo/1.0.0/demo-1.0.0.jar");
  });

  test("keeps path unchanged when no rule matches", () => {
    const rules = parseMavenCacheIgnorePathPrefixes("repo1.maven.org/maven2");
    const url = new URL("https://jitpack.io/com/github/acme/demo/1.0.0/demo-1.0.0.pom");

    const stripped = stripMavenIgnoredPathPrefix(url.pathname, url, rules);
    assert.equal(stripped, "/com/github/acme/demo/1.0.0/demo-1.0.0.pom");
  });

  test("applies strip rules in maven cache file path generation", () => {
    const rules = parseMavenCacheIgnorePathPrefixes("repo1.maven.org/maven2");
    const url = new URL("https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom");

    const cachePath = getCacheFilePath("data/cache", url, {
      ecosystem: "maven",
      includeHost: false,
      mavenCacheIgnorePathPrefixRules: rules,
    });

    assert.equal(
      cachePath,
      path.join("data/cache", "maven", "junit", "junit", "4.13.2", "junit-4.13.2.pom"),
    );
  });

  test("builds hostless lookup candidates for repo endpoint", () => {
    const rules = parseMavenCacheIgnorePathPrefixes(
      "repo1.maven.org/maven2,plugins.gradle.org/m2",
    );

    const candidates = buildMavenHostlessPathCandidates(
      "/maven2/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom",
      rules,
    );

    assert.deepEqual(candidates, [
      "/maven2/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom",
      "/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom",
    ]);
  });
});

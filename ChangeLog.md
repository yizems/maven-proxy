# ChangeLog

All notable changes to this project are documented in this file.

## [1.3.4] - 2026-05-26

### Added
- Implement meta.json handling for related artifact downloads. (4e50d41)
- Add support for passthrough configuration in HTTPS proxy. (6f1dc7e)

### Changed
- Enhance 404 response. (2226291)

### Other
- Misc: ignore. (2446d7c)
- Chore: prepare 1.3.4. (942e413)

### Git Commits Included
- `4e50d41` feat(proxy): implement meta.json handling for related artifact downloads
- `2226291` enhance 404 response
- `6f1dc7e` feat(proxy): add support for passthrough configuration in HTTPS proxy
- `2446d7c` ignore
- `942e413` prepare 1.3.4

## [1.3.3]

### Added
- Added support for ignoring Maven cache path prefixes by host.
- Added Maven domain-dir switch and integrated cache path wiring.

### Changed
- Removed positive 'affinity' cache reuse: the index now maintains negative-only entries (404/410) to suppress repeated upstream requests.
- Renamed environment variables from `MAVEN_AFFINITY_*` to `MAVEN_NEGATIVE_*` and added backwards-compatible fallbacks for `MAVEN_AFFINITY_*`.
- Rewrote the index implementation to `src/cache/maven-negative-index.js` and removed the old `maven-affinity-index.js`.
- Updated the generated config template (`bin/maven-proxy.js`) and sample `config.properties` to use `MAVEN_NEGATIVE_*` keys.
- Updated `src/proxy/proxy-http-handler.js` to skip caching for extensionless paths and to clear negative entries on successful fetches.
- Updated tests and npm scripts to use `negative` naming; removed tests specific to positive-affinity replay/eligibility.
- Updated documentation (README, docs) and ChangeLog-zh to reflect the rename and migration notes.

### Removed
- Removed positive-affinity indexing logic and related replay / E2E tests.

### Git Commits Included (after `1.3.1`)
- `20ef408` feat(cache): add maven cache ignore path prefixes by host
- `75264bf` feat(cache): add maven domain-dir switch and wire cache paths

## [1.3.1] - 2026-05-26

### Added
- Generated default CLI config now includes bilingual Chinese/English comments for each property, aligned with README environment variable descriptions.
- Added `cli:doctor:user` npm script to run doctor checks in user mode.

### Changed
- Updated default Google Maven endpoints from `maven.google.com` to `dl.google.com` in runtime defaults and generated config defaults.

### Git Commits Included (after `1.3.0`)
- `e2398a7` feat(cli): add bilingual default config comments and refresh repo defaults

## [1.3.0] - 2026-05-25

### Breaking Changes
- Removed compatibility for legacy time environment variable keys. The following keys are no longer supported:
  - `DOWNLOAD_TIMEOUT_SECONDS`
  - `OUTBOUND_KEEP_ALIVE_SECONDS`
  - `MAVEN_NEGATIVE_CACHE_TTL_HOURS`
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL_SECONDS`
  - `LOG_RETENTION_DAYS`
- Time configuration now only accepts duration-style keys and values (`1s`, `1m`, `1h`, `1d`):
  - `DOWNLOAD_TIMEOUT` (example: `60s`)
  - `OUTBOUND_KEEP_ALIVE_INTERVAL` (example: `1s`)
  - `MAVEN_NEGATIVE_CACHE_TTL` (example: `24h`)
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL` (example: `5s`)
  - `LOG_RETENTION` (example: `7d`)

### Added
- Added cache cleanup manager with:
  - cache-hit mtime touch (`utimes`) with per-file minimum touch interval control;
  - pressure-triggered cleanup checks on cache miss path;
  - daily fixed-time cleanup check scheduling;
  - staged cleanup rounds from configured retention start window down to minimum window.

### Changed
- Moved Maven affinity index default directory from cache-local `.index` to `data/index`.
- Updated generated config template and project sample config to use new duration-style time variables.
- Synchronized README and README-zh environment variable documentation with the new keys.

### Git Commits Included (after `1.2.1`)
- `8b7a7ab` feat: add cache cleanup manager and move affinity index to data/index
- `ef40594` refactor: unify time env vars to duration format

## [1.2.1]

### Added
- Added non-blocking CLI process control: `maven-proxy start` now runs as a background daemon, and `maven-proxy stop` can terminate it via PID file.

### Changed
- Positive Maven affinity cache entries no longer expire by TTL; they are removed only when local file is missing or conflict is detected.
- Reduced CONNECT/MITM log noise by adding `LOG_CONNECT_EVENTS` (default `false`).
- Added explicit proxy logs for `local cache hit` and `local cache miss` to improve cache behavior observability.
- Changed default `HTTPS_PASSTHROUGH_FOR_UNMATCHED` to `false` in runtime defaults and generated config templates.

### Fixed
- Startup logs are now always printed even when `LOG_TO_STDOUT=false`, and startup success is explicitly logged.
- Restricted positive Maven affinity reuse to binary artifacts (`.jar/.aar/.war` and related checksum/signature files), avoiding cross-repository metadata pollution for `.pom/.module`.

### Git Commits Included (after `prepare 1.2.0`)
- `bbf1771` fix: keep positive affinity cache without ttl
- `cdb1421` fix: always print startup logs when stdout logging is off
- `4e8146f` feat: add non-blocking cli start and stop commands
- `b515910` fix: restrict maven affinity to binary assets
- `20fb0b9` chore: reduce connect noise and log cache hit miss
- `f99cf59` chore: default unmatched https passthrough to false

## [1.2.0]

### Breaking Changes
- Removed legacy environment variable compatibility. The following legacy keys are no longer supported:
  - `MULTI_THREAD_MIN_SIZE_BYTES`
  - `DOWNLOAD_TIMEOUT_MS`
  - `OUTBOUND_KEEP_ALIVE_MSECS`
  - `MAVEN_NEGATIVE_CACHE_TTL_MS`
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL_MS`
  - `MAVEN_NEGATIVE_EVENT_MAX_BYTES`
- Environment configuration now only accepts the new unit-friendly keys:
  - `MULTI_THREAD_MIN_SIZE_MB`
  - `DOWNLOAD_TIMEOUT_SECONDS`
  - `OUTBOUND_KEEP_ALIVE_SECONDS`
  - `MAVEN_NEGATIVE_CACHE_TTL_HOURS`
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL_SECONDS`
  - `MAVEN_NEGATIVE_EVENT_MAX_MB`
- Renamed default configuration file to `config.properties`:
  - Development mode now loads project-root `config.properties`.
  - CLI user mode now uses `~/maven-proxy/config.properties`.

### Changed (from git commits after 1.1.1)
- Unified logging strategy with optional stdout mirroring (`LOG_TO_STDOUT`) and log output simplification.
- Added Maven affinity cache index with persistence and standardized test entry as Node.js built-in test runner.
- Enabled outbound connection pooling and synchronized related documentation.

### Git Commits Included
- `16d85fd` feat: unify logging and add stdout toggle
- `c3b9132` feat: add maven affinity cache and standardize tests
- `5f28c64` feat: enable outbound connection pooling and sync docs

## [1.1.1] - 2026-05-25

### Added
- Added successful download logging with file size and elapsed time.

### Release
- Release preparation commit for 1.1.1.

### Git Commits Included
- `e2391b7` feat: log successful downloads with size and elapsed time
- `66fa44f` prepare 1.1.1

## [1.1.0] - 2026-05-25

### Release
- Baseline release point for the entries above.

### Git Commits Included
- `39a7a65` prepare 1.1.0

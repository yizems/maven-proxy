# ChangeLog

All notable changes to this project are documented in this file.

## [Unreleased]

### Breaking Changes
- Removed legacy environment variable compatibility. The following legacy keys are no longer supported:
  - `MULTI_THREAD_MIN_SIZE_BYTES`
  - `DOWNLOAD_TIMEOUT_MS`
  - `OUTBOUND_KEEP_ALIVE_MSECS`
  - `MAVEN_NEGATIVE_CACHE_TTL_MS`
  - `MAVEN_AFFINITY_FLUSH_INTERVAL_MS`
  - `MAVEN_AFFINITY_EVENT_MAX_BYTES`
- Environment configuration now only accepts the new unit-friendly keys:
  - `MULTI_THREAD_MIN_SIZE_MB`
  - `DOWNLOAD_TIMEOUT_SECONDS`
  - `OUTBOUND_KEEP_ALIVE_SECONDS`
  - `MAVEN_NEGATIVE_CACHE_TTL_HOURS`
  - `MAVEN_AFFINITY_FLUSH_INTERVAL_SECONDS`
  - `MAVEN_AFFINITY_EVENT_MAX_MB`

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

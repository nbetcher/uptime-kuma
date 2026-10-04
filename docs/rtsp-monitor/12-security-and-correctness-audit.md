# 12 — RTSP security and correctness audit

**Date:** 2026-10-04. **Repository:** `nbetcher/uptime-kuma`.
**Audited branch:** `rtsp-monitor-architecture`.
**Baseline commit:** `d13e96096e3306b7fc07d6c9927c62b99c4c70c0`.
**Fixes:** working-tree changes on that branch, reviewed against this baseline.

This audit found and addressed **25 High/Medium findings: 8 High and 17 Medium**.
There are 19 source findings and six dependency advisories. Low-severity
observations are excluded. Related advisory propagation through several npm
packages is counted once, rather than once per dependent package.

The scope includes Basic, Enhanced and Full modes for RTSP/RTSPS and
RTMP/RTMPS; protocol parsing, credentials, TLS, native decoding, deadlines,
concurrency, comparison and reference processing, SSRF protections, socket
authorization and binary uploads, image access and retention, migrations on
SQLite/MariaDB, edit controls, and dependencies used by these paths. This is
a review of the architecture branch, separate from the earlier review of
`rtsp-monitor` described in [11-architecture-review.md](./11-architecture-review.md).
Already-fixed findings from that earlier branch are not counted again.

## Source findings

All entries below are addressed in the working tree. **Reproduced** means a
focused fixture or regression demonstrated the failure or affected boundary.
**Inspection** means the failure follows from the implementation or native
library source; limitations on runtime validation are stated separately.

| ID | Severity | Finding and impact | Evidence and change |
| --- | --- | --- | --- |
| S01 | High | A successful preliminary Node TLS handshake authorized a separate, unverified native decoder connection. A different peer or redirect could supply frames and credentials despite Ignore TLS being off. | Reproduced native hostname-verification failure, including IP targets. Removed preliminary checks as authorization; verified secure Enhanced/Full checks and the worker-input builder now fail closed before decoder traffic. Basic still validates the actual connection. |
| S02 | High | Native decoding and conversion were insufficiently bounded. Full-resolution RGB allocation before resizing, unrestricted decoder threads, and implicit stream-info decoding could consume substantial memory/CPU despite a small output thumbnail. | Inspection plus native oversized-image regression. Open with `skipStreamInfo`, read video packets explicitly, constrain decoder threads to two and `max_pixels` to 16,777,216, validate dimensions, and scale to 640 px inside libav before RGB buffering. Real RTSP/RTMP decoding still passes. |
| S03 | High | A previous failed MariaDB stream migration could leave monitor columns committed but auxiliary tables absent. Restarting with the architecture fix then failed on duplicate columns, preventing application startup. | Partial-schema fixtures on SQLite and MariaDB. The original stream migration now adds only missing columns/tables and resumes the previously committed DDL. |
| S04 | Medium | Basic RTMP accepted a one-byte `0x03` response as proof of a functioning protocol endpoint. Truncated or unrelated services could remain UP. | Fake-server tests for 1, 100, 1,536 and 1,537 bytes. Require the complete 1,537-byte S0/S1 response with the correct version. |
| S05 | Medium | Basic RTSP accepted truncated headers and a CSeq with a valid numeric prefix followed by garbage. Broken protocol exchanges could report UP. | Parser regressions. Require the complete CRLF-delimited header section and an exact numeric CSeq header. |
| S06 | Medium | Reference fetching lacked a wall-clock deadline over DNS resolution and the whole body. A slow-drip server or stalled lookup could retain a fetch indefinitely. | Slow-drip and delayed-DNS fixtures. One 15-second abort deadline covers both lookups and all response bytes; a lookup completing after cancellation cannot start a late request. |
| S07 | Medium | Rejected redirects, error statuses and unsupported content types were drained rather than closed. A rejected remote server could continue consuming a connection and bandwidth without a body bound. | Unending redirect-body fixture. Destroy rejected responses immediately. Redirects remain prohibited. |
| S08 | Medium | Authenticated reference URLs silently lost their HTTP Basic credentials when requests were rebuilt against a pinned IP. Common protected camera snapshots could never load or refresh. | HTTP fixture checking the actual Authorization header. Pass decoded URL credentials through Node's request `auth` field while preserving DNS pinning. |
| S09 | Medium | IPv6 reference literals were sent to DNS with brackets, and the Host header omitted an explicit port. IPv6 and some virtual-host snapshot endpoints failed. | IPv6 loopback and Host-header fixtures. Strip brackets for resolution/connect/SNI, preserve brackets and port in `Host`, and normalize the monitored hostname used for the private-network carveout. |
| S10 | Medium | Malformed URLs, embedded native log URLs and passwords shorter than three characters could escape credential redaction and reach errors or logs. RTMP context URLs also retained credentials unnecessarily. | Malformed-input, embedded/multiple-URL and short-password regressions. Never echo invalid raw input; scrub credentialed URLs throughout log strings; redact every nonempty password; keep all preflight context URLs free of userinfo. |
| S11 | Medium | The selected secure protocol could disagree with a plaintext URL. Runtime silently used the URL, defeating the configuration's stated TLS intent; Test Stream also bypassed configuration validation. | Validation and Chromium regressions. Reject scheme/selector disagreement and unsupported transports at validation/preflight; synchronize URL and protocol controls; validate the test-button request before running it. |
| S12 | Medium | A worker returned frames before native cleanup exited, releasing its global slot and monitor mutex while the decoder still held a camera session. Repeated checks could exceed concurrency and session limits. | Deterministic child-process fixture holds `close` after a frame. Settle capture only after child `close`, keeping slots held; bound successful cleanup by the remaining budget and terminate timed-out/error workers immediately. Handle IPC-send failure. |
| S13 | Medium | Reference image decoding used a very large default pixel allowance. Small compressed files could expand into excessive memory in the main server process. | JPEG dimension-bomb regression. Apply a 16,777,216-pixel input limit to validation and canonicalization before image processing. The compressed-byte limit remains separate. |
| S14 | Medium | Database exceptions rendered bound SQL, including private image bytes and source-URL passwords, into user-visible errors and logs. | Injected transaction failure containing image hex and credentials. Image storage/audit paths now expose a generic failure and a constrained driver code; migration writes expose only the monitor ID. |
| S15 | Medium | Reference deletion and its audit insert were not atomic. An audit failure could permanently remove a reference without recording the action. | Real database rollback fixtures. Perform deletion and audit insertion in one transaction; failure preserves the image and returns a sanitized error. |
| S16 | Medium | The new reference-table migration could commit DDL on MariaDB, fail during backfill, and become permanently unretryable because the table already existed. | Interrupted-backfill fixtures and complete migration reruns on both databases. Guard table creation and use conflict-safe backfill inserts so retries resume without duplicate references. |
| S17 | Medium | Reference migration and rollback loaded all image BLOBs into memory at once. A sufficiently large deployment could run out of memory while upgrading or restoring. | Inspection plus 106-reference fixtures spanning the page boundary. Page image rows by primary key in batches of 100 in both directions; verify references and existing heartbeats survive migration/rollback/re-upgrade. |
| S18 | Medium | An oversized HTTP body could emit an uncaught socket error and leave the reference-fetch promise unsettled instead of rejecting. This retained work and bypassed normal socket error reporting. | Baseline fixture observed one uncaught exception and an unsettled promise. Reject explicitly before destroying request/response without passing an error into the keep-alive socket; oversized and premature-close regressions pass. Uptime Kuma's global uncaught handler normally logs this, so this is not reported as a demonstrated whole-server crash. |
| S19 | Medium | RTMP URL userinfo was percent-encoded as if its native authentication parser decoded it. FFmpeg actually uses literal userinfo and fixed-size credential buffers, causing incorrect passwords or silent truncation. | FFmpeg RTMP source inspection and worker-input tests. Preserve representable literal RTMP credentials, and explicitly reject unsupported delimiters or fields over 49 bytes rather than silently altering authentication. RTSP continues using percent-encoded userinfo, which its parser decodes. |

### Why verified native TLS capture now fails closed

The earlier architecture review's Node TLS precheck verified only that
precheck's socket. It provided no cryptographic binding to the decoder's
subsequent connection, so the remaining gap was broader than a DNS change.

Experiments with the bundled decoder's `tls_verify=1`, a CA file and explicit
`verifyhost` showed that a trusted certificate for the wrong name was still
accepted for an IP target. The FFmpeg/OpenSSL path skips hostname checking
for numeric hosts; redirects can introduce the same condition. Merely
turning on chain verification or pinning the initial DNS result therefore
does not restore the promised hostname verification.

The fork owner explicitly selected this interim behavior:

- **Basic:** RTSPS/RTMPS verifies certificate chain and hostname on the actual
  probe connection unless Ignore TLS is enabled.
- **Enhanced/Full:** RTSPS/RTMPS with Ignore TLS off fails immediately with an
  explanation. The edit form warns about the limitation.
- **Explicit Ignore TLS:** secure frame capture remains available, with
  certificate verification disabled as that option requests.

This closes S01 by refusing unverifiable capture. It does **not** add a
decoder capable of verified secure frame capture. Restoring that feature
requires a native TLS implementation that verifies every actual peer,
including redirects and IP certificate identities.

## Dependency findings

These entries are published advisories affecting installed versions on
reachable RTSP image or socket paths. Advisory presence and dependency
resolution were verified; exploit payloads for these CVEs were not executed.
The socket transport is shared with other Uptime Kuma features, so its fixes
benefit those features as well.

| ID | Severity | Advisory and affected path | Resolution |
| --- | --- | --- | --- |
| D01 | High | [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj): Sharp's inherited libvips vulnerabilities, including CVE-2026-33327, CVE-2026-33328, CVE-2026-35590 and CVE-2026-35591. Reference images reach Sharp in the server process. | Upgrade Sharp from 0.33.5 to 0.35.5, above the advisory's 0.35.0 boundary. |
| D02 | High | [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c): Sharp's inherited libheif vulnerabilities. Sharp identifies the image bytes; a declared upload MIME type is not a decoder sandbox. | Sharp 0.35.5 is above the advisory's 0.35.4 boundary. |
| D03 | High | [GHSA-2gc4-cqfq-p2gv](https://github.com/advisories/GHSA-2gc4-cqfq-p2gv): Engine.IO protocol-revision mismatch denial of service on the shared network transport. | Update Socket.IO/server and client to 4.8.4 and resolve Engine.IO to 6.6.11. |
| D04 | High | [GHSA-2m8v-j782-fhvr](https://github.com/advisories/GHSA-2m8v-j782-fhvr): Socket.IO parser zero-attachment memory exhaustion. Binary reference uploads use this transport. | Resolve socket.io-parser to 4.2.7 through the Socket.IO updates. |
| D05 | High | [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p): WebSocket memory exhaustion through tiny fragments/chunks. | Update direct `ws` to 8.22.0 and the Engine.IO/adapter copies to 8.21.3. |
| D06 | Medium | [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx): WebSocket uninitialized-memory disclosure. | The same `ws` updates exceed the 8.20.1 fix boundary. |

The lockfile was regenerated and a clean `npm ci` completed. The post-update
audit no longer reports these advisories against Sharp, the Socket.IO
packages, or their WebSocket copies. It still reports advisories in other
repository paths, including MQTT's separate `ws` 7.x dependency. Those are
outside this RTSP audit; this report does not claim a vulnerability-free
repository. Advisory metadata in unused node-av WebRTC APIs was not treated
as a demonstrated native RTSP vulnerability.

## Validation

Checks ran in the cloud environment with Node 24.19.0 and the installed
native modules available; RTSP tests did not skip native coverage.

| Check | Result |
| --- | --- |
| `node --test test/backend-test/monitors/test-rtsp-*.js` | 143 passed, zero failures or skips. Covers modes, native fixtures, credentials/TLS, parsing, deadlines, SSRF classification, images, concurrency, socket authorization and SQLite integration. |
| `test-rtsp-store-integration.js` with `RTSP_TEST_MARIADB_URL` targeting MariaDB 12 | 13 passed after the dependency upgrades. Includes complete real migrations, partial migration recovery, reference round trips, audit rollback, retention, pagination and preservation of heartbeats. |
| Chromium with `private/cloud-playwright.config.js` and `test/e2e/specs/rtsp-monitor.spec.js` | Seven passed: five application setup checks and two RTSP regressions. Tested protocol synchronization, verified-TLS warning/Test failure, explicit Ignore TLS, binary reference upload, server canonicalization and persistence after reload. |
| Live MediaMTX 1.21.1 with an H.264 publisher | Enhanced captured five frames and reported UP on RTSP/TCP, RTSP/UDP, RTMP, RTSPS/Ignore TLS and RTMPS/Ignore TLS, approximately 1.2–1.6 seconds to first capture. Verified RTSPS/RTMPS capture failed before decoder traffic. |
| Native adversarial fixtures | Wrong-host and untrusted TLS certificates rejected by Basic; valid trusted hostname accepted; six silent cameras terminated on budget without blocking the server threadpool; oversized frames rejected. |
| Production frontend build | Passed after dependency upgrades. |
| Scoped ESLint and EditMonitor Stylelint | No errors. ESLint retains nonblocking warnings; Stylelint reports deprecated rule configuration. |
| Broader backend run | 221 of 230 passed. Nine failures involved external TLS/STARTTLS network access and missing/unusable system ping, outside the changed RTSP implementation. This broader run preceded the final dependency upgrades; the complete RTSP, MariaDB, browser and build checks were repeated afterward. |

The live RTMP fixture used an unprotected stream. S19's special-character
authentication behavior was verified against native source and input-builder
regressions, rather than an Adobe-authentication production camera. Physical
cameras, other operating systems and production deployment were not exercised.

## Compatibility and operational limits

- Verified TLS **frame capture** is intentionally unavailable until the
  native decoder is corrected. Basic and explicit Ignore TLS remain usable.
- Native frames and reference inputs above 16,777,216 pixels are rejected.
  This bounds memory but excludes larger camera streams/images.
- Native RTMP credentials are limited to 49 UTF-8 bytes per field. Username
  cannot contain colon, percent, query delimiters, path delimiters or
  whitespace; password cannot contain path delimiters or whitespace. Failures
  are explicit instead of silently authenticating with different credentials.
- Sharp 0.35.5 raises the project's minimum Node version to **20.9.0**;
  package metadata and installation documentation now agree. Existing node-av
  platform/runtime requirements still apply to Enhanced/Full.
- Image-library upgrades can affect rounding or encoding near a configured
  fingerprint threshold. Reference storage and comparison regressions pass;
  production images near their decision boundary should be rechecked.

No further High/Medium source findings remained unresolved in the reviewed
paths after these changes. This is the outcome of the scoped review and its
tests, not a guarantee against undiscovered defects or future advisories.

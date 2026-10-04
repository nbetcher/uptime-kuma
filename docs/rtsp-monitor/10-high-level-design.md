# 10 — High-Level Design Specification

**Status:** HLDS round-1 draft. Author: Nick Betcher. Date: 2026-05-11.
Supersedes the "HLDS pending" notice in `README.md`.

This document is the bridge between the requirements in
**[04-requirements.md](./04-requirements.md)** and the source code that
will implement them. It is intentionally one tier above an LLD: it pins
the module layout, the interfaces between modules, the data model, the
sequence flows, the error model, and the test strategy — without
committing to specific function bodies or specific Vue template line
counts. An LLD or the code itself will fill in those details.

Each REQ-ID referenced in this doc is from
**[04-requirements.md](./04-requirements.md)**. Every architectural
decision below either implements one of those requirements or fills a
gap that planning round 1/2 left to HLD time.

The fork-owner has explicitly delegated to the HLDS the resolution of
round-2 open items **Q13–Q21** in
**[08-open-questions.md](./08-open-questions.md)**. Their HLD-time
resolutions are recorded in §17 of this document.

---

## Table of contents

1. [Purpose and document map](#1-purpose-and-document-map)
2. [Architecture overview](#2-architecture-overview)
3. [Domain model](#3-domain-model)
4. [Database schema](#4-database-schema)
5. [Server architecture](#5-server-architecture)
6. [Frame-capture and image pipeline](#6-frame-capture-and-image-pipeline)
7. [Frontend architecture](#7-frontend-architecture)
8. [API surface](#8-api-surface)
9. [Sequence flows](#9-sequence-flows)
10. [Error model and message catalog](#10-error-model-and-message-catalog)
11. [Configuration](#11-configuration)
12. [Security architecture](#12-security-architecture)
13. [Performance budgets and capacity](#13-performance-budgets-and-capacity)
14. [Observability](#14-observability)
15. [Test strategy](#15-test-strategy)
16. [Migration and rollout](#16-migration-and-rollout)
17. [Round-2 open-item resolutions (Q13–Q21)](#17-round-2-open-item-resolutions-q13q21)
18. [Sanity-check corrections to the planning docs](#18-sanity-check-corrections-to-the-planning-docs)
19. [Open items for the LLD / code review](#19-open-items-for-the-lld--code-review)
20. [Appendix](#20-appendix)

---

## 1. Purpose and document map

This HLDS pins **what we will build** in enough detail that:

- A new contributor can read sections 1–9 and produce a credible
  first-pass implementation.
- The fork-owner can read sections 17 and 18 and verify that all
  outstanding planning-time decisions are now resolved.
- An adversarial reviewer can read sections 12–15 and verify the
  monitor will not blow up under load, leak secrets, or be defeated by
  a malicious URL.

Out of HLDS scope:

- Exact Vue template HTML beyond the structural patterns shown.
- Exact JavaScript function bodies. The HLDS specifies what each
  function MUST do and what its inputs/outputs are.
- Final benchmark numbers — placeholders carry "verify at code time"
  notes where they appear.

---

## 2. Architecture overview

### 2.1 System context

```
                       ┌────────────────────────────────────┐
                       │       Uptime Kuma server           │
                       │                                    │
   IP camera /         │  ┌─────────────────────────────┐   │
   RTMP origin ◀───────┼──┤  RtspMonitorType.check()    │   │
   (RTSP/RTSPS/        │  │                             │   │
    RTMP/RTMPS)        │  │  ┌───────────────────────┐  │   │
                       │  │  │ FrameSource (node-av) │  │   │
                       │  │  └───────────────────────┘  │   │
                       │  │                             │   │
                       │  │  ┌───────────────────────┐  │   │
                       │  │  │ ImagePipeline (sharp) │  │   │
                       │  │  └───────────────────────┘  │   │
                       │  └─────────────────────────────┘   │
                       │                                    │
   Operator (Vue UI) ──┼─── EditMonitor.vue ───── REST ────▶│
                       │                                    │
                       └────────────────────────────────────┘
```

External actors:

1. **The monitored camera/origin** — speaks RTSP, RTSPS, RTMP, or
   RTMPS, on a user-configured host:port.
2. **The operator** — configures the monitor through the existing
   Uptime Kuma Vue SPA.
3. **(Full-mode only) A reference-image source** — the operator's
   filesystem (upload) or a URL.

Nothing else is in the trust boundary that this monitor introduces.
No new outbound dependencies, no telemetry, no third-party services.

### 2.2 Layered architecture inside Uptime Kuma

```
┌────────────────────────────────────────────────────────────────────┐
│  Vue UI layer:  src/pages/EditMonitor.vue (existing, augmented)    │
│                 src/components/ReferenceImagePanel.vue (NEW)       │
│                 src/components/StreamTestButton.vue   (NEW)        │
└────────────────────────────────────────────────────────────────────┘
                                  │ HTTP REST (multipart upload, GETs)
                                  │ WebSocket (existing monitor events)
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  HTTP routing & sockets:                                           │
│    server/routers/api-router.js (NEW endpoints under /api/monitor) │
│    server/socket-handlers/    (existing monitor events; no change) │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  Monitor-type plumbing (existing):                                 │
│    server/model/monitor.js  →  check() dispatch (lines 905-918)    │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  RTSP monitor module (NEW):  server/monitor-types/rtsp/            │
│    index.js               — RtspMonitorType class                  │
│    basic-probe.js         — RTSP/RTMP handshake probes             │
│    enhanced-check.js      — multi-frame check                      │
│    full-check.js          — fingerprint-match check                │
│    frame-source.js        — FrameSource interface + NodeAv impl    │
│    image-pipeline.js      — sharp-based fingerprinting             │
│    reference-store.js     — reference upload/fetch/cache           │
│    concurrency.js         — global token bucket + per-monitor mtx  │
│    ssrf-guard.js          — URL fetch safety net                   │
│    audit.js               — reference-upload audit logger          │
│    messages.js            — heartbeat-message catalog              │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  External libraries (new direct deps):                             │
│    node-av (FFmpeg/libav N-API bindings)                           │
│    sharp   (libvips image processing)                              │
└────────────────────────────────────────────────────────────────────┘
```

The choice to fan out RTSP code into its own subdirectory (rather than
one big `rtsp.js` next to `tcp.js`) is deliberate: it makes the
scope-split for upstream PR 2 mechanically a `git rm` of the
`enhanced-check.js`, `full-check.js`, `frame-source.js`,
`image-pipeline.js`, `reference-store.js`, `ssrf-guard.js`, and
`audit.js` files (NFR-051).

### 2.3 Three-PR build mechanics, re-stated

| PR | Branches kept | Files retained in `server/monitor-types/rtsp/` |
|---|---|---|
| **PR 1 (fork)** | basic + enhanced + full | all of the above |
| **PR 2 (upstream Basic)** | basic only | `index.js`, `basic-probe.js`, `concurrency.js` (mutex only), `messages.js` |
| **PR 3 (upstream Enhanced)** | basic + enhanced | adds `enhanced-check.js`, `frame-source.js` |

Files are split so the upstream PRs are subset extractions, not
re-authorings. `index.js` checks for which submodules are present at
require-time and registers the appropriate set of modes.

---

## 3. Domain model

### 3.1 Monitor (extension to existing entity)

A monitor of `type = "rtsp"` carries these protocol-specific fields in
addition to the standard `id`, `name`, `interval`, `maxretries`,
`retryInterval`, `timeout`, `save_response`, `save_error_response`,
`response_max_length` fields that every monitor already has.

| Field | Type | Purpose | Mode |
|---|---|---|---|
| `streamProtocol` | enum (`rtsp` \| `rtsps` \| `rtmp` \| `rtmps`) | Wire protocol | all |
| `streamTransport` | enum (`tcp` \| `udp`) | RTP transport for Enhanced/Full; ignored for Basic and for RTMP | enh/full |
| `streamMode` | enum (`basic` \| `enhanced` \| `full`) | Selected verification depth | all |
| `streamFrameCount` | int (2..15, default 5) | Number of frames to capture in Enhanced | enh |
| `streamWallClockBudgetSec` | int (5..30, nullable) | Per-monitor override of NFR-002 budget | enh/full |
| `streamMatchThreshold` | int (8..48, default 24) | Hamming-distance threshold for Full | full |
| `streamSeparateDayNight` | bool, default `true` | Day/Night reference toggle (FR-017) | full |
| `streamReferenceDayBlob` | BLOB, ≤ 256 KB | Canonical Day reference JPEG | full |
| `streamReferenceDayUrl` | TEXT, nullable | If reference originated from URL | full |
| `streamReferenceDayHash` | BLOB(16) | 128-bit fingerprint (luminance + edge halves) | full |
| `streamReferenceNightBlob` | BLOB, ≤ 256 KB, nullable | Same, Night slot | full |
| `streamReferenceNightUrl` | TEXT, nullable | Same | full |
| `streamReferenceNightHash` | BLOB(16) | Same | full |
| `streamStatusThumbnail` | bool, default `false` | UI-013 opt-in for last-match thumbnail | full |
| `streamKeepDownImages` | bool, default `false` | UI-014 opt-in for last-5-DOWN thumbnails | full |

**Generic columns reused (no new RTSP-prefixed credentials):**
`basic_auth_user` and `basic_auth_pass` columns on the `monitor`
table — already used by HTTP / HTTP-keyword / JSON-query monitors as
the generic "HTTP-style" credentials. Reuse honours **FR-031** and
**`@CommanderStorm`'s** explicit guidance on PR #5954.

> Planning-doc clarification: FR-031 calls these `username` and
> `password` columns; the actual column names are `basic_auth_user`
> and `basic_auth_pass`. The intent (no new RTSP-prefixed credential
> columns) is faithfully preserved. See §18 item 12.

**URL / Path field reuse:** the existing `url` column carries the full
`rtsp://host:port/path` or `rtmp://host:port/app/stream` URL. Host,
port, and path are extracted by URL parse — no separate hostname/port
columns are introduced. If at code time a separate `hostname` column
is desired for sorting/filtering in monitor lists, it is added then;
the URL stays canonical.

### 3.2 Heartbeat (no new columns)

Heartbeats use the existing `heartbeat` table. The `msg` field carries
a structured message per **NFR-040**; the `ping` field carries
wall-clock ms; the `response` field, when `save_response` is enabled,
carries a brotli-compressed base64 payload generated via the **existing
`Monitor.saveResponseData(bean, data)` method**
(`server/model/monitor.js:1157`). The RTSP code MUST call this method
rather than write to `heartbeat.response` directly.

The `response_max_length` cap (`RESPONSE_BODY_LENGTH_DEFAULT = 1024`
bytes in `src/util.js:47`, override per monitor up to
`RESPONSE_BODY_LENGTH_MAX = 1,048,576` bytes) governs the post-truncate
size before brotli compression.

This corrects the planning-doc claim of "10,000 bytes" in NFR-041 —
the actual default is 1,024 bytes.

### 3.3 Reference image (Full mode only)

A reference is the canonical bytes-on-disk plus its fingerprint:

```
ReferenceImage {
  monitor_id:   FK
  slot:         'day' | 'night' | 'single'
  bytes:        Buffer (≤ 80 KB after server-side resample; 256 KB cap)
  fingerprint:  Buffer (16 bytes: 8 luminance + 8 edge)
  source:       'upload' | 'url'
  source_url:   string | null
  uploaded_at:  timestamp
  sha256:       Buffer (32 bytes, of canonical bytes)
}
```

**Canonical form (UI-004):** resized to ≤ 640 px on the long edge,
JPEG quality 85, all metadata stripped (EXIF, GPS, XMP, ICC). ICC
preservation is not required because our fingerprinting operates on
luminance after a `greyscale()` step — colour-profile information is
discarded regardless. Encoded by `sharp`.

**Storage:** as BLOB columns on the monitor row (per Q7 resolution),
*not* in a separate `reference_image` table. The `slot` discriminator
is implicit in which column holds the data
(`streamReferenceDayBlob` vs `streamReferenceNightBlob`); a "single"
reference (when `streamSeparateDayNight = false`) reuses the Day slot.

### 3.4 Reference audit record (OP-007)

A new `monitor_reference_audit` table (proposed name — see
§17 / Q15-resolution for rationale):

```
monitor_reference_audit {
  id:          PK autoincrement
  monitor_id:  FK to monitor.id (CASCADE delete)
  slot:        'day' | 'night' | 'single'
  source:      'upload' | 'url-fetch' | 'url-refresh' | 'delete'
  byte_size:   int (0 for delete)
  sha256:      BLOB(32) (NULL for delete)
  user_id:     FK to user.id (nullable — unauthenticated installs)
  created_at:  timestamp
}
```

No payload retained, only metadata. SHA-256 enables "did this user
re-upload the same reference?" diagnostics without storing duplicates.

### 3.5 DOWN-image history (UI-014, optional per Q12.g contingency)

A new `monitor_stream_down_image` table:

```
monitor_stream_down_image {
  id:          PK autoincrement
  monitor_id:  FK to monitor.id (CASCADE delete)
  captured_at: timestamp
  image_blob:  BLOB (≤ 80 KB; resampled to status-page size)
}
```

Bounded at 5 rows per `monitor_id` by an inline DELETE in the same
transaction as the INSERT — **OP-008**.

The HLDS endorses the planning-time contingency
(**[08-open-questions.md](./08-open-questions.md)** Q12.g): if at
code-time review concludes this bounded-table pattern doesn't fit
Uptime Kuma's existing schema patterns, UI-013 + UI-014 + this entire
table are dropped per the fork-owner's standing instruction, and the
future webhook alternative (UI-015) is logged.

---

## 4. Database schema

### 4.1 Migration file

```
db/knex_migrations/2026-NN-NN-NNNN-add-stream-monitor.js
```

The exact date prefix is set at commit time per
`extra/check-knex-filenames.mjs` (regex
`^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-.*\.js$`).

### 4.2 Migration body — additive only (NFR-033)

```javascript
exports.up = function (knex) {
    return knex.schema
        .alterTable("monitor", function (table) {
            // Configuration
            table.string("stream_protocol", 8).defaultTo(null);
            table.string("stream_transport", 8).defaultTo(null);
            table.string("stream_mode", 16).defaultTo(null);
            table.integer("stream_frame_count").defaultTo(null);
            table.integer("stream_wall_clock_budget_sec").defaultTo(null);

            // Full-mode references
            table.integer("stream_match_threshold").defaultTo(null);
            table.boolean("stream_separate_day_night").defaultTo(null);
            table.binary("stream_reference_day_blob").defaultTo(null);
            table.text("stream_reference_day_url").defaultTo(null);
            table.binary("stream_reference_day_hash").defaultTo(null);
            table.binary("stream_reference_night_blob").defaultTo(null);
            table.text("stream_reference_night_url").defaultTo(null);
            table.binary("stream_reference_night_hash").defaultTo(null);

            // Display opt-ins
            table.boolean("stream_status_thumbnail").defaultTo(null);
            table.boolean("stream_keep_down_images").defaultTo(null);
        })
        .createTable("monitor_reference_audit", function (table) {
            table.increments("id");
            table.integer("monitor_id").notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");
            table.string("slot", 8).notNullable();
            table.string("source", 16).notNullable();
            table.integer("byte_size").notNullable();
            table.binary("sha256").notNullable();
            table.integer("user_id").nullable()
                .references("id").inTable("user").onDelete("SET NULL");
            table.timestamp("created_at").defaultTo(knex.fn.now());
            table.index("monitor_id");
        })
        .createTable("monitor_stream_down_image", function (table) {
            table.increments("id");
            table.integer("monitor_id").notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");
            table.timestamp("captured_at").defaultTo(knex.fn.now());
            table.binary("image_blob").notNullable();
            table.index(["monitor_id", "captured_at"]);
        });
};

exports.down = function (knex) {
    return knex.schema
        .dropTableIfExists("monitor_stream_down_image")
        .dropTableIfExists("monitor_reference_audit")
        .alterTable("monitor", function (table) {
            table.dropColumn("stream_keep_down_images");
            table.dropColumn("stream_status_thumbnail");
            table.dropColumn("stream_reference_night_hash");
            table.dropColumn("stream_reference_night_url");
            table.dropColumn("stream_reference_night_blob");
            table.dropColumn("stream_reference_day_hash");
            table.dropColumn("stream_reference_day_url");
            table.dropColumn("stream_reference_day_blob");
            table.dropColumn("stream_separate_day_night");
            table.dropColumn("stream_match_threshold");
            table.dropColumn("stream_wall_clock_budget_sec");
            table.dropColumn("stream_frame_count");
            table.dropColumn("stream_mode");
            table.dropColumn("stream_transport");
            table.dropColumn("stream_protocol");
        });
};
```

Column-naming note: `stream_*` (not `rtsp_*`) because the monitor type
serves both RTSP **and** RTMP. This corrects a planning-doc
inconsistency where `05-image-comparison-strategy.md` §5 used
`rtsp_reference_day_blob` etc.

### 4.3 Migration subset for upstream PR 2 (Basic only)

A separate migration file authored at PR-2 time with just:

```javascript
exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.string("stream_protocol", 8).defaultTo(null);
        table.string("stream_mode", 16).defaultTo(null);
        // No transport, no frame count, no references, no audit table,
        // no down-image table. Basic doesn't need them.
    });
};
```

PR 3 (Enhanced) adds `stream_transport`, `stream_frame_count`,
`stream_wall_clock_budget_sec`.

This staged migration keeps each upstream PR's schema delta minimal —
`@CommanderStorm`'s "splitting keeps it maintainable" pattern.

### 4.4 `Monitor.toJSON()` extension

In `server/model/monitor.js` `toJSON()` (lines 117-216), the following
fields are added to the always-included `data` object (alongside
`mqttTopic`, `snmpOid`, etc.):

- `streamProtocol`, `streamTransport`, `streamMode`,
  `streamFrameCount`, `streamWallClockBudgetSec`,
  `streamMatchThreshold`, `streamSeparateDayNight`,
  `streamStatusThumbnail`, `streamKeepDownImages`.
- `streamReferenceDayHash` (hex string), `streamReferenceNightHash`
  (hex string) — fingerprints, ~32 hex chars each, cheap to send.
- `streamReferenceDayHasBlob` (boolean), `streamReferenceNightHasBlob`
  (boolean) — derived flags, no BLOB bytes.
- `streamReferenceDayUrl`, `streamReferenceNightUrl` — text-only.

BLOB columns (`streamReferenceDayBlob`, `streamReferenceNightBlob`)
are **excluded** from the JSON payload — fetched lazily via REST
(**UI-012**, resolves Q7 and Q17).

---

## 5. Server architecture

### 5.1 Module layout

```
server/monitor-types/rtsp/
├── index.js              ─ RtspMonitorType extends MonitorType
├── basic-probe.js        ─ pure-Node RTSP/RTMP handshake probes
├── enhanced-check.js     ─ multi-frame frozen/black detection
├── full-check.js         ─ single-frame fingerprint compare
├── frame-source.js       ─ FrameSource interface + NodeAvFrameSource
├── image-pipeline.js     ─ sharp-based fingerprinting
├── reference-store.js    ─ upload, URL-fetch, BLOB serving
├── concurrency.js        ─ global token bucket + per-monitor mutex
├── ssrf-guard.js         ─ URL fetch safety net
├── audit.js              ─ reference-upload audit logger
├── messages.js           ─ heartbeat-message catalog
└── url-parse.js          ─ scheme/transport URL utilities
```

### 5.2 `RtspMonitorType` (`index.js`)

```javascript
const { MonitorType } = require("../monitor-type");
const { UP, log } = require("../../../src/util");
const { basicProbe } = require("./basic-probe");
const enhancedCheck = (() => {
    try { return require("./enhanced-check"); } catch { return null; }
})();
const fullCheck = (() => {
    try { return require("./full-check"); } catch { return null; }
})();
const { acquireConcurrencyToken, acquireMonitorMutex } = require("./concurrency");
const { messages } = require("./messages");
const { preflight } = require("./url-parse");

class RtspMonitorType extends MonitorType {
    name = "rtsp";
    supportsConditions = false;
    allowCustomStatus = false;

    async check(monitor, heartbeat, server) {
        const mutex = await acquireMonitorMutex(monitor.id);
        try {
            const ctx = await preflight(monitor);
            // ctx = { url, protocol, host, port, path, username, password,
            //         tlsVerify, transport, budgetMs, ... }

            const mode = monitor.streamMode || "basic";

            if (mode === "basic") {
                return await basicProbe(monitor, heartbeat, ctx);
            }

            if (!enhancedCheck) {
                throw new Error(messages.NODE_AV_UNAVAILABLE);
            }

            const token = await acquireConcurrencyToken(monitor, ctx.budgetMs);
            try {
                if (mode === "enhanced") {
                    return await enhancedCheck.run(monitor, heartbeat, ctx);
                }
                if (mode === "full") {
                    if (!fullCheck) {
                        throw new Error(messages.NODE_AV_UNAVAILABLE);
                    }
                    return await fullCheck.run(monitor, heartbeat, ctx);
                }
                throw new Error(messages.UNKNOWN_MODE(mode));
            } finally {
                token.release();
            }
        } finally {
            mutex.release();
        }
    }
}

module.exports = { RtspMonitorType };
```

Key contract notes:

1. **Throw to fail (NFR-010).** The base infra
   (`server/model/monitor.js:905-918`) converts thrown errors to DOWN
   heartbeats. Never swallow and set status to anything other than UP.
2. **Mutex always wraps token.** Per-monitor mutex prevents the same
   monitor from running twice in parallel (NFR-014); concurrency token
   limits global decode count (NFR-004). Token is acquired *inside*
   the mutex so a held mutex doesn't burn a token slot.
3. **Skipped-on-saturation semantics.** If the concurrency token
   can't be acquired within `monitor.timeout` seconds,
   `acquireConcurrencyToken` throws a special `SkipCheckError`. The
   `check()` callsite in `monitor.js` already handles thrown errors;
   the HLDS extends that handling so a `SkipCheckError` produces no
   heartbeat row and logs `"RTSP check skipped: concurrency limit"`
   at warn level. **Implementation detail at code-time:** the cleanest
   path is to add a `SkipCheckError` discriminator and let
   `monitor.js` short-circuit before writing the bean — the change is
   small and isolated to one block. If that proves invasive,
   fallback: write a DOWN heartbeat with the skip reason. Decided at
   PR-1 implementation time.
4. **Optional enhanced/full submodules.** `require()` is wrapped in a
   try/catch so PR 2's slim build (no Enhanced/Full files present) is
   self-consistent. The catch is also the mechanism for UI-005's
   "node-av failed to load" graceful degradation: if `frame-source.js`
   throws at require-time, both `enhanced-check.js` and
   `full-check.js` propagate that failure as a `require()` exception,
   and the loader records `null` for the corresponding mode handler.

### 5.3 Registration

In `server/uptime-kuma-server.js`, after line 134 (the last
`monitorTypeList` assignment), add:

```javascript
UptimeKumaServer.monitorTypeList["rtsp"] = new RtspMonitorType();
```

The dropdown ordering in `EditMonitor.vue` is handled separately
(§7.1).

### 5.4 Preflight (`url-parse.js`)

```javascript
async function preflight(monitor) {
    // 1. URL parse
    const url = new URL(monitor.url);

    // 2. Scheme/protocol validation
    const proto = url.protocol.replace(":", "");
    if (!["rtsp", "rtsps", "rtmp", "rtmps"].includes(proto)) {
        throw new Error(messages.SCHEME_MISMATCH(proto));
    }
    if (proto !== monitor.streamProtocol) {
        // user changed protocol selector but left old URL; treat URL as canonical
        log.warn("rtsp", `URL scheme ${proto} disagrees with selector ${monitor.streamProtocol}`);
    }

    // 3. Default port resolution
    const port = url.port || DEFAULT_PORTS[proto];   // 554/322/1935/443

    // 4. Credentials precedence (FR-030)
    //    Form-supplied `basic_auth_user` / `basic_auth_pass` are
    //    canonical. URL-embedded credentials are stripped and used
    //    only if the form fields are empty.
    let username = monitor.basic_auth_user || "";
    let password = monitor.basic_auth_pass || "";
    if (url.username || url.password) {
        if (username || password) {
            log.warn("rtsp", `URL credentials shadowed by form fields on monitor ${monitor.id}`);
        } else {
            // URL class returns percent-encoded values; decode for AVDictionary
            username = decodeURIComponent(url.username);
            password = decodeURIComponent(url.password);
        }
        url.username = "";
        url.password = "";
    }

    // 5. URL parameter sanity (UI-007)
    if (url.searchParams.has("rtsp_transport")) {
        log.warn("rtsp", `?rtsp_transport= in URL ignored on monitor ${monitor.id}`);
        url.searchParams.delete("rtsp_transport");
    }

    // 6. DNS resolution — done implicitly by node-av/net.connect, but
    //    catch and re-throw to produce the right message catalog entry
    //    (handled inside basic-probe / frame-source via DNS hooks).

    // 7. Wall-clock budget
    const budgetMs = computeBudget(monitor);   // NFR-002 formula
    // budgetMs = clamp(interval/3, 5, 30) * 1000, or per-monitor override

    return {
        url: url.toString(),    // canonical, credentials stripped
        protocol: proto,
        host: url.hostname,
        port: parseInt(port, 10),
        path: url.pathname,
        username,
        password,
        tlsVerify: !monitor.ignoreTls && (proto === "rtsps" || proto === "rtmps"),
        transport: monitor.streamTransport || "tcp",
        budgetMs,
    };
}
```

DNS lookups are not pre-resolved (node-av and net.connect resolve
themselves); the SSRF guard for URL-references resolves explicitly,
once, before connecting — see §12.4.

### 5.5 `basic-probe.js`

Two protocol-specific entry points, dispatched by `protocol`:

```javascript
async function basicProbe(monitor, heartbeat, ctx) {
    const { protocol } = ctx;
    if (protocol === "rtsp" || protocol === "rtsps") {
        return probeRtsp(monitor, heartbeat, ctx);
    }
    if (protocol === "rtmp" || protocol === "rtmps") {
        return probeRtmp(monitor, heartbeat, ctx);
    }
    throw new Error(messages.UNKNOWN_PROTOCOL(protocol));
}
```

#### `probeRtsp` contract

1. Open `net.connect(port, host)` — or `tls.connect()` with
   `rejectUnauthorized = ctx.tlsVerify` for `rtsps`.
2. Write the RTSP OPTIONS frame from
   **[02-protocol-coverage.md](./02-protocol-coverage.md)** §5.
3. Read up to 4 KB or until `\r\n\r\n` or socket end.
4. Validate response prefix:
   - First 5 bytes MUST equal `"RTSP/"` — if not, throw with
     `messages.RTSP_NOT_SPOKEN()`.
   - `CSeq:` header MUST be present and MUST equal the request CSeq —
     if not, throw with `messages.RTSP_NOT_SPOKEN()` (a non-RTSP
     server that accidentally starts with `"RTSP/"` won't echo our
     CSeq value).
5. Parse status code from the first line; map per
   **[02-protocol-coverage.md](./02-protocol-coverage.md)** §5. The
   guiding principle from the planning doc is that *any* response
   beginning with `RTSP/` and echoing CSeq proves the server is
   RTSP-speaking and alive:
   - 2xx, 401, 403, 404, 405 → UP, msg = `messages.RTSP_OK(code)`.
   - 3xx → UP, msg = `messages.RTSP_REDIRECT(code)` (warning surface).
   - 5xx → UP, msg = `messages.RTSP_SERVER_ERROR(code)` (warning).
   - Other 4xx (e.g., 400, 411, 414) → UP, msg =
     `messages.RTSP_SERVER_ERROR(code)`. These are unusual responses
     to a well-formed OPTIONS request, but the server is demonstrably
     speaking RTSP, so they don't disqualify it as alive.
6. Set `heartbeat.ping` to `Date.now() - startTime`.
7. Close socket.
8. If `monitor.save_response`, call
   `monitor.saveResponseData(heartbeat, firstNBytes(rawResponse, 256))`
   to populate `heartbeat.response`.

#### `probeRtmp` contract

1. `net.connect()` (or TLS for `rtmps`).
2. Write 1537 bytes: `[0x03, ...c1]` where `c1` is 4 bytes of monotonic
   time + 4 bytes of zeros + 1528 bytes of randomness.
3. Read 1537 bytes (S0+S1); assert first byte = `0x03`.
4. **Do not send C2.** Close.
5. UP with msg = `messages.RTMP_OK()`. Failure throws.

**Tolerances:**

- Socket read budget = `monitor.timeout * 1000 ms`, default 10s.
- Soft-fail on any TCP/TLS error → DOWN via thrown Error with
  `messages.CONNECTION_*` entries.
- TLS hostname mismatch when `tlsVerify=true` → DOWN with
  `messages.TLS_HOSTNAME_MISMATCH`.

### 5.6 `enhanced-check.js`

Public entry: `run(monitor, heartbeat, ctx) → Promise<void>`.

Algorithm:

```
1. const startMs = Date.now()
2. const source = await FrameSource.open(ctx)
   try:
     const wanted = monitor.streamFrameCount ?? 5  // clamped 2..15
     const buffers = []   // JPEG Buffers
     while buffers.length < wanted and (Date.now() - startMs) < ctx.budgetMs:
       const frame = await source.next()      // resolves with raw frame or null on end
       if frame === null: break
       const jpeg = await source.toJpeg(frame)
       validateJpegStructure(jpeg)            // see §6.5 validation rules
       buffers.push(jpeg)
   finally:
     await source.close()

3. if buffers.length < 2:
     throw Error(messages.INSUFFICIENT_FRAMES(buffers.length, wanted))

4. // Frozen-frame check
   const hashes = buffers.map(xxhash64)
   if all hashes equal:
     throw Error(messages.FROZEN_FRAME(buffers.length))

5. // Black/uniform check (last frame, 32×32 grayscale)
   const stats = await ImagePipeline.luminanceStats(buffers[last])
   if stats.mean < 5 and stats.stddev < 2:
     throw Error(messages.BLACK_FRAME(stats))

6. heartbeat.ping = Date.now() - startMs
   heartbeat.msg = messages.ENHANCED_OK(buffers.length, heartbeat.ping)
   heartbeat.status = UP

7. if monitor.save_response:
     monitor.saveResponseData(heartbeat, buildDebugSummary(buffers, hashes, stats))
```

`source.toJpeg(frame)`: encodes via the faster of `node-av`'s mjpeg
encoder or `sharp`. The default is `node-av`'s mjpeg encoder at quality
75; a code-time micro-benchmark (~10 min effort) decides whether
`sharp` is materially faster on the target platforms. Either path
returns a `Buffer` of valid JPEG bytes.

### 5.7 `full-check.js`

Public entry: `run(monitor, heartbeat, ctx) → Promise<void>`.

```
1. const startMs = Date.now()
2. const source = await FrameSource.open(ctx)
   try:
     const frame = await source.next()       // first decoded video frame
     if frame === null:
       throw Error(messages.NO_FRAME)
     const jpeg = await source.toJpeg(frame)
     validateJpegStructure(jpeg)
   finally:
     await source.close()

3. const live = await ImagePipeline.fingerprint(jpeg)
   // live = { lumHash: Buffer(8), edgeHash: Buffer(8), meanLuma: number }

4. // Day/Night decision
   const dayHash = monitor.streamReferenceDayHash
   const nightHash = monitor.streamReferenceNightHash
   const threshold = monitor.streamMatchThreshold ?? 24
   const separate = monitor.streamSeparateDayNight !== false

   let scoreDay = null
   let scoreNight = null
   if (separate and nightHash):
     scoreDay = distance(live, dayHash, "day")
     scoreNight = distance(live, nightHash, "night")
   else:
     // single reference path - treat the present slot as 'single'
     const refHash = dayHash ?? nightHash
     scoreDay = distance(live, refHash, "single")
     scoreNight = null

5. // Extreme-luminance adjustment (corrected, see §6.6 and §18)
   // see §6.6 for the single-reference case

6. const best = (scoreNight !== null && scoreNight < scoreDay) ? scoreNight : scoreDay
   const matched = (scoreNight !== null && scoreNight < scoreDay) ? "Night" : (separate ? "Day" : "single")

7. heartbeat.ping = Date.now() - startMs

   if best <= threshold:
     heartbeat.status = UP
     heartbeat.msg = messages.MATCH_OK(matched, best)
     if monitor.streamStatusThumbnail or monitor.streamKeepDownImages:
       persistLastMatchThumbnail(monitor, jpeg)   // see §5.10
   else:
     if monitor.streamKeepDownImages:
       persistDownImage(monitor, jpeg)           // §5.10
     throw Error(messages.MATCH_FAIL(scoreDay, scoreNight, threshold))

8. if monitor.save_response:
     monitor.saveResponseData(heartbeat, buildFullDebugSummary(live, scoreDay, scoreNight))
```

Note that Full mode **does not** invoke Enhanced's frozen/black-frame
heuristics (FR-016). The pre-flight luminance adjustment in
§6.6 is part of the fingerprint comparison, not a separate abort
path.

### 5.8 `concurrency.js`

```javascript
const os = require("node:os");

const DEFAULT_LIMIT = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
const LIMIT = parseInt(process.env.RTSP_CONCURRENCY || "", 10) || DEFAULT_LIMIT;

class TokenBucket {
    constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
    async acquire(timeoutMs) {
        if (this.active < this.limit) { this.active++; return; }
        return new Promise((resolve, reject) => {
            const entry = {};
            entry.timer = setTimeout(() => {
                const idx = this.queue.indexOf(entry);
                if (idx >= 0) this.queue.splice(idx, 1);
                reject(new SkipCheckError("concurrency limit timeout"));
            }, timeoutMs);
            entry.resolve = () => {
                clearTimeout(entry.timer);
                this.active++;
                resolve();
            };
            this.queue.push(entry);
        });
    }
    release() {
        this.active--;
        const next = this.queue.shift();
        if (next) next.resolve();
        // Note: net active count unchanged when next exists — release
        // gave the slot directly to the next waiter without dropping
        // below the limit.
    }
}

const globalBucket = new TokenBucket(LIMIT);
const monitorMutexes = new Map();   // monitor.id → Promise chain

async function acquireConcurrencyToken(monitor, budgetMs) {
    // Acquire timeout = min(monitor.timeout * 1000, budgetMs * 2)
    const timeout = Math.min((monitor.timeout || 30) * 1000, budgetMs * 2);
    await globalBucket.acquire(timeout);
    return { release: () => globalBucket.release() };
}

async function acquireMonitorMutex(monitorId) {
    const prev = monitorMutexes.get(monitorId) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    // The chain is what we store in the map; new waiters will read it
    // and chain themselves onto it.
    const chain = prev.then(() => next);
    monitorMutexes.set(monitorId, chain);
    await prev;
    return {
        release: () => {
            release();
            // Cleanup: if no other waiter has replaced our chain in
            // the map, drop the entry so the Map doesn't grow without
            // bound. If a new waiter chained onto us in the meantime,
            // its set() will have replaced the map entry, so this
            // identity check returns false and we leave it alone.
            if (monitorMutexes.get(monitorId) === chain) {
                monitorMutexes.delete(monitorId);
            }
        }
    };
}

class SkipCheckError extends Error {
    constructor(msg) { super(msg); this.name = "SkipCheckError"; }
}

module.exports = { acquireConcurrencyToken, acquireMonitorMutex, SkipCheckError };
```

The mutex is per-process — a single `UptimeKuma` instance never runs
two checks for the same monitor concurrently. Horizontal scale is not
relevant for Uptime Kuma's deployment model.

### 5.9 `ssrf-guard.js`

URL-reference fetches go through `ssrf-guard.js`, which:

1. Validates the URL scheme is `http` or `https`.
2. **Resolves the hostname once** via `dns.lookup()`, recording the
   resolved IP.
3. Checks the resolved IP against the private/loopback/link-local
   range list in §12.4. Rejects unless the monitor's own target
   host also resolves to an IP **in the same range bucket** (i.e.,
   both in `10.0.0.0/8`, or both in `172.16.0.0/12`, or both in
   `192.168.0.0/16`, or both in IPv6 ULA `fc00::/7`). The
   range-bucket check is membership equality, not subnet equality —
   a monitor at `10.0.5.10` may fetch from `10.0.5.20` or
   `10.99.99.99`, both in the `10.0.0.0/8` bucket. This corrects
   the planning-doc's "/8 subnet" wording, which conflated bucket
   membership with subnet equality. See §12.4 and §20.4 for the
   exact range list.
4. Uses the resolved IP directly for the HTTPS connect (passing
   `servername` for SNI/cert validation). This prevents DNS rebinding
   between check time and connect time.
5. Disables redirect-following on the underlying fetch.
6. Inspects `Content-Type` before reading body bytes; rejects if it
   doesn't begin with `image/`.
7. Streams the body with a running byte counter and aborts at 10 MB.
8. Returns the response bytes to the caller; the caller (reference
   uploader) is responsible for re-decoding and canonicalising.

This is OP-006, made concrete.

### 5.10 `reference-store.js`

Exposes four methods:

- `uploadBlob(monitorId, slot, multipartFile, userId)` — accepts
  multipart upload, runs through `canonicalize()`, stores BLOB +
  fingerprint, writes audit record, returns metadata.
- `uploadUrl(monitorId, slot, url, userId)` — runs through SSRF guard,
  fetches, canonicalises, stores BLOB + URL + fingerprint, writes
  audit record.
- `refreshUrl(monitorId, slot, userId)` — uses the existing
  `streamReferenceXxxUrl`, re-fetches via SSRF guard,
  re-canonicalises, replaces BLOB + fingerprint, writes audit record.
- `getBlob(monitorId, slot)` — returns the BLOB bytes for the
  lazy-load HTTP GET endpoint.

`canonicalize(buffer)` pipeline:

```
sharp(inputBuffer)
  .rotate()                   // honour EXIF orientation, then strip
  .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 85, mozjpeg: true })
  .withMetadata(false)
  .toBuffer()
```

`fingerprintFromBlob(buffer)` uses the §6.4 pipeline.

`persistLastMatchThumbnail(monitor, jpeg)` and
`persistDownImage(monitor, jpeg)` resize the live JPEG to ≤ 320 px on
the long edge before storing — the DOWN-image table holds compact
visual evidence, not full-resolution frames.

### 5.11 `audit.js`

```javascript
async function recordAudit({ monitorId, slot, source, byteSize, sha256, userId }) {
    await R.exec(
        "INSERT INTO monitor_reference_audit (monitor_id, slot, source, byte_size, sha256, user_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [monitorId, slot, source, byteSize, sha256, userId, dayjs().toISOString()]
    );
}
```

R is RedBeanNode, consistent with how the rest of the codebase writes
to non-bean tables (`server/model/heartbeat.js` and similar use
`R.exec` and `R.dispense`).

The `userId` is sourced from the JWT `passport` middleware that
already protects `/api/monitor/*` endpoints in
`server/routers/api-router.js`. If `req.user?.id` is `null` (e.g.,
the install hasn't required login — `disableAuth` setting), `user_id`
is stored as `NULL`.

---

## 6. Frame-capture and image pipeline

### 6.1 `FrameSource` interface

```javascript
/**
 * @typedef {object} FrameSource
 * @property {(ctx: PreflightCtx) => Promise<FrameSource>} open
 * @property {() => Promise<RawFrame|null>} next     // resolves null on stream end
 * @property {(frame: RawFrame) => Promise<Buffer>} toJpeg
 * @property {() => Promise<void>} close
 */
```

`open()` MUST:

- Apply the wall-clock budget via a `Promise.race` against a
  `setTimeout(rejectWith(TimeoutError), ctx.budgetMs)`.
- Pass credentials through node-av's AVDictionary using the keys
  `rtsp_user`, `rtsp_pass` (RTSP) or via the URL form for RTMP
  (RTMP's libavformat code reads credentials from the URL).
- Pass `rtsp_transport=tcp` or `rtsp_transport=udp` per
  `ctx.transport`.
- Pass `tls_verify=1` or `0` per `ctx.tlsVerify` for RTSPS/RTMPS.
- Open a session that captures **only the first video stream**;
  audio is ignored.

`close()` MUST release every libav handle synchronously after the
session-close promise resolves. Implementation: keep a single
`finally` in the calling code, never multiple `try/finally` racing.

### 6.2 `NodeAvFrameSource` (only initial implementation)

Pseudocode:

```javascript
const av = require("node-av");

async function open(ctx) {
    const dict = {};
    if (ctx.transport === "udp")  dict.rtsp_transport = "udp";
    else                          dict.rtsp_transport = "tcp";
    if (ctx.username)             dict.rtsp_user = ctx.username;
    if (ctx.password)             dict.rtsp_pass = ctx.password;
    if (!ctx.tlsVerify && (ctx.protocol === "rtsps" || ctx.protocol === "rtmps")) {
        dict.tls_verify = "0";
    }

    const session = await withDeadline(
        av.demuxer.open(ctx.url, dict),
        ctx.budgetMs,
        () => new TimeoutError(ctx.budgetMs)
    );
    return new NodeAvFrameSource(session);
}
```

`withDeadline(p, ms, makeErr)` is a small helper: `Promise.race` of
`p` against a `setTimeout` that rejects with `makeErr()` and clears
the timer on either outcome.

### 6.3 JPEG validation

`validateJpegStructure(buf)` checks (FR-013, §03-monitoring-modes
§4):

- First 3 bytes are `0xFF 0xD8 0xFF` (JPEG SOI + marker).
- Last 2 bytes are `0xFF 0xD9` (JPEG EOI).
- `buf.length` between 1 KB and 5 MB (sanity bounds for plausible
  camera-frame JPEGs; a 1080p keyframe is typically 50–500 KB, a 4K
  keyframe up to ~2 MB).
- A single `sharp(buf).metadata()` call MUST return
  `width` ≥ 64, `height` ≥ 64, `width` ≤ 16384, `height` ≤ 16384
  (FR-013 dimension sanity).

Failure throws an Error with `messages.FRAME_INVALID(reason)`.

### 6.4 Fingerprint pipeline (matches §05 image-comparison-strategy)

```javascript
async function fingerprint(jpegBuf) {
    // Luminance hash branch
    const lumPixels = await sharp(jpegBuf)
        .greyscale()
        .normalise()
        .resize(9, 8, { fit: "fill", kernel: "lanczos3" })
        .raw()
        .toBuffer();   // 72 bytes
    const lumHash = dHash(lumPixels, 9, 8);   // returns Buffer(8)

    // Edge hash branch
    const edgePixels = await sharp(jpegBuf)
        .greyscale()
        .normalise()
        .resize(34, 33, { fit: "fill", kernel: "lanczos3" })
        .convolve(SOBEL_X_KERNEL)              // see §6.4.1
        .resize(9, 8, { fit: "fill", kernel: "lanczos3" })
        .raw()
        .toBuffer();
    const edgeHash = dHash(edgePixels, 9, 8);

    // Mean-luminance branch for extreme-luminance adjustment
    const stats = await sharp(jpegBuf)
        .greyscale()
        .resize(32, 32, { fit: "fill" })
        .raw()
        .toBuffer();
    const meanLuma = meanBytes(stats);

    return { lumHash, edgeHash, meanLuma };
}
```

#### 6.4.1 Sobel kernel

```
SOBEL_X_KERNEL = {
    width: 3,
    height: 3,
    kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1]
}
```

The horizontal Sobel kernel is sufficient — a vertical kernel adds
little uniqueness in IP-camera scenes where horizontal lines (walls,
doors, fences) dominate. A code-time test against representative
footage MAY suggest swapping for a magnitude-of-(SobelX+SobelY)
combination; this is a tuning knob in `image-pipeline.js`, not an
architectural decision.

#### 6.4.2 dHash function

```javascript
function dHash(pixels, w, h) {
    // pixels: w*h bytes, row-major
    // for each row: 8 bits comparing pixel[i] > pixel[i+1]
    // total: 8 rows × 8 bits = 64 bits = 8 bytes
    const out = Buffer.alloc(8);
    for (let row = 0; row < h; row++) {
        let bits = 0;
        for (let col = 0; col < w - 1; col++) {
            const left = pixels[row * w + col];
            const right = pixels[row * w + col + 1];
            if (left > right) bits |= (1 << (7 - col));
        }
        out[row] = bits;
    }
    return out;
}
```

### 6.5 Hamming distance

```javascript
function hammingDistance(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        d += POPCOUNT_8[a[i] ^ b[i]];
    }
    return d;
}
```

`POPCOUNT_8` is a 256-entry lookup table built once at module load.

`distance(live, refHash, classification)` computes:

```javascript
function distance(live, refHash, classification) {
    const lumRef = refHash.slice(0, 8);
    const edgeRef = refHash.slice(8, 16);
    let d = hammingDistance(live.lumHash, lumRef)
          + hammingDistance(live.edgeHash, edgeRef);

    // Extreme-luminance adjustment (§6.6)
    if (classification === "day" && live.meanLuma < 5)      d = 128;
    if (classification === "night" && live.meanLuma > 240)  d = 128;
    // For 'single', no classification, so no adjustment is applied.
    return d;
}
```

### 6.6 Extreme-luminance adjustment — corrected

The planning doc's adjustment fires only when a reference is
classified as Day or Night. **For a single-reference monitor
(`streamSeparateDayNight = false`), classification is "single" and
the adjustment is intentionally skipped.** Rationale: without a
Day/Night classification on the reference, we cannot tell whether a
black live frame is "wrong because reference is Day" or "right
because reference is Night, e.g., an indoor camera that's just dark."

This is a planning-doc clarification (see §18, item 4); the
fingerprint distance alone is the pass/fail signal in the
single-reference case.

### 6.7 Memory characteristics

Per check, at peak (per NFR-003 ≤ 50 MB):

- libav decoder context: 10–20 MB (1080p H.264; H.265 similar; AV1
  slightly higher).
- 1–5 raw decoded frames in transit: 1–10 MB each (1080p × 3 channels);
  released as soon as JPEG conversion completes.
- 1–5 JPEG buffers: ~50–500 KB total.
- sharp's libvips: streams; small steady-state footprint.

The expected RSS *increase* across a complete check is ≤ 50 MB
(NFR-003), released back to baseline after `source.close()` resolves
and all `Buffer` references go out of scope.

---

## 7. Frontend architecture

### 7.1 `EditMonitor.vue` modifications

The new monitor type is added to the dropdown's `<optgroup>` block.
Confirmation at code-time which `optgroup` is the best fit (likely
"Multimedia / Streaming" — to be created if no existing group is a
natural home).

The monitor-type-specific block follows the existing pattern at
`EditMonitor.vue:1007-1105` (MQTT) and similar:

```vue
<template v-if="monitor.type === 'rtsp'">
    <div class="my-3">
        <label for="stream-url" class="form-label">{{ $t("RTSP URL") }}</label>
        <input id="stream-url" v-model="monitor.url" type="text"
               class="form-control" required
               placeholder="rtsp://camera.local:554/stream1" />
        <div class="form-text">{{ $t("RTSP URL Description") }}</div>
    </div>

    <div class="my-3">
        <label for="stream-protocol" class="form-label">{{ $t("RTSP Protocol") }}</label>
        <select id="stream-protocol" v-model="monitor.streamProtocol" class="form-select">
            <option value="rtsp">RTSP</option>
            <option value="rtsps">RTSPS</option>
            <option value="rtmp">RTMP</option>
            <option value="rtmps">RTMPS</option>
        </select>
    </div>

    <!-- Mode -->
    <div class="my-3">
        <label class="form-label">{{ $t("RTSP Mode") }}</label>
        <div class="btn-group" role="group">
            <input type="radio" id="mode-basic" value="basic" v-model="monitor.streamMode" class="btn-check" />
            <label for="mode-basic" class="btn btn-outline-primary">{{ $t("RTSP Mode Basic") }}</label>
            <input type="radio" id="mode-enhanced" value="enhanced" v-model="monitor.streamMode" class="btn-check" />
            <label for="mode-enhanced" class="btn btn-outline-primary">{{ $t("RTSP Mode Enhanced") }}</label>
            <input type="radio" id="mode-full" value="full" v-model="monitor.streamMode" class="btn-check" />
            <label for="mode-full" class="btn btn-outline-primary">{{ $t("RTSP Mode Full") }}</label>
        </div>
        <div class="form-text">{{ $t("RTSP Mode Description") }}</div>
    </div>

    <!-- Transport (Enhanced/Full, RTSP only) -->
    <div v-if="(monitor.streamMode === 'enhanced' || monitor.streamMode === 'full')
               && (monitor.streamProtocol === 'rtsp' || monitor.streamProtocol === 'rtsps')"
         class="my-3">
        <label for="stream-transport" class="form-label">{{ $t("RTSP Transport") }}</label>
        <select id="stream-transport" v-model="monitor.streamTransport" class="form-select">
            <option value="tcp">{{ $t("RTSP Transport TCP") }}</option>
            <option value="udp">{{ $t("RTSP Transport UDP") }}
              <!-- tooltip with UI-008 clarification on UDP semantics -->
            </option>
        </select>
        <div class="form-text">{{ $t("RTSP Transport UDP Tooltip") }}</div>
    </div>

    <!-- URL-parameter warning (UI-007) -->
    <div v-if="urlContainsRtspTransport(monitor.url)"
         class="alert alert-warning my-3" role="alert">
        {{ $t("RTSP URL Transport Param Warning") }}
    </div>

    <!-- Credentials (reused: monitor.basic_auth_user / basic_auth_pass — see §7.4) -->
    <!-- The existing 'authMethod' block in EditMonitor.vue gates these -->

    <!-- Test button -->
    <StreamTestButton :monitor="monitor" />

    <!-- Reference image panel (Full only) -->
    <ReferenceImagePanel v-if="monitor.streamMode === 'full'"
                        :monitor="monitor"
                        @validation="onReferenceValidation" />

    <!-- ... -->
</template>
```

**Tooltip pattern (UI-002, UI-008, UI-009)**: Bootstrap's
`title=""`/`data-bs-toggle="tooltip"` is the existing pattern, paired
with a `<font-awesome :icon="['fas', 'question-circle']" />` icon next
to the label. The exact tooltip text for UI-008 (RTSP/UDP semantics)
and UI-009 (vendor path examples) is provided in §20.3.

### 7.2 `ReferenceImagePanel.vue` (new component)

Responsibilities:

- Render the "Separate Day/Night" toggle (FR-017).
- For each enabled slot (Day, Night, or single), render a dual-source
  input: file upload **or** URL textfield with "Refresh" button.
- On file selection / URL entry: POST to the reference endpoint
  (§8.2); on success, replace the slot's thumbnail with the canonical
  thumbnail returned by the server.
- Show resolution and byte size (UI-003).
- Lazy-load existing references on mount via GET `/api/monitor/:id/reference/:slot`
  (UI-012). Loading state shown via spinner.
- Emit `validation` events to the parent so the form's Save button
  reflects FR-019b (Full mode requires at least one reference).

Components reused from Uptime Kuma:
- `<HiddenInput>` is **not** used here (references aren't secrets).
- Standard Bootstrap form classes (`form-control`, `form-text`,
  `alert-warning`) — no custom CSS (UI-001).

### 7.3 `StreamTestButton.vue` (new component)

A button labelled `{{ $t("Test") }}` (proposal — see §17 Q14
resolution).

On click:

1. POST to `/api/monitor/test-stream` with the current form's
   configuration (the monitor need not be saved — Q19 resolution).
2. Server runs the same `RtspMonitorType.check()` against the
   transient config; **no heartbeat is written**.
3. For Enhanced/Full mode, the server additionally measures the
   keyframe interval and returns it in the response (UI-011).
4. On response, render an inline result panel: green check + msg, or
   red X + msg + warnings. Show the keyframe-interval warning when
   applicable.

The "no heartbeat written" guarantee is enforced server-side in the
test endpoint, not by client trust.

### 7.4 Credential field reuse

Per FR-031, RTSP reuses `monitor.basic_auth_user` /
`monitor.basic_auth_pass`. The existing "Authentication" section in
`EditMonitor.vue` already exposes these for HTTP-like monitors; the
RTSP block reuses it by including `'rtsp'` in the existing v-if
conditions, e.g.:

```vue
<template v-if="monitor.type === 'http' || ... || monitor.type === 'rtsp'">
    <!-- existing authMethod / basic_auth_user / basic_auth_pass markup -->
</template>
```

If the existing block requires HTTP-only semantics (e.g., a "Bearer
token" option that doesn't apply to RTSP), the v-if is narrowed to
keep RTSP showing only "None" and "Basic" auth-method choices. RTSP
"Basic" → forms.username/forms.password are sent; "Digest" auth at
the RTSP level is handled inside `node-av` automatically when
credentials are supplied, regardless of UI labelling.

### 7.5 i18n keys (UI-006, qualified)

All new keys in `src/lang/en.json` MUST start with `"RTSP "` or
`"Stream "`. Examples (final list defined at code time):

```json
{
    "RTSP URL": "RTSP URL",
    "RTSP URL Description": "Full URL including scheme, host, port, and path.",
    "RTSP Protocol": "Protocol",
    "RTSP Mode": "Mode",
    "RTSP Mode Basic": "Basic",
    "RTSP Mode Enhanced": "Enhanced",
    "RTSP Mode Full": "Full",
    "RTSP Mode Description": "Basic verifies the server speaks RTSP/RTMP. Enhanced verifies decoded frames are flowing. Full additionally matches frames against reference images.",
    "RTSP Transport": "Transport",
    "RTSP Transport TCP": "TCP-interleaved",
    "RTSP Transport UDP": "UDP",
    "RTSP Transport UDP Tooltip": "RTSP control is always over TCP; this option uses UDP for the actual RTP video packets.",
    "RTSP URL Transport Param Warning": "The ?rtsp_transport= parameter in the URL is ignored. Use the Transport selector above.",
    "RTSP Path Tooltip": "...",
    "RTSP Reference Day": "Day reference image",
    "RTSP Reference Night": "Night reference image",
    "RTSP Reference Match Threshold": "Match threshold (Hamming distance 0–48)",
    "RTSP Reference Threshold Description": "Lower = stricter. Default 24 of 128 bits tolerates day/night and weather changes.",
    "RTSP Frame Count": "Number of frames to capture",
    "RTSP Wall Clock Budget": "Time budget (seconds)",
    "RTSP Separate Day Night": "Separate Day/Night references",
    "RTSP Keyframe Interval Warning": "Keyframe interval ({0}s) exceeds half your monitor interval ({1}s); checks may intermittently fail.",
    "RTSP Status Thumbnail Opt In": "Show last matching frame on status page (opt-in; off by default)",
    "RTSP Keep Down Images Opt In": "Keep last 5 DOWN frames for incident review"
}
```

Translations to other locales MUST go through Weblate, not direct PR
(per `@CommanderStorm`'s policy on PR #5954).

---

## 8. API surface

### 8.1 Existing endpoints unchanged

Monitor CRUD via WebSocket socket-handlers is unchanged. Adding /
editing / saving a monitor of type `rtsp` flows through the same
socket-handler that already handles MQTT/HTTP/TCP monitors. Server
validation in `Monitor.save()` (in `server/model/monitor.js`) is
extended to:

- Reject `type='rtsp'` with `streamMode='full'` and no Day reference
  populated (FR-019b).
- Reject `type='rtsp'` with `streamMode='full'`,
  `streamSeparateDayNight=true`, and a Night slot empty (FR-019b).

Validation errors propagate through Uptime Kuma's standard socket
error envelope.

### 8.2 New REST endpoints

Auth: all endpoints require an authenticated session (same
middleware that protects `/api/monitor/*`).

#### `POST /api/monitor/:id/reference/:slot`

- **Path params:** `id` = monitor id, `slot` ∈ `{day, night, single}`.
- **Auth:** required.
- **Body:** `multipart/form-data` with either:
  - `file`: the uploaded image, max 10 MB raw; OR
  - `url`: a string (sent as a form field); the server fetches it via
    `ssrf-guard`.
- **Response 200:**
  ```json
  {
      "slot": "day",
      "source": "upload",
      "byteSize": 67890,
      "width": 640, "height": 360,
      "sha256": "deadbeef...",
      "fingerprint": "0123abcd...",
      "thumbnailUrl": "/api/monitor/:id/reference/:slot"
  }
  ```
- **Side effects:** monitor row's BLOB + URL + hash columns updated;
  audit record written.

#### `GET /api/monitor/:id/reference/:slot`

- **Auth:** required.
- **Response 200:** `image/jpeg`, body = BLOB bytes. Sets
  `Cache-Control: private, max-age=60, must-revalidate` and an
  `ETag` header derived from the BLOB sha256, so the edit form's
  re-renders don't re-download.

#### `POST /api/monitor/:id/reference/:slot/refresh`

- **Auth:** required.
- **Body:** none.
- **Side effects:** re-fetches the stored URL via `ssrf-guard`,
  re-canonicalises, updates the BLOB + hash, writes audit record.
- **Response 200:** same as POST endpoint.

#### `DELETE /api/monitor/:id/reference/:slot`

- **Auth:** required.
- **Side effects:** clears the slot's BLOB, URL, and hash columns;
  writes audit record with `source="delete"`.

#### `POST /api/monitor/test-stream`

- **Auth:** required.
- **Body:** JSON, mirror of the monitor edit form's current state
  (the monitor need not be persisted).
- **Side effects:** none persisted — no heartbeat, no audit, no DB
  writes. A `SkipCheckError` is converted to a friendly response, not
  silenced.
- **Response 200:**
  ```json
  {
      "ok": true,
      "mode": "enhanced",
      "msg": "captured 5/5 frames in 1820ms",
      "ping": 1820,
      "warnings": ["keyframe interval 12s exceeds half of 5s interval"]
  }
  ```
  or `200` with `ok: false` and `msg` for failure cases.

These endpoints live in `server/routers/api-router.js` alongside the
existing monitor REST routes.

### 8.3 Where these endpoints are wired

`server/routers/api-router.js` already exists and registers
`/api/push/:pushToken` and similar. Add a section for stream-monitor
reference uploads after the existing `/api/badge/*` and `/api/push/*`
routes:

```javascript
router.post("/api/monitor/:id/reference/:slot",
    apiAuth, multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single("file"),
    referenceUploadHandler);
router.get("/api/monitor/:id/reference/:slot", apiAuth, referenceGetHandler);
router.post("/api/monitor/:id/reference/:slot/refresh", apiAuth, referenceRefreshHandler);
router.delete("/api/monitor/:id/reference/:slot", apiAuth, referenceDeleteHandler);
router.post("/api/monitor/test-stream", apiAuth, testStreamHandler);
```

`multer.memoryStorage()` is critical: per **OP-004**, no temp files
on disk — the uploaded bytes live in a `Buffer` until they're either
canonicalised and stored as BLOB or rejected.

`apiAuth` is the existing JWT/session middleware in Uptime Kuma.

---

## 9. Sequence flows

ASCII sequence diagrams for the canonical flows.

### 9.1 Basic-mode RTSP check (UP path)

```
monitor.js                  RtspMonitorType   basic-probe.js     camera
   │                              │                  │              │
   │── check(monitor, hb, srv) ──▶│                  │              │
   │                              │── acquireMutex ──┤              │
   │                              │   (no token —    │              │
   │                              │    basic doesn't │              │
   │                              │    decode)       │              │
   │                              │── preflight ─────│              │
   │                              │                  │              │
   │                              │── probeRtsp ─────▶              │
   │                              │                  │── tcp open ─▶│
   │                              │                  │   send OPTIONS
   │                              │                  │              │
   │                              │                  │◀──RTSP/1.0 200 OK
   │                              │                  │   CSeq: 1   │
   │                              │                  │              │
   │                              │                  │── close ────▶│
   │                              │                  │              │
   │                              │◀── UP, ping=8ms ─│              │
   │                              │                  │              │
   │                              │   release mutex                 │
   │◀── (heartbeat) ──────────────│                                 │
```

### 9.2 Enhanced-mode check (UP path)

```
monitor.js               RtspMonitorType  enhanced-check.js  FrameSource  camera
   │                            │                │                │           │
   │── check ──────────────────▶│                │                │           │
   │                            │ acquireMutex   │                │           │
   │                            │ preflight      │                │           │
   │                            │ acquireToken   │                │           │
   │                            │── run ─────────▶                │           │
   │                            │                │── open ───────▶│           │
   │                            │                │                │── connect▶│
   │                            │                │                │ DESCRIBE │
   │                            │                │                │ SETUP    │
   │                            │                │                │ PLAY     │
   │                            │                │◀── opened ─────│           │
   │                            │                │── next ────────▶           │
   │                            │                │◀── frame1 ─────│           │
   │                            │                │── toJpeg ──────▶           │
   │                            │                │◀── jpeg1 ──────│           │
   │                            │                │  validate      │           │
   │                            │                │  (repeat ×5)   │           │
   │                            │                │  xxhash check  │           │
   │                            │                │  luminance chk │           │
   │                            │                │── close ───────▶           │
   │                            │                │                │── TEARDOWN▶
   │                            │                │                │           │
   │                            │◀── UP, msg=... ─                │           │
   │                            │ release token                                │
   │                            │ release mutex                                │
   │◀── (heartbeat) ────────────│                                              │
```

### 9.3 Full-mode check (mismatch path)

```
monitor.js               RtspMonitorType  full-check.js   ImagePipeline   camera
   │                            │                │              │             │
   │── check ──────────────────▶│                │              │             │
   │                            │ mutex/preflight/token         │             │
   │                            │── run ─────────▶              │             │
   │                            │                │ open / 1 frame / close ───▶│
   │                            │                │              │             │
   │                            │                │── fingerprint▶              │
   │                            │                │◀── {lum, edge, mean} ──────│
   │                            │                │                            │
   │                            │                │ distance(live, refDay) = 47│
   │                            │                │ distance(live, refNight)=53│
   │                            │                │ best = 47, > 24 threshold  │
   │                            │                │                            │
   │                            │                │ (if streamKeepDownImages)  │
   │                            │                │   persistDownImage         │
   │                            │                │                            │
   │                            │◀── throw Error("scene mismatch: …") ────────│
   │                            │ token/mutex release                         │
   │◀── DOWN, msg="..." ────────│                                              │
```

### 9.4 Reference upload (BLOB)

```
ReferenceImagePanel.vue   api-router.js   reference-store.js   audit.js   DB
        │                       │                  │                │       │
        │── POST /api/monitor/N/reference/day ────▶│                │       │
        │   (multipart file)    │                  │                │       │
        │                       │  apiAuth         │                │       │
        │                       │  multer mem      │                │       │
        │                       │── uploadBlob ────▶                │       │
        │                       │                  │ canonicalize   │       │
        │                       │                  │ fingerprint    │       │
        │                       │                  │── UPDATE monitor … ──▶│
        │                       │                  │── recordAudit ─▶       │
        │                       │                  │                │  INSERT▶
        │                       │                  │                │       │
        │                       │◀── {thumbnailUrl, sha256, …} ─────────────│
        │◀── 200 + JSON ────────│                                            │
```

### 9.5 Reference upload (URL)

```
ReferenceImagePanel.vue   api-router.js   ssrf-guard.js    reference-store.js   DB
        │                       │                  │                  │           │
        │── POST /…/reference/day {url:…} ────────▶│                  │           │
        │                       │  apiAuth         │                  │           │
        │                       │── uploadUrl(url)─▶                  │           │
        │                       │                  │ dns.lookup       │           │
        │                       │                  │ RFC1918/loopback │           │
        │                       │                  │ same-range check │           │
        │                       │                  │ https.get(ip, host:…)        │
        │                       │                  │ verify content-type          │
        │                       │                  │ stream → 10MB cap            │
        │                       │                  │── bytes ─────────▶           │
        │                       │                  │                  │ canonicalize
        │                       │                  │                  │ fingerprint
        │                       │                  │                  │── UPDATE ▶│
        │                       │                  │                  │  audit──▶│
        │                       │◀──────────── 200 + JSON ─────────────────────────│
```

### 9.6 Test-button probe

```
StreamTestButton.vue   api-router.js   RtspMonitorType  (no DB writes)
        │                     │                │
        │── POST /api/monitor/test-stream ───▶│
        │   { monitor JSON form state }       │
        │                     │  apiAuth      │
        │                     │  build ephemeral monitor object
        │                     │  (no .save)
        │                     │── check(monitor, hb, srv) ──▶
        │                     │  (Enhanced/Full: also measure
        │                     │   keyframe interval via demuxer)
        │                     │◀── hb populated, no DB written │
        │                     │  build response { ok, msg, warnings }
        │◀── 200 + result ────│
```

---

## 10. Error model and message catalog

### 10.1 Failure taxonomy

| Category | Examples | Mode(s) | Reported as |
|---|---|---|---|
| DNS failure | NXDOMAIN, SERVFAIL | all | DOWN |
| Network connect | refused, RST, timeout | all | DOWN |
| TLS failure | hostname mismatch, expired cert (when verify=on) | all (rtsps/rtmps) | DOWN |
| Protocol mismatch | server doesn't speak RTSP | Basic | DOWN |
| Auth required (no creds) | 401 with WWW-Authenticate | Basic | **UP** (alive) |
| Auth failed (with creds) | 401 after credentialed retry | Enhanced/Full | DOWN |
| Decode failure | corrupted stream, unsupported codec | Enhanced/Full | DOWN |
| Frame budget | 0 or <2 frames within budget | Enhanced | DOWN |
| Frozen | all N frames byte-identical | Enhanced | DOWN |
| Black/uniform | last frame luminance criteria met | Enhanced | DOWN |
| Scene mismatch | min distance > threshold | Full | DOWN |
| Save validation | full mode + no reference | save-time | UI error |
| Saturation | concurrency token timeout | Enhanced/Full | Skip (no HB) |
| node-av unavailable | prebuild missing, source-build failed | Enhanced/Full | DOWN with note |
| Reference fetch SSRF | private IP, redirect, wrong content-type | upload-time | upload 400 |

### 10.2 Heartbeat-message catalog (NFR-040, expanded)

Patterns are `printf`-style for predictability. The catalog lives in
`messages.js`:

```javascript
exports.messages = {
    // === Preflight ===
    DNS_FAILURE: (reason) => `DNS resolution failed: ${reason}`,
    URL_SCHEME_MISMATCH: (proto) => `URL scheme ${proto} does not match selected protocol`,
    UNKNOWN_PROTOCOL: (proto) => `unknown protocol: ${proto}`,
    UNKNOWN_MODE: (mode) => `unknown mode: ${mode}`,

    // === Basic ===
    RTSP_OK: (code) => `RTSP OPTIONS reply: ${code}`,
    RTSP_REDIRECT: (code) => `RTSP OPTIONS reply: ${code} (redirect; treating as alive)`,
    RTSP_SERVER_ERROR: (code) => `RTSP OPTIONS reply: ${code} (server alive but reports error)`,
    RTSP_NOT_SPOKEN: () => `server did not speak RTSP`,
    RTMP_OK: () => `RTMP S0/S1 handshake completed`,
    RTMP_NOT_SPOKEN: () => `server did not speak RTMP`,

    // === Connect ===
    CONNECTION_REFUSED: () => `connection refused`,
    CONNECTION_TIMEOUT: (ms) => `connection timeout after ${ms}ms`,
    CONNECTION_RESET: () => `connection reset by peer`,
    TLS_HOSTNAME_MISMATCH: (got) => `TLS hostname does not match certificate (got ${got})`,
    TLS_CERT_INVALID: (reason) => `TLS certificate invalid: ${reason}`,

    // === Enhanced ===
    INSUFFICIENT_FRAMES: (got, wanted) => `only ${got}/${wanted} valid frames captured`,
    FROZEN_FRAME: (n) => `stream appears frozen — ${n} identical frames`,
    BLACK_FRAME: (s) => `stream appears black or uniform (mean=${s.mean}, stddev=${s.stddev})`,
    ENHANCED_OK: (n, ms) => `captured ${n} frames in ${ms}ms`,
    FRAME_INVALID: (reason) => `frame validation failed: ${reason}`,

    // === Full ===
    MATCH_OK: (which, dist) => `matched ${which} at distance ${dist}/128`,
    MATCH_FAIL: (day, night, thr) => {
        if (night === null) return `scene mismatch: distance ${day}/128 > threshold ${thr}/128`;
        return `scene mismatch: distance ${Math.min(day, night)}/128 > threshold ${thr}/128 (Day=${day}, Night=${night})`;
    },
    NO_FRAME: () => `no frames received within wall-clock budget`,

    // === Infra ===
    NODE_AV_UNAVAILABLE: "node-av failed to load — Enhanced/Full mode unavailable on this platform",
    TIMED_OUT: (ms) => `timed out after ${ms}ms`,
    DECODE_FAILED: (reason) => `decode failed: ${reason}`,
};
```

### 10.3 Debug-response field structure

When `monitor.save_response = true`, the data passed to
`saveResponseData()` is mode-specific JSON:

- **Basic:**
  ```json
  { "raw_first_256_bytes": "RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer: …" }
  ```
- **Enhanced:**
  ```json
  {
    "frames": [
      { "size": 56789, "width": 1920, "height": 1080, "xxhash": "abcd…" },
      …
    ],
    "luminance_stats": { "mean": 87.3, "stddev": 42.1 },
    "elapsed_ms": 1820
  }
  ```
- **Full:**
  ```json
  {
    "frame": { "size": 67890, "width": 1920, "height": 1080 },
    "live_fingerprint": "0123abcdef0123ab",
    "scores": { "day": 11, "night": 47 },
    "threshold": 24,
    "matched": "Day"
  }
  ```

This is then JSON-stringified, truncated to `response_max_length` (1024
default), brotli-compressed, base64-encoded — all by the existing
`saveResponseData()` path.

---

## 11. Configuration

### 11.1 Environment variables

| Var | Default | Purpose |
|---|---|---|
| `RTSP_CONCURRENCY` | `max(2, min(4, floor(cpus/2)))` | Override global decode concurrency cap (NFR-004) |
| `RTSP_REFERENCE_MAX_DIM` | `640` | Max long-edge px for canonicalised reference images |
| `RTSP_REFERENCE_QUALITY` | `85` | JPEG quality for canonicalised references |
| `RTSP_FETCH_MAX_BYTES` | `10485760` | 10 MB cap on URL-reference fetch (OP-006) |
| `RTSP_DOWN_IMAGE_MAX_DIM` | `320` | Max long-edge px for DOWN-image thumbnails |

These are read at module load in `concurrency.js` and
`reference-store.js`. Changes require a server restart, consistent
with `server/config.js` patterns.

### 11.2 Per-monitor settings

Already listed in §3.1. All have sensible defaults so a user who
accepts every default still gets a working monitor for a typical IP
camera.

---

## 12. Security architecture

### 12.1 Trust boundaries

```
   trusted                              untrusted
─────────────────────────────────────────────────────────
   Uptime Kuma server  ◀ media bytes ── monitored camera
                                        (assumed adversary-controlled
                                         for purposes of media decode)

   Uptime Kuma server  ◀ uploaded JPEG ─ operator
                                        (authenticated, but client-side
                                         could be malicious)

   Uptime Kuma server  ◀ HTTP bytes ──── URL reference origin
                                        (assumed adversarial: SSRF guard
                                         + content-type guard + size cap +
                                         sharp re-decode)

   Uptime Kuma DB      ◀ writes ──────── this monitor type
                                        (trusted; we authored it)
```

### 12.2 Credential handling (NFR-020)

- Stored in `monitor.basic_auth_user` / `basic_auth_pass` (existing
  encrypted-at-rest columns, same protection as HTTP-keyword auth).
- Passed to node-av via AVDictionary (`rtsp_user`/`rtsp_pass`) — not
  via shell-quoted command lines.
- **Never** logged. Logger and message-catalog audits at code time MUST
  verify no log line contains the password (covered by NFR-031 test).
- URL credential embed (`rtsp://user:pass@host`) — stripped during
  preflight (§5.4 step 4); the stripped form is what reaches node-av
  and what is logged. Form fields win when both are set, with a
  non-blocking UI warning (FR-030).

### 12.3 TLS posture (NFR-021)

- Cert validation ON by default; per-monitor opt-out via the existing
  `monitor.ignoreTls` column (already in the schema, used by HTTP and
  others).
- When opted out, the monitor list UI displays a warning icon next to
  the monitor name (consistent with how HTTP monitors with
  `ignoreTls = true` are presented).
- TLS hostname validation MUST be on whenever cert validation is on —
  no separate hostname-only opt-out.

### 12.4 SSRF protection on URL references (OP-006, corrected)

The planning doc said "same /8 subnet" — overly coarse. The HLDS
specifies range-membership instead.

The IP-blocklist check rejects a resolved reference-URL IP that is in
any of:

- IPv4 loopback: 127.0.0.0/8
- IPv4 RFC 1918 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- IPv4 link-local: 169.254.0.0/16
- IPv4 multicast: 224.0.0.0/4
- IPv6 loopback: ::1/128
- IPv6 unique-local: fc00::/7
- IPv6 link-local: fe80::/10
- IPv6 multicast: ff00::/8

**Carveout:** if the resolved IP is in one of the private ranges
above, but the *monitor's own target host* also resolves to an IP in
the **same private range** (e.g., both in `192.168.0.0/16`), the
reference fetch is permitted. This lets an operator host their
reference image on the same internal subnet as the camera.

Implementation uses Node's `ip-address` package (or a small
hand-rolled comparator if avoiding the dependency is preferred at
code time — `ip-address` is currently a transitive dep of other
Uptime Kuma packages, no new top-level dep).

Other safeguards reiterated:

- HTTP/HTTPS only; FTP/file/etc rejected.
- No redirect following.
- `Content-Type` must begin with `image/`.
- 10 MB body cap, enforced during streaming.
- The fetched bytes are re-decoded and re-encoded via `sharp` before
  storage — sanitises adversarial JPEGs (NFR-023).

### 12.5 Reference-content sanitisation (NFR-023)

Uploaded bytes are never stored as-is. `canonicalize()` (§5.10) runs
the bytes through `sharp`, which:

- Rejects malformed JPEG/PNG before allocating large buffers.
- Strips EXIF (including GPS, camera serial, lens info) — privacy
  hygiene.
- Re-encodes via mozjpeg — eliminates any malicious JFIF chunks an
  attacker may have crafted to exploit downstream decoders.

The canonical bytes have a deterministic structural shape, which
secondarily eases byte-size budgeting.

### 12.6 Audit visibility

The audit table is queryable via a future admin endpoint (out of
scope for this work; flagged in §19) but is already useful for
forensics — a user who needs to confirm "did anyone re-upload the
reference for monitor 17?" can do so via direct SQL.

The `user_id` column captures the authenticated session user. For
installs with `disableAuth=true`, the column is `NULL`.

---

## 13. Performance budgets and capacity

### 13.1 Concrete budgets

| Mode | Median wall-clock | p95 wall-clock | Network bytes | RSS peak Δ |
|---|---|---|---|---|
| Basic RTSP | < 80 ms | < 250 ms | ~1 KB | < 1 MB |
| Basic RTSPS | < 200 ms | < 500 ms | ~3 KB | < 2 MB |
| Basic RTMP | < 100 ms | < 300 ms | ~3 KB | < 1 MB |
| Enhanced (5 frames, 1080p H.264) | 1.5–3 s | < 10 s | 2–4 MB | 30–50 MB |
| Full (1 frame, 1080p H.264) | 0.8–2 s | < 8 s | 0.5–2 MB | 30–50 MB |

Numbers are targets — actuals MUST be measured during PR-1
implementation and recorded in a benchmark note attached to the PR
(NFR-031b staged integration test).

### 13.2 Capacity model

A 4-core server (a common Uptime Kuma host) with default concurrency
limit of 2 (from `floor(4 / 2) = 2`):

Define **steady-state concurrent demand** as
`(check_rate_per_second) × (mean_check_duration_seconds)`.

- **Basic at 30-second intervals, 200 monitors:** rate = 200/30 = 6.67
  checks/sec; mean duration ~0.1 s → demand ~0.67 active checks. Basic
  doesn't use the concurrency bucket at all (no decode). Bound only by
  socket round-trip latency; comfortably handled.
- **Enhanced at 1-minute intervals, 50 monitors:** rate = 50/60 = 0.83
  checks/sec; p95 duration 10 s → demand ~8.3 active checks at p95,
  ~2.5 at mean (3 s). Against 2 slots, mean utilisation is ~125%
  steady-state — moderately tight; the bucket queues and skips during
  bursts. Either raise `RTSP_CONCURRENCY` or relax the interval.
- **Enhanced at 1-minute intervals, 20 monitors:** rate = 0.33/sec ×
  3 s = ~1.0 active mean. Comfortable.
- **Enhanced at 30-second intervals, 50 monitors:** rate = 1.67/sec ×
  3 s = ~5.0 active mean. Against 2 slots, ~250% oversubscribed at
  mean; most checks will queue and many will time-out → skipped. This
  workload demands `RTSP_CONCURRENCY=4` or larger, or a longer
  interval.

Skip events surface in logs (`"RTSP check skipped: concurrency limit"`
at warn level) — the signal an operator should use to size capacity.

The `RTSP_CONCURRENCY` env var is the lever for the high-density
deployment scenario.

### 13.3 Memory ceiling

Worst case: every concurrency slot active, every reference cached in
memory. With limit=4 and 50 MB per slot, ~200 MB additional RSS for
the decode workers, plus ~10 MB for the reference cache (50 monitors
× ~80 KB references × 2 slots each). Comfortable headroom against a
typical 512 MB-allocated Docker container.

---

## 14. Observability

### 14.1 Logging

All log lines use the existing `log` helper from `src/util`:

```javascript
log.info("rtsp", `[${monitor.name}] mode=enhanced frames=5 ping=${ping}ms`);
log.warn("rtsp", `[${monitor.name}] concurrency limit timeout`);
log.error("rtsp", `[${monitor.name}] decode failed: ${err.message}`);
log.debug("rtsp", `[${monitor.name}] frame[3] size=${size} hash=${hash}`);
```

The first argument is the log category — `"rtsp"` lets users filter
in the logs page.

Debug-level logging includes per-frame metadata; never includes the
raw frame bytes.

### 14.2 Heartbeat as primary observability

The `heartbeat.msg` field is the primary user-facing signal,
following the catalog in §10.2. Alert rules built atop Uptime Kuma's
existing notification mechanisms (NFR-040) pattern-match these
messages.

### 14.3 Debug capture (NFR-041)

Integrated with the existing `save_response` infrastructure. See
§10.3.

### 14.4 Audit trail

`monitor_reference_audit` rows are the audit signal for reference
provenance.

---

## 15. Test strategy

### 15.1 Test pyramid

```
                ┌────────────────────┐
                │  Manual integration│   ~5 cases, run pre-merge
                │  (real MediaMTX in │   NFR-031b
                │   docker, scripted)│
                └────────────────────┘
              ┌──────────────────────────┐
              │  In-process integration  │   ~30 cases
              │  (mock RTSP/RTMP server, │   covers protocol stack
              │   real node-av decode    │   and node-av interop
              │   on small synthetic     │
              │   frames)                │
              └──────────────────────────┘
        ┌────────────────────────────────────┐
        │  Unit                              │   ~100 cases
        │  (stubbed FrameSource, stubbed     │   covers business logic
        │   ssrf-guard, stubbed sharp,       │   exhaustively per NFR-031
        │   real fingerprint math)           │
        └────────────────────────────────────┘
```

### 15.2 Test files

```
test/backend-test/monitors/
  test-rtsp-basic.js        — Basic mode (~25 tests)
  test-rtsp-enhanced.js     — Enhanced mode (~30 tests)
  test-rtsp-full.js         — Full mode + fingerprint math (~25 tests)
  test-rtsp-reference.js    — Reference upload/URL/SSRF (~20 tests)
  test-rtsp-concurrency.js  — Mutex + token bucket (~10 tests)
```

Each file follows the pattern in
[test-tcp.js](../../test/backend-test/monitors/test-tcp.js): Node's
built-in `node:test` module, `describe`/`test` blocks, `assert` from
`node:assert`. Run via `npm run test-backend-22` (Node 22+) and
`npm run test-backend-20`.

### 15.3 Mocking

- **Basic-mode tests:** in-process TCP server (Node's `net.createServer`)
  that responds to `OPTIONS` with canned bytes. Tests Hikvision-401,
  Dahua-spaced-realm, generic 3xx, generic 5xx, HTTP-on-554
  (non-RTSP), RTMP S0/S1 handshake.
- **Enhanced-mode tests:** `FrameSource` is stubbed; the stub returns
  a fixture sequence of pre-made JPEGs (frozen, black, valid, etc.).
  The test never opens a real RTSP socket.
- **Full-mode tests:** same stub; fingerprint math is real (it's
  pure JS). Reference BLOBs are inline base64 fixtures.
- **SSRF tests:** `dns.lookup` is stubbed via Node's
  `--experimental-test-module-mocks` or a manual replacement; HTTPS
  responses are stubbed via `nock`.
- **Concurrency tests:** drive `TokenBucket` directly; assert
  ordering, timeouts, mutex serialisation.

### 15.4 Test coverage gates

A test MUST exist for every REQ-ID in
**[04-requirements.md](./04-requirements.md)** with measurable
runtime behaviour. The list in NFR-031 is the canonical set.

CI runs the full backend test suite on PR; failure blocks merge.

### 15.5 Staged real-world integration (NFR-031b)

Documented runbook (added at PR-1 implementation time as
`docs/rtsp-monitor/11-staged-integration-runbook.md`) covers:

- Spinning up MediaMTX in Docker with a synthetic test pattern as
  source.
- Running each mode against the local MediaMTX endpoint.
- Verifying expected pass / fail behaviour matches the unit tests.
- Recording observed `ping` numbers for the performance table.

Not a CI gate; PR template includes a checkbox confirming it was run.

---

## 16. Migration and rollout

### 16.1 Fresh installs

`db/knex_init_db.js` is the canonical fresh-install schema. The new
columns are added via the migration in §4.2; on a fresh install
they're applied before the first server start.

### 16.2 Existing installs

Migration is forward-compatible: every new column defaults to
`null`, so existing monitor rows (no `streamMode` set) are unchanged
and the dispatch in `monitor.js:905-918` ignores the new code path
because `this.type !== "rtsp"` for them.

### 16.3 Rollback path

If a critical bug is found post-merge:

- The migration's `exports.down` (§4.2) drops every new column and
  table.
- Any monitor of `type='rtsp'` becomes unselectable (the type isn't
  registered) but its DB row remains; the heartbeat path raises
  "Unknown Monitor Type" until either the column is restored or the
  monitor is deleted.
- For a graceful rollback, the operator should DELETE the rtsp
  monitors before running the down migration.

### 16.4 Three-PR rollout mechanics

| | Files | DB columns | Tests |
|---|---|---|---|
| **PR 1 (fork)** | full directory | full migration | all 5 test files |
| **PR 2 (upstream Basic)** | index.js, basic-probe.js, concurrency.js (mutex only), messages.js | stream_protocol, stream_mode | test-rtsp-basic.js |
| **PR 3 (upstream Enhanced)** | PR 2 files + enhanced-check.js, frame-source.js | adds stream_transport, stream_frame_count, stream_wall_clock_budget_sec | + test-rtsp-enhanced.js, test-rtsp-concurrency.js |

Each upstream PR is a `git rm` from the fork branch plus a trimmed
migration file, not a re-author.

### 16.5 `node-av` install-time considerations

`node-av`'s `npm install` may attempt source-build on first install
for unsupported platforms. The acceptable failure modes:

1. **Prebuild fits** (most platforms) — silent install, monitor type
   works fully.
2. **Source-build succeeds** — slow first install (~5–15 min),
   monitor type works fully.
3. **Source-build fails** — install completes with a warning
   (node-av's optional-deps are wrapped in `try`). The require()
   throws at server startup; UI-005 graceful-degradation kicks in;
   Basic mode still works.

Documentation in the fork's README addition covers the platforms
where source-build is required (arm/v7, musl) so operators can
self-diagnose.

---

## 17. Round-2 open-item resolutions (Q13–Q21)

The fork-owner deferred these to HLD time. Each is resolved here.

### Q13 — Accordion / collapsible pattern for the references section

**Finding:** `EditMonitor.vue` does not use a `<details>` or
Bootstrap `collapse` pattern for grouped advanced fields. The
existing convention is a section-break `<h2 class="mt-5 mb-2">{{
$t("Advanced") }}</h2>` (visible at line 1531) followed by always-rendered
fields.

**Decision:** The references section follows the same pattern — a
section heading `<h2 class="mt-5 mb-2">{{ $t("RTSP Reference Images")
}}</h2>` followed by always-rendered fields when
`monitor.streamMode === 'full'`. The lazy-load of BLOBs (UI-012)
fires on component mount (or when `streamMode` switches to `'full'`),
not on user click. This is simpler and matches existing patterns.

### Q14 — "Test" button verbiage

**Finding:** No existing "test now" / "check now" / "probe"
affordance in `EditMonitor.vue` (confirmed).

**Decision:** The button is labelled "Test" in English. At code time,
check whether `"Test"` already exists as a key in `src/lang/en.json`:
- If yes, reuse it (avoid the noise of a near-duplicate key).
- If no, add a single new generic key `"Test": "Test"` rather than an
  RTSP-prefixed one — this is a domain-neutral UI verb. The
  CommanderStorm i18n-key-prefix policy targets domain-specific terms
  like "Username" / "Password" where shared keys cause translation
  collisions. A generic button label is the kind of key prefixing
  doesn't help with.

Button styling: `class="btn btn-outline-primary"`, placed inline
below the mode selector.

### Q15 — Audit-log destination

**Finding:** No generic audit subsystem in Uptime Kuma.

**Decision:** Create a dedicated `monitor_reference_audit` table
(detailed in §3.4 / §4.2). This is the architecturally cleanest
choice; "piggyback on notification_log" was the fallback and it
would create false signal-noise (notifications are operator-facing
events, audits are administrative).

### Q16 — `node-av` API for credentials

**Finding (via code-time research, see §6.2):** `node-av` exposes
FFmpeg's AVDictionary at session-open time. Standard RTSP auth keys
are `rtsp_user` and `rtsp_pass`, identical to the FFmpeg CLI's
`-rtsp_user` / `-rtsp_pass` options.

**Decision:** Pass credentials via AVDictionary, never via the URL
form (which the operator may also use, but our code path strips URL
credentials in preflight). For RTMP, libavformat reads credentials
from URL form; the preflight constructs the URL with credentials for
RTMP only.

### Q17 — Fingerprint serialisation to the frontend

**Decision:** `streamReferenceDayHash` and `streamReferenceNightHash`
are serialised as hex-strings in the default `Monitor.toJSON()`
payload. BLOBs are excluded. Boolean
`streamReferenceXxxHasBlob` flags are also included. Detailed in §4.4.

### Q18 — Non-blocking warning beneath a field

**Finding:** The existing pattern is a Bootstrap
`<div class="alert alert-warning" role="alert">` (visible at lines
133, 151 in `EditMonitor.vue`).

**Decision:** Reuse this exact pattern for UI-007 (rtsp_transport URL
warning) and UI-011 (keyframe-interval warning). See §7.1 example
markup.

### Q19 — Test button availability before save

**Decision:** (a) Yes, operates on the form's in-memory state — no
save required. (b) Side-channel only: no heartbeat row written, no
audit, no state mutation. Detailed contract in §8.2's
`POST /api/monitor/test-stream` and §9.6 sequence diagram.

### Q20 — DOWN-image incident UI surface

**Decision:** (a) Default — DOWN images are visible only on the
monitor's incident-detail page (which exists in the Uptime Kuma SPA
as the route attached to clicking on a DOWN heartbeat dot). (b) Opt-in
via `streamStatusThumbnail` — the *last matching frame* (not the
DOWN frames) is surfaced on the public status page. The 5 DOWN
frames are never shown on the public status page — they are
authenticated content.

### Q21 — FFmpeg license compliance

**Decision:** Action items, recorded as a code-time gate:

1. At PR-1 implementation time, run
   `node -e "console.log(require('node-av').version())"` and inspect
   the prebuild's FFmpeg `configure` output (node-av's
   `build/ffmpeg-config.h` or the `node-av` repo's build scripts).
2. Confirm only LGPL components are enabled. Reject the dependency
   if any GPL component is detected without an LGPL fallback.
3. Add a `NOTICE` file at the repo root documenting:
   - `sharp` / libvips: Apache-2.0 with LGPL dependencies.
   - `node-av`: MIT wrapper around LGPL FFmpeg.
4. The PR-1 description includes the FFmpeg build-flag inventory as
   an attachment.

If a GPL component cannot be avoided in any node-av build, escalate
to fork-owner before merging — the alternative (subprocess against a
distro-installed FFmpeg) would require revisiting OP-001.

---

## 18. Sanity-check corrections to the planning docs

This HLDS supersedes the following details that were imprecise in
docs 01–09. None are scope changes; all are corrections that the
implementation MUST honour.

1. **Schema column prefix.** `05-image-comparison-strategy.md` §5
   wrote `rtsp_reference_day_blob` etc.; the actual monitor type
   serves RTSP and RTMP. The HLDS uses `stream_reference_*` (§3.1 /
   §4.2).

2. **`response_max_length` default.** `04-requirements.md` NFR-041
   says the default is "10,000 bytes." The actual default is **1,024
   bytes** (`src/util.js:47` `RESPONSE_BODY_LENGTH_DEFAULT = 1024`).
   The HLDS reflects 1,024 (§3.2).

3. **`heartbeat.response` encoding.** NFR-041 implies a plaintext
   write. The actual mechanism is brotli-compressed, base64-encoded
   via the existing `Monitor.saveResponseData()` method
   (`server/model/monitor.js:1177`). The HLDS routes all
   debug-capture through `saveResponseData()` (§3.2, §5.5, §5.6,
   §5.7).

4. **Single-reference luminance adjustment.**
   `05-image-comparison-strategy.md` §2's extreme-luminance
   adjustment only covers Day/Night-classified references. The HLDS
   explicitly skips the adjustment for the single-reference case
   (§6.6) and explains why: without a Day/Night classification, the
   adjustment cannot fire correctly.

5. **"Same /8 subnet" SSRF carveout.** `OP-006` in
   `04-requirements.md` says the SSRF carveout uses "the same /8
   subnet" — semantically conflated "bucket membership" with "subnet
   equality." The HLDS clarifies this as **range-bucket membership**:
   both IPs in the same RFC 1918 bucket (one of `10.0.0.0/8`,
   `172.16.0.0/12`, `192.168.0.0/16`) or the IPv6 ULA bucket
   (`fc00::/7`). The carveout permits e.g., `10.0.5.10` and
   `10.99.99.99` (both in `10/8`) but rejects `10.0.5.10` and
   `192.168.1.1` (different buckets). See §5.9, §12.4, §20.4.

6. **Accordion pattern.** `08-open-questions.md` Q13 noted
   `EditMonitor.vue` "uses Bootstrap collapse blocks for advanced HTTP
   options." A precise read shows the existing pattern is `<h2>
   Advanced</h2>` section-headings, *not* collapsible sections. The
   HLDS uses the section-heading pattern (§7.1, §17 Q13 resolution).

7. **Test-button precedent.** `UI-010` says "the button label MUST
   match Uptime Kuma's existing verbiage." No such verbiage exists.
   The HLDS proposes `Test` outright (§17 Q14 resolution).

8. **Concurrency-token timeout source.** `NFR-004` says the check is
   skipped if the token isn't acquired "within its configured
   timeout" — ambiguous. The HLDS pins this to
   `min(monitor.timeout * 1000, ctx.budgetMs * 2)` (§5.8).

9. **No-temp-files upload exception.** `OP-004`'s carveout
   ("Express's body parser if multipart parsing requires it") can be
   eliminated entirely by configuring `multer` with
   `multer.memoryStorage()` (§8.3). The HLDS makes this an explicit
   non-exception — there are zero disk writes at any point in the
   monitor's lifecycle.

10. **`UI-014` table name.** The planning doc called it
    `monitor_rtsp_down_image`. The HLDS renames to
    `monitor_stream_down_image` for protocol-agnostic consistency
    (§3.5, §4.2).

11. **`UI-013`/`UI-014` storage of last-match thumbnail.** The
    planning doc didn't specify a column for the last-match
    thumbnail. The HLDS reuses the same
    `monitor_stream_down_image` table — but distinguishes match vs.
    DOWN rows via a discriminator column. **Open at code time:** if
    review prefers a separate `monitor_stream_match_image` column on
    the monitor row instead (single row, no history), that is a
    simpler choice and acceptable. Decided at PR-1 review time.

12. **Credential column names.** `FR-031` and §A.4 of
    `04-requirements.md` describe "generic `username`/`password`
    columns already present on the `monitor` table." The columns
    that actually exist with this semantic role are
    `basic_auth_user` and `basic_auth_pass` (used by HTTP /
    HTTP-keyword / JSON-query monitors and surfaced in
    `Monitor.toJSON()` lines 225-226). The HLDS uses the actual
    column names throughout. The intent of FR-031 — "do not introduce
    `rtsp_username`/`rtsp_password` columns; reuse what's already
    there" — is faithfully preserved.

13. **`monitor_stream_down_image` last-match row discrimination.**
    The HLDS proposes reusing this table for both DOWN frames and
    the last-match thumbnail. To make this work, the table needs a
    `kind` discriminator column (`'down' | 'match'`). The migration
    in §4.2 omits this column for brevity — to be added at code time
    when this design choice is confirmed. The alternative (a column
    on the monitor row) avoids the discriminator entirely. Final
    pick at PR-1 review (also see §18 item 11).

---

## 19. Open items for the LLD / code review

Items that the HLDS cannot resolve without code-level work, flagged so
PR-1 review can confirm direction:

1. **Optgroup placement** — which `<optgroup>` in `EditMonitor.vue`'s
   type selector hosts `rtsp`. A new "Streaming" group is proposed;
   alternative is to add to "Other" or to the existing "Specific"
   group.

2. **JPEG-encode backend choice** — `node-av` mjpeg encoder vs
   `sharp` JPEG encoder for converting decoded frames. Benchmark at
   PR-1 implementation; pick the faster of the two on the target
   platforms. Either is functionally equivalent.

3. **`Monitor.saveResponseData()` shape** — currently accepts
   strings or stringifies via `JSON.stringify`. Verify it copes with
   our structured-object debug payloads without surprising
   truncation behaviour.

4. **`SkipCheckError` integration in `monitor.js`** — see §5.2 note.
   Determine whether a one-line `if (error?.name === "SkipCheckError")
   { … skip heartbeat … }` addition to the catch block at
   `monitor.js:949` is acceptable, or whether the fallback (writing a
   DOWN with skip reason) is preferred to keep `monitor.js`
   unchanged.

5. **`ip-address` dependency** — verify it's already transitively
   present (suspected: yes, via `tcp-ping` or similar). If not, a
   small ~20-line CIDR matcher inlined in `ssrf-guard.js` avoids a
   new dep.

6. **`xxhash64` library** — `xxhash-addon` is the natural choice; if
   it pulls a native binding, prefer `js-xxhash` (pure JS, fast
   enough for ≤ 5 small JPEGs per check). Pick at PR-1 time;
   functionally equivalent.

7. **`Monitor.toJSON()` insert-point** — where in the existing field
   list to add `streamProtocol`, `streamMode`, etc. Code-time
   editorial choice.

8. **Admin endpoint for audit-table inspection** — out of scope for
   this work but consider whether a minimal `GET
   /api/monitor/:id/audit` would help operators. Flagged for future
   sprint.

9. **Status-page-render integration** — `UI-013` requires changes to
   `src/pages/StatusPage.vue` to render the last-match thumbnail.
   This is mechanically additive (a small `v-if` block) but the
   exact placement and styling is editorial; resolved at PR-1
   implementation.

10. **Default tooltip strings** — `UI-008` (RTSP/UDP semantics),
    `UI-009` (vendor path examples), `UI-011` (keyframe interval).
    Final wording at code time; structure pinned in §20.3.

---

## 20. Appendix

### 20.1 File layout summary

```
server/monitor-types/rtsp/
  index.js                ─ RtspMonitorType
  basic-probe.js          ─ RTSP/RTMP basic probes
  enhanced-check.js       ─ multi-frame check
  full-check.js           ─ fingerprint check
  frame-source.js         ─ FrameSource interface + NodeAvFrameSource
  image-pipeline.js       ─ sharp pipeline + fingerprint
  reference-store.js      ─ upload, fetch, BLOB serving
  concurrency.js          ─ TokenBucket + mutex + SkipCheckError
  ssrf-guard.js           ─ URL fetch hardening
  audit.js                ─ audit-table writer
  messages.js             ─ heartbeat message catalog
  url-parse.js            ─ preflight URL parsing & ctx assembly

db/knex_migrations/
  2026-NN-NN-NNNN-add-stream-monitor.js

src/components/
  ReferenceImagePanel.vue
  StreamTestButton.vue

test/backend-test/monitors/
  test-rtsp-basic.js
  test-rtsp-enhanced.js
  test-rtsp-full.js
  test-rtsp-reference.js
  test-rtsp-concurrency.js
```

### 20.2 New direct dependencies (NFR-034)

```json
"dependencies": {
    "node-av":   "^X.Y.Z",
    "sharp":     "^0.34.x"
}
```

Exact pins at PR-1 implementation time. Transitive deps (e.g.,
`unzipper` via node-av; libvips platform packages via sharp) are
acceptable and not counted against NFR-034.

### 20.3 Tooltip text (proposed; final at code time)

**UI-008 (RTSP/UDP semantics):**

> RTSP control is always over TCP. This option uses UDP for the
> actual RTP video packets, which is the form most cameras refer to
> as "UDP transport." Some networks (especially over the public
> internet) block UDP for video — if checks fail with this option,
> try TCP-interleaved instead.

**UI-009 (vendor path examples):**

> Typical paths for popular cameras:
> - Hikvision: `/Streaming/Channels/101` (main) or `/102` (sub)
> - Dahua / Amcrest: `/cam/realmonitor?channel=1&subtype=0`
> - Reolink: `/h264Preview_01_main` or `/h264Preview_01_sub`
> - Axis: `/axis-media/media.amp`
> - Unifi: `/<random-token>` (assigned by the controller)
>
> Consult your camera's documentation; paths vary by firmware
> version.

**UI-011 (keyframe interval warning):**

> Your stream's keyframe interval is {0} seconds, which exceeds half
> of this monitor's check interval ({1} s). Checks may intermittently
> fail because the first keyframe may arrive after the check budget
> expires. Consider raising the monitor interval or shortening the
> camera's GOP / keyframe interval.

### 20.4 RFC 1918 / private-range membership table

| Range | Membership test |
|---|---|
| `10.0.0.0/8` | `ip >= 0x0A000000 && ip <= 0x0AFFFFFF` |
| `172.16.0.0/12` | `ip >= 0xAC100000 && ip <= 0xAC1FFFFF` |
| `192.168.0.0/16` | `ip >= 0xC0A80000 && ip <= 0xC0A8FFFF` |
| `127.0.0.0/8` | `ip >= 0x7F000000 && ip <= 0x7FFFFFFF` |
| `169.254.0.0/16` | `ip >= 0xA9FE0000 && ip <= 0xA9FEFFFF` |
| `224.0.0.0/4` | `ip >= 0xE0000000` |
| IPv6 `::1/128` | exact match `0...01` |
| IPv6 `fc00::/7` | first byte `& 0xFE == 0xFC` |
| IPv6 `fe80::/10` | first 10 bits `0xFE80 >> 6` |
| IPv6 `ff00::/8` | first byte `0xFF` |

The carveout for "monitored host is in the same private range as the
reference URL host" tests range *identity*, not subnet equality —
membership in `192.168.0.0/16` for both is sufficient.

### 20.5 Default ports

| Protocol | Default port |
|---|---|
| `rtsp` | 554 |
| `rtsps` | 322 |
| `rtmp` | 1935 |
| `rtmps` | 443 (commercial) or 4935 (self-hosted) — no auto-pick, user must select |

### 20.6 Glossary additions (beyond §01)

| Term | Definition |
|---|---|
| `FrameSource` | Internal interface abstracting the source of decoded video frames; current implementation `NodeAvFrameSource` wraps `node-av`. |
| `TokenBucket` | In-memory concurrency limiter for Enhanced/Full decode sessions (§5.8). |
| `SkipCheckError` | Discriminator error thrown when a concurrency token can't be acquired; signals "skip this check, no heartbeat" rather than "the check failed." |
| `canonicalize` | `sharp` pipeline that re-encodes uploaded references to a canonical form (≤ 640 px, JPEG q85, no EXIF). |
| `ssrf-guard` | URL-fetch wrapper that enforces protocol, IP-range, redirect, content-type, and size constraints. |
| dHash | Difference hash; perceptual-image hash that compares adjacent pixel luminances. |
| pHash | Perceptual hash via DCT; we don't use it, but it's the historical alternative to dHash. |
| AVDictionary | libav's key-value parameter mechanism for passing options into a session-open call. |

---

## End of HLDS

This HLDS is the canonical design contract for the RTSP/RTMP monitor.
Subsequent implementation work refers back to this document by
section number. Material deviations during implementation (e.g.,
benchmark-driven changes to NFR-002's clamp values) MUST be
documented as amendments here at the same time the code change is
made.

When PR 1 is implementation-ready, this document's "Open items for
the LLD / code review" section (§19) is the gate — every numbered
item is either resolved with a sentence here or with a code-time
note in the PR description.

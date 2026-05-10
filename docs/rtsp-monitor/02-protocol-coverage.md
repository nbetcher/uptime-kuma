# 02 — Protocol Coverage

This document enumerates *exactly* which protocol/transport combinations the
monitor supports, which it deliberately does not, and why. Vendor quirks
that affect the protocol surface are listed in §4.

## 1. Coverage matrix

| Protocol | Control transport | Media transport | Default port | Supported by this monitor | Note |
|---|---|---|---|---|---|
| RTSP | TCP | n/a (Basic only) | 554 | **Yes — Basic** | OPTIONS/DESCRIBE handshake |
| RTSP | TCP | RTP over TCP-interleaved | 554 | **Yes — Enhanced, Full** | RFC 2326 §10.12; works through firewalls. UI label: "RTSP/TCP" |
| RTSP | TCP | RTP over UDP | 554 (control), dynamic UDP (media) | **Yes — Enhanced, Full** | UI label: "RTSP/UDP" with a `?` tooltip clarifying that this means RTSP control over TCP and RTP media over UDP — see UI-008 in [04-requirements.md](./04-requirements.md) |
| RTSP | UDP | n/a | 554 | **No** | IANA-reserved but virtually unused; see §3.1 |
| RTSPS | TLS over TCP | RTP over TCP-interleaved | 322 | **Yes — Basic, Enhanced, Full** | RFC 7826 §4.2 |
| RTSPS | TLS over TCP | RTP over UDP | 322 (control), dynamic UDP (media) | **Yes — Basic, Enhanced, Full** | Control encrypted; media is plain RTP unless SRTP-keyed (rare) |
| RTMP | TCP | (in-band) | 1935 | **Yes — Basic, Enhanced, Full** | C0/C1 handshake at minimum |
| RTMPS | TLS over TCP | (in-band) | 443 or 4935 | **Yes — Basic, Enhanced, Full** | TLS-then-RTMP |
| RTMP | UDP | n/a | n/a | **No** | Does not exist; see §3.3 |
| RTMFP | UDP | UDP | dynamic | **No** | Different protocol family; out of scope |

`[HIGH]` confidence on every row above. Sources: RFC 2326, RFC 7826, RFC 7016,
IANA Service Name and Transport Protocol Port Number Registry, FFmpeg
protocols documentation, and current Axis/MediaMTX/NGINX-RTMP server docs.

## 2. Mode-by-protocol applicability

| | Basic | Enhanced | Full |
|---|---|---|---|
| RTSP/TCP | Yes | Yes | Yes |
| RTSPS (TLS over TCP) | Yes | Yes | Yes |
| RTMP/TCP | Yes | Yes | Yes |
| RTMPS (TLS over TCP) | Yes | Yes | Yes |

Every supported protocol works in every mode. Differences are in the
verification depth, not the wire protocol — see
**[03-monitoring-modes.md](./03-monitoring-modes.md)**.

## 3. Out-of-scope variants — with reasoning

### 3.1 RTSP control over UDP

IANA reserves UDP/554 for RTSP, but no consumer or prosumer camera vendor
ships with RTSP-control over UDP. Every shipping implementation (Hikvision,
Dahua, Axis, Reolink, Amcrest, Unifi, MediaMTX, GStreamer, FFmpeg) uses TCP
for control. **Not implementing.** If a vendor request emerges, it is
mechanically additive (a UDP socket parallel to the TCP path).

### 3.2 SRTP under RTSPS

SRTP can carry RTP media securely. RTSPS encrypts the *control* channel;
if the underlying RTP needs encryption, the keying is a separate
(and rarely used) configuration. We delegate media decoding to `node-av`
(see **[03-monitoring-modes.md](./03-monitoring-modes.md)** §6); whichever
SRTP keying the camera uses is libav's concern, not ours, *if* the URL
is configured correctly.

### 3.3 RTMP over UDP

RTMP is TCP-only by specification. The protocol's framing (C0+C1 handshake,
chunk streams, AMF) assumes ordered, reliable byte delivery — UDP gives
neither. The UDP-based cousin from the same era is RTMFP (RFC 7016),
which is a wholly different protocol designed for peer-to-peer
NAT-traversal in legacy Adobe Flash applications. RTMFP has no current
camera-vendor adoption.

**PUSHBACK: "RTMP over UDP" is excluded from scope.** See
**[08-open-questions.md](./08-open-questions.md)**.

### 3.4 Other media protocols

Out of scope explicitly: HLS (`.m3u8`), DASH (`.mpd`), MPEG-TS over HTTP,
WebRTC (whip/whep), MJPEG over HTTP, ONVIF event subscriptions, SRT, and
NDI. Each could become a future monitor type; none belongs in this work.

## 4. Vendor quirks the monitor must tolerate

These are observed behaviours that cause naive RTSP probes to misreport.
The monitor's Basic-mode response parser MUST tolerate each.

| Vendor | Quirk | Tolerance required |
|---|---|---|
| Hikvision | Returns `RTSP/1.0 401 Unauthorized` to anonymous OPTIONS, with `WWW-Authenticate: Digest`. | A 401 with `WWW-Authenticate` proves liveness; treat as UP for Basic. Optionally retry with credentials when supplied. |
| Dahua / Amcrest | `WWW-Authenticate: Digest realm="Login to ..."` — embedded space in realm string confuses strict parsers. | The Digest header is consumed only if credentials are supplied; even then, lenient header parsing is required. For Basic-mode liveness, the 401 status alone suffices. |
| Reolink | RTSP path varies by firmware; some firmware silently downgrades to a non-conformant response on unsupported methods. | Accept any reply whose first 5 bytes are `RTSP/`; do not require strict status-code 200. |
| Unifi (UVC) | Random-token URL paths; RTSP must be enabled per-camera. | The user enters the full URL path; we do not validate path content. |
| Wyze / Eufy | Stock firmware does not expose RTSP. Special builds or premium toggles required. | Out of our control; if port 554 is closed, Basic correctly reports DOWN. |
| Axis | Conformant. Supports RTSPS on 322. | No special handling needed. |
| ONVIF GoAhead embedded HTTP servers | Some cameras run a webserver on TCP/554 *as well as* RTSP — or *instead of* RTSP if RTSP is disabled. | A response that does not begin with `RTSP/` is **DOWN**, even if a TCP connection succeeded. This is the failure mode CommanderStorm-style reviewers will probe for. |

`[HIGH]` for Hikvision/Dahua/Axis. `[MEDIUM]` for Reolink/Unifi (community
reports; vendor docs are inconsistent). `[MEDIUM]` for the GoAhead concern
(observed but vendor-specific).

## 5. Wire-format reference

For Basic mode's hand-rolled probe (see
**[03-monitoring-modes.md](./03-monitoring-modes.md)** §3):

### Minimal RTSP OPTIONS request

```
OPTIONS rtsp://HOST:PORT/PATH RTSP/1.0\r\n
CSeq: 1\r\n
User-Agent: UptimeKuma/2.x\r\n
\r\n
```

A "speaking RTSP" response is any line beginning with `RTSP/`, with a
matching `CSeq:` echoed back. Status codes 200, 401 (auth required), 404
(path wrong but server alive), and 405 (method not allowed but server
alive) all prove liveness. Status codes 5xx are ambiguous — we report UP
because a 5xx still came from an RTSP-speaking process, with a warning
message indicating server-side error.

### Minimal RTMP handshake

Send 1 byte (`0x03` for plain RTMP) followed by 1536 bytes (4-byte time +
4-byte zeros + 1528-byte random). Read 1537 bytes back; the first byte
should be `0x03`. That is the entire Basic-mode test for RTMP — no AMF, no
publish/play simulation. C2 is *not* sent; the connection is closed
immediately after S0+S1 are received.

`[HIGH]` confidence per the Adobe RTMP specification (Annex A) and
ossrs.net handshake reference.

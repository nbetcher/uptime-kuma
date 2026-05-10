# 01 — Vision and Scope

## Why this exists

Uptime Kuma today can probe network ports (TCP, UDP), application protocols
(HTTP, MQTT, gRPC, SMTP, SNMP, etc.), and accept passive heartbeats (Push). It
cannot, today, tell you whether an IP camera is actually delivering video.

That gap manifests in two ways for camera operators:

1. **Port-open ≠ stream-live.** The camera's RTSP server is reachable on TCP
   554, but the encoder has crashed and no frames are being delivered. A
   port-level monitor reports UP; the operator only finds out when they open
   their NVR or doorbell app.
2. **Stream-live ≠ scene-correct.** Frames are arriving — but the lens has
   been bumped, the camera has been redirected, the sensor is stuck on a
   black or frozen image, or the IR illuminator has died. A frame-level
   monitor reports UP; the operator only finds out when they need the
   footage.

This monitor closes both gaps with a tiered design (Basic → Enhanced → Full),
letting the operator choose the verification depth appropriate to each
camera's importance and to their resource budget.

## In scope

- A new monitor type covering RTSP and RTMP video streams.
- Three depth modes (Basic, Enhanced, Full) selectable per monitor.
- Transport coverage for the protocol variants that actually exist in the
  wild — see **[02-protocol-coverage.md](./02-protocol-coverage.md)** for the
  precise matrix and the variants I am pushing back on.
- TLS support for RTSP (RTSPS, port 322) and RTMP (RTMPS) with a per-monitor
  toggle to disable certificate validation, for self-signed deployments.
- Image-similarity verification (Full mode) tolerant of camera, compression,
  and infrared/night-vision artefacts.
- Day/Night reference-image support with automatic best-match selection.
- Full UI/UX parity with existing Uptime Kuma monitor types.
- A test plan that mocks the network and does not rely on a real camera.

## Out of scope

These are deliberately excluded. Each is justified in the document linked.

- **Recording or replay** of camera feeds. We sample for verification only.
- **Multi-track audio analysis.** Video frame is the only signal we examine.
- **HLS, DASH, MPEG-TS-over-HTTP, WebRTC, ONVIF, MJPEG-over-HTTP.** Possible
  follow-up monitor types; not part of this work. See
  **[02-protocol-coverage.md](./02-protocol-coverage.md#out-of-scope)**.
- **RTSP-over-DTLS.** The original brief asked for this to be planned; I am
  pushing back because it is not a standardised or vendor-deployed
  combination. See **[08-open-questions.md](./08-open-questions.md)** §1.
- **RTMP-over-UDP.** Does not exist. The UDP cousin is RTMFP — a different
  protocol family, used almost exclusively by Adobe Flash legacy systems.
  See **[08-open-questions.md](./08-open-questions.md)** §2.
- **Per-frame motion detection, object detection, OCR, classifier ML.**
  These are camera-NVR features, not uptime-monitor features.

## Project posture: fork-only vs. upstream-bound

This work is being authored on the `nbetcher/uptime-kuma` fork on a branch
named `claude/rtsp-requirements-docs-8L95n`. Two distinct postures are
possible, and the design accommodates both:

- **Fork-only:** the work ships in this fork and is consumed by its owner.
  No upstream concerns apply. Nothing here changes.
- **Upstream-bound:** at some future date, a subset (likely Basic mode
  alone, per `@CommanderStorm`'s repeated guidance — see
  **[06-prior-art-review.md](./06-prior-art-review.md)**) is offered to
  `louislam/uptime-kuma`. In that case, additional constraints from
  `AGENTS.md` and `CONTRIBUTING.md` apply. The design is structured so
  Basic mode is independently extractable.

Recommendation: design and document for fork-only delivery, but keep Basic
mode's surface area small enough that it can be extracted into a clean,
single-purpose upstream PR if you choose. **PROPOSED**.

## AGENTS.md implications

The upstream `AGENTS.md` policy is unambiguous: code agents may not produce
work beyond ~10 lines of code without the human author's full understanding,
manual testing, and authoring of the PR description. This applies to
upstream submissions. For this fork's own use it is advisory but still
worth honouring:

- Documentation is permitted (this work).
- Implementation work that follows must be authored, reviewed, and tested by
  the human; AI can assist but not author.
- Any upstream PR description must be written by the human, not generated.

This is not a blocker for the planning phase. It is, however, a constraint
on any future implementation phase, and the requirements in
**[04-requirements.md](./04-requirements.md)** include process gates that
keep us inside the policy.

## Glossary

| Term | Definition |
|------|------------|
| **RTSP** | Real-Time Streaming Protocol (RFC 2326, RFC 7826). Text-based control protocol for media streams; default TCP port 554. |
| **RTSPS** | RTSP over TLS. Default TCP port 322. Encrypts the *control* channel only. |
| **RTP** | Real-time Transport Protocol. Carries the actual media packets. Negotiated by RTSP `SETUP`; runs over UDP or TCP-interleaved. |
| **RTCP** | RTP Control Protocol. Statistics/feedback alongside RTP. |
| **SRTP / DTLS-SRTP** | Encrypted RTP. Keying via DTLS appears in WebRTC, **not** in RTSP. |
| **RTMP** | Real-Time Messaging Protocol. TCP-only; default port 1935. |
| **RTMPS** | RTMP over TLS. No standardised port; commonly TCP 443 (live ingest) or 4935 (self-hosted). |
| **RTMFP** | Real-Time Media Flow Protocol (RFC 7016). Adobe's UDP-based cousin of RTMP. **Not the same as "RTMP over UDP."** |
| **OPTIONS** | RTSP request that asks "what methods do you support?" — the cheapest probe of liveness. |
| **DESCRIBE** | RTSP request that returns an SDP describing media tracks. |
| **SETUP / PLAY / TEARDOWN** | Subsequent RTSP requests that establish, start, and end media transport. |
| **Basic mode** | Verifies the server is reachable and speaks RTSP/RTMP. No media decoded. |
| **Enhanced mode** | Verifies that real video frames are flowing. Extracts and inspects N frames. |
| **Full mode** | Skips Enhanced's heuristics and instead matches a captured frame against user-supplied reference images. |
| **Reference image** | A user-supplied still that defines "the scene the camera should be looking at." Day-time and Night-time variants supported. |
| **Fingerprint** | A small, opaque blob (typically 64–128 bits) summarising an image's perceptual content. Distance between fingerprints estimates similarity. |
| **dHash / pHash** | Two perceptual-hashing techniques. dHash compares neighbour-pixel gradients; pHash uses the DCT. Both produce a small bit-string usable for similarity comparison. |
| **Hamming distance** | Number of bit positions that differ between two equal-length bit-strings. The natural distance metric for perceptual hashes. |

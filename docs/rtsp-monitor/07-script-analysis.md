# 07 — Critical Analysis of `check_rtsp_stream_up.sh`

The script the user shared. Reviewed for appropriateness, issues, and
potential improvements — *not* to be ported as-is. Each finding is keyed
to a line and given a severity (HIGH / MEDIUM / LOW). Each is mapped to
the requirement that supersedes it in the new design.

## 1. The script under review

```bash
#!/usr/bin/env bash
set -xo pipefail

declare -r SCRIPT_PWD="/volume1/scripts"
declare -ra RTSP_URLS=("rtsp://192.168.2.94:8554/front-doorbell-cam"
                       "rtsp://192.168.2.94:8554/backyard-far-corner")
declare -ra UTKUMA_URLS=("http://192.168.2.94/api/push/RktTd5dMfv"
                         "http://192.168.2.94/api/push/fua4NfLfUY")
declare -ra CURL_RETRY_OPTS=("--max-time" "10" "--connect-timeout" "10"
                             "--retry" "3" "--retry-delay" "15"
                             "--retry-max-time" "30" "--retry-connrefused")
declare -ra CURL_MAIN_OPTS=("-H" "Host: utkuma.nickbetcher.com")
declare -ra FFMPEG_MAIN_OPTS=("-hide_banner" "-loglevel" "error"
                              "-rtsp_transport" "tcp")
declare -ra FFMPEG_STREAM_OPTS=("-timeout" "10100" "-rw_timeout" "10000"
                                "-fflags" "1+flush_packets+nobuffer"
                                "-flush_packets" "1" "-rtbufsize" "1"
                                "-max_delay" "0" "-vframes" "5"
                                "-f" "image2" "-y"
                                "tmp_rtsp_vframes/%d.jpg")

cd "$SCRIPT_PWD" && mkdir tmp_rtsp_vframes

for ((i=0; i < ${#RTSP_URLS[@]}; i++)); do
    if ffmpeg6 "${FFMPEG_MAIN_OPTS[@]}" -i "${RTSP_URLS[$i]}" "${FFMPEG_STREAM_OPTS[@]}" \
       && [[ -f tmp_rtsp_vframes/1.jpg ]] && [[ -f tmp_rtsp_vframes/2.jpg ]] \
       && [[ -f tmp_rtsp_vframes/3.jpg ]] && [[ -f tmp_rtsp_vframes/4.jpg ]] \
       && [[ -f tmp_rtsp_vframes/5.jpg ]] \
       && [[ $(stat -c %s "tmp_rtsp_vframes/5.jpg") -gt 85000 ]]; then
        curl ... "?status=up&msg=..."
    else
        curl ... "?status=down&msg=..."
    fi
    rm -f tmp_rtsp_vframes/*
done
```

## 2. Findings

### F-01 — `-timeout 10100` is wrong by **two** mechanisms `[HIGH]`
- **Where:** in `FFMPEG_STREAM_OPTS`, *after* `-i`. Becomes an output
  option, where it is silently meaningless for RTSP.
- **Compounding error:** the value is `10100` *microseconds* (≈ 10.1 ms),
  not 10 seconds. Even if placed correctly (before `-i`), it would be
  effectively zero.
- **Modern FFmpeg (5.0+):** `-timeout` is the input-side socket timeout
  for RTSP. **Old FFmpeg (≤ 4.x):** the equivalent was `-stimeout` and
  `-timeout` meant something else. Detection of the FFmpeg version is
  therefore necessary if both ranges are supported.
- **Superseded by:** OP-002 (decode-stack precedence) and the wrapper
  in **[03-monitoring-modes.md](./03-monitoring-modes.md)** §6, plus
  NFR-002 (wall-clock budget enforced at the Node layer regardless of
  what FFmpeg's own option does).

### F-02 — `-rw_timeout 10000` is wrong by the same two mechanisms `[HIGH]`
- Placed after `-i` (output option, no effect).
- Value is 10 ms in microseconds, not 10 seconds.
- Even when correctly placed, `-rw_timeout` is honoured inconsistently
  by RTSP code paths in FFmpeg.
- **Superseded by:** the same wall-clock backstop as F-01.

### F-03 — `-rtbufsize 1` is below FFmpeg's silent minimum `[MEDIUM]`
- The `-rtbufsize` option's docs specify bytes; FFmpeg silently clamps
  values below ~32 to a default. So `1` is meaningless. The user
  presumably wanted "tiny buffer; flush as soon as a frame arrives,"
  which is already what `-fflags +nobuffer` accomplishes.
- **Superseded by:** removing `-rtbufsize` entirely from the new design.

### F-04 — `-fflags 1+flush_packets+nobuffer` uses an undocumented integer prefix `[MEDIUM]`
- The literal `1` is the numeric value of the `discardcorrupt` flag in
  some FFmpeg versions. It works because of how the option parser
  ORs values, but it is version-fragile.
- **Superseded by:** writing `+discardcorrupt+nobuffer` explicitly in
  the new design.

### F-05 — `-flush_packets 1` is a no-op for image2 muxer `[LOW]`
- `-flush_packets` controls the muxer's flush behaviour. The `image2`
  muxer writes one file per frame as the frame arrives; flush per
  packet is implicit. This option does no harm but adds noise.
- **Superseded by:** removing it.

### F-06 — `-max_delay 0` means "no max delay tolerance" `[LOW]`
- This is a packet-reordering tolerance. Setting it to 0 means any
  out-of-order RTP packet causes the demuxer to give up. On a healthy
  TCP-interleaved stream this is fine; on UDP-RTP it is fragile.
- **Superseded by:** dropping the explicit value (FFmpeg's default is
  500 ms, sane).

### F-07 — `mkdir tmp_rtsp_vframes` (no `-p`) fails on second run `[MEDIUM]`
- If the directory already exists, `mkdir` exits non-zero. Combined
  with `set -o pipefail` (but **without** `set -e`), the script
  silently continues, and the loop runs against a stale temp dir from
  the previous invocation.
- **Superseded by:** OP-004 (no temp directory at all) — frames are
  in-memory in the new design.

### F-08 — Concurrent invocations race on a fixed temp path `[HIGH]`
- The fixed `tmp_rtsp_vframes` directory means two invocations of the
  script overwrite each other's frames mid-flight. cron at 1 minute
  with a 90-second-runtime check guarantees this race.
- **Superseded by:** OP-004 (no temp directory) and NFR-014 (per-monitor
  mutex).

### F-09 — The 85,000-byte threshold is fragile `[HIGH]`
- JPEG file size depends on resolution, JPEG quality, and scene
  complexity. A 1080p stream at low complexity easily falls under
  85 KB; a 720p stream in a busy scene may exceed it. Both reports
  would be wrong. The original script picked the threshold by
  calibration on one camera; it does not generalise.
- **Superseded by:** FR-013's structural validation (JPEG magic bytes,
  dimension sanity) and FR-014's black/uniform check, neither of
  which depends on file size.

### F-10 — Frozen-frame failure mode invisible `[HIGH]`
- The script only checks `5.jpg`'s file size. If the camera repeatedly
  emits the same identical JPEG (frozen encoder, common in cheap
  cameras after a network blip), all five files will be identical
  bytes and the test passes. This is exactly `@PoleTransformer`'s
  reported failure on issue #2851.
- **Superseded by:** FR-013's "frozen-frame detection" — Enhanced mode
  computes a fast hash per frame and requires at least one
  byte-different pair.

### F-11 — `set -xo pipefail` without `set -e` silently swallows errors `[MEDIUM]`
- `set -x` enables tracing. `set -o pipefail` propagates pipe failures.
  Neither aborts on a failed simple command. The author probably wanted
  fail-fast; `set -euo pipefail` is the canonical incantation.
- **Superseded by:** moot — the new design is in Node, not bash.

### F-12 — Race between FFmpeg's exit and `stat -c %s` `[MEDIUM]`
- The script uses `&&` to chain ffmpeg's exit with the file size check.
  This is correct *if* ffmpeg has flushed and closed `5.jpg` by the
  time it returns 0. The `image2` muxer does close per-frame, so this
  is usually fine — but on slow filesystems or under heavy I/O load,
  the check can read a file partway through close. A conservative
  variant adds `sync` or reads from `cat` to force a barrier.
- **Superseded by:** OP-004 (no files at all).

### F-13 — Unquoted array reference (none in this script, but a near-miss) `[LOW]`
- All array expansions use the correct `"${ARR[@]}"` form. The URL
  expansion `"${RTSP_URLS[$i]}"` is also quoted. Good. (Mentioned only
  to confirm I checked.)

### F-14 — Push-monitor URL leaks the host header trick `[LOW]`
- `Host: utkuma.nickbetcher.com` overrides the request's `Host:` so a
  reverse proxy can route correctly even when the target is a private
  IP. This works but is a correctness coupling between the monitoring
  script and the reverse proxy. With the new active-pull design, this
  coupling vanishes — the monitor IS Uptime Kuma, no push, no proxy
  routing concern.
- **Superseded by:** the active-monitor design itself.

### F-15 — One-shot per script run, no per-camera retry `[MEDIUM]`
- The script runs each camera once per cron tick. A transient network
  blip turns into a DOWN. Uptime Kuma's `maxretries` per monitor
  handles this elegantly when the check is native.
- **Superseded by:** Uptime Kuma's existing retry mechanism, which the
  new monitor inherits via the shared `MonitorType` lifecycle.

## 3. What the script *did* get right

In fairness:

- It uses `-rtsp_transport tcp`, which is the right default for cameras
  behind firewalls. The new design carries this forward as the default
  but exposes a per-monitor override (TCP-interleaved vs UDP-RTP).
- It uses `-loglevel error` and `-hide_banner` for clean output.
- It uses `-vframes 5` to bound work, an idea the new design preserves
  (Enhanced default).
- It separates per-camera logic into a loop with parallel arrays,
  conceptually scaling to N cameras — exactly what the monitor table
  formalises.
- It uses `--retry-connrefused` on the curl post-back, which is
  defensive and correct.

## 4. How findings inform the new design

The script informed the new design's *intent* — the FFmpeg flags
themselves were starting points, not literal references. The takeaways
that influenced the requirements:

| Script finding | Influenced requirement |
|---|---|
| F-09: 85,000-byte threshold is fragile | FR-013 (structural validation: JPEG magic, dimension sanity) |
| F-10: Frozen-frame failure invisible | FR-013 (frozen-frame detection via per-frame hash) |
| F-08: Concurrent-invocation race on temp dir | OP-004 (no temp directory) + NFR-014 (per-monitor mutex) |
| F-01/F-02: Timeout flags incorrectly placed and microsecond-vs-second confusion | NFR-002 (Node-side wall-clock budget, not relying on FFmpeg's own option) |
| F-03/F-04: Magic-number flag values | Documented preference for named flag values where applicable |

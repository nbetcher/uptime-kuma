# RTSP monitor test fixtures

Tiny H.264 clips (160×120, 10 fps, 2 s, GOP 5) used by the RTSP backend
tests to exercise the real decode path without a camera. Regenerate with:

```sh
ffmpeg -f lavfi -i testsrc=size=160x120:rate=10 -t 2 -c:v libx264 -pix_fmt yuv420p -g 5 -preset veryfast -movflags +faststart moving.mp4
ffmpeg -f lavfi -i color=c=0x808080:size=160x120:rate=10 -t 2 -c:v libx264 -pix_fmt yuv420p -g 5 -preset veryfast frozen.mp4
ffmpeg -f lavfi -i color=c=black:size=160x120:rate=10 -vf "noise=alls=3:allf=t" -t 2 -c:v libx264 -pix_fmt yuv420p -g 5 -preset veryfast dark.mp4
```

- `moving.mp4` — every frame differs; Enhanced mode is UP.
- `frozen.mp4` — every frame identical; Enhanced mode reports a frozen stream.
- `dark.mp4` — frames differ but are near-black; Enhanced mode reports a black stream.

# SIGFM (third-party, LGPL-2.1+)

These files are **not** ours. They are the SIGFM matcher ("SIFT Is Good For Matching") from
`https://github.com/goodix-fp-linux-dev/sigfm`, vendored at the revision used by the
`goodix-fp-linux-dev/libfprint` `sigfm` branch (commit `07306bbc9256942595e31fb0f407b364ffa24d07`).

License: LGPL-2.1+ (compatible with libfprint). Reviewed before use: no network, process,
exec or file I/O; only OpenCV `SIFT` + `BFMatcher`. Build dependency: `libopencv-dev` (>= 4.5).

`patches/04-sigfm-matcher-port.diff` contains **our** integration changes only
(libfprint core + elanspi), not these files.

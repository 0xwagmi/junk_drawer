# Fingerprint (ELAN7001 / elanspi) — diagnosis notes

Hardware: ASUS VivoBook X509JA — Elan `ELAN7001` on SPI (`/dev/spidev0.0`), touchpad `04F3:3087`
Driver: libfprint `elanspi` (scan type "swipe", 8 stages)
OS: Ubuntu 24.04 → 26.04 (libfprint 1.94.7 → 1.95.1+tod1), kernel 6.8 → 7.0

## What was fixed

`libpam-fprintd` was installed but its PAM profile was never enabled — no `pam_fprintd.so`
in `/etc/pam.d/common-auth`, so fingerprint login could never work.

Fixed with: `sudo pam-auth-update --enable fprintd`
Resulting stack (correct jump counts):

    auth [success=3 default=ignore] pam_fprintd.so max-tries=1 timeout=10
    auth [success=2 default=ignore] pam_unix.so nullok try_first_pass
    auth [success=1 default=ignore] pam_sss.so use_first_pass
    auth requisite pam_deny.so
    auth required  pam_permit.so

Backup of the original file: `/etc/pam.d/common-auth.bak-fprint-fix`

## Remaining problem (not a config issue)

Enrollment completes (7 stages + enroll-completed), but verification **never** matches:
`pam_fprintd` prints "Failed to match fingerprint" and falls back to the password.

Measured with a debug build of libfprint (same version as the distro package):

1. Sensor + driver are healthy:
   - init OK: `<init/otp> got vcm mode = 2`, sensor detected as `eFSA96SA` (96x96)
   - frames are 96x43 strips → genuine swipe sensor, stitching is the correct model
   - driver correctly reports good frames: `<guess> stddev=~2.0e6, ip=0, is_fp=2`

2. **Minutiae extraction produces far too few, unstable minutiae:**
   - 3–20 minutiae per capture (a usable 500 dpi print yields 30–60+)

3. **bozorth3 match scores are below the driver's threshold of 24:**
   - live verify: `score 0/24` for every enrolled sub-template
   - offline re-computation on the dumped images: cross-scores ≤17, mostly 0
     (matrix in `evidence/`, generated with the same NBIS code as libfprint)

4. Investigated and ruled out:
   - colour inversion (`FPI_IMAGE_COLORS_INVERTED`) — same result
   - scale: raw 144px native vs 1.3/1.5/1.7/2.0/2.5x upscale — cross-scores stay ≤17
   - `remove_perimeter_pts` (FPI_IMAGE_PARTIAL) — self-scores rise (82/148), cross-scores stay 0–15
   - ppmm 9.84–39.37 — no change in minutiae count
   - ridge period inside a single capture varies 20–32 px and is often not detectable →
     stitching gains/exposure differ per frame (visible banding), so ridge geometry is
     not consistent between captures

Conclusion: with this sensor the driver delivers images whose minutiae are not reproducible
between two swipes, so a stored template can never be matched. This is a driver/quality
limitation, not a PAM, polkit, permission or packaging problem.

Side note: the driver polls frames continuously while waiting for a finger, so libfprint's
thermal guard (`DEFAULT_TEMP_HOT_SECONDS = 180 s`) aborts enrollment with
"Device disabled to prevent overheating" if a full enrollment is not finished in ~3 minutes.

## Evidence

`evidence/` contains raw captures dumped from the driver (`cap-*` = submitted stitched image,
`raw-*` = pre-upscale, `frame-*` = single 96x43 sensor frames).

## FIXED (verified working)

Verification now succeeds and fingerprint unlock works:

    before: minutiae 3-22 per capture, bozorth3 score 0/24  -> verify-never-match
    after : minutiae ~40-70,          bozorth3 score 32/24  -> verify-match, unlock OK

What is installed:

* `/usr/local/lib/fprint-elanfix/libfprint-2.so.2.0.0` - patched libfprint (libfprint snapshot
  `v1.94.100-10-g6f9479c`, i.e. the code base of Ubuntu's `1:1.95.1+tod1`).
* `/etc/systemd/system/fprintd.service.d/zz-elanfix.conf` - makes fprintd load that library and
  enables the ridge enhancement (`FP_ENHANCE_RIDGES=1 FP_ENHANCE_ORIENT=8`).
* PAM profile `fprintd` enabled (`pam-auth-update --enable fprintd`).

The fix itself: a Gabor filter bank (lambda 11.5 px, 8 orientations) applied to the driver image
**in the minutiae-detection worker thread** before NBIS minutiae extraction. Plus: SPI line-read
timeout 100 ms -> 400 ms and enrollment stages 7 -> 10 (more gallery templates).
Details and patches: `patches/README.md`, rebuild/install: `scripts/build-and-install.sh`.

Revert to stock:

    rm /etc/systemd/system/fprintd.service.d/zz-elanfix.conf
    rm -rf /usr/local/lib/fprint-elanfix
    systemctl daemon-reload && systemctl restart fprintd

Maintenance note: this is a locally built library, so it does not get replaced by package
upgrades - but a future fprintd/libfprint ABI bump may require rebuilding with
`scripts/build-and-install.sh`. If the patched library ever fails to load, fingerprint auth
simply falls back to the password.

## Files in this folder

    FINDINGS.md                     this report
    evidence/README.md              description of every capture folder
    evidence/run1-press/            images from the pressed-finger run (cap-0009 = verify capture)
    evidence/run2-swipe/            images from the swiped-finger run (raw-* native, cap-* upscaled)
    evidence/frames/                single 96x43 sensor frames + their stitched images
    evidence/downscale-tests/       offline resampling experiments
    evidence/scaled-sweep/          offline 1.3x-2.5x upscale sweep of native images
    evidence/binarized/bin1.png     NBIS binarization of a capture (ridges are clean!)
    evidence/png/                   every .pgm above converted to viewable .png
    analysis/README.md              what each tool does + rebuild instructions
    analysis/tools/*.c, *.py        test_min, test_match, bin_dump, convert_pgm_to_png (+ binaries)
    analysis/outputs/*.txt          minutiae counts, bozorth3 score matrices, ridge periods
    patches/debug-instrumentation.diff   the libfprint debug/dump patch (diagnostic only)
    patches/README.md               how the patch was built and run
    logs/sysinfo.txt                OS, package versions, SPI device, PAM stack
    logs/fprintd-driver-trace.log.gz     full filtered driver trace (26k lines)
    logs/excerpt-key-events.log     readable excerpt: init, minutiae counts, scores, verify results
    logs/kernel-and-session-grep.log.gz  kernel/session lines mentioning elanspi/fprint/spidev

All debug artefacts (custom libfprint, systemd drop-in, test prints, dump dir) have been
removed - the machine is back on the stock library with no enrolled fingers.

## Options

- Try a slower/steadier vertical swipe, same finger area, sensor cleaned — then re-enroll and
  test with `sudo -k; sudo true`.
- Disable fingerprint login again (keeps the password prompt fast, no failed attempt first):
  `sudo pam-auth-update --disable fprintd`
- Report upstream: https://gitlab.freedesktop.org/libfprint/libfprint/-/issues
  (attach `evidence/`, the score matrix and the minutiae counts above)

---

# UPDATE - the enhancement fix does NOT discriminate (measured)

Live measurement with the enhanced build (10 enrolled subprints, threshold 24), reading the
daemon's `score N/24` per attempt:

| attempt | finger | max score | result |
|---|---|---|---|
| 1 | right index (genuine) | 12 | no-match |
| 2 | right index (genuine) | 25 | match |
| 3 | right index (genuine) | **4** | no-match |
| 4 | middle (impostor) | 19 | no-match |
| 5 | middle (impostor) | **24** | **match - FALSE ACCEPT** |
| 6 | middle (impostor) | 11 | no-match |

Genuine (4, 12, 25) and impostor (11, 19, 24) overlap completely. The Gabor ridge enhancement
raises the minutiae count (3-22 -> 40-70) but emphasizes generic ridge flow, so NBIS templates
stop being finger-specific. **Conclusion: the enhancement must not be used as-is; it trades
security for a higher "matches sometimes" rate.** The earlier single 32/24 verify-match was a
lucky genuine sample, and the offline cross-score gains were equally high for the wrong reason.

Therefore the correct state for this machine is fingerprint auth **disabled**:

    sudo pam-auth-update --disable fprintd
    sudo rm -rf /usr/local/lib/fprint-elanfix /etc/systemd/system/fprintd.service.d/zz-elanfix.conf
    sudo systemctl daemon-reload && sudo systemctl restart fprintd

# Reverse engineering outcome (Windows driver)

Extracted the real vendor package (Microsoft Update Catalog CAB, ELAN WBF 3.5.12033.10040) and
analysed it with Ghidra 12.2 headless. Details and artifacts: `win-driver/RE-FINDINGS.md`,
`win-driver/ghidra/`.

* Vendor pipeline = hard per-capture gates (area / finger position / dirt / image stability) plus a
  **proprietary matcher** (`FingerSA` + RANSAC, Crypto++ encrypted templates). The matcher is not
  portable; NBIS stays.
* The SPI wire protocol is the **same** as `elanspi` (`reg | 0x40` write, `reg | 0x80` read).
* The one unported capability is asking the **firmware** for a processed image + its `ImageQuality`
  byte (`GetImgFromFW`, `p381_record->ImageQuality`) instead of stitching raw 96x43 strips.
* Getting there is blocked in practice: `WbfUsbDriver.dll` is a release build with all logging
  strings stripped of code references, it has no WBDI IOCTL immediates (UMDF callback interface),
  and the only OR-mask anchor for the SPI framing lands in CryptoPP bignum code. Continuing would
  need anchor-less function-by-function work or dynamic tracing on Windows.

# Next steps if this is picked up again

1. Fix the capture, not the matcher: dump **all** raw 96x43 frames per swipe and build a better
   stitcher offline (phase correlation between frames, per-frame gain normalisation) - the current
   `fpi_do_movement_estimation` + `fpi_assemble_frames` path is where ridge geometry gets distorted
   (measured ridge period varies 18-33 px inside one capture).
2. Evaluate with the tools in `analysis/` (`eval` prints minutiae per capture and a bozorth3 score
   matrix, with `--probes N` to model verify-vs-enrolled).
3. Only accept a configuration where genuine and impostor score ranges are separated with margin -
   that is the bar, not "sometimes matches".

---

# SOLVED - SIGFM matcher ported (verified: 3/3 genuine, 0/3 impostor)

NBIS/bozorth3 cannot discriminate fingers on these narrow swipe strips (that is the whole story
above). The community rebuild of libfprint for small sensors replaces the matcher with **SIGFM**
(SIFT-based, LGPL-2.1+, `https://github.com/goodix-fp-linux-dev/sigfm`). I ported SIGFM into our
libfprint tree instead of using their binaries.

## Measured on this machine (ELAN7001 / eFSA96SA, threshold 100)

    right index (genuine):  verify-match, verify-match, verify-match   max sigfm score 1895 / 24479
    middle finger (impostor): verify-no-match x3                       max sigfm score 32

=> ~30x margin between the impostor ceiling (32) and the genuine floor (~1895) at threshold 100.

## Port summary (`patches/04-sigfm-matcher-port.diff`, 537 lines)

* `fpi-print.{c,h}`: `FPI_PRINT_SIGFM` type, `fpi_print_sigfm_match()`, SIGFM branch in
  `fpi_print_add_from_image()`, per-type copy/free of stored templates
* `fp-image.{c,h}`: `fp_image_extract_sigfm_info()` worker + `fp_image_get_sigfm_info()`
* `fpi-image-device.{c,h}` + `fp-image-device{,-private}.h`: `FpiImageDeviceAlgorithm` class field
  (`cls->algorithm`), dispatch to SIGFM extraction/matching, and the plain-boolean task completion
  the SIGFM worker needs
* **`fp-image-device.c`: the enroll print type was hard-coded to `FPI_PRINT_NBIS`** - this is why the
  first attempts stored an empty 52-byte print and verify said "sigfm match requires sigfm print
  data". It now follows `priv->algorithm`.
* `fp-print.c`: GVariant serialisation/deserialisation for SIGFM templates (`(a(ay))` of
  `sigfm_serialize_binary()` blobs)
* `meson.build`: `subdir('sigfm')`, OpenCV dep, C++ link args
* `drivers/elanspi.c`: `img_class->algorithm = FPI_DEVICE_ALGO_SIGFM`, threshold 100
  (env override `ELANSPI_BZ3_THRESHOLD` still works)

SIGFM sources are vendored in `sigfm-upstream/` (LGPL-2.1+, see its README).

## Installed state (working)

    /usr/local/lib/fprint-sigfm/libfprint-2.so.2.0.0      patched libfprint (SIGFM)
    /etc/systemd/system/fprintd.service.d/zz-sigfm.conf   loads it for fprintd
    PAM profile "fprintd" enabled (password fallback intact)

Revert:

    rm /etc/systemd/system/fprintd.service.d/zz-sigfm.conf
    rm -rf /usr/local/lib/fprint-sigfm
    systemctl daemon-reload && systemctl restart fprintd

Maintenance: a future libfprint/fprintd ABI bump may need a rebuild; if the patched library fails to
load, fingerprint auth falls back to the password.

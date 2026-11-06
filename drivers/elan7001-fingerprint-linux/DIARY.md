# Diary - Elan ELAN7001 fingerprint on ASUS VivoBook X509JA (Linux)

One long debugging session, written up in order, including the wrong turns.
Machine: ASUS VivoBook X509JA, Ubuntu 24.04 -> 26.04, sensor `ELAN7001` on SPI
(`/dev/spidev0.0`, ACPI `ELAN7001`), touchpad `04F3:3087`, sensor chip `eFSA96SA` (96x96, swipe
strips of 96x43). It worked fine in Windows; on Linux it did nothing.

---

## Phase 1 - "the driver is broken" was wrong

Facts found:

* `fprintd`, `libfprint-2-2`, `libpam-fprintd` all installed, `fprintd-list` saw the device
  ("ElanTech Embedded Fingerprint Sensor", driver `elanspi`, scan type `swipe`).
* The sensor is **not** on USB - it is SPI, bound to `spidev`, and udev does that correctly.
* `/etc/pam.d/common-auth` had **no `pam_fprintd.so` line** - the PAM profile had never been
  enabled, so fingerprint auth could never work no matter what the driver did.

Fix: `pam-auth-update --enable fprintd` (backup left at `/etc/pam.d/common-auth.bak-fprint-fix`).
That was real, but it only moved the failure one step later: now the prompt appeared and then
always said "Failed to match fingerprint".

Lesson: a driver that reports a device is not a driver that works, and PAM is a separate switch.

---

## Phase 2 - enrollment fights back

`fprintd-enroll` kept ending in `enroll-unknown-error`. The daemon log said:

    Device reported an error during enroll: Device disabled to prevent overheating.

`elanspi` polls frames continuously while waiting for a finger, and libfprint's thermal model
(`DEFAULT_TEMP_HOT_SECONDS = 180 s`) treats that as activity, so a slow enrollment aborts after
~3 minutes. Enrollment also needed firm, prompt presses: the driver's own `<guess>` log shows
`stddev` ~2e6 and `ip=0` for a real finger vs ~5e3-15e3 with `ip=40-70` for an empty sensor.

With correct pressing, enrollment completed. Verification still never matched.

---

## Phase 3 - instrument everything, measure instead of guess

Built libfprint from source (snapshot `v1.94.100-10-g6f9479c` = Ubuntu's 1.95.1 code base) with:

* image dumps in `elanspi` (`ELANSPI_DUMP_DIR`): submitted image, pre-upscale image, single frames
* minutiae counts and every bozorth3 score in `fpi-print.c`

Then ran libfprint's own NBIS code offline on the dumps (`analysis/tools/test_min`, `test_match`).

Result - the actual bug, in numbers:

    minutiae per capture (same finger, 9 captures):  13 12 15 16 11 11 11 12 10
    bozorth3 scores between captures of the same finger: mostly 0, max 17   (threshold 24)
    live verify: "score 0/24" for all sub-templates

A usable 500 dpi print gives 30-60+ minutiae. These images give 3-22.

Ruled out, with measurements: colour inversion, image scale (native 144 px and 1.3x-2.5x
upscales), `ppmm` 9.8-39.4, `remove_perimeter_pts`/`FPI_IMAGE_PARTIAL` (self-scores rise to
82/148, cross-scores stay 0-15).

Ridge period inside one capture, measured by autocorrelation: 18-33 px and often undetectable at
all -> per-frame gain/offset inconsistency in `fpi_do_movement_estimation`/`fpi_assemble_frames`.

Lesson: dump what the driver submits, then measure with the *same* matcher code the daemon uses.

---

## Phase 4 - the wrong fix (and why it was dangerous)

Idea: add a Gabor filter bank (lambda 11.5 px, 8 orientations) in the minutiae worker thread to
boost ridge contrast. It worked "great": minutiae 3-22 -> 40-70, and a verify attempt returned
`verify-match` with score 32/24.

Then the real test - is it *discriminating*?

    index finger (genuine): 12, 25, 4
    middle finger (impostor): 19, 24 (=match!), 11

Complete overlap. The enhancement emphasises generic ridge flow, so NBIS templates stop being
finger-specific: it turned the sensor into a false-accept machine. Rejected, documented, and the
recommendation became "disable fingerprint until it actually discriminates".

Lesson: "it matched" is not success. Only genuine-vs-impostor separation is.

---

## Phase 5 - reverse engineering the Windows driver (educational, not the fix)

The vendor installer (`Fingerprint_WBF_SPI_DCH_ELAN_Z_V4.5...exe`) is an **Inno Setup 6.1.0**
package with `zlb` compressed payload - 7z cannot open it, Ubuntu's `innoextract` 1.9 stops at
Inno 6.0.5. Instead the identical package was pulled from the **Microsoft Update Catalog**
(`ELAN Finger Print Biometric Driver Update 3.5.12033.10040`) as a plain CAB and extracted:
`WbfUsbDriver.dll` (UMDF WBDI driver), `SensorAdapter`/`EngineAdapter`/`StorageAdapter`, `VBS*`
variants, `.inf`, `.cat`.

Findings:

* The SPI wire protocol is the **same** as `elanspi` (`reg | 0x40` write, `reg | 0x80` read).
* Windows works because it (a) applies **hard per-capture gates** - coverage area, finger position
  (`WINBIO_FP_TOO_LEFT`...), sensor dirt, image stability, plus a firmware `ImageQuality` byte -
  and (b) uses its **own matcher** (`FingerSA` + RANSAC, Crypto++ encrypted templates).
* Ghidra 12.2 headless: all quality/log strings in `WbfUsbDriver.dll` have **zero** code
  references (logging stripped), no `0x000Bxxxx` IOCTL immediates (UMDF callback interface), and
  the only OR-mask anchor for the SPI framing landed in CryptoPP bignum code.

Conclusion: the matcher is not portable; the gating concept is; deep static RE here is a
months-long dead end. Artifacts kept in `win-driver/`.

---

## Phase 6 - the internet already knew

Searching found that this is a known class of problem, not our bug:

* `r4nd3l/elan-3104-fingerprint-linux`, `kavindamihiran/asus-x513-fingerprint-linux`
* their measurements: NBIS genuine/impostor distributions **fully overlap** on these narrow swipe
  strips ("not needs tuning, it cannot discriminate fingers")
* the fix the community uses: **SIGFM** ("SIFT Is Good For Matching"), a SIFT-based matcher for
  low-resolution sensors, LGPL-2.1+, from `goodix-fp-linux-dev`
* same driver tweaks we had independently measured as relevant (drop 2x upscale, drop
  `FPI_IMAGE_PARTIAL`, light Gaussian)

Also confirmed: `spidev.bufsiz` matters for *their* PID (HV capture path, 23 KB transfer) but
**not** for ours - `04F3:3087` uses the 192-byte line path.

Lesson: 10 minutes of searching would have skipped phases 4 and 5.

---

## Phase 7 - port SIGFM ourselves (no third-party binaries)

Reviewed the SIGFM sources first (no network/exec/file I/O; OpenCV SIFT only), then ported the
integration into our own libfprint tree:

* `fpi-print.{c,h}`: `FPI_PRINT_SIGFM`, `fpi_print_sigfm_match()`, SIGFM branch in
  `fpi_print_add_from_image()`, per-type copy/free
* `fp-image.{c,h}`: `fp_image_extract_sigfm_info()` worker + getter
* `fpi-image-device.{c,h}`, `fp-image-device{,-private}.h`: `FpiImageDeviceAlgorithm` class field,
  dispatch for extraction/matching, plain-boolean task completion
* `fp-print.c`: GVariant (de)serialisation of SIGFM templates
* `meson.build`: `subdir('sigfm')`, OpenCV dep, C++ link args
* `elanspi.c`: `algorithm = FPI_DEVICE_ALGO_SIGFM`, threshold 100

Then three integration bugs, each visible only as "verify-unknown-error":

1. `fp_image_detect_minutiae_finish: assertion 'g_task_get_source_tag (...) == ...' failed`
   - the SIGFM worker's task was finished with the NBIS finish function.
2. The enrollment target print was `FPI_PRINT_UNDEFINED` -> `fpi_print_add_print()` bailed out
   silently -> 52-byte empty print file.
3. Even with (2) fixed, `fp-image-device.c` **hard-coded `fpi_print_set_type (enroll_print,
   FPI_PRINT_NBIS)`** - that was the real template killer.

Lesson: when a stored template is suspiciously small, dump it. 52 bytes told us "empty NBIS print"
faster than any amount of guessing.

---

## Phase 8 - verified

    right index (genuine):   verify-match, verify-match, verify-match    sigfm scores 1895 / 24479
    middle finger (impostor): verify-no-match x3                         sigfm score <= 32

Threshold 100 sits ~30x above the impostor ceiling. Installed and enabled:

    /usr/local/lib/fprint-sigfm/libfprint-2.so.2.0.0     patched libfprint (SIGFM)
    /etc/systemd/system/fprintd.service.d/zz-sigfm.conf  loads it for fprintd
    PAM profile "fprintd" enabled (password fallback intact)

---

## Bottom line

The hardware was always fine and the Linux driver was speaking the right protocol. Two things were
missing: PAM was not configured, and the matcher (NBIS/bozorth3) fundamentally cannot tell fingers
apart on this sensor's narrow swipe strips. The working stack is our own libfprint build with the
SIGFM matcher. Everything needed to rebuild or revert it is in this repository.

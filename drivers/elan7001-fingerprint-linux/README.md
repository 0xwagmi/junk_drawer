# Elan ELAN7001 fingerprint on Linux - install kit

Laptop: ASUS VivoBook X509JA - ELAN7001 (eFSA96SA) SPI sensor, touchpad 04F3:3087.
Works on Linux via a locally built libfprint with the **SIGFM** matcher (NBIS/bozorth3 cannot
discriminate fingers on these swipe strips).

Verified on Ubuntu 26.04 (libfprint 1.95.1 / fprintd 1.94.5, OpenCV 4.10, kernel 7.0):
genuine index 3/3 match (scores 1895 / 24479), middle finger 0/3 (<= 32), threshold 100.

## Install / reinstall

    cd /home/user/tool/junk_drawer/drivers/elan7001-fingerprint-linux
    ./scripts/install-fingerprint-sigfm.sh              # needs sudo; uses the bundled sources
    fprintd-enroll -f right-index-finger                # ~10 slow even swipes, within ~2 min

Other modes:

    ./scripts/install-fingerprint-sigfm.sh --check       # verify prerequisites only
    ./scripts/install-fingerprint-sigfm.sh --build-only  # build, no sudo
    ./scripts/install-fingerprint-sigfm.sh --from-git    # rebuild from upstream + patch (network)
    ./scripts/install-fingerprint-sigfm.sh --uninstall   # revert to the distro libfprint

## Contents

| path | what |
|---|---|
| `scripts/install-fingerprint-sigfm.sh` | build + install + fprintd drop-in + PAM enable (and revert) |
| `patches/libfprint-sigfm-working-sources.tar.gz` | exact libfprint source tree that produced the working library |
| `patches/05-PRODUCTION-working-build.diff` | the same changes as a patch on upstream `6f9479c` (used by `--from-git`) |
| `sigfm-upstream/` | vendored SIGFM matcher sources (third-party, LGPL-2.1+) + its meson.build |
| `DIARY.md` | the whole debugging story, including the dead ends |
| `FINDINGS.md` | technical report: measurements, root cause, revert steps |

## What it installs

    /usr/local/lib/fprint-sigfm/libfprint-2.so.2.0.0      patched libfprint (SIGFM)
    /etc/systemd/system/fprintd.service.d/zz-sigfm.conf    fprintd loads it
    PAM profile "fprintd" enabled                          password fallback stays

The distro libfprint package is not modified.

## Notes

* Runtime dependency: OpenCV shared libraries (`libopencv-*`) must stay installed.
* After a libfprint/fprintd upgrade, re-run the installer if fingerprint auth stops working.
* Swipe slowly and evenly; `verify-swipe-too-short` just means "try again".
* Enrollment must finish within ~2 minutes (the driver polls frames and libfprint's thermal guard
  aborts after 180 s of activity).
* If the patched library ever fails to load, auth falls back to your password.

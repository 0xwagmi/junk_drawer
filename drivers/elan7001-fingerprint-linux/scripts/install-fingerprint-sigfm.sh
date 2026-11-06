#!/usr/bin/env bash
# Install (or remove) the ELAN ELAN7001 fingerprint fix for libfprint:
#   libfprint + SIGFM matcher  ->  /usr/local/lib/fprint-sigfm  (+ fprintd drop-in, PAM profile)
#
# Verified on: ASUS VivoBook X509JA, ELAN7001 (eFSA96SA) on SPI, Ubuntu 26.04,
#              fprintd 1.94.5 / libfprint 1.95.1, OpenCV 4.10, kernel 7.0.
#
# Usage:
#   ./install-fingerprint-sigfm.sh              # build from bundled sources and install
#   ./install-fingerprint-sigfm.sh --check      # only verify prerequisites / sources
#   ./install-fingerprint-sigfm.sh --uninstall  # revert to the distro library
#   ./install-fingerprint-sigfm.sh --build-only # build but do not install (no sudo needed)
#   ./install-fingerprint-sigfm.sh --from-git   # ignore the tarball, clone upstream + apply patch
#
# Notes:
#  * Needs root for the install step (sudo). Nothing outside /usr/local, /etc/systemd and PAM
#    is touched; the distro libfprint package is never modified.
#  * The matcher is SIGFM (SIFT, LGPL-2.1+), vendored in sigfm-upstream/. OpenCV runtime is
#    required afterwards.
#  * Re-run this after a libfprint/fprintd ABI bump if fingerprint auth stops working.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=${WORK:-/var/tmp/fprint-sigfm-build}
LIBDIR=/usr/local/lib/fprint-sigfm
DROPIN=/etc/systemd/system/fprintd.service.d/zz-sigfm.conf
SNAPSHOT=6f9479c        # == Ubuntu 1:1.95.1+tod1 code base (upstream v1.94.100-10-g6f9479c)
TARBALL="$HERE/patches/libfprint-sigfm-working-sources.tar.gz"
PATCH="$HERE/patches/05-PRODUCTION-working-build.diff"
MODE=install

for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    --uninstall) MODE=uninstall ;;
    --from-git) MODE=fromgit ;;
    --build-only) MODE=buildonly ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }

need_bin() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; MISSING=1; }; }
MISSING=0

check_deps() {
  say "Checking build prerequisites"
  for b in git meson ninja cc c++ pkg-config tar; do need_bin "$b"; done
  for p in glib-2.0 gio-unix-2.0 gusb gudev-1.0 json-glib-1.0 opencv4; do
    if pkg-config --exists "$p" 2>/dev/null; then ok "pkg-config $p $(pkg-config --modversion "$p")"
    else warn "pkg-config $p missing"; MISSING=1; fi
  done
  if [ "$MISSING" -ne 0 ]; then
    NEED_PRIVATE=1
    warn "some dev headers are missing - the missing ones (gusb/gudev/json-glib) will be fetched"
    warn "privately before the build. If something else is missing, install:"
    warn "  sudo apt install git meson ninja-build build-essential pkg-config \\"
    warn "       libglib2.0-dev libgusb-dev libgudev-1.0-dev libjson-glib-dev \\"
    warn "       libpixman-1-dev libnss3-dev libopencv-dev fprintd libpam-fprintd"
    # opencv/meson/ninja are mandatory and cannot be fetched privately
    for p in opencv4 gio-unix-2.0 glib-2.0; do
      pkg-config --exists "$p" 2>/dev/null || { echo "missing required dependency: $p" >&2; exit 1; }
    done
    for b in meson ninja c++; do command -v "$b" >/dev/null 2>&1 || { echo "missing required tool: $b" >&2; exit 1; }; done
  fi
  ok "prerequisites checked"
}

# If the distro dev headers for gusb/gudev/json-glib are absent we can still build by extracting
# the .deb packages into $WORK/deps (nothing is installed system-wide).
private_deps() {
  say "Fetching build headers privately into ${DEPS:-/var/tmp/fprint-sigfm-deps} (no system install)"
  local pool=http://archive.ubuntu.com/ubuntu/pool
  DEPS=${DEPS:-/var/tmp/fprint-sigfm-deps}
  local d=$DEPS/debs
  mkdir -p "$d" "$DEPS/deps"
  (
    cd "$d"
    for u in \
      $pool/main/libg/libgudev/libgudev-1.0-dev_238-5ubuntu1_amd64.deb \
      $pool/main/libg/libgusb/libgusb-dev_0.4.8-1build2_amd64.deb \
      $pool/main/j/json-glib/libjson-glib-dev_1.8.0-2build2_amd64.deb
    do
      local f=${u##*/}
      [ -f "$f" ] || curl -sSLO "$u" || return 1
      dpkg -x "$f" "$DEPS/deps" || return 1
    done
    # the dev packages ship dangling symlinks; give them their runtime targets
    cp -a /usr/lib/x86_64-linux-gnu/libgusb.so.2* \
          /usr/lib/x86_64-linux-gnu/libjson-glib-1.0.so.0* \
          /usr/lib/x86_64-linux-gnu/libgudev-1.0.so.0* \
          "$DEPS/deps/usr/lib/x86_64-linux-gnu/" 2>/dev/null || true
  )
  export PKG_CONFIG_PATH="$DEPS/deps/usr/lib/x86_64-linux-gnu/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export CFLAGS="-I$DEPS/deps/usr/include -I$DEPS/deps/usr/include/gusb-1 -I$DEPS/deps/usr/include/gudev-1.0 -I$DEPS/deps/usr/include/json-glib-1.0 ${CFLAGS:-}"
  export CXXFLAGS="$CFLAGS"
  export LDFLAGS="-L$DEPS/deps/usr/lib/x86_64-linux-gnu ${LDFLAGS:-}"
  ok "private headers ready"
}

prepare_sources() {
  say "Preparing sources in $WORK"
  rm -rf "$WORK"; mkdir -p "$WORK"
  if [ "$MODE" = fromgit ] || [ ! -f "$TARBALL" ]; then
    [ -f "$PATCH" ] || { echo "patch not found: $PATCH" >&2; exit 1; }
    git clone --quiet --filter=blob:none https://gitlab.freedesktop.org/libfprint/libfprint.git "$WORK/src"
    git -C "$WORK/src" checkout --quiet "$SNAPSHOT"
    ( cd "$WORK/src" && patch -p1 --quiet < "$PATCH" )
    mkdir -p "$WORK/src/libfprint/sigfm"
    cp "$HERE"/sigfm-upstream/*.cpp "$HERE"/sigfm-upstream/*.hpp \
       "$HERE"/sigfm-upstream/meson.build "$WORK/src/libfprint/sigfm/"
    ok "upstream $SNAPSHOT + production patch + vendored SIGFM"
  else
    tar -xzf "$TARBALL" -C "$WORK"
    mv "$WORK/libfprint-sigfm-src" "$WORK/src"
    ok "bundled working sources (exact tree that produced the installed library)"
  fi
}

build_sources() {
  say "Building libfprint (elanspi + SIGFM + OpenCV)"
  cd "$WORK/src"
  rm -rf build
  meson setup build \
    -Ddrivers=elanspi \
    ${LDFLAGS:+-Dc_link_args="$LDFLAGS" -Dcpp_link_args="$LDFLAGS"} \
    -Dintrospection=false -Ddoc=false -Dinstalled-tests=false \
    -Dgtk-examples=false -Dudev_rules=disabled -Dudev_hwdb=disabled \
    >"$WORK/meson-setup.log" 2>&1 || { tail -30 "$WORK/meson-setup.log"; exit 1; }
  ninja -C build libfprint/libfprint-2.so.2.0.0 >"$WORK/ninja.log" 2>&1 \
    || { grep -E "error:|undefined reference" "$WORK/ninja.log" | head -20; exit 1; }
  ok "$(ls -l build/libfprint/libfprint-2.so.2.0.0 | awk '{print $5}') bytes"
}

install_all() {
  say "Installing to $LIBDIR"
  sudo install -d "$LIBDIR"
  sudo install -m 0644 "$WORK/src/build/libfprint/libfprint-2.so.2.0.0" "$LIBDIR/"
  sudo ln -sf libfprint-2.so.2.0.0 "$LIBDIR/libfprint-2.so.2"
  sudo ln -sf libfprint-2.so.2 "$LIBDIR/libfprint-2.so"

  say "Configuring fprintd"
  sudo install -d "$(dirname "$DROPIN")"
  sudo tee "$DROPIN" >/dev/null <<'EOF'
# Elan ELAN7001 swipe sensor: libfprint + SIGFM matcher.
# NBIS/bozorth3 cannot discriminate fingers on these narrow strips.
# Revert: rm this file, rm -rf /usr/local/lib/fprint-sigfm, then
#         systemctl daemon-reload && systemctl restart fprintd
[Service]
ExecStart=
ExecStart=/usr/bin/env LD_LIBRARY_PATH=/usr/local/lib/fprint-sigfm /usr/libexec/fprintd
EOF
  sudo systemctl daemon-reload
  sudo systemctl restart fprintd

  say "Enabling the PAM fingerprint profile"
  sudo pam-auth-update --enable fprintd --force >/dev/null 2>&1 || warn "pam-auth-update failed; enable 'Fingerprint authentication' manually"

  say "Done"
  cat <<EOF
  library : $LIBDIR/libfprint-2.so.2.0.0
  drop-in : $DROPIN
  PAM     : profile 'fprintd' enabled (password fallback stays)

  Next:
    fprintd-enroll -f right-index-finger      # ~10 slow, even swipes, within ~2 minutes
    for i in 1 2 3; do fprintd-verify -f right-index-finger \$USER; done   # genuine
    # repeat the verify loop with a DIFFERENT finger -> must say verify-no-match

  Expected: genuine scores in the thousands, impostor <= ~50, threshold 100.
  If verify says verify-unknown-error or a stored print is tiny (<1 KB), see diary/DIARY.md phase 7.
EOF
}

uninstall_all() {
  say "Removing the SIGFM build"
  sudo rm -f "$DROPIN"
  sudo rm -rf "$LIBDIR"
  sudo systemctl daemon-reload
  sudo systemctl restart fprintd || true
  warn "PAM profile left enabled; disable with: sudo pam-auth-update --disable fprintd"
  ok "back on the distro libfprint"
}

case "$MODE" in
  check)    check_deps; [ -f "$TARBALL" ] && ok "bundled sources: $TARBALL" || warn "no tarball, would use --from-git" ;;
  uninstall) uninstall_all ;;
  buildonly) check_deps; prepare_sources; [ "${NEED_PRIVATE:-0}" = 1 ] && private_deps; build_sources
             ok "build only - binary at $WORK/src/build/libfprint/libfprint-2.so.2.0.0" ;;
  install|fromgit) check_deps; prepare_sources
                   [ "${NEED_PRIVATE:-0}" = 1 ] && private_deps
                   build_sources; install_all ;;
esac

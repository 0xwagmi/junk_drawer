#!/bin/bash
# Tap overlay icons in the Chikii game screen (Waydroid) via genuine
# touchscreen-sourced adb input, since plain mouse clicks don't hit the
# touch-only overlay. Coords are for 1280x720 (adb shell wm size).
#
# Usage: ./chikii-touch.sh <target|x y>
#   targets: settings | keyboard | gamepad | screenshot
#   or pass raw coords:  ./chikii-touch.sh 640 360

set -e

case "$1" in
  settings)   X=1218; Y=46 ;;
  keyboard)   X=1158; Y=46 ;;
  gamepad)    X=103;  Y=40 ;;
  screenshot) X=37;   Y=40 ;;
  "")
    echo "Usage: $0 <settings|keyboard|gamepad|screenshot|X Y>"
    exit 1
    ;;
  *)
    X="$1"; Y="$2"
    if [ -z "$Y" ]; then
      echo "Unknown target '$1'. Use settings|keyboard|gamepad|screenshot, or pass X Y coords."
      exit 1
    fi
    ;;
esac

echo "Tapping ($X, $Y)..."
adb shell input touchscreen tap "$X" "$Y"

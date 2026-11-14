#!/bin/zsh
# Renders card.html -> ../../email/giftcard-pdf-en.jpg, giftcard-pdf-nl.jpg (PDF backgrounds)
# and giftcard-thumb.jpg (picture on the Stripe payment page). Run from this folder.
setopt NO_MONITOR 2>/dev/null
SRC="$PWD"; OUT="$(cd ../../email && pwd)"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROF="/tmp/wogo-card-chrome-profile"
run() { local out="$1"; shift; rm -f "$out"
  "$CH" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=8000 --no-first-run --user-data-dir="$PROF" "$@" >/dev/null 2>&1 &
  local pid=$!; local i=0
  while [ ! -s "$out" ] && [ $i -lt 90 ]; do sleep 1; i=$((i+1)); done
  sleep 2; kill $pid 2>/dev/null; wait $pid 2>/dev/null || true
  [ -s "$out" ] && echo "ok  $out" || echo "FAIL $out"; }
sed 's/<body class="">/<body class="nl">/' card.html > _nl.html
sed 's/<body class="">/<body class="thumb">/' card.html > _thumb.html
run "$SRC/_en.png" --force-device-scale-factor=2 --window-size=794,559 --screenshot="$SRC/_en.png" "file://$SRC/card.html"
run "$SRC/_nl.png" --force-device-scale-factor=2 --window-size=794,559 --screenshot="$SRC/_nl.png" "file://$SRC/_nl.html"
run "$SRC/_thumb.png" --force-device-scale-factor=1.6 --window-size=559,559 --screenshot="$SRC/_thumb.png" "file://$SRC/_thumb.html"
sips -s format jpeg -s formatOptions 82 _en.png --out "$OUT/giftcard-pdf-en.jpg" >/dev/null
sips -s format jpeg -s formatOptions 82 _nl.png --out "$OUT/giftcard-pdf-nl.jpg" >/dev/null
sips -s format jpeg -s formatOptions 84 _thumb.png --out "$OUT/giftcard-thumb.jpg" >/dev/null
rm -f _nl.html _thumb.html _en.png _nl.png _thumb.png
ls -la "$OUT"/giftcard-*

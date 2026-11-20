#!/bin/bash
# Builds Covo.app into apps/mac/build/. Run it with: bun run mac:build
#
# It's signed for this Mac only ("ad hoc"), which is free and needs no account. To sign it with your
# free Apple ID instead, add the account in Xcode (Settings, Accounts), then run:
#   COVO_SIGN_IDENTITY="Apple Development: you@example.com (TEAMID)" bun run mac:build
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release --product Covo
BIN="$(swift build -c release --show-bin-path)/Covo"

if [ ! -f Resources/AppIcon.icns ]; then
  swift make-icon.swift "$PWD" >/dev/null
  iconutil -c icns build/AppIcon.iconset -o Resources/AppIcon.icns
fi

rm -rf build/Covo.app
mkdir -p build/Covo.app/Contents/MacOS build/Covo.app/Contents/Resources
cp "$BIN" build/Covo.app/Contents/MacOS/Covo
cp Info.plist build/Covo.app/Contents/Info.plist
cp Resources/AppIcon.icns build/Covo.app/Contents/Resources/AppIcon.icns
codesign --force --options runtime --timestamp=none --sign "${COVO_SIGN_IDENTITY:--}" build/Covo.app
codesign --verify --strict build/Covo.app
echo "Built $PWD/build/Covo.app"

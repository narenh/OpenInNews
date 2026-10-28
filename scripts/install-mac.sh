#!/bin/zsh
# Builds the Mac app and installs it to /Applications, so Safari lists the extension.
#
#   ./scripts/install-mac.sh
#
# Then tick Open in News in Safari › Settings › Extensions.
set -euo pipefail

ROOT="${0:A:h}/.."
cd "$ROOT"
xcodegen generate --quiet
xcodebuild -project OpenInNews.xcodeproj -scheme OpenInNewsMac -configuration Release \
  -destination 'platform=macOS' -derivedDataPath build/dd build \
  | grep -E 'error:|BUILD (SUCCEEDED|FAILED)'

BUILT="build/dd/Build/Products/Release/Open in News.app"
DEST="/Applications"
[[ -w "$DEST" ]] || DEST="$HOME/Applications"
mkdir -p "$DEST"
rm -rf "$DEST/Open in News.app"
cp -R "$BUILT" "$DEST/"

# Xcode registers every app it builds, which would show Safari a second copy
# of the extension. Keep only the installed one.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$ROOT/build/dd/Build/Products/Debug/Open in News.app" 2>/dev/null || true
"$LSREGISTER" -u "$ROOT/$BUILT" 2>/dev/null || true
"$LSREGISTER" -f "$DEST/Open in News.app"

open "$DEST/Open in News.app"
echo "Installed $DEST/Open in News.app"

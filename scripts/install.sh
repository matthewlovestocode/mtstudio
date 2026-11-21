#!/bin/bash
# Installs the latest release of mtstudio on an Apple silicon Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/matthewlovestocode/mtstudio/main/scripts/install.sh | bash
#
# It downloads the app from the project's GitHub Releases and puts it in
# Applications. Run again to update. Nothing else on the machine is changed.
set -euo pipefail

repo=matthewlovestocode/mtstudio

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "mtstudio is packaged for Apple silicon Macs only. On other machines, run it from source:" >&2
  echo "  https://github.com/$repo#run-from-source" >&2
  exit 1
fi

address=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | grep -o '"browser_download_url": *"[^"]*mac-arm64\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/') || true
if [ -z "${address:-}" ]; then
  echo "No release of mtstudio was found at https://github.com/$repo/releases" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Downloading ${address##*/}"
curl -fL --progress-bar -o "$work/mtstudio.zip" "$address"
ditto -x -k "$work/mtstudio.zip" "$work/unpacked"
if [ ! -d "$work/unpacked/mtstudio.app" ]; then
  echo "The download did not hold mtstudio.app." >&2
  exit 1
fi

folder=/Applications
if [ ! -w "$folder" ]; then
  folder="$HOME/Applications"
  mkdir -p "$folder"
fi

if pgrep -qf "$folder/mtstudio.app/Contents/MacOS/mtstudio"; then
  echo "mtstudio is running. Quit it and run this again." >&2
  exit 1
fi

rm -rf "$folder/mtstudio.app"
mv "$work/unpacked/mtstudio.app" "$folder/mtstudio.app"
echo "mtstudio is in $folder. The first time it starts it downloads its instrument sounds (216 MB)."
open "$folder/mtstudio.app"

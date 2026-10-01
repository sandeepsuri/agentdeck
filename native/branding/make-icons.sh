#!/bin/sh
# Regenerates the committed app icons from the SVG masters in this folder.
set -eu
cd "$(dirname "$0")"
phone=../AgentDeckPhone/AgentDeckPhone/Assets.xcassets/AppIcon.appiconset
swift render.swift AppIcon-ios.svg "$phone/AppIcon-1024.png" 1024 opaque

iconset=$(mktemp -d)/AppIcon.iconset
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  swift render.swift AppIcon-mac.svg "$iconset/icon_${size}x${size}.png" "$size"
  swift render.swift AppIcon-mac.svg "$iconset/icon_${size}x${size}@2x.png" "$((size * 2))"
done
iconutil -c icns "$iconset" -o ../AgentDeckApp/AppIcon.icns

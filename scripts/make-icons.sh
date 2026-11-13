#!/bin/sh
# Makes the app's icons from icon.svg: assets/icon.icns (macOS), assets/icon.ico
# (Windows) and app/icon.png (Linux, and the window while running from source).
# Needs rsvg-convert (librsvg) and magick (ImageMagick); iconutil is part of macOS.
# The results are kept in the repository, so run this only when icon.svg changes.
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# macOS shows an icon at full size only when it has the system's shape: a
# rounded square of 824 of the 1024 pixels, centred. Anything else is shrunk
# onto a grey tile. The drawing has a frame of its own, a little wider than
# tall and with other corners, so it is drawn large enough for that frame to
# fall outside the shape, then cut to it.
rsvg-convert -w 960 --keep-aspect-ratio icon.svg -o "$tmp/art.png"
magick "$tmp/art.png" -background none -gravity center -extent 1024x1024 "$tmp/art-1024.png"
magick -size 1024x1024 xc:none -fill white -draw "roundrectangle 100,100 923,923 185,185" "$tmp/shape.png"
magick "$tmp/art-1024.png" "$tmp/shape.png" -compose DstIn -composite "$tmp/1024.png"

set_dir="$tmp/icon.iconset"
mkdir "$set_dir"
for size in 16 32 128 256 512; do
  magick "$tmp/1024.png" -resize "${size}x${size}" "$set_dir/icon_${size}x${size}.png"
  magick "$tmp/1024.png" -resize "$((size * 2))x$((size * 2))" "$set_dir/icon_${size}x${size}@2x.png"
done
mkdir -p assets
if command -v iconutil >/dev/null; then
  iconutil -c icns "$set_dir" -o assets/icon.icns
fi
magick "$tmp/1024.png" -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
magick "$tmp/1024.png" -resize 512x512 app/icon.png
echo "made assets/icon.icns, assets/icon.ico, app/icon.png"

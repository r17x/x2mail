#!/bin/sh
set -eu
VERSION="$1"

for arch in darwin-arm64 darwin-x64; do
  src="release/x2mail-${arch}"
  dst="release/x2mail-${arch}-lite"

  cat > "$dst" << STUB
#!/bin/sh
set -e
V="${VERSION}"
D="\${XDG_CACHE_HOME:-\$HOME/.cache}/x2mail/\$V"
B="\$D/x2mail"
if [ -x "\$B" ]; then exec "\$B" "\$@"; fi
mkdir -p "\$D"
L=\$(awk '/^__ARCHIVE__\$/{print NR + 1; exit}' "\$0")
tail -n +"\$L" "\$0" | gunzip > "\$B"
chmod +x "\$B"
exec "\$B" "\$@"

__ARCHIVE__
STUB

  gzip -c -9 "$src" >> "$dst"
  chmod +x "$dst"
done

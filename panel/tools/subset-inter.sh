#!/bin/sh
# Reproduce src/fonts/InterVariable-latin.woff2 from an official Inter release.
#
# $1 is InterVariable.woff2 out of an Inter release from
# https://github.com/rsms/inter/releases — the official download, not the copy
# that ships inside a Tailwind Plus template, so that anyone can fetch the same
# input and the licence chain stays plainly SIL OFL 1.1.
#
# The committed subset is Inter Variable 4.001 (git-9221beed3), SIL OFL 1.1,
# cut to latin with both variable axes (opsz 14-32, wght 100-900) and the cv11
# feature Catalyst asks for. Running this is a one-off: it needs fonttools
# (pip install 'fonttools[woff]' zopfli) and is deliberately not wired into the
# build, because the font is committed and the build must not need Python.
#
# Run it from panel/: the output path below is relative to there.
set -eu

pyftsubset "$1" \
  --output-file=src/fonts/InterVariable-latin.woff2 \
  --layout-features+=cv11 \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" \
  --flavor=woff2 \
  --with-zopfli

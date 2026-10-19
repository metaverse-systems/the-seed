#!/bin/sh
# Libtool is only part of the project when with-library exists: with it, automake installs every
# program through libtool, and libtool cannot install into every prefix a plain program can.
cd "$(dirname "$0")" || exit 1
mkdir -p build-aux
if [ -f with-library ]; then
  cp library.ac.in build-aux/library.ac
  cp src/library.am.in src/library.am
else
  : > build-aux/library.ac
  : > src/library.am
fi
autoreconf -fi

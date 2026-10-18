AC_INIT([tiny], [0.0.1])
AC_CONFIG_AUX_DIR([build-aux])
AC_CONFIG_MACRO_DIR([m4])
AM_INIT_AUTOMAKE([foreign])
AC_PROG_CC
m4_include([build-aux/library.ac])
PKG_PROG_PKG_CONFIG
if test -n "$SEED_TEST_REQUIRES"; then
  PKG_CHECK_MODULES([SEEDTEST], [$SEED_TEST_REQUIRES])
fi
AC_CONFIG_FILES([Makefile src/Makefile])
AC_OUTPUT

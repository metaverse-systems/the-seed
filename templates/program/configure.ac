AC_PREREQ([2.71])
AC_INIT([{{name}}], [0.0.1], [{{author_email}}], [{{name}}], [{{author_url}}])
AC_CONFIG_HEADERS([config.h])
AC_PROG_CXX
AM_INIT_AUTOMAKE([subdir-objects])
LT_INIT

AC_CONFIG_MACRO_DIR([m4])

PKG_CHECK_MODULES([LIBECS], [ecs-cpp >= {{ecs_cpp_version}}])
PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed >= {{the_seed_version}}])

AC_CHECK_HEADER([windows.h],
    [LIBS="$LIBS"],
    [LIBS="$LIBS -ldl"],
    [])

AC_CONFIG_FILES([Makefile src/Makefile])
AC_OUTPUT

ACLOCAL_AMFLAGS = -I m4
lib_LTLIBRARIES = lib{{name}}.la
pkginclude_HEADERS = {{name}}.hpp
lib{{identifier}}_la_SOURCES = {{name}}.cpp
lib{{identifier}}_la_CXXFLAGS = -std=c++20 ${LIBECS_CFLAGS}
lib{{identifier}}_la_LDFLAGS = -no-undefined
lib{{identifier}}_la_LIBADD = ${LIBECS_LIBS}

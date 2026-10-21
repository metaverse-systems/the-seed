ACLOCAL_AMFLAGS = -I m4
lib_LTLIBRARIES = lib{{name}}.la
lib{{identifier}}_la_SOURCES = {{name}}.cpp
lib{{identifier}}_la_CXXFLAGS = -std=c++20 ${LIBECS_CFLAGS} ${LIBTHE_SEED_CFLAGS}
lib{{identifier}}_la_LDFLAGS = -no-undefined
lib{{identifier}}_la_LIBADD = ${LIBECS_LIBS} ${LIBTHE_SEED_LIBS}

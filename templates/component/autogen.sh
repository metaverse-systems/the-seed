#!/bin/bash

libtoolize \
&& aclocal \
&& autoheader \
&& automake --add-missing -c \
&& autoconf

bin_PROGRAMS = tiny
tiny_SOURCES = tiny.c

SEED_TEST_NOISE ?= 0

all-local:
	@echo "MAKEFLAGS: $(MAKEFLAGS)"
	@if test "$(SEED_TEST_NOISE)" -gt 0; then head -c "$(SEED_TEST_NOISE)" /dev/zero | tr '\0' 'x'; echo; fi
	@echo "tiny: end of output"
	@if test -n "$$SEED_TEST_FAIL"; then echo "tiny: deliberate failure"; exit 1; fi

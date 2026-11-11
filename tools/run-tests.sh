#!/bin/sh
# Run every dsh-serial-debugger test suite.
#
#   sh tools/run-tests.sh
#
# Thin shim: the runner lives in tools/run-tests.mjs so one command works on
# Windows and Linux alike. Set NODE=/path/to/node to pick a specific runtime.

set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${NODE:-node}" "$DIR/run-tests.mjs"

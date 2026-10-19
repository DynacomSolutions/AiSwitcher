#!/usr/bin/env bash
# Fail when the peak disk growth in a df sample file exceeds 80% of the free
# space at the first sample. Lines: "<epoch> <used_kib> <avail_kib>". At least
# two samples are required (the synchronous initial and final ones).
# Usage: assert-disk.sh <samples>
set -euo pipefail
file=${1:?usage: assert-disk.sh <samples>}
awk '
  {
    if (NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/) {
      print "assert-disk: malformed sample at line " NR > "/dev/stderr"
      bad = 1
      next
    }
    if (!n++) { used0 = $2; free0 = $3 }
    if ($2 > max) max = $2
  }
  END {
    if (bad) exit 2
    if (n < 2) { print "assert-disk: need at least 2 samples, got " n+0 > "/dev/stderr"; exit 2 }
    if (free0 <= 0) { print "assert-disk: initial available space must be positive" > "/dev/stderr"; exit 2 }
    peak = max - used0
    printf "assert-disk: free_at_start_kib=%d peak_growth_kib=%d (%.1f%% of free)\n", free0, peak, 100 * peak / free0
    if (peak * 100 > 80 * free0) { print "assert-disk: peak above 80% of free disk" > "/dev/stderr"; exit 1 }
  }' "$file"

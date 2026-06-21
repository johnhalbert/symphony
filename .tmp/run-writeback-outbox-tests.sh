#!/usr/bin/env bash
set -euo pipefail
repo='/c/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-406'
log="$repo/.tmp/writeback-outbox-vitest.log"
exit_file="$repo/.tmp/writeback-outbox-vitest.exit"
rm -f "$log" "$exit_file"
cd "$repo"
cmd=(../../node_modules/.bin/vitest run tests/writeback-outbox.test.ts --no-file-parallelism)
printf '+ %s\n' "${cmd[*]}" | tee "$log"
status=0
"${cmd[@]}" >>"$log" 2>&1 || status=$?
printf '%s\n' "$status" > "$exit_file"
cat "$log"
exit "$status"

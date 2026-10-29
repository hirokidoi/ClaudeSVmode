#!/bin/sh
# 連絡帳フック（hook.sh）に模擬の入力を流して確かめる。使い方: sh test-hook.sh
# SV_MAILBOX_HOOK_UNDER_TEST で差し替えるときは .../mailbox/hook.sh という名前に置く（waker の照合がこの名前を見る）

DIR=$(cd "$(dirname "$0")" && pwd)
HOOK=${SV_MAILBOX_HOOK_UNDER_TEST:-$DIR/hook.sh}

if ! command -v jq >/dev/null 2>&1; then
  echo "jq が無いためフックは無効です（担当が自分で連絡帳を読む動きだけになります）"
  exit 1
fi

T=$(mktemp -d "${TMPDIR:-/tmp}/sv-mailbox-test.XXXXXX") || exit 1
BGPIDS=
cleanup() {
  for p in $BGPIDS; do kill "$p" 2>/dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

SROOT=$T/state
mkdir -m 700 "$SROOT"
export SV_MAILBOX_STATE_DIR=$SROOT
CAP_BYTES=$(sed -n 's/^CAP_BYTES=//p' "$HOOK")
RUNS=$T/runs
NL='
'

N=0
FAILED=
fail() { FAILED="$FAILED${NL}  $1"; }
pass() { N=$((N + 1)); }

assert_eq() { # 名前 期待 実際
  if [ "$2" = "$3" ]; then pass; else fail "$1（期待: $2 / 実際: $3）"; fi
}
assert_has() { # 名前 全体 部分
  case "$2" in *"$3"*) pass ;; *) fail "$1（「$3」が無い: $2）" ;; esac
}
assert_lacks() {
  case "$2" in *"$3"*) fail "$1（「$3」が含まれる: $2）" ;; *) pass ;; esac
}
assert_empty() { # 名前 値
  if [ -z "$2" ]; then pass; else fail "$1（空のはずが: $2）"; fi
}
assert_file() {
  if [ -e "$2" ]; then pass; else fail "$1（無い: $2）"; fi
}
assert_nofile() {
  if [ -e "$2" ]; then fail "$1（あるはずがない: $2）"; else pass; fi
}

# 入力の組み立て: sid ev aid tool tool_input(json) [cwd]
mk() {
  jq -cn --arg sid "$1" --arg ev "$2" --arg aid "$3" --arg tool "$4" --argjson ti "$5" --arg cwd "${6:-$T}" \
    '{session_id: $sid, hook_event_name: $ev, cwd: $cwd, tool_name: $tool, tool_input: $ti}
     + (if $aid == "" then {} else {agent_id: $aid} end)'
}
ti_file() { jq -cn --arg p "$1" '{file_path: $p}'; }
ti_cmd() { jq -cn --arg c "$1" '{command: $c}'; }

OUT=; RC=
run() {
  OUT=$(printf '%s' "$1" | sh "$HOOK" 2>"$T/err")
  RC=$?
}
ctx() { printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // empty'; }

new_box() { # run名 担当名 → フォルダのパス
  mkdir -p "$RUNS/wf-sv-design/$1/mailbox/$2"
  printf '%s' "$RUNS/wf-sv-design/$1/mailbox/$2"
}
append() { printf '%s\n' "$2" >> "$1"; }
state_of() { printf '%s' "$SROOT/$1"; }
now() { date +%s; }

now_ms() {
  t=$(date +%s%N 2>/dev/null)
  case "$t" in
    ''|*[!0-9]*) echo "$(date +%s)000" ;;
    *) echo "$((t / 1000000))" ;;
  esac
}

# ---------------------------------------------------------------- T-1
S=s1
B=$(new_box run1 alpha)
run "$(mk $S PreToolUse a1 Read "$(ti_file "$B/inbox.md")")"
assert_eq "T-1 結び付け: 終了コード" 0 "$RC"
assert_empty "T-1 結び付け: 出力なし" "$OUT"
assert_eq "T-1 結び付け: box" "$B" "$(cat "$(state_of $S)/agents/a1/box")"
assert_file "T-1 結び付け: inbox.md を空で作る" "$B/inbox.md"
assert_eq "T-1 結び付け: 空の inbox の既読位置" 0 "$(cat "$(state_of $S)/agents/a1/read")"

run "$(mk $S PostToolUse a1 Read "$(ti_file "$B/inbox.md")")"
assert_has "T-1 フック有効の知らせ" "$(ctx)" "連絡帳のフックが有効です"
run "$(mk $S PostToolUse a1 Read "$(ti_file "$B/inbox.md")")"
assert_empty "T-1 知らせは 1 回だけ" "$OUT"

append "$B/inbox.md" "## #1 SV → alpha${NL}FIRST-MESSAGE"
run "$(mk $S PostToolUse a1 Bash "$(ti_cmd 'echo hi')")"
assert_has "T-1 追記分の差し込み" "$(ctx)" "FIRST-MESSAGE"
assert_has "T-1 差し込みの前置き" "$(ctx)" "新しい連絡が届いています"
run "$(mk $S PostToolUse a1 Bash "$(ti_cmd 'echo hi')")"
assert_empty "T-1 同じ分は二度出ない" "$OUT"

append "$B/inbox.md" "SELF-READ-MESSAGE"
run "$(mk $S PreToolUse a1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse a1 Read "$(ti_file "$B/inbox.md")")"
assert_empty "T-1 自分で全体を読んだ分は差し込まれない" "$OUT"

# 別の agent_id が同じフォルダに結び付く
run "$(mk $S PreToolUse a2 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse a2 Read "$(ti_file "$B/inbox.md")")"
assert_lacks "T-1 後続の担当にはそれまでの分を渡さない" "$(ctx)" "FIRST-MESSAGE"
append "$B/inbox.md" "AFTER-BIND"
run "$(mk $S PostToolUse a2 Bash "$(ti_cmd 'echo hi')")"
assert_has "T-1 後続の担当に以後の追記を渡す" "$(ctx)" "AFTER-BIND"
assert_lacks "T-1 後続の担当に以前の分は含まれない" "$(ctx)" "SELF-READ-MESSAGE"

# command 内のパス・日本語の担当名
B2=$(new_box run1 beta)
run "$(mk $S PreToolUse a3 Bash "$(ti_cmd "cat $B2/inbox.md")")"
assert_eq "T-1 command 内のパスで結び付く" "$B2" "$(cat "$(state_of $S)/agents/a3/box")"
BJ=$(new_box run1 調査-領域)
run "$(mk $S PreToolUse a4 Read "$(ti_file "$BJ/inbox.md")")"
assert_eq "T-1 日本語の担当名で結び付く" "$BJ" "$(cat "$(state_of $S)/agents/a4/box")"

# 相対パスは cwd を前に付ける
mkdir -p "$T/rel/work/wf-sv-x/r1/mailbox/gamma"
run "$(mk $S PreToolUse a5 Bash "$(ti_cmd 'cat work/wf-sv-x/r1/mailbox/gamma/inbox.md')" "$T/rel")"
assert_eq "T-1 相対パスは cwd を前に付けて結び付く" "$T/rel/work/wf-sv-x/r1/mailbox/gamma" "$(cat "$(state_of $S)/agents/a5/box")"

# = の後のパス
B2E=$(new_box run1 eta)
run "$(mk $S PreToolUse a5e Bash "$(ti_cmd "tool --file=$B2E/inbox.md")")"
assert_eq "T-1 = の後のパスで結び付く" "$B2E" "$(cat "$(state_of $S)/agents/a5e/box")"

# 空白を含むパスを Bash で触れても誤ったフォルダに結び付けない（後の Read で正しく結び付く）
mkdir -p "$T/sp ace/wf-sv-x/r1/mailbox/kappa" "$T/cwdk"
run "$(mk $S PreToolUse a5s Bash "$(ti_cmd "cat \"$T/sp ace/wf-sv-x/r1/mailbox/kappa/inbox.md\"")" "$T/cwdk")"
assert_nofile "T-1 空白を含むパスの Bash では結び付けない" "$(state_of $S)/agents/a5s/box"
assert_nofile "T-1 空白を含むパスの Bash で cwd の下にフォルダを作らない" "$T/cwdk/ace"
run "$(mk $S PreToolUse a5s Read "$(ti_file "$T/sp ace/wf-sv-x/r1/mailbox/kappa/inbox.md")" "$T/cwdk")"
assert_eq "T-1 空白を含むパスも Read なら結び付く" "$T/sp ace/wf-sv-x/r1/mailbox/kappa" "$(cat "$(state_of $S)/agents/a5s/box")"

# run ディレクトリがまだ無いうちの Bash では結び付けず、できた後の同じ Bash では結び付く
NOTYET=$RUNS/wf-sv-design/run-notyet/mailbox/mu
run "$(mk $S PreToolUse a5u Bash "$(ti_cmd "cat $NOTYET/inbox.md")")"
assert_nofile "T-1 run ディレクトリが無いうちの Bash では結び付けない" "$(state_of $S)/agents/a5u/box"
mkdir -p "$RUNS/wf-sv-design/run-notyet"
run "$(mk $S PreToolUse a5u Bash "$(ti_cmd "cat $NOTYET/inbox.md")")"
assert_eq "T-1 run ディレクトリができた後の Bash では結び付く" "$NOTYET" "$(cat "$(state_of $S)/agents/a5u/box")"

# SV の wf の run ディレクトリの形でない mailbox は結び付けない
mkdir -p "$T/repo/mailbox/theta"
run "$(mk $S PreToolUse a5n Bash "$(ti_cmd "cat $T/repo/mailbox/theta/inbox.md")")"
assert_nofile "T-1 run ディレクトリの形でない mailbox は結び付けない（Bash）" "$(state_of $S)/agents/a5n/box"
run "$(mk $S PreToolUse a5n Read "$(ti_file "$T/repo/mailbox/theta/inbox.md")")"
assert_nofile "T-1 run ディレクトリの形でない mailbox は結び付けない（Read）" "$(state_of $S)/agents/a5n/box"
assert_nofile "T-1 結び付けないフォルダに inbox.md を作らない" "$T/repo/mailbox/theta/inbox.md"

# command 内の $HOME・${HOME} はホームに置き換える
REAL_HOME=$HOME
HOME=$T/home; export HOME
mkdir -p "$HOME/w/wf-sv-x/r1/mailbox/eps" "$HOME/w/wf-sv-x/r1/mailbox/zeta"
run "$(mk $S PreToolUse a5h Bash "$(ti_cmd 'cat $HOME/w/wf-sv-x/r1/mailbox/eps/inbox.md')" "$T/rel")"
assert_eq "T-1 command 内の \$HOME をホームに置き換えて結び付く" "$HOME/w/wf-sv-x/r1/mailbox/eps" "$(cat "$(state_of $S)/agents/a5h/box")"
run "$(mk $S PreToolUse a5b Bash "$(ti_cmd 'cat ${HOME}/w/wf-sv-x/r1/mailbox/zeta/inbox.md')" "$T/rel")"
assert_eq "T-1 command 内の \${HOME} をホームに置き換えて結び付く" "$HOME/w/wf-sv-x/r1/mailbox/zeta" "$(cat "$(state_of $S)/agents/a5b/box")"
mkdir -p "$HOME/w/wf-sv-x/r1/mailbox/lam"
run "$(mk $S PreToolUse a5t Read "$(ti_file '~/w/wf-sv-x/r1/mailbox/lam/inbox.md')" "$T/rel")"
assert_eq "T-1 ~ で始まる file_path をホームに置き換えて結び付く" "$HOME/w/wf-sv-x/r1/mailbox/lam" "$(cat "$(state_of $S)/agents/a5t/box")"
HOME=$REAL_HOME; export HOME

# 結び付けの初期位置
B3=$(new_box run1 delta)
append "$B3/inbox.md" "PRE-EXISTING"
run "$(mk $S PreToolUse a6 Read "$(ti_file "$B3/outbox.md")")"
assert_eq "T-1 outbox の Read で結び付くと既読位置は 0" 0 "$(cat "$(state_of $S)/agents/a6/read")"
run "$(mk $S PostToolUse a6 Read "$(ti_file "$B3/outbox.md")")"
assert_has "T-1 outbox の Read で結び付くと inbox の全体が差し込まれる" "$(ctx)" "PRE-EXISTING"

B4=$(new_box run1 epsilon)
append "$B4/inbox.md" "PRE-EXISTING-2"
run "$(mk $S PreToolUse a7 Bash "$(ti_cmd "ls $B4/inbox.md")")"
assert_eq "T-1 Bash の ls で結び付くと既読位置は 0" 0 "$(cat "$(state_of $S)/agents/a7/read")"
run "$(mk $S PostToolUse a7 Bash "$(ti_cmd "ls $B4/inbox.md")")"
assert_has "T-1 Bash の ls で結び付くと inbox の全体が差し込まれる" "$(ctx)" "PRE-EXISTING-2"

# 結び付け済みで Bash や部分読みでは既読が進まない
B5=$(new_box run1 zeta)
run "$(mk $S PreToolUse a8 Read "$(ti_file "$B5/inbox.md")")"
run "$(mk $S PostToolUse a8 Read "$(ti_file "$B5/inbox.md")")"
append "$B5/inbox.md" "BASH-TOUCHED"
run "$(mk $S PreToolUse a8 Bash "$(ti_cmd "wc -c $B5/inbox.md")")"
run "$(mk $S PostToolUse a8 Bash "$(ti_cmd "wc -c $B5/inbox.md")")"
assert_has "T-1 Bash で触れても既読は進まない" "$(ctx)" "BASH-TOUCHED"

B6=$(new_box run1 eta)
run "$(mk $S PreToolUse a9 Read "$(ti_file "$B6/inbox.md")")"
run "$(mk $S PostToolUse a9 Read "$(ti_file "$B6/inbox.md")")"
append "$B6/inbox.md" "PARTIAL-READ"
run "$(mk $S PreToolUse a9 Read "$(jq -cn --arg p "$B6/inbox.md" '{file_path: $p, offset: 1}')")"
run "$(mk $S PostToolUse a9 Read "$(ti_file "$B6/inbox.md")")"
assert_has "T-1 offset 付きの Read では既読が進まない" "$(ctx)" "PARTIAL-READ"
append "$B6/inbox.md" "LIMITED-READ"
run "$(mk $S PreToolUse a9 Read "$(jq -cn --arg p "$B6/inbox.md" '{file_path: $p, limit: 1}')")"
run "$(mk $S PostToolUse a9 Bash "$(ti_cmd 'true')")"
assert_has "T-1 limit 付きの Read では既読が進まない" "$(ctx)" "LIMITED-READ"

append "$B6/inbox.md" "EDIT-TOOL"
run "$(mk $S PreToolUse a9 Edit "$(ti_file "$B6/inbox.md")")"
run "$(mk $S PostToolUse a9 Bash "$(ti_cmd 'true')")"
assert_has "T-1 Read 以外のツールでは既読が進まない" "$(ctx)" "EDIT-TOOL"

# 古いセッションの掃除
mkdir -p "$SROOT/old-session" "$SROOT/old-unmarked"
: > "$SROOT/old-session/alive"
touch -t 200001010000 "$SROOT/old-session" "$SROOT/old-unmarked"
B7=$(new_box run1 iota)
run "$(mk $S PreToolUse a10 Read "$(ti_file "$B7/inbox.md")")"
assert_nofile "T-1 更新から日数を超えたセッションの状態を消す" "$SROOT/old-session"
assert_file "T-1 状態の印が無いフォルダは消さない" "$SROOT/old-unmarked"
assert_file "T-1 掃除で自分のセッションは消えない" "$(state_of $S)/agents/a10/box"

# ---------------------------------------------------------------- T-2
S=s2
B=$(new_box run2 review)
run "$(mk $S PreToolUse r1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse r1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PreToolUse r1 StructuredOutput '{}')"
assert_empty "T-2 未読が無ければ deny しない" "$OUT"
append "$B/inbox.md" "BEFORE-SUBMIT"
SUBMIT=$(mk $S PreToolUse r1 StructuredOutput '{}')
run "$SUBMIT"
assert_eq "T-2 未読があれば deny" deny "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision')"
assert_has "T-2 deny の理由に未読の本文" "$OUT" "BEFORE-SUBMIT"
assert_eq "T-2 deny の終了コード" 0 "$RC"
run "$SUBMIT"
assert_empty "T-2 同じ入力の 2 回目は deny しない" "$OUT"

# 提出の後の PostToolUse では既読を進めず、未読は SubagentStop で SV に知らせる
append "$B/inbox.md" "AFTER-SUBMIT"
run "$(mk $S PostToolUse r1 StructuredOutput '{}')"
assert_empty "T-2 提出の後の PostToolUse では差し込まない" "$OUT"
run "$(mk $S SubagentStop r1 '' '{}')"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_has "T-2 提出の後に届いた連絡は未読を残して終了として SV に出る" "$(ctx)" "未読の連絡を残して終了しました"

# ---------------------------------------------------------------- T-3
S=s3
B=$(new_box run3 design)
ST=$(state_of $S)
run "$(mk $S PreToolUse d1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PreToolUse d1 Bash "$(ti_cmd 'echo status-check')")"
case "$(cat "$B/status")" in
  "running "[0-9]*" Bash echo status-check") pass ;;
  *) fail "T-3 PreToolUse の status（実際: $(cat "$B/status")）" ;;
esac
run "$(mk $S PostToolUse d1 Bash "$(ti_cmd 'echo status-check')")"
case "$(cat "$B/status")" in "idle "[0-9]*) pass ;; *) fail "T-3 PostToolUse の status" ;; esac
printf 'running 1 Bash x\n' > "$B/status"
run "$(mk $S PostToolUseFailure d1 Read "$(ti_file "$B/nothing")")"
case "$(cat "$B/status")" in "idle "[0-9]*) pass ;; *) fail "T-3 PostToolUseFailure の status" ;; esac

# 未読を残した SubagentStop
append "$B/inbox.md" "LEFT-UNREAD"
run "$(mk $S SubagentStop d1 '' '{}')"
case "$(cat "$B/status")" in "done "[0-9]*) pass ;; *) fail "T-3 SubagentStop の status" ;; esac
assert_file "T-3 SubagentStop の done の印" "$ST/agents/d1/done"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_has "T-3 未読を残して終了した知らせ" "$(ctx)" "未読の連絡を残して終了しました"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_empty "T-3 知らせは 1 回だけ" "$OUT"

# 同じフォルダの引き継ぎ（修正ループのラウンド）
S=s3b
B=$(new_box run3b design)
ST=$(state_of $S)
run "$(mk $S PreToolUse p1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse p1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S SubagentStop p1 '' '{}')"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_file "T-3 引き継ぎ: 1 人目に retired" "$ST/agents/p1/retired"
run "$(mk $S PreToolUse p2 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_nofile "T-3 引き継ぎ: 2 人目に retired が付かない（status が done のまま）" "$ST/agents/p2/retired"
append "$B/outbox.md" "## #1 design → SV${NL}ROUND2-REPORT"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_has "T-3 引き継ぎ: 2 人目の outbox が SV に出る" "$(ctx)" "ROUND2-REPORT"

# outbox の新着
S=s3c
B=$(new_box run3c design)
run "$(mk $S PreToolUse c1 Read "$(ti_file "$B/inbox.md")")"
append "$B/outbox.md" "## #1 design → SV${NL}OUTBOX-ENTRY"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_has "T-3 SV に outbox の新着" "$(ctx)" "OUTBOX-ENTRY"
assert_has "T-3 見出しに wf/run/担当" "$(ctx)" "受信] wf-sv-design/run3c/design"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_empty "T-3 SV への新着は二度出ない" "$OUT"
append "$B/outbox.md" "## #2 design → SV${NL}AFTER-FAILURE"
run "$(mk $S PostToolUseFailure '' Read "$(ti_file "$T/nothing")")"
assert_has "T-3 SV のツールが失敗した後にも新着を出す" "$(ctx)" "AFTER-FAILURE"
printf 'SHORT\n' > "$B/outbox.md"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_has "T-3 縮んだ outbox は書き換えの注記" "$(ctx)" "書き換えられた"
assert_has "T-3 縮んだ outbox は全体を渡す" "$(ctx)" "SHORT"
LINE=0123456789012345678901234567890123456789012345678901234567890123456789012345678
LINE_BYTES=$(( ${#LINE} + 1 ))
# 見出し・前置きの分の余裕（設計値）
HEADER_ALLOWANCE=200
MORE_BYTES=$(printf '%s' "(続きは $B/outbox.md を Read)" | wc -c)
i=0
while [ $i -lt $((CAP_BYTES / LINE_BYTES * 4)) ]; do printf '%s\n' "$LINE" >> "$B/outbox.md"; i=$((i + 1)); done
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_has "T-3 長い追記は切って続きの案内" "$(ctx)" "続きは $B/outbox.md を Read"
if [ "$(ctx | wc -c | tr -d ' ')" -le $((CAP_BYTES + MORE_BYTES + HEADER_ALLOWANCE)) ]; then pass; else fail "T-3 切った後の大きさ"; fi
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'true')")"
assert_empty "T-3 切った範囲は位置が進み再送されない" "$OUT"

# ---------------------------------------------------------------- T-4
# 何もしない経路
mkdir -p "$SROOT/other-session"
run "$(mk s4none PostToolUse '' Bash "$(ti_cmd 'ls')")"
assert_eq "T-4 状態の無いセッション: 終了コード" 0 "$RC"
assert_empty "T-4 状態の無いセッション: 出力なし" "$OUT"
assert_nofile "T-4 状態の無いセッションの状態は作らない" "$(state_of s4none)"

mkdir -p "$T/fakebin"
printf '#!/bin/sh\n: > "%s/jq-called"\nexit 0\n' "$T" > "$T/fakebin/jq"
chmod +x "$T/fakebin/jq"
rm -f "$T/jq-called"
printf '%s' "$(mk s4none PostToolUse '' Bash "$(ti_cmd 'ls')")" | PATH="$T/fakebin:$PATH" sh "$HOOK" >/dev/null 2>&1
assert_nofile "T-4 別セッションの状態があっても jq を起動しない" "$T/jq-called"
printf '%s' "$(mk s4none PreToolUse a1 Read "$(ti_file "$T/x/mailbox/n/inbox.md")")" | PATH="$T/fakebin:$PATH" sh "$HOOK" >/dev/null 2>&1
assert_file "T-4 対照: mailbox/ を含む入力では jq を起動する" "$T/jq-called"
rm -f "$T/jq-called"

# 肯定側: 状態があるセッションで mailbox/ を含まない入力
S=s4
B=$(new_box run4 omega)
ST=$(state_of $S)
run "$(mk $S PreToolUse o1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse o1 Read "$(ti_file "$B/inbox.md")")"
append "$B/inbox.md" "PLAIN-JSON"
run "$(mk $S PostToolUse o1 Bash "$(ti_cmd 'echo hi')")"
assert_has "T-4 肯定側: 結び付け済みの担当の Bash の PostToolUse" "$(ctx)" "PLAIN-JSON"
append "$B/outbox.md" "## #1 omega → SV${NL}SV-SIDE-PLAIN"
run "$(mk $S PostToolUse '' Bash "$(ti_cmd 'echo hi')")"
assert_has "T-4 肯定側: SV の PostToolUse" "$(ctx)" "SV-SIDE-PLAIN"

append "$B/inbox.md" "SPACED-KEY"
run '{"session_id" : "s4","hook_event_name":"PostToolUse","agent_id":"o1","tool_name":"Bash","tool_input":{"command":"echo hi"},"cwd":"/"}'
assert_has "T-4 肯定側: キーと値の間に空白" "$(ctx)" "SPACED-KEY"

append "$B/inbox.md" "NESTED-BEFORE"
run '{"tool_response":{"session_id":"nostate-x"},"session_id":"s4","hook_event_name":"PostToolUse","agent_id":"o1","tool_name":"Bash","tool_input":{"command":"echo hi"},"cwd":"/"}'
assert_has "T-4 肯定側: 入れ子の session_id が前" "$(ctx)" "NESTED-BEFORE"
append "$B/inbox.md" "NESTED-AFTER"
run '{"session_id":"s4","hook_event_name":"PostToolUse","agent_id":"o1","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_response":{"session_id":"nostate-y"},"cwd":"/"}'
assert_has "T-4 肯定側: 入れ子の session_id が後" "$(ctx)" "NESTED-AFTER"

# 結び付けていない担当・壊れた入力
run "$(mk $S PostToolUse stranger Bash "$(ti_cmd 'echo hi')")"
assert_empty "T-4 結び付けていない担当の PostToolUse: 出力なし" "$OUT"
assert_eq "T-4 結び付けていない担当の PostToolUse: 終了コード" 0 "$RC"
run 'not json {'
assert_empty "T-4 壊れた JSON: 出力なし" "$OUT"
assert_eq "T-4 壊れた JSON: 終了コード" 0 "$RC"
run '{"session_id":"s4","hook_event_name":"PostToolUse","agent_id":"o1","tool_input":'
assert_empty "T-4 途中で切れた JSON: 出力なし" "$OUT"
assert_eq "T-4 途中で切れた JSON: 終了コード" 0 "$RC"

mkdir -p "$T/nojq"
for c in cat grep tr wc head tail date mkdir id find rm sleep ps kill; do
  p=$(command -v "$c") && ln -sf "$p" "$T/nojq/$c"
done
append "$B/inbox.md" "NO-JQ"
OUT=$(printf '%s' "$(mk $S PreToolUse o1 Read "$(ti_file "$B/inbox.md")")" | PATH="$T/nojq" /bin/sh "$HOOK" 2>/dev/null)
RC=$?
assert_empty "T-4 jq が無い: 出力なし" "$OUT"
assert_eq "T-4 jq が無い: 終了コード" 0 "$RC"

# 自分だけが使える置き場でなければ何もしない
BS=$(new_box run4s sigma)
mkdir -m 755 "$T/open-root"
OUT=$(printf '%s' "$(mk s4s PreToolUse z1 Read "$(ti_file "$BS/inbox.md")")" | SV_MAILBOX_STATE_DIR=$T/open-root sh "$HOOK" 2>/dev/null)
assert_nofile "T-4 他人も入れる置き場には書かない" "$T/open-root/s4s"
mkdir -m 700 "$T/real-root"
ln -s "$T/real-root" "$T/link-root"
OUT=$(printf '%s' "$(mk s4s PreToolUse z1 Read "$(ti_file "$BS/inbox.md")")" | SV_MAILBOX_STATE_DIR=$T/link-root sh "$HOOK" 2>/dev/null)
assert_nofile "T-4 シンボリックリンクの置き場には書かない" "$T/real-root/s4s"
OUT=$(printf '%s' "$(mk s4s PreToolUse z1 Read "$(ti_file "$BS/inbox.md")")" | SV_MAILBOX_STATE_DIR=$T/new-root sh "$HOOK" 2>/dev/null)
assert_file "T-4 置き場が無ければ自分だけの権限で作って使う" "$T/new-root/s4s/agents/z1/box"
case "$(ls -ld "$T/new-root")" in drwx------*) pass ;; *) fail "T-4 作った置き場の権限が 700 でない" ;; esac

# ---------------------------------------------------------------- T-5
S=s5none
mkdir -p "$SROOT/other-session"
IN=$(mk $S PostToolUse '' Bash "$(ti_cmd 'ls')")
t0=$(now_ms)
i=0
while [ $i -lt 100 ]; do printf '%s' "$IN" | sh "$HOOK" >/dev/null 2>&1; i=$((i + 1)); done
t1=$(now_ms)
AVG0=$(((t1 - t0) / 100))
echo "T-5 連絡帳を使っていない入力の平均: ${AVG0} ms"
[ "$AVG0" -lt 20 ] || echo "警告: 目安の 20 ms を超えています（機械の差が大きいため失敗扱いにはしません）"

S=s5big
ST=$(state_of $S)
i=0
while [ $i -lt 50 ]; do
  mkdir -p "$ST/agents/b$i" "$RUNS/wf-sv-design/run5/mailbox/b$i"
  printf '%s\n' "$RUNS/wf-sv-design/run5/mailbox/b$i" > "$ST/agents/b$i/box"
  : > "$ST/agents/b$i/done"
  i=$((i + 1))
done
S0=s5zero
mkdir -p "$(state_of $S0)"
IN50=$(mk $S PostToolUse '' Bash "$(ti_cmd 'ls')")
IN0=$(mk $S0 PostToolUse '' Bash "$(ti_cmd 'ls')")
printf '%s' "$IN50" | sh "$HOOK" >/dev/null 2>&1
ret=0
i=0
while [ $i -lt 50 ]; do [ -e "$ST/agents/b$i/retired" ] && ret=$((ret + 1)); i=$((i + 1)); done
assert_eq "T-5 最初の走査で終わった 50 人に retired が付く" 50 "$ret"
# retired の担当は走査の対象外（新着があっても拾わない）
append "$RUNS/wf-sv-design/run5/mailbox/b0/outbox.md" "RETIRED-NOT-SCANNED"
OUT=$(printf '%s' "$IN50" | sh "$HOOK" 2>/dev/null)
assert_lacks "T-5 retired の担当は走査しない" "$OUT" "RETIRED-NOT-SCANNED"
t0=$(now_ms)
i=0
while [ $i -lt 100 ]; do printf '%s' "$IN50" | sh "$HOOK" >/dev/null 2>&1; i=$((i + 1)); done
t1=$(now_ms)
i=0
while [ $i -lt 100 ]; do printf '%s' "$IN0" | sh "$HOOK" >/dev/null 2>&1; i=$((i + 1)); done
t2=$(now_ms)
AVG50=$(((t1 - t0) / 100))
AVGZ=$(((t2 - t1) / 100))
echo "T-5 SV の PostToolUse の平均: 終わった担当 50 人 ${AVG50} ms / 0 人 ${AVGZ} ms"
[ $((AVG50 - AVGZ)) -lt 20 ] || echo "警告: 終わった担当の有無で差が大きいです（失敗扱いにはしません）"

# ---------------------------------------------------------------- T-7
export SV_MAILBOX_REARM_SEC=3
export SV_MAILBOX_LONG_SEC=2
STOP_WF() { jq -cn --arg sid "$1" '{session_id: $sid, hook_event_name: "Stop", background_tasks: [{type: "workflow", status: "running", name: "sv-design"}]}'; }
STOP_OTHERWF() { jq -cn --arg sid "$1" '{session_id: $sid, hook_event_name: "Stop", background_tasks: [{type: "workflow", status: "running", name: "my-own-workflow"}]}'; }
STOP_NOWF() { jq -cn --arg sid "$1" '{session_id: $sid, hook_event_name: "Stop", background_tasks: []}'; }

# バックグラウンドで waker を張る。$! を WPID に入れる
start_waker() { # sid tag
  STOP_WF "$1" > "$T/$2.in"
  sh "$HOOK" < "$T/$2.in" > "$T/$2.out" 2> "$T/$2.err" &
  WPID=$!
  BGPIDS="$BGPIDS $WPID"
}
wait_for() { # 秒数 条件コマンド…
  _n=$(($1 * 10)); shift
  while [ "$_n" -gt 0 ]; do
    "$@" && return 0
    sleep 0.2 2>/dev/null || sleep 1
    _n=$((_n - 2))
  done
  return 1
}
dead() { ! kill -0 "$1" 2>/dev/null; }
exists() { [ -e "$1" ]; }
finish() { # pid → 終了コードを RC に
  wait_for 10 dead "$1"
  wait "$1" 2>/dev/null
  RC=$?
}

# wf が無い Stop
S=s7a
mkdir -p "$(state_of $S)"
STOP_NOWF $S > "$T/nowf.in"
OUT=$(sh "$HOOK" < "$T/nowf.in" 2>/dev/null); RC=$?
assert_eq "T-7 wf 無しの Stop: 終了コード" 0 "$RC"
assert_nofile "T-7 wf 無しの Stop: waker.pid が残らない" "$(state_of $S)/waker.pid"
STOP_OTHERWF $S > "$T/otherwf.in"
t0=$(date +%s)
OUT=$(sh "$HOOK" < "$T/otherwf.in" 2>/dev/null); RC=$?
t1=$(date +%s)
assert_eq "T-7 SV 以外の wf だけが動いている Stop: 終了コード" 0 "$RC"
if [ $((t1 - t0)) -le 1 ]; then pass; else fail "T-7 SV 以外の wf だけが動いている Stop がすぐ終わらない"; fi
assert_nofile "T-7 SV 以外の wf だけが動いている Stop: waker を張らない" "$(state_of $S)/waker.pid"

# 名前の無い wf は SV モードの wf とみなして張る（見張りの取りこぼしより起床の重複を選ぶ）
S=s7n
mkdir -p "$(state_of $S)"
jq -cn --arg sid $S '{session_id: $sid, hook_event_name: "Stop", background_tasks: [{type: "workflow", status: "running"}]}' > "$T/noname.in"
sh "$HOOK" < "$T/noname.in" > /dev/null 2>&1 &
NPID=$!
BGPIDS="$BGPIDS $NPID"
wait_for 3 exists "$(state_of $S)/waker.pid"
assert_file "T-7 名前の無い wf の Stop: waker を張る" "$(state_of $S)/waker.pid"
STOP_NOWF $S | sh "$HOOK" >/dev/null 2>&1
wait_for 3 dead "$NPID"
wait "$NPID" 2>/dev/null

# 動いている waker は wf 無しの Stop で止まる
start_waker $S w1
wait_for 3 exists "$(state_of $S)/waker.pid"
assert_file "T-7 waker.pid が書かれる" "$(state_of $S)/waker.pid"
# waker が動いている間の 2 つ目の Stop はすぐ 0
STOP_WF $S > "$T/second.in"
t0=$(date +%s)
sh "$HOOK" < "$T/second.in" > "$T/second.out" 2>&1; RC=$?
t1=$(date +%s)
assert_eq "T-7 動いている間の 2 つ目の Stop: 終了コード" 0 "$RC"
if [ $((t1 - t0)) -le 1 ]; then pass; else fail "T-7 2 つ目の Stop がすぐ終わらない"; fi
assert_empty "T-7 2 つ目の Stop: 出力なし" "$(cat "$T/second.out")"
sh "$HOOK" < "$T/nowf.in" >/dev/null 2>&1
wait_for 3 dead "$WPID"
if dead "$WPID"; then pass; else fail "T-7 wf 無しの Stop で動いている waker が止まる"; fi
wait "$WPID" 2>/dev/null
assert_nofile "T-7 止めた後に waker.pid が残らない" "$(state_of $S)/waker.pid"

# 張り直しの起床（担当なし）
S=s7b
mkdir -p "$(state_of $S)"
t0=$(date +%s)
start_waker $S w2
finish "$WPID"
t1=$(date +%s)
assert_eq "T-7 担当がいなくても張り直しは終了コード 2" 2 "$RC"
assert_has "T-7 担当がいない場合の知らせ" "$(cat "$T/w2.err")" "まだ連絡帳に結び付いた担当はいない"
assert_has "T-7 新着なしの知らせ" "$(cat "$T/w2.err")" "新着なし"
if [ $((t1 - t0)) -le $((SV_MAILBOX_REARM_SEC * 2)) ]; then pass; else fail "T-7 張り直しの秒数"; fi
assert_nofile "T-7 終了後に waker.pid が残らない" "$(state_of $S)/waker.pid"

# 張り直しの起床（担当あり）
S=s7c
B=$(new_box run7c worker)
run "$(mk $S PreToolUse k1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse k1 Read "$(ti_file "$B/inbox.md")")"
start_waker $S w3
finish "$WPID"
assert_eq "T-7 張り直し（担当あり）: 終了コード 2" 2 "$RC"
assert_has "T-7 担当の status の一覧" "$(cat "$T/w3.err")" "worker: idle"

# outbox の新着で起きる
S=s7d
B=$(new_box run7d worker)
run "$(mk $S PreToolUse k1 Read "$(ti_file "$B/inbox.md")")"
run "$(mk $S PostToolUse k1 Read "$(ti_file "$B/inbox.md")")"
start_waker $S w4
wait_for 3 exists "$(state_of $S)/waker.pid"
sleep 1
append "$B/outbox.md" "## #1 worker → SV${NL}WAKE-ME"
finish "$WPID"
assert_eq "T-7 outbox の追記で終了コード 2" 2 "$RC"
assert_has "T-7 stderr に新着" "$(cat "$T/w4.err")" "WAKE-ME"

# 長いコマンド
S=s7e
B=$(new_box run7e worker)
run "$(mk $S PreToolUse k1 Read "$(ti_file "$B/inbox.md")")"
printf 'running %s Bash sleep-forever\n' "$(($(now) - 10))" > "$B/status"
start_waker $S w5
finish "$WPID"
assert_eq "T-7 長いコマンドで終了コード 2" 2 "$RC"
assert_has "T-7 長いコマンドの知らせ" "$(cat "$T/w5.err")" "同じコマンドを実行中"
assert_has "T-7 長いコマンドの要約" "$(cat "$T/w5.err")" "sleep-forever"
start_waker $S w6
finish "$WPID"
assert_eq "T-7 同じコマンドの 2 回目は張り直しで終わる" 2 "$RC"
assert_lacks "T-7 同じコマンドは 2 回知らせない" "$(cat "$T/w6.err")" "同じコマンドを実行中"
assert_has "T-7 2 回目は新着なしの知らせ" "$(cat "$T/w6.err")" "新着なし"

# 最初の Stop: 状態ディレクトリも結び付けも無い
S=s7f
start_waker $S w7
wait_for 3 exists "$(state_of $S)/waker.pid"
assert_file "T-7 最初の Stop で waker が張られる" "$(state_of $S)/waker.pid"
B=$(new_box run7f worker)
run "$(mk $S PreToolUse k1 Read "$(ti_file "$B/inbox.md")")"
sleep 1
append "$B/outbox.md" "## #1 worker → SV${NL}LATE-BIND"
finish "$WPID"
assert_eq "T-7 後から結び付いた担当の新着で終了コード 2" 2 "$RC"
assert_has "T-7 後から結び付いた担当の新着" "$(cat "$T/w7.err")" "LATE-BIND"

# 古い pid ファイル
S=s7g
mkdir -p "$(state_of $S)"
sleep 300 &
SLP=$!
BGPIDS="$BGPIDS $SLP"
printf '%s Mon Jan  1 00:00:00 2001\n' "$SLP" > "$(state_of $S)/waker.pid"
STOP_NOWF $S > "$T/nowf-g.in"
printf '%s Mon Jan  1 00:00:00 2001\n' "$SLP" > "$(state_of $S)/waker.pid"
sh "$HOOK" < "$T/nowf-g.in" >/dev/null 2>&1
if kill -0 "$SLP" 2>/dev/null; then pass; else fail "T-7 古い pid の無関係なプロセスを kill した"; fi
assert_nofile "T-7 古い pid ファイルは消える" "$(state_of $S)/waker.pid"
printf '%s Mon Jan  1 00:00:00 2001\n' "$SLP" > "$(state_of $S)/waker.pid"
start_waker $S w8
OLDW=$WPID
wait_for 3 exists "$(state_of $S)/waker.pid"
sleep 1
rec=$(cat "$(state_of $S)/waker.pid")
assert_has "T-7 古い pid の後に新しい waker が張られる" "$rec" "$OLDW "
if kill -0 "$SLP" 2>/dev/null; then pass; else fail "T-7 新しい waker を張る際に無関係なプロセスを kill した"; fi
sh "$HOOK" < "$T/nowf-g.in" >/dev/null 2>&1
wait_for 3 dead "$OLDW"
wait "$OLDW" 2>/dev/null

# ----------------------------------------------------------------
if [ -n "$FAILED" ]; then
  echo "NG: 失敗した項目:$FAILED"
  exit 1
fi
echo "OK ($N 件)"
exit 0

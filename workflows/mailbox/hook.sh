#!/bin/sh
# SV モードの連絡帳フック（担当側・SV 側・waker）。設定からは sh <パス> で呼ぶ。

# 設計値
DEFAULT_LONG_SEC=300
DEFAULT_REARM_SEC=1800
CAP_BYTES=8000
POLL_SEC=2
KEEP_DAYS=2

LONG_SEC=${SV_MAILBOX_LONG_SEC:-$DEFAULT_LONG_SEC}
REARM_SEC=${SV_MAILBOX_REARM_SEC:-$DEFAULT_REARM_SEC}
case "$LONG_SEC" in ''|*[!0-9]*) LONG_SEC=$DEFAULT_LONG_SEC ;; esac
case "$REARM_SEC" in ''|*[!0-9]*) REARM_SEC=$DEFAULT_REARM_SEC ;; esac

NL='
'

JQ_PROG='
(.cwd // "") as $cwd
| (.tool_input | if type == "object" then . else {} end) as $ti
| def absp: if startswith("/") then . elif startswith("~/") then ($ENV.HOME + .[1:])
    elif startswith("$HOME/") then ($ENV.HOME + .[5:]) elif startswith("${HOME}/") then ($ENV.HOME + .[7:])
    else ($cwd + "/" + .) end;
  def ismbx: test("/wf-sv-[^/]+/[^/]+/mailbox/[^/]+/(inbox|outbox)\\.md$");
  ($ti.file_path // "" | tostring) as $fp
| ($ti.command // "" | tostring) as $cmd
| (if $fp == "" then "" else ($fp | absp) end) as $fabs
| (if ($fabs | ismbx) then $fabs
   elif $cmd != "" then
     ([$cmd | match("[^\\s\"\\x27();|&<>=]*wf-sv-[^/\\s\"\\x27();|&<>=]+/[^/\\s\"\\x27();|&<>=]+/mailbox/[^/\\s\"\\x27();|&<>=]+/(inbox|outbox)\\.md"; "g") | .string]
      | (.[0] // "") | if . == "" then "" else absp end)
   else "" end
   | sub("/(inbox|outbox)\\.md$"; "")) as $bind
| "EV=" + ((.hook_event_name // "") | tostring | @sh),
  "AID=" + ((.agent_id // "") | tostring | @sh),
  "SID=" + ((.session_id // "") | tostring | @sh),
  "TOOL=" + ((.tool_name // "") | tostring | @sh),
  "BIND=" + ($bind | @sh),
  "BINDCMD=" + (if $bind != "" and ($fabs | ismbx | not) then "1" else "0" end),
  "FABS=" + ($fabs | @sh),
  "HASRANGE=" + (if ($ti | has("offset") or has("limit")) then "1" else "0" end),
  "BG=" + (if ([(.background_tasks // [])[]? | select(.type == "workflow" and .status == "running" and ((.name // "") | tostring | . == "" or startswith("sv-")))] | length) > 0 then "1" else "0" end),
  "SUMMARY=" + ((if $cmd != "" then $cmd else $fp end) | gsub("[\\r\\n]"; " ") | .[0:80] | @sh)
'

getsize() {
  SZ=0
  if [ -f "$1" ]; then
    SZ=$(wc -c < "$1")
    SZ=$((SZ))
  fi
}

readnum() {
  NUM=0
  [ -f "$1" ] && IFS= read -r NUM < "$1"
  case "$NUM" in ''|*[!0-9]*) NUM=0 ;; esac
}

# $1 ファイル、$2 位置ファイル。未読を TAKEN に入れて位置を進める。未読が無ければ 1
take_new() {
  TAKEN=
  readnum "$2"
  from=$NUM
  getsize "$1"
  size=$SZ
  note=
  if [ "$size" -lt "$from" ]; then
    from=0
    note="ファイルが書き換えられたため全体を渡す${NL}"
  fi
  if [ "$size" -le "$from" ]; then
    [ "$size" -eq "$NUM" ] || printf '%s\n' "$size" > "$2"
    return 1
  fi
  cut=$((size - from))
  more=
  if [ "$cut" -gt "$CAP_BYTES" ]; then
    cut=$CAP_BYTES
    more="${NL}(続きは $1 を Read)"
  fi
  body=$(tail -c +"$((from + 1))" "$1" | head -c "$cut")
  # 位置は切った所ではなく読んだ時点の大きさまで進める
  printf '%s\n' "$size" > "$2"
  TAKEN="$note$body$more"
  return 0
}

emit_ctx() {
  jq -n --arg e "$EV" --arg c "$1" '{hookSpecificOutput: {hookEventName: $e, additionalContext: $c}}'
}

emit_deny() {
  jq -n --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
}

label_of() {
  _b=$1
  _n=${_b##*/}
  _r=${_b%/mailbox/*}
  _id=${_r##*/}
  _p=${_r%/*}
  _w=${_p##*/}
  printf '%s/%s/%s' "$_w" "$_id" "$_n"
}

# $1 が自分の inbox.md の全体読みなら 0
self_read() {
  [ "$TOOL" = Read ] && [ "$HASRANGE" != 1 ] && [ "$FABS" = "$1/inbox.md" ]
}

bind_agent() {
  mkdir -p "$A" "$BIND" 2>/dev/null
  [ -e "$BIND/inbox.md" ] || : > "$BIND/inbox.md"
  pos=0
  # 大きさは Read の前の PreToolUse で取る。Read までに足された分は重複側に倒れ、取りこぼさない
  if self_read "$BIND"; then
    getsize "$BIND/inbox.md"
    pos=$SZ
  fi
  printf '%s\n' "$pos" > "$A/read"
  printf '%s\n' "$BIND" > "$A/box"
  rm -f "$STATE/alive"
  date +%s > "$STATE/alive"
  find "$STATE_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" 2>/dev/null | while IFS= read -r old; do
    { [ -e "$old/alive" ] || [ -d "$old/agents" ]; } && rm -rf "$old"
  done
}

agent_side() {
  A=$STATE/agents/$AID
  if [ ! -f "$A/box" ]; then
    # コマンドから取ったパスは空白などで切れて誤りうるので、run ディレクトリが実在するときだけ結び付ける
    if [ "$BINDCMD" = 1 ] && [ ! -d "${BIND%/mailbox/*}" ]; then
      return 0
    fi
    if [ "$EV" = PreToolUse ] && [ -n "$BIND" ]; then
      bind_agent
    fi
    return 0
  fi
  box=
  IFS= read -r box < "$A/box"
  [ -n "$box" ] || return 0

  case "$EV" in
    PreToolUse)
      if [ "$TOOL" = StructuredOutput ]; then
        # 位置を進めてから deny するので、同じ未読で提出を何度も止めない
        if take_new "$box/inbox.md" "$A/read"; then
          emit_deny "返り値を提出する前の時点で、SV から連絡帳の inbox（$box/inbox.md）に未読の連絡が届いています。連絡帳の規則に沿って対応した後で、返り値を提出し直せます:${NL}$TAKEN"
          return 0
        fi
      elif self_read "$box"; then
        # Bash や部分読みでは中身が担当の文脈に入ったと言えないので、全体読みでだけ進める
        getsize "$box/inbox.md"
        printf '%s\n' "$SZ" > "$A/read"
      fi
      printf 'running %s %s %s\n' "$(date +%s)" "$TOOL" "$SUMMARY" > "$box/status"
      ;;
    PostToolUse|PostToolUseFailure)
      printf 'idle %s\n' "$(date +%s)" > "$box/status"
      # 提出の後は担当が作業を続けないので既読を進めず、未読は SubagentStop で SV に知らせる
      [ "$TOOL" = StructuredOutput ] && return 0
      ctx=
      if [ ! -e "$A/announced" ]; then
        : > "$A/announced"
        ctx="連絡帳のフックが有効です。以降、inbox の新着はツール実行の後にこの形で届きます。"
      fi
      if take_new "$box/inbox.md" "$A/read"; then
        ctx="${ctx:+$ctx$NL$NL}SV（この作業の依頼元）から連絡帳の inbox（$box/inbox.md）に新しい連絡が届いています:${NL}$TAKEN"
      fi
      [ -n "$ctx" ] && emit_ctx "$ctx"
      ;;
    SubagentStop)
      printf 'done %s\n' "$(date +%s)" > "$box/status"
      : > "$A/done"
      getsize "$box/inbox.md"
      readnum "$A/read"
      if [ "$SZ" -gt "$NUM" ]; then
        printf '担当 %s が未読の連絡を残して終了しました%s' "${box##*/}" "$NL" >> "$STATE/notices"
      fi
      ;;
  esac
  return 0
}

# $1 担当フォルダ。outbox の新着と長いコマンドを out に足す
box_news() {
  bx=$1
  if take_new "$bx/outbox.md" "$bx/.sv-read"; then
    out="$out[$hhmm 受信] $(label_of "$bx")${NL}$TAKEN${NL}"
  fi
  if [ -f "$bx/status" ]; then
    st=; since=; rest=
    IFS=' ' read -r st since rest < "$bx/status"
    if [ "$st" = running ]; then
      case "$since" in
        ''|*[!0-9]*) ;;
        *)
          el=$((now - since))
          if [ "$el" -ge "$LONG_SEC" ] && ! grep -Fqx "$bx $since" "$STATE/long-reported" 2>/dev/null; then
            printf '%s %s\n' "$bx" "$since" >> "$STATE/long-reported"
            out="${out}担当 ${bx##*/} が ${el} 秒、同じコマンドを実行中です: $rest${NL}"
          fi
          ;;
      esac
    fi
  fi
}

sv_news() {
  out=
  seen=$NL
  now=$(date +%s)
  hhmm=$(date +%H:%M)
  for af in "$STATE"/agents/*/; do
    [ -d "$af" ] || continue
    [ -e "${af}retired" ] && continue
    [ -f "${af}box" ] || continue
    b=
    IFS= read -r b < "${af}box"
    [ -n "$b" ] || continue
    case "$seen" in
      *"$NL$b$NL"*) ;;
      *)
        seen="$seen$b$NL"
        box_news "$b"
        ;;
    esac
    # 終了の判定は共有の status ではなく担当ごとの done の印で行う（前のラウンドの done で新しい担当を外さないため）
    if [ -e "${af}done" ]; then
      getsize "$b/outbox.md"
      osz=$SZ
      readnum "$b/.sv-read"
      [ "$NUM" -ge "$osz" ] && : > "${af}retired"
    fi
  done
  if take_new "$STATE/notices" "$STATE/notices.read"; then
    out="$out$TAKEN${NL}"
  fi
  printf '%s' "$out"
}

rearm_report() {
  list=
  seen=$NL
  for af in "$STATE"/agents/*/; do
    [ -d "$af" ] || continue
    [ -e "${af}retired" ] && continue
    [ -f "${af}box" ] || continue
    b=
    IFS= read -r b < "${af}box"
    [ -n "$b" ] || continue
    case "$seen" in
      *"$NL$b$NL"*) continue ;;
    esac
    seen="$seen$b$NL"
    s="(状態なし)"
    [ -f "$b/status" ] && IFS= read -r s < "$b/status"
    list="$list- ${b##*/}: $s${NL}"
  done
  if [ -n "$list" ]; then
    printf '新着なし（見張りの張り直し）。担当の状態:\n%s' "$list"
  else
    printf '新着なし（見張りの張り直し）。まだ連絡帳に結び付いた担当はいない\n'
  fi
}

trim() {
  _t=$1
  _t=${_t#"${_t%%[![:space:]]*}"}
  _t=${_t%"${_t##*[![:space:]]}"}
  TRIMMED=$_t
}

# 動いている waker なら 0 で WPID に pid を入れる。古い記録は消して 1
waker_alive() {
  [ -f "$STATE/waker.pid" ] || return 1
  rec=
  IFS= read -r rec < "$STATE/waker.pid"
  wpid=${rec%% *}
  wstart=${rec#* }
  case "$wpid" in ''|*[!0-9]*) rm -f "$STATE/waker.pid"; return 1 ;; esac
  # pid の再利用で無関係のプロセスを止めないよう、開始時刻と command まで照合する
  info=$(ps -p "$wpid" -o lstart= -o command= 2>/dev/null)
  trim "$info"
  info=$TRIMMED
  trim "$wstart"
  wstart=$TRIMMED
  case "$info" in
    "$wstart"*mailbox/hook.sh*) WPID=$wpid; return 0 ;;
  esac
  rm -f "$STATE/waker.pid"
  return 1
}

waker_cleanup() {
  rec=
  [ -f "$STATE/waker.pid" ] && IFS= read -r rec < "$STATE/waker.pid"
  case "$rec" in "$$ "*) rm -f "$STATE/waker.pid" ;; esac
}

run_waker() {
  printf '%s %s\n' "$$" "$(ps -p "$$" -o lstart= 2>/dev/null)" > "$STATE/waker.pid"
  trap waker_cleanup EXIT
  trap 'exit 143' TERM INT HUP
  t0=$(date +%s)
  while :; do
    news=$(sv_news)
    if [ -n "$news" ]; then
      printf '連絡帳の新着:\n%s\n' "$news" >&2
      exit 2
    fi
    el=$(($(date +%s) - t0))
    if [ "$el" -ge "$REARM_SEC" ]; then
      # 0 で終わると待機中の SV は起きず次の Stop も来ないので、wf の実行中は張り直しでも 2 で起こす
      rearm_report >&2
      exit 2
    fi
    rem=$((REARM_SEC - el))
    [ "$rem" -gt "$POLL_SEC" ] && rem=$POLL_SEC
    sleep "$rem"
  done
}

sv_side() {
  case "$EV" in
    PostToolUse|PostToolUseFailure)
      news=$(sv_news)
      [ -n "$news" ] && emit_ctx "連絡帳の新着:${NL}$news"
      ;;
    Stop)
      if [ "$BG" != 1 ]; then
        if waker_alive; then
          kill "$WPID" 2>/dev/null
          rm -f "$STATE/waker.pid"
        fi
        return 0
      fi
      mkdir -p "$STATE" 2>/dev/null
      date +%s > "$STATE/alive"
      waker_alive && return 0
      run_waker
      ;;
  esac
  return 0
}

input=$(cat)

# 打ち切りの判定に jq は使わない。session_id がちょうど 1 回だけ現れるときだけその値を使い、
# 0 回・複数回（tool_input 等の入れ子）・空は打ち切らず jq の経路に回す（取り出しの誤りで黙って効かなくなるのを防ぐ）
sid=
m=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"')
case "$m" in
  ''|*"$NL"*) ;;
  *)
    v=${m#*:}
    v=${v#*\"}
    sid=${v%\"}
    ;;
esac
case "$sid" in */*|.|..) sid= ;; esac

# SV_MAILBOX_STATE_DIR は test-hook.sh 用
STATE_ROOT=${SV_MAILBOX_STATE_DIR:-${TMPDIR:-/tmp}/sv-mailbox-$(id -u)}

# 共有の /tmp に落ちたとき他のユーザに置き場を差し替えられないよう、自分だけが使える置き場でなければ何もしない
secure_root() {
  [ -e "$STATE_ROOT" ] || mkdir -m 700 "$STATE_ROOT" 2>/dev/null || return 1
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] && [ -O "$STATE_ROOT" ] || return 1
  case "$(ls -ld "$STATE_ROOT" 2>/dev/null)" in drwx------*) return 0 ;; esac
  return 1
}

if [ -n "$sid" ]; then
  case "$input" in
    *mailbox/*|*'"Stop"'*) ;;
    # Stop は打ち切らない。最初の Stop では状態ディレクトリも結び付けも無い
    *) [ -d "$STATE_ROOT/$sid" ] || exit 0 ;;
  esac
fi

command -v jq >/dev/null 2>&1 || exit 0

EV=; AID=; SID=; TOOL=; BIND=; BINDCMD=0; FABS=; HASRANGE=0; BG=0; SUMMARY=
vars=$(printf '%s' "$input" | jq -r "$JQ_PROG" 2>/dev/null) || exit 0
eval "$vars"

case "$SID" in ''|*/*|.|..) exit 0 ;; esac
case "$AID" in */*|.|..) exit 0 ;; esac
STATE=$STATE_ROOT/$SID

if [ "$EV" != Stop ] && [ ! -d "$STATE" ]; then
  [ "$EV" = PreToolUse ] && [ -n "$AID" ] && [ -n "$BIND" ] || exit 0
fi
secure_root || exit 0

# 担当の状態は担当のフックにも親の session_id が付くことを前提に、セッションごとに分けている
if [ -n "$AID" ]; then
  agent_side
else
  sv_side
fi

# waker の起床以外は常に 0 で終える。途中の失敗で 2 が漏れると PreToolUse ではツール実行が止まる
exit 0

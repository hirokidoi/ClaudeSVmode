#!/usr/bin/env bash
# _prelude.js.md の正本と、各 sv-*.js に複製した prelude が目印の間で一致するかを確かめる。
# 食い違いが 1 件でもあれば 1 を返す。
set -u

dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
canon="$dir/_prelude.js.md"
all_blocks="core review-checks diff-review-helpers diff-review-prompt selfcheck-gate"

# wf ごとに持つべきブロック
blocks_for() {
  case "$1" in
    sv-investigate|sv-explore-approach|sv-implement|sv-discuss) echo "core" ;;
    sv-prototype-ui|sv-design) echo "core review-checks" ;;
    sv-review-plan) echo "core review-checks selfcheck-gate" ;;
    sv-comprehensive-review) echo "core review-checks diff-review-helpers selfcheck-gate" ;;
    sv-review-changes) echo "core review-checks diff-review-helpers diff-review-prompt selfcheck-gate" ;;
    *) echo "" ;;
  esac
}

extract() { sed -n "/^\/\/ >>> sv-prelude:$2\$/,/^\/\/ <<< sv-prelude:$2\$/p" "$1"; }
marker_count() { grep -c "^// $2 sv-prelude:$3\$" "$1"; }

errors=0
fail() {
  echo "$1: $2: $3"
  errors=$((errors + 1))
}

if [ ! -f "$canon" ]; then
  fail "_prelude.js.md" "-" "正本が見つからない"
  echo "食い違い ${errors} 件"
  exit 1
fi

for name in $all_blocks; do
  opens=$(marker_count "$canon" '>>>' "$name")
  closes=$(marker_count "$canon" '<<<' "$name")
  if [ "$opens" != 1 ] || [ "$closes" != 1 ]; then
    fail "_prelude.js.md" "$name" "目印が 1 組ではない (開始 $opens / 終了 $closes)"
  fi
done

checked=0
for file in "$dir"/sv-*.js; do
  [ -e "$file" ] || continue
  base=$(basename "$file" .js)
  checked=$((checked + 1))
  wanted=$(blocks_for "$base")
  if [ -z "$wanted" ]; then
    fail "$base.js" "-" "持つべきブロックの表に無い wf"
    continue
  fi
  for name in $all_blocks; do
    opens=$(marker_count "$file" '>>>' "$name")
    closes=$(marker_count "$file" '<<<' "$name")
    case " $wanted " in
      *" $name "*)
        if [ "$opens" != 1 ] || [ "$closes" != 1 ]; then
          fail "$base.js" "$name" "目印が 1 組ではない (開始 $opens / 終了 $closes)"
        elif ! out=$(diff <(extract "$canon" "$name") <(extract "$file" "$name")); then
          fail "$base.js" "$name" "正本と一致しない"
          echo "$out" | sed 's/^/    /'
        fi
        ;;
      *)
        if [ "$opens" != 0 ] || [ "$closes" != 0 ]; then
          fail "$base.js" "$name" "持つべきでないブロックの目印がある"
        fi
        ;;
    esac
  done
  if sed '/^\/\/ >>> sv-prelude:/,/^\/\/ <<< sv-prelude:/d' "$file" | grep -q 'SV workflow prelude'; then
    fail "$base.js" "-" "目印の外に prelude の見出しコメントが残っている"
  fi
  meta_name=$(sed -n "s/^  name: '\([^']*\)',\$/\1/p" "$file" | head -n 1)
  wf_name=$(sed -n "s/^const _WF_NAME = '\([^']*\)'\$/\1/p" "$file")
  if [ -z "$meta_name" ] || [ "$meta_name" != "$wf_name" ]; then
    fail "$base.js" "-" "_WF_NAME が meta.name と一致しない (meta.name: ${meta_name:-なし} / _WF_NAME: ${wf_name:-なし})"
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "食い違い ${errors} 件 (確認した wf ${checked} 本)"
  exit 1
fi
echo "一致 (確認した wf ${checked} 本)"

# wf: sv-discuss

## 1. 目的・想定利用シーン

すでにある問い・選択肢を、立場を分けた論者に議論させ、制限の範囲内で判断材料か結論を出す。論者は互いの発言を読んで反論・譲歩・修正する。まとめ役がモードに応じた判断メモをまとめ、全発言を全文で並べた議事録も返す。SV はそれらを読み、ユーザに提示する。

- 選択肢や論点は出ているが、決めきれない時
- 立場を戦わせて、各案の強み・弱み・争点・それを選ぶ条件を明らかにしたい時
- 論者同士で結論まで詰めさせたい時

`sv-explore-approach` は異なる観点で案を出すのに対し、この wf は出ている問い・選択肢を戦わせる。

**進め方は 2 種類。**

- 順番制 (既定): 論者が 1 人ずつ順に発言し、直前までの発言を読んで反論できる。所要時間は人数に比例して延びる
- 並行ラウンド制: ラウンド内の論者は並行して書き、反論は次のラウンドで行う。速く、同じラウンドの他の論者に引きずられない

**wf は決定しない** — 提示モードは結論を出さない。合意モードの結論も採るかは SV が決め、前提を覆す結論は SV がユーザに上げる。

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "question": "議論する問い",
  "options": ["選択肢 1", "選択肢 2"],
  "stances": [{ "name": "advocate-a", "position": "A 案を擁護する" }],
  "mode": "present | consensus",
  "format": "sequential | parallel",
  "max_rounds": 5,
  "deadline_epoch_sec": 1900000000,
  "context": "論者に共通の背景・材料 (md のパスを含めてよい)",
  "speech_rules": "論者全員に守らせる発言の形式・縛り"
}
```

- `question`・`mode` は必須。`mode` に既定は持たない (結論を出させるかは打ち切り条件と返すものを変える判断のため)
- `options: []` は省略と同じ扱い
- `stances[].name` はファイル名・議事録のコマンドに入るので、ファイル名になる値として検査し、重複は args 構造不足
- 論者の組み立て

| 入力 | 論者 |
|---|---|
| `stances` あり | `stances` の数・順。`options` があれば全員に共通の材料として渡す |
| `stances` なし・`options` が少ない | 選択肢ごとの擁護者と、批判役 1 人 |
| `stances` なし・`options` が多め | 選択肢ごとの擁護者 |
| どちらも無し | 案を出す論者を複数人 |

- 論者の数の下限・上限、案を出す論者の数、批判役を足す選択肢数の境目、`max_rounds` の既定と上限は wf の定数。外れる入力は args 構造不足
- `max_rounds` は議論のラウンドの数で、初めの主張は数えない
- `deadline_epoch_sec` は UNIX 時刻 (秒)。SV が起動前に `date` で求めて渡す
- `speech_rules` は論者全員の「発言の決まり」の節に入り、まとめ役にも伝わる。特定の決まりを扱う機能は持たない
- `checkpoint_declarations` は受け取っても無視する (対応する名前が無い)

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation',
  summary: '<モード>・<進め方>: <打ち切りの理由> (<完了したラウンド数> ラウンド、論者 <参加中の人数> 人)',
  outputPath: '<run>/agents/summarizer.md',       // 判断メモ
  minutesPath: '<run>/agents/minutes.md' | null,  // 議事録。書記が失敗すると null
  stopReason: 'consensus' | 'exhausted' | 'max_rounds' | 'deadline',
  roundsCompleted: <議論のラウンドの完了数>,
  debaters: [{ name, stance, active }],
  roundMdPaths: [{ round, debater, mdPath, succeeded }],
  runDir: '<run>',        // escalation のとき
  escalation: {...},      // escalation のとき
}
```

- 判断メモは単一 md なので `outputPath`、発言の記録は複数 md なので `roundMdPaths`。`roundMdPaths` は論者を起動した順で、順番制では発言順。round 0 が初めの主張
- `debaters[].active: false` は初めの主張に失敗して外れた論者
- 合意したかは `stopReason` で分かる。別のフラグは持たない
- 議事録は発言の連結で、担当が要約した集約ではない (`_common.md` §4)
- 担当の起動後の escalation は、その時点の `roundMdPaths`・`debaters`・`runDir` を返す。まとめ役の失敗の escalation では、書記が成功していれば `minutesPath` も返す

**発言の md (論者が生成) の構成** (見出しは h4、タイトル行なし):
現在の立場の要約 (行数の上限は wf の定数。他の論者はこの節だけを読むことがある) / 判定 JSON / 発言 (1 行目に応答先の発言 ID。段落ごとに反論・譲歩・修正・応答の別) / 新しい論点 (あれば)

**判断メモ (まとめ役が生成) の構成:**

- 提示モード: 打ち切りの理由 / 各案 (強み・弱み・それを選ぶ条件) / 争点 / 議論の経過。結論・推奨は書かない
- 合意モードで合意: 打ち切りの理由 / 合意の内容 / 根拠 / 退けた案と理由
- 合意モードで未合意: 打ち切りの理由 / 未合意 / 合意できた点 / 残った対立 / 暫定の結論 (最も支持の強い案と、支持の数え方)

**議事録の構成:** 見出し、問い・モード・進め方・論者の一覧、ラウンドごとの節 (区切りの説明を添える)、発言ごとの節 (時刻・論者名・発言 ID の見出しに続けて、発言の md を全文)。そのラウンドに失敗した論者は「発言なし」の 1 行。並びは、順番制は発言順、並行ラウンド制はラウンド内を書き終えた時刻の順。論者以外の出力 (判断メモ) は含めない。

**論者の返り値** (判定は周の区切りでスクリプトが行う):

| フィールド | 意味 |
|---|---|
| `changed_position` | この発言で立場を変えた・修正した (要約の主張が変わったときだけ) |
| `new_points` | これまで誰も出していない論点を出した |
| `endorsed_position` | 合意モードのみ。結論として受け入れる立場の持ち主の論者名 (無ければ空文字) |
| `finished_at_epoch_sec` / `finished_at_hm` | md を書き終えた直後に `date` を 1 回実行して得た UNIX 時刻 (秒) と時:分 |

初めの主張 (round 0) の返り値は `precondition_failed` / `precondition_reason` と時刻の 2 つ。`precondition_failed` は、問いが曖昧すぎて割り振られた立場で具体的な主張にできないときだけ true。

**書記の返り値:** `exit_code` と `detail`。`exit_code` が 0 のときだけ `minutesPath` を返す。

## 4. 内部エージェント構成

```
[検査]      共通の検査 → wf 固有の検査 (論者の組み立て・数・上限値)
[初めの主張] round 0。進め方に従って全論者を起動 → 周の区切りの判定
[議論]      round 1..。進め方に従って全論者を起動 → 周の区切りの判定
[まとめ]    並列に 2 人: まとめ役 (判断メモ) と書記 (議事録)
```

**論者** (順番制は 1 人ずつ直列、並行ラウンド制はラウンド内を並列)
- ロール: designer.md を、議論に意味を持つ範囲に絞る注記つきで読ませる。割り振られた立場から始め、反論に納得したら立場を変えてよい
- 出力: loop/round-<N>-<論者名>.md

**まとめ役**
- ロール: reviewer.md を、振る舞いの原則だけに絞る注記つきで読ませる。合否・重大度・観点チェックは使わない。論者の発言に無い主張を足さない
- 出力: agents/summarizer.md

**書記**
- ロール節を持たない (`_common.md` §6)
- スクリプトが組んだ連結コマンドを Bash で 1 回、1 字も変えずに実行する。発言の中身には触れない
- 出力: agents/minutes.md

**発言順 (順番制)**: 参加中の論者の並び (組み立て順) を、ラウンドごとに 1 人分ずつ左に回す。回した並びの先頭が前のラウンドで最後に成功した発言の論者なら、先頭と 2 番目を入れ替え、境目で同じ論者が続けて発言しないようにする。論者 2 人では毎ラウンド同じ交互になる。初めの主張も進め方に従う。

**周の区切りの判定** (スクリプトが返り値だけで決める。最初に当たったものが `stopReason`):

1. 合意 (合意モードのみ): 参加中の全論者がそのラウンドに成功し、全員の `endorsed_position` が同じ参加中の論者を指し、その論者自身も自分を指して `changed_position` が false
2. 出尽くし: 参加中の全論者が成功し、全員が `changed_position` も `new_points` も false
3. ラウンドの上限
4. 時間の上限: そのラウンドで成功した論者の書き終えた時刻の最大値が締め切り以上。初めの主張の後にも判定する

- 判定をラウンドの区切りでだけ行うのは、周の途中では一部の論者の最新の意思しか無く、後に話す論者ほど不利になるため。時間の上限もラウンドの途中では切らない
- `endorsed_position` は 2 段で決める。結論として受け入れる立場が無ければ空文字。あれば、同じ内容の立場を持つ論者のうち組み立て順で最も先の論者の名前。決め方を 1 つにして、同じ内容を受け入れる全員が同じ論者を指すようにする
- 失敗した論者がいるラウンドは合意にも出尽くしにもしない。参加中の論者名でない `endorsed_position` は空文字と同じ扱い
- 時刻の比較はスクリプトが行い、担当は `date` の出力をそのまま報告するだけ。時刻が数値でなければ締め切りの判定に使わない
- 合意モードで合意せずに終わったとき、まとめ役の入力に最後のラウンドの支持の集計を渡す (初めの主張の直後に終わったときは、初めの主張から判断させる)。決めるのは SV

**読む量**: 各論者が全文を読むのは直近の発言だけ。順番制は自分の前回の成功した発言より後の全員の発言、並行ラウンド制は前のラウンドの全員の発言。それ以外の参加中の論者は、最新の発言の要約の節だけを読む。読む量は人数に比例し、ラウンド数に依存しない。順番制で直前の発言は「直前の発言」と明示する。全文の範囲が空のときは、初めの主張なら「応答先: なし」として書かせ、議論のラウンドなら新しい発言が無い旨と要約の節への応答を促す。並行ラウンド制では同じラウンドの他の論者の発言を読まない旨を明記する。

**議事録の作り方**: コマンドの値はすべて単一引用符で囲み、値の中の引用符を置き換える。担当が返した時:分は形式が合うときだけ使い、合わなければ `--:--` と表示する。発言の md の見出しが h4 のため、議事録の節の下にそのまま入る。

**モデルの役割キー**: 論者は `designer`、まとめ役と書記は `judge`。新設しない。

**連絡帳**: まとめ役だけが `summarizer` を持つ。論者と書記は持たない。論者は 1 回の発言ごとに起動する短い担当で、進み具合の報告が担当の数だけ SV を起こすため。

## 5. エスカレ条件 (wf 固有)

- args 構造不足 (担当を起動する前): 論者の数・上限値・名前の検査に該当
- 初めの主張で、成功した論者が下限未満または論者の半数未満 — 再実行 / 論者を減らして再起動 (再実行を推奨)
- 初めの主張で、成功した論者の過半数が `precondition_failed` — 問いを具体化して再起動 / `sv-investigate` で材料を補う (前者を推奨)
- 議論のラウンドで、成功した論者が下限未満または参加中の論者の半数未満 — 再実行 / その時点の記録を SV が読む (再実行を推奨)。それより少ない失敗は続行し、失敗した論者は次のラウンドで戻る
- まとめ役の失敗 — wf を再実行 / SV が記録と議事録を読んでまとめる (後者を推奨。議論は終わっており、再実行は全ラウンドをやり直すため)
- 書記の失敗は escalation にしない。`minutesPath: null` と summary で知らせる (判断メモと記録は揃っている)

## 6. `meta` ブロック案

```javascript
export const meta = {
  name: 'sv-discuss',
  description: '立場を分けた論者に議論させ、判断材料か結論の md と議事録を SV に返す',
  whenToUse: '問い・選択肢・論点が出ていて、立場を戦わせて比べたい・結論を詰めたい時',
  phases: [
    { title: '初めの主張' },
    { title: '議論' },
    { title: 'まとめ' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (擬似コード)

```javascript
const { question, options, stances, mode, format, max_rounds, deadline_epoch_sec, context, speech_rules } = svArgs.wf_specific
const dir = runDir(_WF_NAME)
const errors = <max_rounds・deadline_epoch_sec・stances の数/重複/ファイル名・options の重複/論者数の上限の検査>
if (errors.length > 0) return argsValidationEscalation(errors)
const debaters = <§2 の論者の組み立ての表から作った [{ name, stance, active: true }]>

phase('初めの主張')
const opening = await runRound(0)   // 順番制は speakingOrder の順に await、並行ラウンド制は parallel
<成功しなかった論者を active: false にする>
if (<成功した論者が下限未満、または半数未満>) return <escalation: 初めの主張の失敗>
if (<成功した論者の過半数が precondition_failed>) return <escalation: 問いの具体化が要る>

let stopReason = deadlineReached(opening) ? 'deadline' : null
if (stopReason == null) phase('議論')
for (let round = 1; stopReason == null; round++) {
  const results = await runRound(round)
  if (<成功した論者が下限未満、または参加中の半数未満>) return <escalation: 議論のラウンドの失敗>
  if (mode === 'consensus' && consensusHolder(results) != null) stopReason = 'consensus'
  else if (isExhausted(results)) stopReason = 'exhausted'
  else if (round >= maxRounds) stopReason = 'max_rounds'
  else if (deadlineReached(results)) stopReason = 'deadline'
}

phase('まとめ')
const [summarizer, minutes] = await parallel([
  () => svAgent(summarizerPrompt(...), 'judge', 'summarizer', { schema: COMPLETION_SCHEMA }),
  () => agent(minutesPrompt(minutesCommand()), agentOpts('judge', 'minutes', { schema: MINUTES_SCHEMA })),
])
if (summarizer == null) return <escalation: まとめ役の失敗>
return {
  status: 'success',
  summary, outputPath, minutesPath: <書記が exit_code 0 のときだけ>,
  stopReason, roundsCompleted, debaters, roundMdPaths,
}
```

- 論者と書記は連絡帳を持たないので、`svAgent` を通さず `agent()` と `agentOpts` で起動する。論者の label は `debate-r<N>:<論者名>`
- 並行ラウンド制でラウンド間を `parallel` の barrier で区切るのは、次のラウンドの論者が前のラウンドの全員の発言を読む必要があるため

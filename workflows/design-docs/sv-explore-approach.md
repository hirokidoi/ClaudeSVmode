# wf: sv-explore-approach

## 1. 目的・想定利用シーン

仕様確定前のアプローチ比較。ユーザの要望に対して異なる観点のアプローチを並列で生成・独立審査し、各案と審査結果の md を SV に返す。SV はそれを比較してユーザに提示し、対話を深める。

- 「〜したい」だが具体像が定まっていない時
- アプローチ選定でトレードオフを整理したい時
- ユーザに「こういう選択肢がある」を示して意思決定を促したい時

**wf は決定しない** — 最終選択は SV とユーザの対話で行う。

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "goal": "ユーザの要望 (自然言語)",
  "constraints": ["制約 1", "制約 2", "..."],
  "perspectives": ["mvp", "risk", "scalability", "..."],
  "background": "関連する既存実装や過去の判断 (あれば)"
}
```

- `perspectives` — 案を作らせる観点のリスト。重複、またはファイル名に使えない文字 (文字・数字で始まり、文字・数字・`.`・`_`・`-` 以外) を含む要素は args 構造不足の escalation。デフォルト (未指定・空配列) は `["mvp", "risk", "scalability", "user-experience"]`
- 観点ごとに 1 エージェント。3〜5 個が推奨。

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation',
  summary: 'x/N 案を生成、M 案を独立審査済み',
  proposalMdPaths: [
    { perspective: 'mvp', proposalMdPath: '...', judgeMdPath: '...' | null, succeeded: true | false },
    ...
  ],
  runDir: '<run-dir>',   // 提案生成の過半数が失敗した escalation のとき
  escalation: {...},   // status=escalation のとき
}
```

SV は各案の `proposalMdPath` と `judgeMdPath` を Read して比較表を作成する。集約 md は作らない。

`succeeded: false` は提案の生成に失敗した観点で、審査は行わない。`judgeMdPath` は提案の生成か審査が失敗した観点では `null`。提案生成の過半数が失敗した escalation でも `proposalMdPaths` (`succeeded` 付き、`judgeMdPath` はすべて `null`) と `runDir` を返し、summary に失敗した観点を出す。

**proposal md (提案担当が生成) の構成:** 観点 / 案タイトル / 概要 / 具体的な実装イメージ / 想定シナリオ / リスク / 工数感 / 判定 JSON

**judge md (審査担当が生成) の構成:** 総合評価 (総合コメント) / 判定 JSON (総合評価の直下) / 評価対象 / 実現性・拡張性・ユーザ価値 (各 5 段階 + 根拠)

**判定 JSON の追加項目 (情報のみ。wf は分岐に使わない):**
- 提案: `constraints_unmet` — 満たせない制約の配列 (なければ空配列)。この wf は探索が目的なので、制約を満たせない案も書き、満たせない制約と理由を本文と合わせて明記する (制約の未充足は打ち切りの理由にしない)
- 提案: `precondition_failed` / `precondition_reason` — 要望が曖昧すぎて、その観点で具体的な案にできない (要望の言い換えや質問しか書けない) ときだけ true とし、案の本文は書かず理由だけを書く。SV が見るべきフラグ
- 審査: `substantive` — 提案が具体的なアプローチになっておらず、要望の言い換えや質問だけのときは false

比較表や、ユーザへの提示の仕方は SV が各 md を Read して組み立てる。

## 4. 内部エージェント構成

```
[生成フェーズ] 観点ごとに並列 fan-out
  └─ agent: アプローチ提案担当 x N (parallel)
     ロール: designer.md (要件整理と設計思考が近いため)
     プロンプト: 「観点 X の立場でアプローチを考えて」。制約を満たせない場合も案を書かせ、要望が曖昧すぎて案にできないときだけ `precondition_failed` で打ち切らせる
     出力: agents/proposal-<perspective>.md

[審査フェーズ] 独立審査 (Judge panel)
  └─ agent: 独立審査担当 x N (parallel、生成に成功した案の数だけ)
     ロール: reviewer.md (振る舞いの原則のみ。合否は持たない)
     プロンプト: 「実現性・拡張性・ユーザ価値の 3 軸で評価」
     出力: agents/judge-<perspective>.md

```

- 合成 (比較表作成) は SV が受け取った各 md を Read して行う。合成用のエージェントは持たない
- **修正ループなし** — 探索目的なので合意形成は SV に委ねる

## 5. エスカレ条件 (wf 固有)

- **提案生成の過半数が失敗した場合** — escalation (perspectives の再選定を推奨)
- 全案が制約を満たせない・提案間の差異が実質ないといった判断は wf としてはエスカレしない。SV が各 md を読んで判断する

## 6. `meta` ブロック案

```javascript
export const meta = {
  name: 'sv-explore-approach',
  description: '異なる観点で複数アプローチを生成・比較して SV に返す',
  whenToUse: '仕様確定前にユーザに選択肢を提示したい時',
  phases: [
    { title: '生成' },
    { title: '審査' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (擬似コード)

```javascript
const { goal, constraints, perspectives, background } = svArgs.wf_specific
const dir = runDir('sv-explore-approach')
const activePerspectives = perspectives && perspectives.length ? perspectives : ['mvp', 'risk', 'scalability', 'user-experience']
if (<activePerspectives に重複、または fileNameErrors に該当する要素>) return argsValidationEscalation([<重複した観点とファイル名エラー>])

phase('生成')
const proposals = await parallel(
  activePerspectives.map(p => () => agent(
    buildProposalPrompt({ perspective: p, goal, constraints, background, dir }),
    agentOpts('designer', `propose:${p}`)
  ))
)

const validProposals = proposals.filter(Boolean)
if (validProposals.length < activePerspectives.length / 2) {
  return {
    status: 'escalation',
    summary: `<失敗数>/${activePerspectives.length} 案の生成失敗 (失敗: <観点>)`,
    runDir: dir,
    proposalMdPaths: <観点ごとの { perspective, proposalMdPath, judgeMdPath: null, succeeded }>,
    escalation: {
      reason: '提案生成の過半数が失敗',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
        { title: 'perspectives 再選定', description: 'より具体的な観点で再指定', tradeoffs: 'ユーザとの追加対話が必要', effort: '小' },
      ],
      recommendation: 1,
      reasoning: '提案が失敗する原因は観点の抽象度不足の可能性',
    },
  }
}

phase('審査')
const succeededPerspectives = activePerspectives.filter((_, i) => proposals[i] != null)
const judgments = await parallel(
  succeededPerspectives.map(p => () => agent(
    buildJudgePrompt({ perspective: p, goal, constraints, dir }),
    agentOpts('judge', `judge:${p}`)
  ))
)

const judgedPerspectives = succeededPerspectives.filter((_, j) => judgments[j] != null)
const proposalMdPaths = activePerspectives.map((p, i) => ({
  perspective: p,
  proposalMdPath: `${dir}/agents/proposal-${p}.md`,
  judgeMdPath: judgedPerspectives.includes(p) ? `${dir}/agents/judge-${p}.md` : null,
  succeeded: proposals[i] != null,
}))

return {
  status: 'success',
  summary: `${validProposals.length}/${activePerspectives.length} 案を生成、${judgedPerspectives.length} 案を独立審査済み`,
  proposalMdPaths,
}
```

- 合成用のエージェントは持たず、path 配列を返して比較を SV に委ねる

**buildProposalPrompt の specialize 部分:**

_common.md §15 の制作系テンプレをベースに、perspective ごとに主眼を変える:

```
# 観点: {{perspective}}
以下の立場に立って案を作ってください:
- mvp: 最小実装で価値を早く出す。将来拡張は後回し
- risk: リスクを最小化し、失敗時の影響を局所化する
- scalability: 将来の拡張・スケール変化を先取り
- user-experience: ユーザ体験の質を最優先する

他の観点の案は他エージェントが担当するので、あなたはこの観点に集中してください。
```

**buildJudgePrompt の指示コア:**

```
以下の 3 軸で評価してください:
1. 実現性 (現状の技術・リソースで実現可能か)
2. 拡張性 (将来変更に耐えるか)
3. ユーザ価値 (ユーザにとっての価値の高さ)

各軸を 5 段階で評価し、根拠を添えてください。
判定は下すが、案を「棄却」する権限はありません。あくまで比較材料の提供です。
```

# wf: sv-investigate

## 1. 目的・想定利用シーン

曖昧な要望や特定領域の現状を構造化して把握する。

- 「〜の実装がどうなってるか調べて」に対する体系的な回答
- 複数領域 (例: API 層と DB 層) を並列で調査する
- 対話フェーズで方向性が固まりきる前の情報収集

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "areas": [
    {
      "name": "領域名 (エージェント区別用。ファイル名になる値で、文字・数字で始まり、文字・数字・. _ - だけ)",
      "scope": "調査対象のパスや観点",
      "questions": ["この領域で答えを出したい問い", "..."]
    }
  ],
  "context": "全領域共通の背景情報 (要望・制約・関連ファイル)",
  "completeness_check": "網羅性チェックを回すか (省略時 true)"
}
```

- `areas` は 1〜N 個。各領域に 1 エージェント。各要素の `name` と `scope` は必須で、`name` が重複している、またはファイル名に使えない文字を含むと args 構造不足の escalation を返す
- `completeness_check` が false のときは網羅性チェックを回さず、返り値の `critiquePath` は `null`
- 各 `area` は独立して調査できる粒度で切る。

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation' | 'checkpoint_stop',
  summary: 'x/N 領域を調査完了 (失敗: <領域名>)',
  areaMdPaths: [{ area: 'name', mdPath: '<run-dir>/agents/investigator-<name>.md', succeeded: true | false }, ...],
  critiquePath: '<run-dir>/agents/completeness-critic.md',   // completeness_check=false またはクリティック失敗のときは null
  runDir: '<run-dir>',   // 調査担当の過半数が失敗した escalation のとき
  escalation: {...},
  checkpoint: {...},
}
```

SV は各 `mdPath` と `critiquePath` を Read して総括する。集約 md は作らない。`succeeded: false` の領域は調査担当が失敗しており、summary にも領域名が出る。網羅性クリティックには調査に成功した領域の md だけを読ませる。調査担当の過半数が失敗した escalation でも `areaMdPaths` (`succeeded` 付き) と `runDir` を返し、summary に失敗した領域名を出す (失敗した領域だけを再実行できるように)。

**各 area md (調査担当が生成) の構成:**
- ## 調査対象 (スコープの確認)
- ## 主要な発見
- ## 問いへの回答 (問いごとに Q/A 形式)
- ## 参照ファイル (file:line 形式)
- ## アクセス不能領域 (該当あれば列挙、なければ「なし」)
- ## 範囲外で気になった点 (任意。あれば)

網羅性クリティックの md (`critiquePath`) には、抜けている観点と追加調査の推奨、アクセス不能領域のまとめが入る。

## 4. 内部エージェント構成

```
[調査フェーズ] 各 area を並列に fan-out
  └─ agent: 調査担当 x N (parallel)
     agentType: general-purpose (Explore は Write 不可なので不適、grep/find は general-purpose でも可)
     ロール: investigator.md
     出力: agents/investigator-<area.name>.md

[網羅性チェックフェーズ]
  └─ agent: 網羅性クリティック x 1
     ロール: reviewer.md (振る舞いの原則のみ。合否は持たない)
     入力: 調査に成功した area の結果 + 失敗領域の名前 (抜けとして扱わない) + 元の context
     出力: agents/completeness-critic.md
     問い: 「調査観点として抜けている領域はないか」
     completeness_check=false のときは起動しない

```

- 集約は SV が各 md を Read して行う。集約用のエージェントは持たない
- **修正ループなし** — 調査結果に対する「再調査」は網羅性クリティックが「追加調査推奨」を出した時のみ
- クリティックが追加調査推奨を出したら、SV に返り値として提示し、SV が新規 `sv-investigate` を追加起動するか判断
- 並列失敗の閾値: 過半数超が null → escalation (_common.md §14)

## 5. エスカレ条件 (wf 固有)

- **調査担当の過半数が失敗した場合** — escalation (§4)
- アクセス不能な領域 (DB 権限がない・ファイルが読めない等) では wf としてはエスカレしない。各領域 md の「アクセス不能領域」とクリティックの md に記載され、SV が読んで権限付与かスコープ変更かを判断する

## 6. `meta` ブロック案

```javascript
export const meta = {
  name: 'sv-investigate',
  description: '複数領域を並列に調査して構造化された結果を返す',
  whenToUse: '曖昧な要望・複数領域の状態把握が必要な時',
  phases: [
    { title: '調査' },
    { title: '網羅性チェック' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (擬似コード)

```javascript
const { areas, context, completeness_check } = svArgs.wf_specific
const dir = runDir(_WF_NAME)

const dupNames = <areas の name の重複 + name のファイル名検査 (fileNameErrors)>
if (dupNames.length > 0) return argsValidationEscalation([<name の重複とファイル名エラー>])

phase('調査')
const investigations = await parallel(
  areas.map(area => () => svAgent(
    buildInvestigatorPrompt({ area, context, dir }),
    'investigator', `investigate:${area.name}`, { agentType: 'general-purpose', schema: COMPLETION_SCHEMA }
  ))
)

const validInvestigations = investigations.filter(r => r != null)
if (validInvestigations.length < areas.length / 2) {
  return {
    status: 'escalation',
    summary: `<失敗数>/${areas.length} 領域で調査失敗 (失敗: <領域名>)`,
    runDir: dir,
    areaMdPaths: <areas ごとの { area, mdPath, succeeded }>,
    escalation: { reason: '調査担当エージェントの過半数が null を返した', options: [<再実行 / 領域を絞って再実行>], recommendation: 0, reasoning: '一時的な失敗の可能性' },
  }
}

const succeededAreas = areas.filter((_, i) => investigations[i] != null)

let critiquePath = null
if (completeness_check !== false) {
  phase('網羅性チェック')
  critiquePath = `${dir}/agents/completeness-critic.md`
  const critique = await svAgent(
    buildCompletenessCriticPrompt({ areas, succeededAreas, context, dir }),
    'critique', 'completeness-critic', { schema: COMPLETION_SCHEMA }
  )
  if (critique == null) critiquePath = null
}

const areaMdPaths = areas.map((a, i) => ({ area: a.name, mdPath: `${dir}/agents/investigator-${a.name}.md`, succeeded: investigations[i] != null }))
const failedNote = <失敗した領域があれば ' (失敗: <領域名>)'>

if (svArgs.checkpoint_declarations?.includes('investigated')) {
  return { status: 'checkpoint_stop', summary: `調査完了 (${succeededAreas.length}/${areas.length} 領域${failedNote})、ユーザ確認待ち`, areaMdPaths, critiquePath, checkpoint: { name: 'investigated', reason: 'ユーザ宣言のチェックポイント' } }
}

return { status: 'success', summary: `${succeededAreas.length}/${areas.length} 領域を調査完了${failedNote}${completeness_check === false ? ' (網羅性チェックなし)' : ''}`, areaMdPaths, critiquePath }
```

- `buildInvestigatorPrompt` / `buildCompletenessCriticPrompt` は各 wf のスクリプト内で組み立てるプロンプト (雛形は _common.md §15)

**buildInvestigatorPrompt の specialize 部分:**

_common.md §15 の調査担当テンプレを基本に、以下を area ごとに差し込む:

```
# 領域: {{area.name}}
# 調査対象: {{area.scope}}
# 問い:
{{area.questions を番号付きで}}
```

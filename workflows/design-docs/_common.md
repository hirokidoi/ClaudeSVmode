# SV wf 共通パターン設計

`sv-mode.md` の内容を前提とする。個別 wf 設計 (implement.md 等) はこの共通パターンに準拠する。

配置先: `~/.claude/workflows/` (ユーザグローバル)

---

## 1. 共通返り値エンベロープ

全 wf は以下の統一形式で SV に返す。

```json
{
  "status": "success" | "escalation" | "checkpoint_stop" | "rejected",
  "summary": "SV への短い要約 (1〜3 文)",
  "outputPath": "tmp/... (成果物ファイルパス、あれば)",
  "escalation": { /* status=escalation のとき (§2 参照) */ },
  "checkpoint": { /* status=checkpoint_stop のとき (§3 参照) */ },
  "rejection": { /* status=rejected のとき: { reason, selfcheck_path } */ }
}
```

- **`status`** — SV が次アクションを判断する主軸
  - `success`: 想定通り完了。`outputPath` の成果物を後続 wf に渡す
  - `escalation`: wf 内部で判断困難。SV は `escalation` フィールドを見てユーザに判断書を提示
  - `checkpoint_stop`: ユーザ宣言のチェックポイントに到達。SV は経過をユーザに報告して承諾待ち
  - `rejected`: レビュー系 wf でセルフチェック証跡に不備があり、レビュー本体を実施しなかった。SV はセルフチェックをやり直して再起動する
- **`summary`** — SV のコンテキストに載る唯一の詳細情報。詳細は `outputPath` の md を参照する形にして SV コンテキストを保護
- **`outputPath`** — `tmp/` 配下の成果物パス (§4 参照)
- **`runDir` と escalation の返り値**
  - 成果物を書く担当エージェントを 1 つでも起動した後の escalation は、`runDir` と、その時点で存在する成果物の path キー (`outputPath` / `reviewMdPaths` / `prototypeDir` / `lensMdPaths` / `componentOutputs` 等) を返す
  - それより前の escalation (args 検証、依存関係の循環、セルフチェック確認) は run ディレクトリに成果物が無いため、返さなくてよい
  - 全 escalation で返す案を採らない理由: args 検証は run ディレクトリの算出前に呼ばれる箇所があり、Prelude と、レビュー系 wf が共有するセルフチェック確認ヘルパを同時に変える必要が出る。返しても指す成果物が無い

## 2. エスカレーション判断書スキーマ

```json
{
  "reason": "エスカレの発生理由 (何が判断困難か)",
  "options": [
    {
      "title": "選択肢の要約",
      "description": "選択肢の内容",
      "tradeoffs": "この選択の得失",
      "effort": "予想工数感 (小/中/大)"
    }
  ],
  "recommendation": 0,
  "reasoning": "推奨案を選んだ根拠"
}
```

- `options` は 2〜4 個 (sv-mode.md の判断書の規則)。ただし args 不正・循環依存・エージェントの実行失敗のように、選べる手が実質 1 つしかない機械的な失敗は 1 個でよい
- `recommendation` は 0-indexed で `options` のどれを推奨するか
- SV はこの構造をそのままユーザに提示できる整形にして表示する

## 3. チェックポイント停止スキーマ

```json
{
  "name": "宣言されたチェックポイント名",
  "reason": "なぜここで停止したか (どのチェックポイント条件に該当したか)"
}
```

- ユーザに見せる成果物の path は、返り値エンベロープ側のキー (`outputPath` / `reviewMdPaths` / `componentOutputs` 等) で返す
- SV はその成果物をユーザに提示し、承諾または修正指示を待つ

---

## 4. tmp/ パス命名規則

**基準ディレクトリの決定順:**

1. 実行中プロジェクトに git 管理外の `<repo>/tmp/` が存在すればそれを使う
2. なければ `~/tmp/wf-runs/` を使う

**wf ごとのサブディレクトリ:**

```
<base>/wf-<wf-name>/<run-id>/
├── agents/                # 内部エージェントの成果物
│   ├── <agent-role>-<index>.md
│   └── ...
└── loop/                  # 修正ループのラウンド記録
    ├── round-N-output.md
    ├── round-N-review.md
    └── ...
```

- `<run-id>` は SV が起動前に採番して `run_id` で渡す (script 内では時刻・乱数を使えないため)
- 集約 md は作らない。各エージェントが自身の担当分を書き出した md への path を wf の返り値に含める (返り値の形は各 wf 設計書の §3「返り値スキーマ」)
- SV は返り値の path を Read して総括する。必要な path だけ Read することでコンテキストを保護する

**掃除方針:**

- 案件完了時に SV が中身を確かめてから、`<base>/wf-<wf-name>/` 配下の不要なランを片付ける
- ユーザに見せる必要がある成果物のみ残す

---

## 5. レビュー系エージェントのプロンプト要件

レビュー系エージェントのプロンプトの正本は各 wf の実装側に置く (コード diff レビューは `_prelude.js.md` の「コード diff レビュー用プロンプト」、計画レビュー・総合レビューは各 wf のスクリプト)。出力形式 (判定 JSON・md 構成・重大度の語彙・チェック観点の名前) は役割定義でなく wf のプロンプトと schema を正とする。どのレビュー系プロンプトも以下を含める:

- ロール定義 `~/.claude/roles/reviewer.md` を全文読ませる (振る舞いの原則。出力形式はプロンプトの指定に従わせる)
- `policyReferenceBlock` で、導入先の CLAUDE.md・プロジェクト規約と、`project_memory_path` (任意) 内の規約・memory 類を確認させる
- 早期打ち切りの手段 (`upstream_precondition_failed`) を持たせる。合否を扱わない審査・網羅性チェックは持たない
- 共通語彙と観点カタログを、その wf に意味を持つ範囲で指定する

### 共通語彙

- 重大度は 3 種
  - `blocker`: ブロッカー (リリース不可)
  - `must_fix`: 要修正 (品質上問題あり)
  - `suggestion`: 提案 (改善余地)
- pass との対応
  - `blocker` か `must_fix` が 1 件でもあれば不合格
  - `suggestion` だけなら合格
  - 前提不成立・構造見直し・行き詰まりのフラグ (`upstream_precondition_failed` / `structural_rethink_required` / `designer_stuck`) が立っていれば不合格
- 指摘の置き場
  - `revision_required[]`: `blocker` と `must_fix` (severity / location / instruction)
  - `additional_findings[]`: `suggestion` (location / detail)
  - 総合レビューは `findings[]`、計画レビューは `revisions[]` に置き、各要素に重大度を持たせる

### 観点カタログ

観点は番号でなくキーで呼ぶ (判定 JSON の `checks` の項目名と一致する)。コード上の正本は `_prelude.js.md` の「レビュー観点カタログ」。

| キー | 内容 |
|---|---|
| `n_plus_1` | N+1 問題 (DB / API / ディスク走査などをループの中で繰り返していないか) |
| `dry` | DRY・共通化の漏れ・デッドコード |
| `semantic` | セマンティック設計の 4 つの問い |
| `callee_behavior` | 呼び出し先の内部実装と非自明挙動 (暗黙の型変換・null の扱い・文字コードや照合順序や時刻の変換等の前提) |
| `hot_path` | ホットパスの効率 |
| `spec` | 自動テストの存在と実効性 (呼び出しでなく動作を検証しているか、定数の中身に依存していないか) |
| `consumers` | 全消費者・全レイヤーへの影響 |
| `docs` | ドキュメント・コメントの整合と、導入先の CLAUDE.md・プロジェクト規約にある記載ルール |
| `policy` | プロジェクトポリシー (導入先の CLAUDE.md・プロジェクト規約と、`project_memory_path` 内の規約・memory 類) |
| `progress` | プロジェクト進行の証跡 |

`checks` の形は、観点キーごとに ok / issue / na の状態と詳細を持つ。na には理由を必ず書く。

### wf ごとの適用

| wf / 担当 | 判定の主キー | チェック観点 | 早期打ち切り・特殊フラグ |
|---|---|---|---|
| sv-design レビュー担当 | pass | `progress` 以外の全観点 | 前提不成立・構造見直し (全ラウンド)、件数過多 (2 ラウンド目以降で件数が前回以上)、設計担当の行き詰まり (2 ラウンド目以降) |
| sv-prototype-ui レビュー担当 | pass | UI 固有チェック + `dry` / `semantic` / `policy` | sv-design と同じ |
| sv-review-changes | pass | 全観点。スコープ判定表で絞る | 前提不成立 (大規模変更は情報のみ) |
| sv-comprehensive-review (観点別並列) | lens ごとの pass | lens に割り当てた観点 | 前提不成立 (lens ごと) |
| sv-comprehensive-review (単一 agent) | overall_pass | 全観点。スコープ判定表で絞る | 前提不成立 |
| sv-review-plan | verdict | `progress` 以外の全観点 | 上流前提不成立、計画ファイル読取不可、計画種別の不一致 |

- sv-comprehensive-review の観点並列では、既定の lens で全観点を分担する (lens ごとの割当は sv-comprehensive-review.md §4 を正とする)。既定以外の lens は固有の観点のみ
- 計画・設計・プロトタイプのレビューでは、レビュー自体がそのフェーズにあたるため `progress` を観点に含めない
- コード diff 系の `progress` は、セルフチェック証跡と渡された背景資料から前工程の証跡を確認する。確認できなければ `must_fix`
- sv-review-plan の verdict と重大度の対応: `NG` は `blocker` があるか前提不成立・読取不可のとき、`conditional-pass` は局所的な修正で解消できる `must_fix` だけのとき、`pass` は `suggestion` だけのとき。`NG` と `conditional-pass` はどちらも不合格

### 対象外

網羅性クリティック (sv-investigate) と独立審査 (sv-explore-approach の Judge) は本節の対象外。合否・重大度・観点チェックを持たない。

---

## 6. 制作系エージェント起動テンプレ

調査担当・設計担当・実装担当も同様にロールファイルを組み込むテンプレを持つ。

```
あなたは{{role_label}}エージェントです。以下を全て遵守してください。

# ロール定義
以下を全文読み、指示を全て守ること:
- ~/.claude/roles/{{role_file}}.md

# タスク
{{task_description}}

# 入力
{{input_summary_or_paths}}

# 出力
以下のパスに成果物を保存すること:
- {{output_path}}

出力の詳細フォーマット:
{{output_schema}}

# 制約
- 途中の作業ファイルは {{workdir}} に置く
- 判断に迷ったら決定せず、その旨を成果物に明記して報告
```

**プレースホルダー:**
- `{{role_label}}` — 「調査担当」「設計担当」「実装担当」
- `{{role_file}}` — `investigator` / `designer` / `implementer`
- `{{task_description}}` — タスク詳細
- `{{input_summary_or_paths}}` — 入力の要約または入力ファイルのパス
- `{{output_path}}` — 成果物保存先
- `{{output_schema}}` — 出力の詳細スキーマ
- `{{workdir}}` — 作業ディレクトリ

---

## 7. 修正ループハンドラ

`sv-design` / `sv-prototype-ui` など、レビューと修正ループを持つ制作系 wf で使う共通ループ。

パターンの説明。sv-design / sv-prototype-ui は早期打ち切り判定を挟んだ独自ループで実装する。

**擬似コード (workflow スクリプト内):**

```javascript
async function produceWithReviewLoop({ produceFn, reviewFn, reviseFn, maxAttempts = 3 }) {
  let attempt = 0
  let output = await produceFn()  // 初回制作

  while (attempt < maxAttempts) {
    const review = await reviewFn(output)
    if (review.pass) {
      return { success: true, output, review, attempts: attempt + 1 }
    }
    if (attempt === maxAttempts - 1) {
      // 上限到達 → エスカレ用データを返す
      return {
        success: false,
        output,
        review,
        attempts: attempt + 1,
        escalation: buildEscalationFromReview(review),
      }
    }
    output = await reviseFn(output, review.revision_required)
    attempt++
  }
}
```

- `produceFn` — 初回制作 (設計担当・デザイン担当のエージェント起動)
- `reviewFn` — レビュー (§5 の要件を満たすレビュー担当の起動)
- `reviseFn` — 修正 (レビュー指摘を含めた再制作エージェント起動)
- `maxAttempts` — sv-mode.md の共通仕様どおり 3

**focused 再レビュー (attempt >= 2):**

初回 (attempt 1) はフル監査だが、2 回目以降のレビューは指摘の解消確認に絞ることで、軽微修正に対する全文フル監査の無駄を避ける。`reviewFn` は attempt >= 2 で前回レビュー (指摘一覧) と前回成果物を入力に受け取り、次の判断を行う:

- 成果物がラウンド別に残る wf (design) は前後の `diff` を根拠に、上書き型の wf (prototype-ui) は指摘項目の解消検証を根拠にする
- 差分が「指摘への対応 + その直接の波及範囲」に収まり局所的、かつ revision_required 全件が解消 → **focused pass** (変更のない箇所は前回 pass を信頼し再監査しない)
- 差分が広範・構造的、または未解消/新規問題あり → **フル監査に fall back** (wf が指定するチェック観点 + wf 固有チェックを全て実施)

判定 JSON に `review_mode: "focused" | "full"` と `revision_items_resolved` を含める。focused でも「修正が指摘外の箇所に副作用を及ぼしていないか」は必ず確認する (レビュー担当が拒否権を保持し、局所と判断できなければ full に上げる)。

**上限到達時のエスカレ:**

`buildEscalationFromReview()` はレビュー結果 (`review.additional_findings` や `revision_required`) からエスカレ判断書 (§2 のスキーマ) を組み立てる。

- reason: 「N 回の修正ループで品質基準を満たせず」
- options: 「(1) さらに再修正 (2) 現状で受け入れ (3) 設計から見直し」など
- recommendation: 内容によって wf 側で判断

---

## 8. wf `meta` ブロック標準

Workflow ツール仕様の `meta` に必要な項目 + SV wf 独自の項目:

```javascript
export const meta = {
  name: 'sv-<wf-name>',                   // sv- プレフィックスで一貫命名
  description: '短い説明 (パーミッションダイアログに表示)',
  whenToUse: 'どんな時に SV が起動すべきか',
  phases: [                                // phase() 呼び出しと一致
    { title: '...' },
    ...
  ],
  argsSchema: { ... },                     // wf_specific の検証スキーマ (§19)
}
```

命名規則: 全 wf は `sv-` プレフィックス付き (`sv-investigate` / `sv-design` etc.)。他の wf との衝突を避け、SV モード用と分かるようにする。

---

## 9. 起動時に SV から受け取る共通引数

全 wf は最低限以下を受け取る (`args` 経由):

```json
{
  "project_root": "実行中プロジェクトのルートパス",
  "project_memory_path": "プロジェクトの規約・memory 類のディレクトリ (任意)",
  "tmp_base_dir": "wf 実行結果の基準ディレクトリ (SV が確定)",
  "run_id": "SV が採番した run-id (§12 参照)",
  "checkpoint_declarations": [ "designed", "implemented" ],
  "complexity_profile": "light | standard | deep",
  "model_overrides": { "reviewer": "opus", "implementer": null },
  "wf_specific": { /* wf ごとの固有引数 */ }
}
```

- `tmp_base_dir` は Workflow スクリプトがファイルシステム API を使えないため必須。SV が起動前に決定:
  - git 管理外の `<project_root>/tmp` が存在すればそれ
  - なければ `~/tmp/wf-runs`

- `run_id` は必須 (渡し忘れるとエージェント起動前に `args 構造不足` で返る)
- `project_memory_path` は任意。ディレクトリがあるときだけ渡し、省略時は policy 観点を CLAUDE.md・プロジェクト規約だけで判定する
- `project_root` は任意。レビュー系 wf のセルフチェック確認担当と、コード diff を見るレビュー担当 (sv-review-changes / sv-comprehensive-review) に、git コマンドの実行場所として渡す (省略時は作業ディレクトリ)
- `checkpoint_declarations` — このリストに含まれるフェーズ完了時、wf は `status: "checkpoint_stop"` で返す。受け付ける名前は `investigated` (sv-investigate) / `ui_prototyped` (sv-prototype-ui) / `designed` (sv-design) / `implemented` (sv-implement) の 4 つで、Prelude の `CHECKPOINT_NAMES` で検査する。表に無い名前は `args 構造不足`
- `complexity_profile` — 案件全体のモデル方針 (§13 参照)。省略時は `"standard"`
- `model_overrides` — 役割別モデル上書き (§13 参照)。省略時は空
- `wf_specific` — 各 wf の固有引数 (個別 wf 設計に定義)

---

## 10. wf 内部での SV コンテキスト保護

- 内部エージェントの出力は `agents/` 配下に保存し、SV の返り値には含めない
- `summary` フィールドは 1〜3 文以内に留める
- 詳細を SV が読みたい場合は `outputPath` の md を SV 側から Read させる
- レビュー結果の詳細 (チェック観点の結果) は成果物 md に含め、返り値には要約のみ

---

## 11. 各 wf 設計ドキュメントの共通構成

以下の章立てで個別 wf を設計する:

1. 目的・想定利用シーン
2. 引数スキーマ (`wf_specific`)
3. 返り値スキーマ (と成果物 md の構成)
4. 内部エージェント構成 (逐次 / 並列パターン)
5. エスカレ条件 (共通仕様以外の wf 固有条件)
6. `meta` ブロック案
7. スクリプト骨格 (擬似コード、または処理の順序)

---

## 12. run-id・ファイル命名の具体形式

**run-id 形式:**

`args` 経由で外部注入する。生成は SV 側 (Workflow スクリプト内で `Date.now()` 等は使用不可のため)。

- 形式: `<YYYYMMDD-HHMMSS>-<6char-random>` (例: `20260706-234512-a3f9x1`)
- SV は wf 起動前に採番して `args.run_id` に含めて渡す

**ファイル名になる値:**

`run_id`・`areas[].name`・`perspectives[]`・`components[].name`・`prev_run_id` は成果物のファイル名・パス、Bash の引数にそのまま使われる。文字・数字で始まり、文字・数字・`.`・`_`・`-` だけに制限し、Prelude の `fileNameErrors` で検査する。違反は `args 構造不足`。

**ディレクトリ構造 (§4 を具体化):**

```
<base>/                              # 基準ディレクトリ (§4)
└── wf-<wf-name>/
    └── <run-id>/
        ├── agents/                  # 各エージェントの成果物
        │   ├── <role>-<index>.md
        │   └── review-<lens>.md
        └── loop/                    # 修正ループの記録
            ├── round-<N>-output.md
            └── round-<N>-review.md
```

集約 md は作らない (§4)。SV は wf 返り値中の path を Read する。

**ヘルパ関数:**

```javascript
function runDir(wfName) {
  return `${svArgs.tmp_base_dir}/wf-${wfName}/${svArgs.run_id}`
}
```

- script はファイルシステムを参照できないため、ベースディレクトリ (プロジェクトの git 管理外の `tmp/` か `~/tmp/wf-runs`) は SV が決めて `tmp_base_dir` で渡す
- ディレクトリの作成はエージェント側で行う

---

## 13. エージェント設定の推奨値

Workflow の `agent()` 呼び出し時のオプション推奨値。

### 基本方針

- **明示的に指定するのは `model: 'sonnet'` だけ**
- 判断・批判系 (設計・レビュー・審査など) は **model 指定なし → SV のセッションモデル継承**
- 将来 SV のセッションモデルが変わっても、判断系役割は自動追従する
- `effort` は指定しない (セッション継承)

### 役割別マッピング

| エージェント種別 | agentType | model 指定 | 想定作業 |
|---|---|---|---|
| 調査担当 | `general-purpose` | `sonnet` | 情報収集・構造化 (Explore は Write 不可なので不適) |
| 設計担当 | `general-purpose` (sv-explore-approach の提案担当は指定なし) | 指定なし (継承) | 設計案作成 (深い判断) |
| 実装担当 | 指定なし | `sonnet` | ファイル編集 |
| レビュー担当 | 指定なし (sv-design のレビュー担当のみ `general-purpose`) | 指定なし (継承) | コード・設計レビュー |
| 網羅性クリティック | 指定なし | 指定なし (継承) | 抜け検出 |
| 独立審査 (Judge) | 指定なし | 指定なし (継承) | 案の評価 |
| デザイン担当 (UI プロト) | `general-purpose` | 指定なし (継承) | UI 設計・HTML/CSS 制作 |
| デザインレビュー | `general-purpose` | 指定なし (継承) | UX / アクセシビリティ判定 |
| commit 担当 | 指定なし | `sonnet` | commit メッセージ作成 + git 操作 |
| テスト実行担当 | 指定なし | `sonnet` | Bash でテスト実行 |
| セルフチェック確認担当 | 指定なし | `sonnet` | レビュー系 wf で証跡から実施有無を判定 |

- 「創造・判断・批判系は継承 (セッションのモデル)」「実行系は sonnet 明示」
- agentType「指定なし」は Workflow の既定のサブエージェントで起動する
- `agentType` は環境によって存在有無が異なる。存在確認は SV が事前に把握してから起動する

### ケース別上書き (wf 引数 `model_overrides` 経由)

SV が対話で複雑度を判断し、以下のいずれかで上書き可:

**プロファイルショートカット** (`complexity_profile`):
- `light`: 全役割で `sonnet` 明示 (typo 修正など)
- `standard`: 上記マッピングをそのまま (デフォルト)
- `deep`: 全役割で継承 (SV セッションのモデル) にする
- `light` / `deep` のときは `model_overrides` を無視する

**細かい上書き** (`model_overrides`):
```json
{ "model_overrides": { "implementer": null, "committer": "sonnet" } }
```
- キー: 役割名 (`investigator` / `designer` / `implementer` / `reviewer` / `critique` / `judge` / `committer` / `test_runner` / `selfcheck_gate` / `ui_designer` / `ui_reviewer`)
- 値: モデルの別名 (`sonnet` 等) かフルのモデル ID、`null` は継承
- `null` を明示すると強制的にセッション継承 (デフォルトが sonnet の役割を継承に上げるのに使う)
- 表に無い役割キーは Prelude の検査で `args 構造不足` になる

### 実装ヘルパ

各 wf のスクリプト内で以下ヘルパを使う:

```javascript
function modelFor(role) {
  // profile short-circuit
  if (svArgs.complexity_profile === 'light') return 'sonnet'
  if (svArgs.complexity_profile === 'deep') return undefined  // 全員継承

  // per-role override
  if (svArgs.model_overrides && role in svArgs.model_overrides) {
    return svArgs.model_overrides[role] || undefined
  }

  // default table
  const defaults = {
    investigator: 'sonnet',
    designer: undefined,
    implementer: 'sonnet',
    reviewer: undefined,
    critique: undefined,
    judge: undefined,
    ui_designer: undefined,
    ui_reviewer: undefined,
    committer: 'sonnet',
    test_runner: 'sonnet',
    selfcheck_gate: 'sonnet',
  }
  return defaults[role]
}

// 使い方
await agent(prompt, { label: 'review', model: modelFor('reviewer') })
```

- `modelFor(role)` が `undefined` を返した場合、`agent()` の opts から `model` を除外して呼ぶ (継承)
- 実装スタイル:
  ```javascript
  const opts = { label: 'review' }
  const m = modelFor('reviewer')
  if (m) opts.model = m
  await agent(prompt, opts)
  ```

---

## 14. エラーハンドリング

**エージェント失敗:**

`agent()` は失敗時 `null` を返す (Workflow ツール仕様)。以下で判定:

```javascript
const result = await agent(...)
if (result == null) {
  // ネットワーク断・API エラー・ユーザキャンセルなど
  return {
    status: 'escalation',
    summary: 'エージェント実行失敗',
    runDir: dir,
    escalation: {
      reason: 'wf 内エージェントが null を返した (実行失敗)',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
        { title: '直接作業に切替', description: 'SV が手を動かす', tradeoffs: 'コンテキスト圧迫', effort: '中' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性が高い',
    },
  }
}
```

**parallel 内の失敗:**

`parallel()` は失敗した thunk を `null` で埋める。`.filter(Boolean)` で除外してから処理を継続。ただし失敗数が過半数超なら全体を `escalation` にする。

```javascript
const results = await parallel(tasks)
const succeeded = results.filter(Boolean)
if (succeeded.length < tasks.length / 2) {
  return { status: 'escalation', summary: `${tasks.length - succeeded.length}/${tasks.length} 件失敗`, runDir: dir, ... }
}
```

**Schema 検証失敗:**

`agent()` に `schema` を渡した場合、Workflow ツール側で自動リトライ (仕様)。それでも失敗したら `null` として上記に流れる。

---

## 15. 具体的なエージェントプロンプトテンプレ

**制作系 (調査担当) の完全プロンプト例:**

```
あなたは調査担当エージェントです。

# ロール定義 (必読)
以下のファイルを Read で全文読み、その指示を全て守ってください:
- ~/.claude/roles/investigator.md

# タスク
{{area.name}} 領域を調査してください。

## 調査対象
{{area.scope}}

## 答えを出したい問い
{{area.questions を箇条書き}}

## 全体背景
{{context}}

# 成果物
以下のパスに md 形式で保存してください:
{{output_path}} (例: /path/to/run-dir/agents/investigator-<area.name>.md)

# 成果物の構成
- ## 調査対象 (スコープの確認)
- ## 主要な発見
- ## 問いへの回答 (問いごとに Q/A 形式で)
- ## 参照ファイル (重要ファイルの列挙、file:line 形式)
- ## アクセス不能領域 (もしあれば列挙、なければ「なし」と記載)
- ## 範囲外で気になった点 (あれば)

# 制約
- 判断に迷ったら決定せず、その旨を成果物に明記
- 推測は避け、確認したファイル・コマンド出力を根拠として記載
- SV へのメッセージではなく、成果物ファイルへの記述に注力すること
- 最終応答は「成果物を <output_path> に保存しました」の 1 文で良い
```

**レビュー系:** §5 を参照 (プロンプト本文の正本は wf の実装側)。

---

## 16. 成果物 md と wf 返り値

Workflow スクリプトはファイル IO を持たないため、成果物 md はエージェント経由で書き出す。各エージェントは自身の担当分だけを md に書き、集約は行わない。

**各エージェントへの書き出し指示:**

```
以下パスに成果物 md を保存してください。集約はしないでください。
- 保存パス: {{run_dir}}/agents/<role>-<label>.md
- 構成: (各 wf 設計書 §3 の該当セクションに従う)
```

**wf 返り値:**

wf スクリプトはエージェントが書いた md の path を集めて返り値に含める。SV はこの path を Read して総括する。

```javascript
return {
  status: 'success' | 'escalation' | 'checkpoint_stop' | 'rejected',
  summary: 'SV への短い要約',
  outputPath: '...',          // 単一 md を返す wf
  <wfKey>: [{ ..., mdPath }], // 複数 md を返す wf (各 wf 設計書の §3)
  escalation: {...},          // status=escalation のとき
  checkpoint: {...},          // status=checkpoint_stop のとき
  rejection: {...},           // status=rejected のとき (レビュー系 wf)
}
```

---

## 17. Workflow ツール実運用時の落とし穴

wf を実装・起動する際の注意点。

### 17.1. `args` の渡し方と wf 内での届き方

- **呼び出し側 (SV)**: ツール仕様どおり、`args` には JSON オブジェクトをそのまま渡す。JSON 文字列にして渡すと、エスケープの組み立て誤りで解釈できず失敗しやすい
- **wf 内**: 呼び出し側の渡し方によっては `args` グローバルが JSON 文字列で届くことがある。prelude の `parseSvArgs` がオブジェクト / JSON 文字列 / 二重エンコードのいずれも解釈し、解釈できなければ `null` を返す。`null` のときは検証エラーとして「args はオブジェクトをそのまま渡す」を返す (§19.4)

以降 wf 内では `args` ではなく `svArgs` を参照する。全ヘルパ (`modelFor`, `agentOpts`, `runDir`) も `svArgs` を使うこと。

長い指示や改行・記号を多く含む文章は `args` に直接入れず、作業ディレクトリの md に書いてそのパスを渡す (文字列型の引数ならその値として、`sv-review-plan` の `context` のようにオブジェクト型の引数ならそのキーの 1 つとして)。

### 17.2. `name` 指定はセッション初期のキャッシュを見る

SV が Workflow ツールを `Workflow({ name: 'sv-investigate', ... })` の形で起動すると、`~/.claude/workflows/sv-investigate.js` のソースを直接読まず、セッション初期に解決されたバージョン (キャッシュ) を使う。

日常運用では `name` 指定で問題ない (セッション開始時のソースがそのまま使われるため)。

**問題になるケース**: セッション中に wf の js を編集した場合、その変更は `name` 起動には反映されない。

**対策 (どちらか)**:
- **セッション再起動** — 新セッションで最新ソースが読み込み直される
- **`scriptPath` で絶対パス指定** — キャッシュを迂回して指定ファイルを直接読ませる
  ```
  Workflow({ scriptPath: '<ホームの絶対パス>/.claude/workflows/sv-investigate.js', args: {...} })
  ```
  `~` は展開されないので絶対パスを使うこと。

### 17.3. `Explore` agentType は Write ツールを持たない

Workflow の `agent()` で `agentType: 'Explore'` を指定すると、そのエージェントは Read/Bash/grep 系は使えるが、**Write/Edit ツールを持たない**。成果物 md を保存できず、テキスト応答で返してくる。SV や後続の工程がそのファイルを Read しようとして失敗する。

**対策**: ファイル書き込みが必要なエージェントに `Explore` を指定しない。agentType 指定なし (Workflow 既定のサブエージェント) と `general-purpose` はどちらも Write を持つ。各担当の agentType は §13 の表参照。

### 17.4. その他の Workflow スクリプト制約 (仕様書通り)

念のため再掲:

- `Date.now()` / `Math.random()` / argless `new Date()` は使用不可 → SV から `args.run_id` で注入
- `process` / `fs` / Node.js API 使用不可 → `args.tmp_base_dir` で SV から注入
- import 不可 → 共通ヘルパは各 wf にコピー配置
- ランタイムが同時実行数と総 agent 数に上限を設けている (同時実行数を超えた呼び出しは自動でキューイングされる)

---

## 18. 設計判断の記録

システム設計時に対話ベースで決めた核となる判断と、その根拠。将来 SV や設計者が構造を触り直すときに、根本の意図に立ち返るための記録。

### 18.1. なぜ Workflow 基盤か

Agent ツールで直接サブエージェントを起動する運用にも改善余地はあるが、以下の理由から Workflow ツールを採用:

- Agent ツールは `run_in_background: true` にしてもサブエージェント出力が SV のメインチャットに流れ込む。Workflow ツール内部の子エージェント出力は `/workflows` の専用ビューに隔離される
- Workflow は決定的なスクリプトなので、フェーズ構成・レビュー起動・修正ループ回数を **構造で強制** できる。「レビュー起動忘れ」を SV の判断に頼らず防げる
- Workflow は resume 機能を持ち、スクリプト編集後に途中から再走できる

### 18.2. SV の役割設計

- **SV モード中は、極小タスクを含めて本筋タスクは全て wf 経由** — 「これぐらいなら直接やった方が早い」という判断は、極小の判定が SV ごとにブレるため許容しない
- **例外は割り込み対応のみ** — ユーザが wf 実施中に別件を SV に直接依頼した場合のみ SV 直接対応 OK
- **SV モード中、本筋の作業を Agent ツールで直接任せない (例外は割り込み対応)** — Workflow 経由に一本化することで運用ルールを単純化 (適用範囲は sv-mode.md の「適用範囲」と揃える)

### 18.3. チェックポイント概念の導入

- ユーザが対話フェーズで「設計終わったら見せて」等を宣言すると、SV は wf 起動時に `checkpoint_declarations` に含める
- 該当フェーズ完了時、wf は `checkpoint_stop` で停止して SV に返す
- ブロッカーでない (エスカレでない) 停止として設計。ユーザ判断書は不要、経過報告と承諾待ちで良い
- デフォルトは空配列 (通常完了まで自律進行)
- 受け付ける名前は Prelude の `CHECKPOINT_NAMES` の 4 つ。名前の無い宣言 (「レビュー結果を見せて」など) は wf に渡さず、SV が該当する wf の結果を受け取った時点で自分で止まる

### 18.4. 修正ループ上限 3 回でエスカレ

- 制作 → レビュー → 修正のループは最大 3 回、上限で自動エスカレ
- 3 回で通過しない場合、要件側や設計スタイル側の問題である可能性が高いという経験則
- ユーザ判断書は 2〜4 択で提示 (「要件見直し」「設計スタイル変更」「現状で受け入れ」等)

### 18.5. モデル方針: 明示指定は sonnet だけ

- 判断・批判系 (設計・レビュー・審査・クリティック) は **モデル指定なし** で SV のセッションモデル継承
- 実行系 (調査・実装・commit・テスト実行・セルフチェック確認) は `model: 'sonnet'` 明示
- 効果:
  - SV のセッションモデルが変わっても判断系は自動追従
  - コードが素直: `model: 'sonnet'` を書くか書かないかだけ
- effort は指定せず継承 (model の方が体感上効果的という判断)

### 18.6. complexity_profile / model_overrides で対話ベースの調整

- `complexity_profile`: `light` / `standard` / `deep` を対話で合意
  - light: 全 sonnet、typo 修正等
  - standard: 役割別デフォルト (通常)
  - deep: 全継承 (セッションのモデル)、重要案件
- `model_overrides`: 役割別に上書き (「レビューだけ上位モデル」等)。`light` / `deep` のときは無視し、未知の役割キーは検査で弾く
- SV が案件見立てに応じて提案 → ユーザと合意

### 18.7. Explore agentType を使わない

- Explore は Read/Bash/grep が使えるが Write を持たない
- 調査担当が成果物 md を保存できず、SV や後続の工程がファイル不在で困る
- 書き込みが必要な担当には Explore を指定しない (agentType は指定なしか `general-purpose`。§13)

### 18.8. wf カタログの 8 個

対話フェーズがどこまで詰まったかに応じて呼び出す wf が変わる。呼び出し順は sv-mode.md「対話の深さ別の wf の呼び出し順」を正とする。

wf は 8 個で日常運用をカバーする粒度。案件次第で新規追加は SV 裁量で提案可能。

### 18.9. 明示的に選ばなかった選択肢

以下のオプションは検討したが採用しなかった:

- **フック (hook) で外側から強制** — 原則を渡して LLM が文脈で判断する設計を採る。運用の規則は sv-mode.md に置く
- **事前ルールの細かい定義** — 同上。wf カタログという「型」は導入するが、対話深さ別の呼び出しパターンは「代表例、SV 裁量」と位置付ける
- **プロファイルを wf 内部で自動判定** — 案件複雑度は対話で決める方が実態に合う
- **wf 内部で複雑度を都度変更** — Workflow ツール仕様上、実行中の変更は不可。チェックポイント停止と組み合わせて SV が次 wf を別プロファイルで起動する形で対応

---

## 19. argsSchema と実行時バリデーション

### 19.1. 目的

呼び出し側 (SV) が wf script を Read せずに args 構造を把握できるようにする。実行時にキー不足・型違反・許容値外があった場合、暗号的な JSON parse エラーや例外ではなく「どのキーがどう不正か」を明示した escalation を返す。

### 19.2. スキーマ形式

各 wf の `meta` ブロックに `argsSchema.wf_specific` を追加する:

```javascript
export const meta = {
  name: 'sv-review-plan',
  description: '...',
  whenToUse: '...',
  phases: [...],
  argsSchema: {
    wf_specific: {
      plan_path: { type: 'string', required: true, description: 'SV が起草した計画・設計 md のパス' },
      plan_type: { type: 'enum', values: ['design', 'implementation-plan', 'refactor-plan'], required: true },
      context: { type: 'object', required: false, description: '対話で合意した要件・制約' },
      // 他にも wf 固有の任意引数を追加してよい (詳細・最新の一覧は各 wf の design-docs を参照)
    },
  },
}
```

上記は `type` / `values` / `required` / `description` の書き方を示すための一例であり、`sv-review-plan` の完全な引数一覧ではない。個別 wf の正確な現行スキーマは `USAGE.md` および各 `design-docs/<wf名>.md` を正とする。

**フィールド:**
- `type` — `'string'` | `'number'` | `'boolean'` | `'array'` | `'object'` | `'enum'`。値がある場合は型も検証する (不一致は検証エラー)
- `properties` — 任意。`type: 'object'` の下位キーのスキーマ (同じ形式で再帰的に検証する)
- `items` — 任意。`type: 'array'` の各要素のスキーマ (同じ形式で再帰的に検証する)
- `values` — `type: 'enum'` のとき必須。取り得る値の配列
- `required` — true / false。値が undefined / null / 空文字 / 空配列なら不足とみなす
- `description` — 任意。SV や設計者が構造を理解するための説明

**共通引数のスキーマは prelude 内 `COMMON_ARGS_SCHEMA` として保持** — meta.argsSchema には wf_specific のみ書く。

### 19.3. バリデーション実装 (prelude)

```javascript
const CHECKPOINT_NAMES = ['investigated', 'ui_prototyped', 'designed', 'implemented']

const COMMON_ARGS_SCHEMA = {
  tmp_base_dir: { type: 'string', required: true },
  run_id: { type: 'string', required: true },
  project_memory_path: { type: 'string', required: false },
  project_root: { type: 'string', required: false },
  checkpoint_declarations: { type: 'array', required: false, items: { type: 'enum', values: CHECKPOINT_NAMES } },
  complexity_profile: { type: 'enum', values: ['light', 'standard', 'deep'], required: false },
  model_overrides: { type: 'object', required: false },
  wf_specific: { type: 'object', required: true },
}

const TYPE_CHECKS = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number',
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => typeof v === 'object' && !Array.isArray(v),
}

function validateArgs(schema) {
  const errors = []
  const checkOne = (path, val, spec) => {
    if (spec.required && (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0))) errors.push(`${path} が不足 (required)`)
    if (val === undefined || val === null) return
    if (spec.type === 'enum') {
      if (!spec.values.includes(val)) errors.push(`${path}=${JSON.stringify(val)} は許容値 ${spec.values.join('|')} 外`)
      return
    }
    if (TYPE_CHECKS[spec.type] && !TYPE_CHECKS[spec.type](val)) {
      errors.push(`${path} の型が ${spec.type} ではない`)
      return
    }
    for (const [key, sub] of Object.entries(spec.properties || {})) {
      checkOne(`${path}.${key}`, val[key], sub)
    }
    if (spec.items) val.forEach((el, i) => checkOne(`${path}[${i}]`, el, { ...spec.items, required: true }))
  }
  for (const [key, spec] of Object.entries(COMMON_ARGS_SCHEMA)) {
    checkOne(`args.${key}`, svArgs[key], spec)
  }
  const wfSpecificSchema = (schema && schema.wf_specific) || {}
  const wfSpecificVal = svArgs.wf_specific || {}
  for (const [key, spec] of Object.entries(wfSpecificSchema)) {
    checkOne(`args.wf_specific.${key}`, wfSpecificVal[key], spec)
  }
  return errors
}
```

実際の Prelude の `validateArgs` は、上記に加えて `run_id` のファイル名検査と `model_overrides` の未知の役割キーの検査を行う (正本は `_prelude.js.md`)。

### 19.4. 呼び出しパターン

Workflow ランタイム制約により script 本体から `meta` は参照できない。同じスキーマ内容を `meta.argsSchema` と body 側の `_WF_ARGS_SCHEMA` const の 2 箇所に持たせる。同期は各 wf の手書き責任で担保する:

```javascript
export const meta = {
  name: '...',
  description: '...',
  ...,
  argsSchema: {
    wf_specific: {
      // meta 側スキーマ (SV が Read で参照するための表示用、description 含めて可)
    },
  },
}

// body 側スキーマ (validateArgs 用、description は不要)
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    // meta.argsSchema.wf_specific と同じキー・型・required を書く
  },
}

const svArgs = parseSvArgs(args)
const validationErrors = svArgs
  ? validateArgs(_WF_ARGS_SCHEMA)
  : ['args を JSON オブジェクトとして解釈できない (args はオブジェクトをそのまま渡す。USAGE.md「起動契約」参照)']
if (validationErrors.length > 0) {
  return {
    status: 'escalation',
    summary: `args 構造不足: ${validationErrors.length} 件`,
    escalation: {
      reason: 'wf 起動引数のスキーマ検証エラー',
      details: validationErrors,
      options: [
        { title: 'args を修正して再起動', description: '不足キー・型・enum 違反を補って再送', tradeoffs: 'SV での args 組み立て見直し', effort: '小' },
      ],
      recommendation: 0,
      reasoning: 'スキーマ不足は SV 側の args 組み立てミス',
    },
  }
}
```

**注記**: `export const meta = {...}` を宣言しても body から `meta` シンボルは resolve できない (Workflow runtime が `ReferenceError: meta is not defined` を投げる)。SV wf は上記の const 二重持ち方式で回避する。

---

## 20. sv-implement の test 実行タイミング

### 20.1. デフォルト挙動: post-pipeline

`test_commands` の実行は、**全コンポーネントの実装が完了した後に 1 回だけ** 実行する。

**根拠:**

コンポーネントごとに実装直後にテストすると、コンポーネント間に依存があるとき false-fail が起きる:

- 例: 本体の実装コンポーネントと `テスト更新` コンポーネントを別に分けた場合
- 本体の実装直後のテスト時点では、`テスト更新` はまだ完了していない
- 古い形式のテストデータを新実装が触って失敗扱いになる
- 最終状態では pass するのに、wf としては "コンポーネント fail" の escalation を返してしまう

このため、テストは全実装の完了後に一括で実行するのがデフォルト。

### 20.2. オプション: test_timing

必要に応じて `test_timing` で切替可:

```javascript
wf_specific: {
  test_timing: 'post-pipeline' | 'per-component'
}
```

- `'post-pipeline'` (default): 全実装の完了後に 1 回
- `'per-component'`: 各コンポーネントの実装直後に実行 (コンポーネント間に依存がない構成向け)

### 20.3. パイプライン構造

```
[バッチ実行] dependencies の順にバッチ化し、バッチ内は並列、バッチ間は直列
  各コンポーネント:
    [実装] 実装担当

[全実装完了後] test_timing='post-pipeline' のとき
  [テスト] テスト実行担当 (test_commands を 1 回実行)
```

per-component のレビューは持たない。品質は後段の `sv-comprehensive-review` で担保する。

### 20.4. テスト失敗時のエスカレ

- post-pipeline のテスト失敗は wf 全体のテスト失敗として集約し、判断書に「実装は完了、テスト失敗」を明示する

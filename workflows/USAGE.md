# SV wf 起動ガイド

SV が wf を Workflow ツールで起動するときに参照するドキュメント。

---

## 起動契約

```
Workflow({
  name: 'sv-<wf-name>',
  args: { tmp_base_dir: '...', run_id: '...', ..., wf_specific: { ... } }
})
```

- **wf 名は常に `sv-` 付き**。本書と `sv-mode.md` の一覧にある名前をそのまま `name` に渡す

- **`args` は JSON オブジェクトをそのまま渡す**
  - 文字列にしない。`JSON.stringify()` した文字列や、外側を引用符で包んだ JSON は、エスケープの組み立て誤りで壊れやすい (wf 側は文字列でも解釈を試みるが、壊れた文字列は救えない)
  - 自然言語のタスク説明だけを渡すのは NG
  - 長い指示や、改行・引用符・コード片を多く含む文章は `args` に直接入れず、作業ディレクトリ (`sv-mode.md`「対話の基本」) の md に書いてそのパスを渡す。文字列型の引数 (`sv-review-changes` の `context` など) ならその値として、オブジェクト型の引数 (`sv-review-plan` の `context` など) ならそのキーの 1 つとして渡す
- **`name`** で登録済み wf を起動できる。wf.js を編集した直後で反映されない場合は `scriptPath: '<ホームの絶対パス>/.claude/workflows/sv-<wf-name>.js'` で絶対パス指定に切替可 (`~` は展開されない)

---

## status の種類

- `success`: 成果物の path を返して完了
- `escalation`: 続行できず、`escalation` に判断書 (理由・選択肢・推奨) を返す
- `checkpoint_stop`: `checkpoint_declarations` の宣言どおり成果物を返して停止。`checkpoint: {name, reason}` が付く。成果物の path キーは `success` と同じ
- `rejected`: セルフチェック証跡の不備でレビューを実施しなかった (レビュー系 3 wf のみ)。`rejection.reason` に理由

---

## 返り値の path 参照方針

- 各 wf は集約 md を作らず、各エージェントが書いた md への path を返す。SV は返り値中の path 群を Read して総括する
- 単一 md を返す wf は `outputPath` を返す (`sv-design` / `sv-review-changes` / `sv-review-plan`)
- 複数 md を返す wf は wf 固有キーで path 配列を返す:
  - `sv-implement`: `componentOutputs: [{name, succeeded, implMdPath, perComponentTestMdPath, error}]` と `postPipelineTestMdPath`、`commitMdPath` (commit_strategy='none'、または commit 担当が null を返したときは null)。コンポーネントの失敗・テスト失敗・テスト未実施・commit 失敗の escalation でも `componentOutputs` を返す。`design_mismatch` のコンポーネントは `implMdPath` の md に乖離の理由がある
  - `sv-comprehensive-review`: 既定 (`optimize_for: 'wall_clock'`) は観点ごとの md を `lensMdPaths: [{lens, mdPath, succeeded}]` で返す (`succeeded: false` はレビュー担当が失敗した観点で、md が無いか不完全。失敗した観点は summary にも出る)。`optimize_for: 'tokens'` のときは単一 agent が全観点を 1 md にまとめ `outputPath` で返す
  - `sv-investigate`: `areaMdPaths: [{area, mdPath, succeeded}]` と `critiquePath` (`succeeded: false` は調査担当が失敗した領域。`critiquePath` は網羅性チェックを回さなかった・クリティックが失敗したときは `null`。失敗した領域は summary にも出る)
  - `sv-explore-approach`: `proposalMdPaths: [{perspective, proposalMdPath, judgeMdPath, succeeded}]` (`succeeded: false` は提案の生成に失敗した観点。`judgeMdPath` は提案の生成か審査が失敗した観点では `null`)
  - `sv-prototype-ui`: `prototypeDir` と `reviewMdPaths: [...]`
- 担当エージェントの起動後の escalation では、その時点で存在する成果物の path キー (`outputPath` / `reviewMdPaths` / `prototypeDir` / `lensMdPaths` / `componentOutputs` 等) と `runDir` が返る。args 検証とセルフチェック確認の escalation は成果物が無いため返さない
- SV はコンテキスト保護のため、必要な path だけを Read する (全部一気に読むと context を圧迫)

---

## 判定の読み方

レビュー系の判定は共通の重大度で表す。`blocker` (ブロッカー: リリース不可) / `must_fix` (要修正: 品質上問題あり) / `suggestion` (提案: 改善余地)。`blocker` か `must_fix` が 1 件でもあれば不合格、`suggestion` だけなら合格。前提不成立・構造見直し・行き詰まりのフラグ (`upstream_precondition_failed` / `structural_rethink_required` / `designer_stuck`) が立っていれば不合格。不合格の指摘は修正指示として、提案は追加所見として md に出る。

wf ごとの判定の主キーと、SV が見るべきフラグ:

| wf | 判定の主キー | SV が見るべきフラグ |
|---|---|---|
| `sv-design` | レビュー md の `pass` | `upstream_precondition_failed` / `structural_rethink_required` / `revision_count_high` / `designer_stuck`、設計担当の `contradiction_detected` / `design_precondition_failed` |
| `sv-prototype-ui` | レビュー md の `pass` | 設計と同じ早期打ち切りフラグ、デザイン担当の `precondition_failed` |
| `sv-implement` | テスト担当の `pass` | 実装担当の `design_mismatch` |
| `sv-review-changes` | `pass` | `upstream_precondition_failed`、`change_size_too_large` (情報のみ。総合レビューの検討材料) |
| `sv-comprehensive-review` | 既定は観点ごとの `pass`、`optimize_for: 'tokens'` は `overall_pass` | 観点ごと (`optimize_for: 'tokens'` は全体で 1 つ) の `upstream_precondition_failed` |
| `sv-review-plan` | `verdict` (`NG` / `conditional-pass` は不合格、`pass` が合格) | `upstream_precondition_failed` / `plan_path_unreadable` / `plan_type_mismatch` |
| `sv-investigate` | 合否なし | クリティックの `access_blocker` |
| `sv-explore-approach` | 合否なし (3 軸スコア) | 提案担当の `precondition_failed`、提案担当の `constraints_unmet` と審査担当の `substantive` (後者 2 つは情報のみ) |

判定 JSON の詳細は各 wf の成果物 md と `design-docs/` の各設計書 §3 を正とする。

---

## 共通 args (全 wf)

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `tmp_base_dir` | string | ○ | 作業ディレクトリ。決め方は sv-mode.md「対話の基本」の作業ファイル |
| `run_id` | string | ○ | SV 採番。形式例: `YYYYMMDD-HHMMSS-<6char>`。`date +%Y%m%d-%H%M%S` の結果に、SV が英数字 6 文字を付ける。ファイル名に使える文字だけ (後述「ファイル名になる値」) |
| `project_memory_path` | string | 任意 | プロジェクトの規約・memory 類を置いたディレクトリ (Claude Code の auto memory を使っていればそのディレクトリ)。ディレクトリがあるときだけ渡す。省略時は policy 観点を CLAUDE.md・プロジェクト規約だけで判定する |
| `project_root` | string | 任意 | プロジェクトルート絶対パス。コード diff を見るレビュー系 wf では git コマンドの実行場所、`sv-implement` の検証手順の既定の実行場所 (省略時は作業ディレクトリ) |
| `stacks` | array | 任意 | プロジェクトの技術スタック (`~/.claude/stacks/` のディレクトリ名の配列。各要素はファイル名になる値 (後述)、重複は `args 構造不足`)。指定すると、ロール定義を読む各担当がスタックのパックも読む。決め方は後述「`stacks` の決め方」。省略時はロール定義だけで進む |
| `checkpoint_declarations` | array | 任意 | ユーザ宣言のフェーズ停止点 (例: `['designed', 'implemented']`)。受け付ける名前と止まる wf は下表。他の wf にも同じ配列を渡してよく、該当しない wf は止まらない。表に無い名前は `args 構造不足` |
| `complexity_profile` | enum | 任意 | `'light'` \| `'standard'` \| `'deep'` (後述「モデルの指定」) |
| `model_overrides` | object | 任意 | 役割別モデル上書き (例: `{reviewer: 'opus'}`)。役割キーは後述「モデルの指定」 |
| `wf_specific` | object | ○ | wf 固有引数 (次節参照) |

`run_id` は SV が起動前に Bash で採番する。Workflow スクリプト内では `Date.now()` / `Math.random()` が使用不可のため、外から注入する必要がある。

### `checkpoint_declarations` の名前

| 名前 | 止まる wf |
|---|---|
| `investigated` | `sv-investigate` |
| `ui_prototyped` | `sv-prototype-ui` |
| `designed` | `sv-design` |
| `implemented` | `sv-implement` |

### `stacks` の決め方

- 材料: `~/.claude/stacks/*/index.md` を Glob か Read で列挙し、各パックの「当てはまるプロジェクト」と対象プロジェクトのファイルを突き合わせる。どのスタックがあるかの一覧は本書に持たない
- 複数が当てはまるとき: この作業が触る部分に当てはまるものをすべて渡す。リポジトリの一部だけを触るなら、その部分のスタックに絞る
- 迷うとき: 自律進行シグナルの「🟡」の 1 点として、推奨付きで聞く
- 当てはまるパックが無いとき: `stacks` を渡さない。シグナルでは「該当パックなし」と示す
- ユーザへの示し方: 「🟢」の中に「wf に伝える技術スタック (判断の目印)」を 1 行で入れる
- 同じ案件の中では、全 wf に同じ `stacks` を渡す
- 配置されていない名前を渡しても wf は止まらない。担当は成果物に「スタックパック未配置」と書いて続けるだけで、知識は届かない

### モデルの指定

- `complexity_profile`: `standard` (省略時) は役割ごとの既定と `model_overrides` を使う。`light` は全役割を `sonnet` にし、`deep` は全役割をセッションのモデルにする。どちらも `model_overrides` を無視する
- `model_overrides`: 役割キーとモデルの別名 (`sonnet` 等) またはフルのモデル ID。`null` はセッションのモデル。表に無いキーは `args 構造不足`
- 役割定義ファイルと役割キーは対応しない (例: 網羅性チェックは `reviewer.md` を読むが `critique` で制御する。テスト担当は `verifier.md` を読むが `test_runner` で制御する)

| 役割キー | 既定 | 制御する担当 |
|---|---|---|
| `investigator` | `sonnet` | `sv-investigate` の調査担当 |
| `critique` | セッションのモデル | `sv-investigate` の網羅性チェック |
| `designer` | セッションのモデル | `sv-design` の設計担当、`sv-explore-approach` の提案担当 |
| `judge` | セッションのモデル | `sv-explore-approach` の審査担当 |
| `reviewer` | セッションのモデル | `sv-design` / `sv-review-plan` / `sv-review-changes` / `sv-comprehensive-review` のレビュー担当 |
| `ui_designer` | セッションのモデル | `sv-prototype-ui` のデザイン担当 |
| `ui_reviewer` | セッションのモデル | `sv-prototype-ui` のレビュー担当 |
| `implementer` | `sonnet` | `sv-implement` の実装担当 |
| `test_runner` | `sonnet` | `sv-implement` のテスト担当 |
| `committer` | `sonnet` | `sv-implement` の commit 担当 |
| `selfcheck_gate` | `sonnet` | レビュー系 3 wf のセルフチェック確認 |

### ファイル名になる値

`run_id`・`stacks[]`・`sv-investigate` の `areas[].name`・`sv-explore-approach` の `perspectives[]`・`sv-implement` の `components[].name`・`sv-review-plan` の `prev_run_id` は、成果物のファイル名・パスに使われる。文字・数字で始まり、文字・数字・`.`・`_`・`-` だけで書く。それ以外は `args 構造不足`。

---

## wf 別 `wf_specific` 引数

### `sv-investigate` — 曖昧な要望・特定領域の状態把握

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `areas` | array | ○ | 調査対象領域の配列。各要素は `{ name, scope, questions }` (name・scope は必須、name は重複不可でファイル名になる値 (上記)) |
| `context` | string | 任意 | 全領域共通の背景情報 |
| `completeness_check` | boolean | 任意 | 網羅性チェックを回すか（既定 `true`）。**調査範囲がユーザ決定で閉じているときは `false`** — 「抜けている領域はないか」は範囲を開け直す開いた問いで、追加調査の圧力を生む。`false` のとき返り値の `critiquePath` は `null`。アクセス不能領域は各領域の md が同名の節を必ず持つのでそちらから拾う |

### `sv-explore-approach` — 仕様確定前のアプローチ比較

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `goal` | string | ○ | ユーザの要望 (自然言語) |
| `constraints` | array | 任意 | 制約の配列 |
| `perspectives` | array | 任意 | 案作成の観点。デフォルト `['mvp', 'risk', 'scalability', 'user-experience']` (空配列もデフォルトに戻す。重複は args 構造不足。各要素はファイル名になる値 (上記)) |
| `background` | string | 任意 | 関連する既存実装・過去の判断 |

### `sv-prototype-ui` — HTML プロトタイプ制作

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `ui_requirements` | string | ○ | UI 要件 |
| `usage_scenarios` | array | 任意 | `[{ actor, goal, steps }]` |
| `existing_ui_references` | array | 任意 | 参考にすべき既存画面 |
| `constraints` | object | 任意 | `{ responsive, dark_mode, framework }` |
| `output_base_dir` | string | 任意 | プロトタイプ HTML 保存先 |

### `sv-design` — 要件から設計 + レビュー + 修正ループ

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `requirements` | string | ○ | 確定済み要件 |
| `constraints` | array | 任意 | 制約の配列 |
| `investigation_result_path` | string | 任意 | 調査結果 md のパス |
| `scope` | object | 任意 | `{ target_paths, out_of_scope }` |
| `design_style_preference` | enum | 任意 | `'aggressive'` \| `'conservative'` (デフォルト後者) |

### `sv-implement` — 依存順のバッチ単位で並列実装 + テスト + commit (レビューは後段の sv-comprehensive-review)

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `design_path` | string | ○ | 設計書 md のパス |
| `components` | array | ○ | `[{ name, files, description, dependencies }]` (name・description は必須、name は重複不可でファイル名になる値 (上記)、dependencies は他要素の name のみ。files は省略可で、実装担当は設計書から、commit 担当は実装 md から対象を特定する) |
| `run_tests_after` | boolean | 任意 | テスト実行するか |
| `test_commands` | array | 任意 | `run_tests_after=true` のとき必須 (空は args 構造不足)。検証の手順の配列。要素は文字列か `{ command, kind, cwd }`。文字列は `kind: 'test'` と同じ。`kind` は `build` / `test` / `launch` (省略時 `test`)、`cwd` は実行場所の絶対パス (省略時は `project_root`)。組み立て方は後述「検証コマンドの組み立て」 |
| `test_timing` | enum | 任意 | `'post-pipeline'` (default) \| `'per-component'` |
| `commit_strategy` | enum | 任意 | `'per-component'` \| `'all-at-once'` \| `'none'` (default) |

#### 検証コマンドの組み立て

- 渡すスタックの `verification.md` の「検証コマンド」節から選ぶ
- テストの範囲: プロジェクトの規約に従う。規約が無ければ、`test_timing: 'per-component'` では変更に届くテスト、`post-pipeline` (完了前の確認) では全件
- `test_commands` は全コンポーネントで共通の 1 組になる。`per-component` では、どのコンポーネントの変更にも届く範囲を渡す。同じバッチのテストは並列に走るので、出力先を取り合う `build` と、同じアプリを起動する `launch` は `post-pipeline` で使う
- ビルドを先に、起動確認を最後に並べる。ビルドが失敗すると後続は実行されない
- 起動確認のコマンドは自分で終わる形にする。起動 → 状態の確認 → 起動したプロセスの停止までを 1 つのコマンドで完結させ、起動したものを残さない。終わらない・プロセスが残る手順は、テスト担当が失敗として報告する
- 実行場所は、可能ならコマンド側のオプション (`--package-path`、`-C` など) で指定する。`cwd` はそれができないときに使う (`cd` を含む形での実行になり、許可の確認が出ることがある)
- 人の目が要る確認 (画面の見た目・許可ダイアログ・音) は入れない。SV が実機確認としてユーザに頼む

### `sv-comprehensive-review` — 変更セット全体の多観点レビュー

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `change_scope` | object | ○ | `{ files, commit_range }`。`files` (配列) は必須で空配列不可。`commit_range` は任意で、省略か `'uncommitted'` で作業ツリーの未 commit 変更 (未追跡の新規ファイルを含む)、それ以外は git の範囲指定。対象が git 管理外のときは `files` の全文をレビューする (`commit_range` は無視。変更の中身はセルフチェック証跡と `spec_paths` で伝える) |
| `selfcheck_path` | string | ○ | SV がレビュー前に実施したセルフチェックの証跡 md のパス (後述「セルフチェック証跡」) |
| `spec_paths` | array | 任意 | 仕様書のパス配列 |
| `documentation_paths` | array | 任意 | ドキュメントのパス配列 |
| `test_paths` | array | 任意 | 関連テストのパス配列 |
| `review_lenses` | array | 任意 | デフォルト `['correctness', 'docs', 'policy']` (空配列もデフォルトに戻す。許容値外・重複は args 構造不足。`consistency` / `spec-coverage` / `spec-existence` / `security` も指定でき、それぞれ独立した観点としてレビューする。チェック観点は既定 3 観点 (`correctness` / `docs` / `policy`) で分担するので、この 3 つのどれかを外すと、その観点が担うチェックも外れる) |
| `optimize_for` | enum | 任意 | `'wall_clock'` (default: 観点ごとに並列 agent) \| `'tokens'` (単一 agent が全観点を 1 パス) |

### `sv-review-plan` — SV 自作計画の独立レビュー

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `plan_path` | string | ○ | SV 起草の計画・設計 md パス |
| `plan_type` | enum | ○ | `'design'` \| `'implementation-plan'` \| `'refactor-plan'` |
| `selfcheck_path` | string | ○ | SV がレビュー前に実施したセルフチェックの証跡 md のパス (後述「セルフチェック証跡」) |
| `context` | object | 任意 | 対話で合意した要件・制約 |
| `prev_plan_path` | string | 任意 | 前バージョン計画 md のパス。指定時は diff モードで起動。前回のレビュー結果は「このパスと同じディレクトリの `plan-review.md`」として探すため、前回の sv-review-plan のスナップショット以外を渡すと前回結果が見つからずフル監査になる。通常は `prev_run_id` を使う |
| `prev_run_id` | string | 任意 | 前回 sv-review-plan 実行の run_id (ファイル名になる値 (上記))。指定時は前回スナップショットを `prev_plan_path` として自動採用 (`prev_plan_path` 明示指定があればそちらを優先) |

### `sv-review-changes` — 手元変更の単発コードレビュー

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `change_scope` | object | ○ | `{ files: string[], commit_range: string }`。`files` は必須で空配列不可。`commit_range` は任意で、省略か `'uncommitted'` で作業ツリーの未 commit 変更 (未追跡の新規ファイルを含む)、それ以外は git の範囲指定。対象が git 管理外のときは `files` の全文をレビューする (`commit_range` は無視。変更の中身は `context` とセルフチェック証跡で伝える) |
| `selfcheck_path` | string | ○ | SV がレビュー前に実施したセルフチェックの証跡 md のパス (後述「セルフチェック証跡」) |
| `context` | string | 任意 | 変更の意図・背景。2 巡目以降は、前の巡の成果物の path と通過済みの範囲も書く |
| `focus_areas` | array | 任意 | 重点観点の配列 |

## セルフチェック証跡

レビュー系 wf (`sv-review-plan` / `sv-review-changes` / `sv-comprehensive-review`) は `selfcheck_path` を必須とする。作成手順と内容の目安は `sv-mode.md` の「実施上の原則」のレビュー必須を参照。

- wf はレビュー本体の前に、軽量エージェントで証跡を確認する。見るのは「実施したことが読み取れ、対象の規模に対して妥当か」だけで、内容の正しさは検証しない
- 不備があればレビュー本体を起動せず `status: 'rejected'` を返す (`rejection.reason` に理由)。SV はセルフチェックをやり直して証跡を補い、再起動する
- `selfcheck_path` 自体を渡し忘れた場合は、他の必須キーと同じく `args 構造不足` の escalation になる

---

## 起動例

`sv-review-changes` の起動例:

```
Workflow({
  name: 'sv-review-changes',
  args: {
    tmp_base_dir: '/path/to/project/tmp',
    run_id: '20260710-123456-abc123',
    project_root: '/path/to/project',
    wf_specific: {
      change_scope: {
        files: ['src/foo.py', 'tests/test_foo.py'],
        commit_range: 'uncommitted',
      },
      selfcheck_path: '/path/to/project/tmp/selfcheck_foo.md',
      context: '変更の意図をここに書く',
      focus_areas: ['特に見てほしい観点 1', '観点 2'],
    },
  },
})
```

規約・memory 類のディレクトリ (auto memory 等) があるときは `project_memory_path` も渡す。スタックを判断したら `stacks` も渡す (例: `stacks: ['rails']`)。

---

## よくある間違い

- **`args` を文字列で渡す** (`JSON.stringify()` した結果や、引用符で包んだ JSON) → エスケープ崩れで解釈できず即失敗しやすい。オブジェクトをそのまま渡す
- **`args` に長文・コード片を直接埋め込む** → md ファイルに書いてパスを渡す
- **必須の共通引数 (`tmp_base_dir` / `run_id`) を渡し忘れる** → エージェントを起動する前に `args 構造不足` で返る。`run_id` は script 内で時刻・乱数を使えないため、必ず SV が Bash で採番する
- **レビュー系 wf に `selfcheck_path` を渡さない、または中身のない証跡を渡す** → レビューは実施されない (`args 構造不足` または `rejected`)
- **`checkpoint_declarations` に表に無い名前を入れる** → `args 構造不足` になる。名前の無い宣言 (「レビュー結果を見せて」など) は wf に渡さず、SV が結果を受け取った時点で止まる
- **配置されていないスタック名を `stacks` に渡す** → 担当は未配置として続けるだけで、知識は届かない。起動前に `~/.claude/stacks/<名前>/index.md` の有無を確かめる
- **`test_commands` に人の目が要る確認を入れる** → テスト担当には確かめられない。SV が実機確認としてユーザに頼む
- **`model_overrides` に存在しない役割キーを入れる** → `args 構造不足` になる (打ち間違いが黙って無視されない)。役割キーは「モデルの指定」の表を参照

---

## エラー対応

wf 起動が `args 構造不足: N 件` を含む escalation で返ってきたら、`details` フィールドに問題のあるキーと内容 (不足・型違反・許容値外・重複・存在しない参照) が入っている。該当キーを直して再起動する。必須の配列は空配列も不足とみなす。`details` が「args を JSON オブジェクトとして解釈できない」の場合は、`args` を文字列で渡していないか確認し、オブジェクトで渡し直す。

例:
```
"details": [
  "args.tmp_base_dir が不足 (required)",
  "args.wf_specific.change_scope が不足 (required)"
]
```

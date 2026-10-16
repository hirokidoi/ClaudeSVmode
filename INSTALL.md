# SV モードキットの導入

workflow (wf) を組み合わせて案件を進める SV (スーパーバイザー) モード一式。運用ルールは `sv-mode.md`、wf の概要は `workflows/README.md` を参照。

## 概要

キットの中身は次のとおり。

| ファイル | 役割 |
|---|---|
| `sv-mode.md` | SV モードの進め方 (導入先の CLAUDE.md から取り込む) |
| `CLAUDE.snippet.md` | 導入先の CLAUDE.md に足す行 |
| `workflows/` | wf 本体と、その使い方の文書 |
| `roles/` | wf 内のエージェントが読む役割定義 |
| `stacks/` | 技術スタック別の補足知識 (パック)。作り方と足し方は `stacks/README.md` |
| `settings.snippet.json` | wf が確認なしで動くための許可設定 |

導入の流れは、配置 → CLAUDE.md への書き足し → 許可設定 → 確認。

## 前提

- Claude Code の Workflow が使えること
  - Workflow は v2.1.154 で入った機能。このキットの動作を確かめた版は v2.1.285
  - 使えるかの確かめ方: Claude Code で `/workflows` を開ける。開けなければ、次を順に確かめる
  - 既定の状態はプランや利用経路で異なる
    - Pro: 既定で無効
    - Max・Team・Enterprise、Anthropic API・クラウド経由 (Amazon Bedrock・Google Cloud・Microsoft Foundry) での利用: 既定で有効
  - 有効にする手順 (全プラン共通): `/config` の「Dynamic workflows」をオンにする。設定ファイルで書くなら `enableWorkflows: true`。`/config` で操作すれば、設定ディレクトリの場所を気にしなくてよい
  - 無効にされている原因ごとの対処
    - 利用者自身の設定ファイル (ユーザ・プロジェクト・ローカル) に `disableWorkflows` がある、またはシェルで環境変数 `CLAUDE_CODE_DISABLE_WORKFLOWS=1` を設定している: それを外せば使える (`enableWorkflows` では打ち消せない)
    - 組織の管理設定 (managed settings) や管理画面で無効にされている: 利用者の設定では有効にできない。管理者に有効化を依頼する
- wf の Bash は macOS / Linux のシェルを前提にする (`mkdir -p` / `cp` / `diff` / `date`)
- レビュー系 wf は、git があれば差分を、無ければ対象ファイルの全文をレビューする
- プロンプトと文書は日本語。成果物の言語は導入先の言語設定に従う

## 配置

| このフォルダ | 配置先 |
|---|---|
| `sv-mode.md` | `~/.claude/sv-mode.md` |
| `workflows/` | `~/.claude/workflows/` |
| `roles/` | `~/.claude/roles/` |
| `stacks/` | `~/.claude/stacks/` |

wf・roles・stacks はこのパスを固定で参照するので、配置先は変えない。

役割ファイル名 (designer / implementer / investigator / reviewer / verifier) は一般的なので、先に同名のファイルが無いか確かめる。既にあれば上書きになる。

```sh
ls ~/.claude/roles ~/.claude/workflows ~/.claude/stacks
```

フォルダが無ければ `No such file or directory` と出る。その場合は同名のファイルも無いので、そのまま進めてよい。

キットのフォルダで次を実行する。

```sh
mkdir -p ~/.claude
cp -R workflows roles stacks ~/.claude/
cp sv-mode.md ~/.claude/
```

### 設定ディレクトリの注意

- `~/.claude` がシンボリックリンクの場合: 配置はそのままでよい。許可設定にはリンクのパスと実際のパスの両方を書く (「許可設定」参照)
- `CLAUDE_CONFIG_DIR` で設定ディレクトリを移していて `~/.claude` が無い場合: `ln -s "$CLAUDE_CONFIG_DIR" ~/.claude` で `~/.claude` からたどれるようにする。wf は設定ディレクトリの `workflows/` から読まれ、プロンプトの `~/.claude/roles/...` と `~/.claude/stacks/...` はホームから読まれるため、両方が同じ場所を指す必要がある
- `CLAUDE_CONFIG_DIR` を使っていて、`~/.claude` が別の実体として存在する場合: このキットはそのままでは動かない (wf は設定ディレクトリ側、roles と stacks はホーム側を見るため)。どちらかに寄せる

## CLAUDE.md への書き足し

- `CLAUDE.snippet.md` の内容を `~/.claude/CLAUDE.md` の末尾に足す (無ければ作る)。コードブロックの中には入れない (コードブロック内の `@` は取り込まれない)
- 足した後に、既存のルールと食い違いが無いかを確かめる。特に見る点は次のとおり。食い違う場合は、どちらを優先するかを CLAUDE.md に書く
  - サブエージェントの使い方 (SV モード中は Agent ツールで本筋を直接任せない)
  - 変更後のレビュー (SV モード中は必須)
  - 承諾の取り方
  - 作業ファイルの置き場
- 取り込まれたかは `/memory` で確かめられる (`sv-mode.md` が一覧に出る)

## 許可設定

`settings.snippet.json` の `allow` の要素を `~/.claude/settings.json` の `permissions.allow` に足す (ファイルや `permissions` が無ければ作る)。

| ルール | 用途 |
|---|---|
| `Workflow(sv-...)` | wf の起動 (wf ごとに 1 行) |
| `Read(~/.claude/roles/**)` / `Read(~/.claude/workflows/**)` | エージェントによる役割定義と使い方の読み取り |
| `Read(~/.claude/stacks/**)` | エージェントによるスタックパックの読み取り |
| `Edit(tmp/**)` | プロジェクトの `tmp/` (Claude Code を起動したディレクトリ基点) への成果物の書き込み |
| `Edit(~/tmp/wf-runs/**)` | プロジェクトに `tmp/` が無いときの成果物の置き場 |
| `Bash(git rev-parse *)` / `Bash(git diff *)` / `Bash(git status *)` | レビュー系 wf による差分の取得 |
| `Bash(mkdir -p *)` / `Bash(cp *)` | 計画レビューのスナップショットと、設計の修正ループでの前回成果物の退避。wf の作業ディレクトリ内のコピーに使う。`cp` は任意の場所への上書きも確認なしにするので、気になる場合は外してよい (その都度確認になる) |
| `Bash(diff *)` | 修正ループでの前回との差分の確認 |
| `Bash(date *)` | SV による `run_id` の採番 |

- `~/.claude` がシンボリックリンクの場合: 許可ルールは、指定したパスと実際のパスの両方に一致したときだけ効く。`Read(~/.claude/roles/**)` や `Read(~/.claude/stacks/**)` などに加えて、実際のパスのルール (例: `Read(//<実際の絶対パス>/roles/**)`、`Read(//<実際の絶対パス>/stacks/**)`) も足す
- `Write(...)` 形式のルールは評価されない。書き込みの許可は `Edit(...)` で書く
- `~/.claude` の下への書き込みは保護されていて、許可ルールでも事前承認できない。作業ディレクトリを `~/.claude` の下にしない
- 作業ディレクトリ: プロジェクトの `tmp/` を使うなら `.gitignore` に入れる。`~/tmp/wf-runs` を使うなら `mkdir -p ~/tmp/wf-runs` で作っておく
- 状況に応じて足すもの
  - `sv-implement` に commit させるなら `Bash(git add *)`・`Bash(git commit *)` と、commit の書式を直近の履歴に合わせるための `Bash(git log *)`
  - テストを実行させるなら、そのコマンド。検証の手順に `cwd` を使うと `cd` を含む形で実行されるので、許可の確認が出ることがある
  - 調査担当は他の読み取り系コマンド (`ls` など) を使うことがあり、許可が無いとその都度確認になる
- 実装担当によるプロジェクトのファイル編集は、ふだんの権限モードに従う。default では編集ごとに確認が出て wf が一時停止する。止めたくなければ acceptEdits で進めるか、プロジェクトの `Edit(...)` を許可する
- 広く許可する場合: `Bash(*)` を足すと Bash の個別ルールは不要になる (確認なしで任意のコマンドが走る点に注意)
- SV モードは対話の CLI で使う。wf はバックグラウンドで動くため、`claude -p` で SV モードを使うと、wf の完了を待たずにセッションが終わり、wf が途中で止まることがある (wf を単体で起動した場合の挙動は確かめていない)
- 対話なし (`claude -p` や Agent SDK) で wf を単体で起動する場合は、`Workflow` の許可ルールが必須 (対話の CLI では初回に確認ダイアログが出る)

## 確認

- Claude Code を再起動し、`/` の補完に `sv-investigate` などが出ること、`/memory` に `sv-mode.md` が出ることを確かめる
- 試運転: 小さなプロジェクトで「この中の X について調べたい」と頼み、SV モードの提案 → 承諾 → `sv-investigate` の起動 → 作業ディレクトリに成果物ができる、まで通ることを確かめる。途中で出た許可の確認は、許可設定に足すか判断する
- 任意: `stacks` を指定して wf を起動し、担当の成果物に「スタックパック未配置」が出ないことを確かめる

## 更新と取り外し

- 更新: 配置と同じコマンドで上書きする。同じ名前のスタックパックも上書きされる (自分で足すパックは別の名前で置く。詳細は `stacks/README.md`)
- 取り外し: CLAUDE.md から足した行を消す。`~/.claude/sv-mode.md`、`~/.claude/workflows/sv-*.js` と関連文書、`~/.claude/roles/` のキット由来のファイル (designer / implementer / investigator / reviewer / verifier)、`~/.claude/stacks/` のキット由来のパックは、中身を確かめてから削除する

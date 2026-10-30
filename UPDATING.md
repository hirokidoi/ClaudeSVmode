# キットの更新

キットを新しい版に取り込む手順。初めての導入は `INSTALL.md` を参照。

## 手元の版の確かめ方

```sh
cat ~/.claude/workflows/VERSION
```

ファイルが無ければ 1.0.0。

## 取り込み方

1.2.0 以降、自分用の規則は利用者の追記 (`INSTALL.md` の「利用者の追記」) に置ける。キットのファイルに手を入れず追記だけで済ませていれば、「手を入れていない場合」の手順で更新できる。

### 手を入れていない場合

`INSTALL.md` の「配置」と同じコマンドで上書きする。そのあと、下の「版ごとの変更」のうち、手元の版より新しく、新しい版までのすべての版について、「無くなったファイル」の項にあるものを `~/.claude` から消し、「設定」の項を `~/.claude/settings.json` と `~/.claude/CLAUDE.md` に足す。

### 手を入れている場合

Claude Code に頼む。キットのリポジトリ (`git clone` したもの) で `git pull` を実行して新しい版のタグまで取り込み、その中で次の文面を使う。`<手元の版>` と `<新しい版>` は置き換える。

```text
~/.claude に配置している SV モードキットを、v<手元の版> から v<新しい版> に更新してください。
キットのリポジトリは今のフォルダです。旧版と新版は git のタグ v<手元の版> と v<新しい版> を使います。INSTALL.md と UPDATING.md は v<新しい版> のものを読みます。
対象は INSTALL.md の「配置」の表にあるもの (sv-mode.md と workflows・roles・stacks の下) だけです。リポジトリでのパスが、そのまま ~/.claude の下のパスになります。
~/.claude/sv-mode.local.md と ~/.claude/roles/local/ は私のファイルです。変更・削除しないでください。

1. 旧版から新版までの、対象の変更ファイルの一覧を作り、書き換える前に私に見せて承諾を得てください。
2. 新版で増えたファイルは、そのまま ~/.claude にコピーしてください。ただし手元に同じ名前のファイルがあれば、上書きせずに私に見せてください。
3. 変わったファイルは、~/.claude の手元のファイルが旧版と同じなら新版で上書きしてください。
   違っていれば git merge-file -p <手元> <旧版> <新版> で 3 者マージしてください。
   旧版と新版のファイルは git show v<版>:<パス> で一時ファイルに取り出し、マージの結果は確かめてから手元のファイルに書き戻します。
   衝突があれば私に見せて決めてもらい、私の変更を残す側に倒してください。
   新版で無くなったファイルは、手元のファイルが旧版と同じなら消し、違っていれば消さずに私に見せてください。
4. UPDATING.md の「版ごとの変更」のうち、v<手元の版> より新しく v<新しい版> までのすべての版の「設定」の項を見て、~/.claude/settings.json と ~/.claude/CLAUDE.md に足してください。
   足し方は INSTALL.md の「CLAUDE.md への書き足し」「許可設定」「フック設定」に従い、既存の内容は消さないでください。
5. 終わったら bash ~/.claude/workflows/check-prelude.sh と sh ~/.claude/workflows/mailbox/test-hook.sh を実行してください (後者は 1.1.0 以降で、jq が無い環境では飛ばす)。
```

### ZIP で入手した場合

- 旧版と新版の ZIP を、GitHub のリポジトリの Releases か Tags から版を選んで入手し、別々のフォルダに展開する
- 上の文面の 2 行目 (「キットのリポジトリは今のフォルダです。」で始まる行) を、次の 1 行に置き換えて使う。`<旧版のフォルダ>` と `<新版のフォルダ>` は、展開してできたフォルダのうち `INSTALL.md` があるフォルダに置き換える

  ```text
  旧版は <旧版のフォルダ>、新版は <新版のフォルダ> に展開してあります。git show の代わりに、それぞれのフォルダのファイルを使います。INSTALL.md と UPDATING.md は新版のフォルダのものを読みます。
  ```

- 3 者マージに `git merge-file` を使うので、git は要る (リポジトリの clone は要らない)

## 版ごとの変更

新しい版を上に並べる。

### 1.3.0

立場を分けた論者に議論させる wf `sv-discuss` の追加。

- 増えたファイル (そのままコピー)
  - `workflows/sv-discuss.js`
  - `workflows/design-docs/sv-discuss.md`
- 変わったファイル (手を入れていればマージ)
  - `workflows/USAGE.md`・`workflows/README.md`: sv-discuss の引数・返り値と一覧
  - `workflows/check-prelude.sh`: sv-discuss の持つブロック
  - `workflows/_prelude.js.md`: 使用方法の表
  - `workflows/design-docs/_common.md`: ファイル名になる値・担当の表・設計判断ほか
  - `sv-mode.md`: wf カタログと呼び出し順
  - `workflows/VERSION`
- 無くなったファイル: なし
- 配置しない文書の変更
  - `README.md`: 用途の一覧
  - `UPDATING.md`: 1.3.0 の項
- 配置しないその他のファイルの変更
  - `settings.snippet.json`: `Workflow(sv-discuss)`
- 設定
  - `settings.json` の `permissions.allow` に `Workflow(sv-discuss)` を足す。手順は `INSTALL.md` の「許可設定」
  - `CLAUDE.md` への追加はない
- roles は変わらない

### 1.2.2

担当が連絡帳を Bash やシェル変数で読んでも、フックが担当と連絡帳を結び付け、新着が担当に届くようにする。

- 増えたファイル: なし
- 変わったファイル (手を入れていればマージ)
  - `workflows/_prelude.js.md` と `workflows/sv-*.js` 8 本: 担当は inbox と outbox を Read ツールで、完全なパスを書いて読む
  - `workflows/mailbox/rules.md`: 同上
  - `workflows/mailbox/hook.sh`: Bash のコマンドに連絡帳のフォルダの絶対パスがあれば結び付ける。inbox・outbox の絶対パスは run ディレクトリが無くても結び付ける
  - `workflows/mailbox/test-hook.sh`: 上の結び付けの検査
  - `workflows/VERSION`
- 無くなったファイル: なし
- 配置しない文書の変更
  - `UPDATING.md`: 1.2.2 の項
- 設定
  - `settings.json` への追加はない
  - `CLAUDE.md` への追加はない
- roles は変わらない

### 1.2.1

wf や Agent ツールで起動した担当 (サブエージェント) が、CLAUDE.md の取り込みで文脈に入る `sv-mode.md` とアドオンを自分に当てはめないようにする。

- 増えたファイル: なし
- 変わったファイル (手を入れていればマージ)
  - `sv-mode.md`: 「適用範囲」に、担当は本書とアドオンの対象外である旨の 1 項
  - `workflows/VERSION`
- 無くなったファイル: なし
- 配置しない文書の変更
  - `UPDATING.md`: 1.2.1 の項
- 設定
  - `settings.json` への追加はない
  - `CLAUDE.md` への追加はない
- roles は変わらない

### 1.2.0

利用者の追記 (SV のアドオン・ロールの追記) の読み込みと、sv-investigate の深掘りの追加。

- 増えたファイル: なし (利用者が作るファイルはキットに含まれない)
- 変わったファイル (手を入れていればマージ)
  - `workflows/_prelude.js.md` と `workflows/sv-*.js` 8 本: 担当がロール定義の後に利用者の追記を読む。追記ファイルや連絡帳が無いことを成果物に書かない
  - `workflows/mailbox/rules.md`: 連絡帳のファイルが無いことを成果物に書かない
  - `workflows/sv-investigate.js`: 上に加えて、深掘りの引数 `deep_dive` と、網羅性チェックの返り値の形式、返り値の `deferredAreas`・`areaMdPaths[].followup`
  - `workflows/USAGE.md`・`workflows/README.md`: sv-investigate の深掘りと、ロール節の説明
  - `workflows/design-docs/_common.md`・`workflows/design-docs/sv-investigate.md`: 同上と設計判断
  - `workflows/VERSION`
  - `sv-mode.md`: アドオンの優先と、wf カタログの sv-investigate
  - `stacks/README.md`: 担当の読み方と優先順位
- 無くなったファイル: なし
- 配置しない文書の変更
  - `INSTALL.md`・`README.md`・`UPDATING.md`: 利用者の追記の案内
- 配置しないその他のファイルの変更
  - `.gitignore`: 利用者の追記ファイルを無視
- 設定
  - `settings.json` への追加はない (追記の Read は `Read(~/.claude/roles/**)` に含まれる)
  - `CLAUDE.md` への追加はない。アドオンを使う場合だけ、取り込みの行を足す (`INSTALL.md` の「利用者の追記」)
- roles は変わらない
- 使い方の変化: sv-investigate の網羅性チェックの md の判定 JSON の形が変わった (`additional_areas_recommended` → `followup_areas`・`confirmation_areas`)。md を読む手順を自分で書いている場合は合わせる

### 1.1.0

連絡帳 (wf の実行中に SV と担当がやりとりする仕組み) の追加。

- 増えたファイル (そのままコピー)
  - `workflows/mailbox/` の `hook.sh`・`rules.md`・`test-hook.sh`
  - `workflows/VERSION`
- 変わったファイル (手を入れていればマージ)
  - `workflows/_prelude.js.md` と `workflows/sv-*.js` 8 本: 連絡帳の場所を担当に渡す仕組みの追加。調査・アプローチ比較の担当には最小の返り値形式を追加
  - `workflows/USAGE.md`: 連絡帳の節の追加
  - `workflows/README.md`・`workflows/design-docs/_common.md`: 連絡帳の説明と設計判断の追加
  - `workflows/design-docs/sv-*.md` (sv-design・sv-prototype-ui を除く 6 本): 担当の起動の書き方を prelude の新しい関数に合わせた
  - `workflows/check-prelude.sh`: wf 名の定数と meta の名前が一致するかの検査の追加
  - `sv-mode.md`: 連絡帳の原則の追加
- 無くなったファイル: なし
- 配置しない文書の変更
  - `INSTALL.md`・`README.md`: フック設定と更新の案内の追加
- 設定
  - `settings.json` に `settings.snippet.json` の `hooks` を足す。手順は `INSTALL.md` の「フック設定」。jq が要る
  - `CLAUDE.md` への追加はない
- roles は変わらない

### 1.0.0

最初の公開版 (commit `862143d`)。

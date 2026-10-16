# Rails の検証

## 検証コマンド

SV はここから `test_commands` を組み立てる。範囲 (全件か変更に届くものか) はプロジェクトの規約に従い、規約が無ければ、完了前の確認は全件にする。

| kind | コマンド | 用途 |
|---|---|---|
| test | `bundle exec rspec` | RSpec の構成。範囲を絞るときはファイルやディレクトリを渡す |
| test | `bin/rails test` | Minitest の構成 |
| test | `bundle exec brakeman -q --no-pager` | 静的解析。出力は警告の一覧 |
| build | `bash -c 'RAILS_ENV=production bin/rails assets:precompile; rc=$?; RAILS_ENV=production bin/rails assets:clobber; exit $rc'` | 本番相当のアセットコンパイル。アセットを変えたときだけ。成果物を残さないよう、片付けまで 1 つのコマンドで行う |

- `assets:clobber` はアセットの出力先を消す。SV は、出力先が追跡対象外であることを確かめてから、この手順を入れる。追跡しているプロジェクトでは使わない

## 環境の前提

- 開発 DB を作り直したら、test DB も作り直す。migrate は開発の DB にしか流れないので、`RAILS_ENV=test` で準備のタスク (`bin/rails db:prepare` など。タスク名はプロジェクトの手順に従う) を流す。流さないと、テーブルが存在しない失敗になる
- 環境の失敗 (DB に接続できない、テーブルが無い) は、テストの失敗と分けて報告する

## 結果の読み方

- 実行順に依存して落ちる疑いがあるときは、同じ seed (`--seed`) で流し直して再現を確かめる
- 変更と無関係に見える失敗も、不合格のまま報告する

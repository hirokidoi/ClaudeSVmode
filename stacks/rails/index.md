# rails パック

## 当てはまるプロジェクト

- Gemfile に `rails` がある
- `config/application.rb` と `bin/rails` がある

## 読むファイル

| ファイル | 読み手 | 条件 |
|---|---|---|
| practice.md | investigator, designer, implementer, reviewer | 常に |
| testing.md | designer, implementer, reviewer | 常に |
| db-mysql.md | investigator, designer, implementer, reviewer | `config/database.yml` の adapter が `mysql2` か `trilogy` のとき |
| db-postgresql.md | investigator, designer, implementer, reviewer | `config/database.yml` の adapter が `postgresql` のとき |
| db-sqlite.md | investigator, designer, implementer, reviewer | `config/database.yml` の adapter が `sqlite3` のとき |
| verification.md | verifier | 常に |

## SV への案内

- 検証コマンドは verification.md の「検証コマンド」節から選ぶ
- テストの範囲 (全件か変更に届くものか) は、プロジェクトの規約を先に確かめる

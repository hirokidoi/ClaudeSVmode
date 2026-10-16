# WKWebView の落とし穴

- 一度も表示されないウィンドウの `WKWebView` は、描画と JavaScript の実行が抑えられる。`orderOut` や画面外への移動も、不可視として扱われる。裏で動かしたいときは、不可視のまま画面上に置く形 (`alphaValue` を 0、`ignoresMouseEvents` を true にして前面に出す) を試し、実機で動作を確かめる
- ポップアップの要求 (`createWebViewWith`) に nil を返すと、UI が固まる場合がある。ポップアップを使うフロー (認証など) は、実機で確かめる

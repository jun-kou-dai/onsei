# Edge TTS（Bing WebSocket TTS）がVercelから遅い問題

## 環境
- ホスティング: Vercel (Serverless Functions, Node.js runtime)
- リージョン: hnd1（東京）
- WebSocketライブラリ: ws (npm)
- edge-tts npm パッケージ v1.0.1 もインストール済み（未使用）

## 症状
- `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` へのWebSocket接続自体は成功する
- HTTPレスポンスヘッダー（200）も数秒で返る
- しかし**音声データの受信に30秒以上**かかる
- ローカル環境やブラウザ拡張からは高速に動作する（はず）

## 試したこと（全て効果なし）
1. GEC認証（Sec-MS-GEC）の追加・修正
2. X-Timestampを `Date()` → `new Date().toISOString()` に修正
3. WebSocket sendの `{ compress: true }` 削除
4. Chromiumバージョンを103→143に更新
5. クライアント側リトライ無効化
6. サーバータイムアウト調整（15s→25s→30s）
7. Vercelリージョンを hnd1（東京）に設定
8. 音声ビットレート変更（48kbps↔96kbps）

## 知りたいこと
1. 2025-2026年時点で、Edge TTSをクラウドサーバー（Vercel/AWS Lambda等）から使うと遅くなる既知の問題はあるか？
2. MicrosoftはクラウドプロバイダーのIPレンジをスロットルしているか？
3. 解決策はあるか？（Cloudflare Workers、別のURL/エンドポイント、別のトークン、別のプロトコル等）
4. edge-tts の Python版やNode.js版で、この問題を回避している実装例はあるか？
5. そもそもVercel Serverless Functionsからの外部WebSocket接続に既知の遅延問題はあるか？

## 現在のサーバーコード（api/edge-tts.js）

```javascript
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import WebSocket from "ws";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

function computeGEC() {
  const WIN_EPOCH = 116444736000000000n;
  const ticks = BigInt(Math.round(Date.now() * 10000)) + WIN_EPOCH;
  const FIVE_MIN = 3000000000n;
  const rounded = ticks - (ticks % FIVE_MIN);
  const input = `${rounded}${TOKEN}`;
  return createHash("sha256").update(input, "utf8").digest("hex").toUpperCase();
}

// WebSocket URL
const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${connId}`;

// WebSocket options
const ws = new WebSocket(wsUrl, {
  host: "speech.platform.bing.com",
  origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  headers: {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
  },
});
```

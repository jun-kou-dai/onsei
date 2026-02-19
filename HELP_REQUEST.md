# EarFlow TTS再生遅延（30秒以上）の修正依頼

## 症状

TTS音声の再生開始まで**常に30秒以上**かかる。Edge TTS・OpenAI TTS両方で発生。
OpenAI TTSでは Vercel の `FUNCTION_INVOCATION_TIMEOUT` エラーも発生する。

**期待される動作**: 再生ボタンを押してから数秒以内に音声再生が始まる
**実際の動作**: 30秒以上待たされる、またはタイムアウトエラー

## プロジェクト概要

- **名前**: EarFlow（音声読み上げWebアプリ）
- **構成**: React (Vite) + Vercel Serverless Functions
- **デプロイ先**: Vercel（Hobbyプラン）
- **リポジトリ**: `jun-kou-dai/onsei`、ブランチ `claude/migrate-earflow-vite-vercel-LPq0z`
- **安定コミット**: `dc16c81`（翻訳機能追加前。TTS再生は正常に動作していた）

## アーキテクチャ

```
ブラウザ (React SPA)
  ↓ POST /api/edge-tts (or /api/openai-tts, /api/tts)
Vercel Serverless Function (Node.js)
  ↓ WebSocket (Edge TTS) or HTTPS (OpenAI/ElevenLabs API)
外部TTS API (Bing / OpenAI / ElevenLabs)
  ↓ 音声データ (audio/mpeg)
Vercel → ブラウザ（ストリーミングまたはバッファリング）
```

## TTSエンジン3種

| エンジン | API関数 | 外部API | 認証 |
|---|---|---|---|
| Edge TTS (無料) | `api/edge-tts.js` | Bing WebSocket | TrustedClientToken |
| OpenAI TTS | `api/openai-tts.js` | OpenAI REST API | ユーザーAPIキー |
| ElevenLabs | `api/tts.js` | ElevenLabs REST API | ユーザーAPIキー |

## 安定コミット dc16c81 からの変更差分（機能追加）

翻訳機能と多言語音声対応を追加した（これ自体は正常に動作する）:
- `api/translate.js`（新規）: OpenAI GPT-4o-mini で翻訳
- `src/App.jsx`: 言語検出、翻訳UI、多言語ボイス選択、自動言語切替
- キューアイテムに `lang` プロパティ追加

## 安定コミット dc16c81 での各ファイル状態

### api/edge-tts.js（安定版）
- GEC認証あり（`computeGEC()`, `Sec-MS-GEC`, `Sec-MS-GEC-Version`）
- `CHROMIUM_FULL_VERSION = "143.0.3650.75"`
- `outputFormat: "audio-24khz-96kbitrate-mono-mp3"`
- タイムアウト: 30秒
- `xml:lang` はハードコード `"ja-JP"`
- WebSocket 送信に `{ compress: true }` なし
- タイムスタンプ: `new Date().toISOString()`

### api/openai-tts.js（安定版）
- AbortController/タイムアウトなし
- `await oaiRes.arrayBuffer()` で全量バッファリング後に `res.send()`
- Vercel maxDuration 設定なし（デフォルト10秒）

### vercel.json（安定版）
```json
{
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist"
}
```
**maxDuration 設定なし** → Vercelデフォルトの10秒が適用される

### src/App.jsx fetchWithRetry（安定版）
```js
async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status === 400) return res;
      if (i < retries) { await new Promise(r => setTimeout(r, 1000 * (i + 1))); continue; }
      return res;
    } catch (err) {
      if (i >= retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```
- タイムアウトなし、リトライ2回、バックオフ 1s/2s/3s

## 過去の修正試行とその結果（全て失敗）

### 試行1: GEC認証削除 + maxDuration追加（a0b317f）
- **仮説**: GEC認証がBingにスロットリングされている + Vercelデフォルト10秒で関数が殺される
- **変更**: GEC削除、Chrome/103 User-Agent、48kbitrate、maxDuration追加、fetchWithRetryにAbortController
- **結果**: 遅延は改善せず

### 試行2: ブラウザ直接WebSocket（90d122e）
- **仮説**: Vercelを経由せずブラウザから直接Bing WebSocketに接続すれば速い
- **変更**: `edgeTTSBrowser()` 関数を追加、ブラウザからBingに直接WS接続
- **結果**: ブラウザのCORSまたはBingの認証で失敗（403/接続拒否）

### 試行3: GEC認証復元（8190ed4）
- **仮説**: GEC認証がないから拒否される
- **変更**: GEC復元、96kbitrate、30秒タイムアウト
- **結果**: 遅延がさらに悪化

### 試行4: GEC再削除（868510a）
- **仮説**: やはりGECが遅延原因
- **変更**: GEC再削除
- **結果**: Edge TTSの遅延は変わらず。OpenAI TTSで`FUNCTION_INVOCATION_TIMEOUT`発生

### 試行5: 全APIストリーミング化（0b9b252）
- **仮説**: openai-tts.jsがarrayBuffer()で全量バッファリング→maxDuration超過
- **変更**: res.write()ストリーミング、maxDuration 60秒
- **結果**: ユーザー報告「30秒かかる」— **改善なし**

## 現在のコード状態（HEAD = 0b9b252）

### api/edge-tts.js
```js
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import WebSocket from "ws";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

function escapeSSML(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, voice, rate } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Missing text" });
  }

  const trimmed = text.slice(0, 5000);
  const ratePercent = Math.round(((rate || 1.0) - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
  const voiceName = voice || "ja-JP-NanamiNeural";
  const langMatch = voiceName.match(/^([a-z]{2}-[A-Z]{2})/);
  const xmlLang = langMatch ? langMatch[1] : "ja-JP";

  const connId = randomUUID().replaceAll("-", "");
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&ConnectionId=${connId}`;

  let headersSent = false;
  let finished = false;

  const ws = new WebSocket(wsUrl, {
    host: "speech.platform.bing.com",
    origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.66 Safari/537.36 Edg/103.0.1264.44",
    },
  });

  const finish = (errMsg) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { ws.close(); } catch {}
    if (!headersSent) {
      res.status(500).json({ error: errMsg || "No audio generated" });
    } else {
      try { res.end(); } catch {}
    }
  };

  const timer = setTimeout(() => finish("TTS timeout (15s)"), 15000);
  req.on("close", () => finish("Client disconnected"));

  ws.on("open", () => {
    const config = JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          },
        },
      },
    });
    ws.send(
      `X-Timestamp:${Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`,
      { compress: true }
    );
    const ssmlBody = escapeSSML(trimmed);
    ws.send(
      `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${Date()}Z\r\nPath:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
      `<voice name='${voiceName}'><prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>` +
      `${ssmlBody}</prosody></voice></speak>`,
      { compress: true }
    );
  });

  ws.on("message", (rawData, isBinary) => {
    if (finished) return;
    if (!isBinary) {
      if (rawData.toString("utf8").includes("turn.end")) finish();
      return;
    }
    const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
    const sep = "Path:audio\r\n";
    const idx = data.indexOf(sep);
    if (idx >= 0) {
      if (!headersSent) {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        headersSent = true;
      }
      res.write(data.subarray(idx + sep.length));
    }
  });

  ws.on("error", (err) => finish(err.message));
  ws.on("close", () => finish());
}
```

### api/openai-tts.js（現在）
```js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { apiKey, text, voice, model } = req.body;
  if (!apiKey || !text) {
    return res.status(400).json({ error: "Missing apiKey or text" });
  }
  const trimmed = text.slice(0, 4096);
  let headersSent = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);
    const oaiRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "tts-1",
        input: trimmed,
        voice: voice || "nova",
        response_format: "mp3",
      }),
      signal: controller.signal,
    });
    if (!oaiRes.ok) {
      clearTimeout(timer);
      const errBody = await oaiRes.text().catch(() => "");
      let errJson;
      try { errJson = JSON.parse(errBody); } catch { errJson = errBody; }
      return res.status(oaiRes.status).json({ error: "OpenAI TTS error", status: oaiRes.status, detail: errJson });
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    headersSent = true;
    const reader = oaiRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    clearTimeout(timer);
    res.end();
  } catch (e) {
    if (!headersSent) {
      if (e.name === "AbortError") return res.status(504).json({ error: "Timeout" });
      return res.status(500).json({ error: e.message });
    }
    try { res.end(); } catch {}
  }
}
```

### vercel.json（現在）
```json
{
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "functions": {
    "api/edge-tts.js": { "maxDuration": 30 },
    "api/tts.js": { "maxDuration": 60 },
    "api/openai-tts.js": { "maxDuration": 60 },
    "api/translate.js": { "maxDuration": 60 },
    "api/extract-url.js": { "maxDuration": 30 }
  }
}
```

### package.json 依存関係
```json
{
  "dependencies": {
    "cheerio": "^1.2.0",
    "edge-tts": "^1.0.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.7"
  }
}
```
注意: `edge-tts` npm パッケージが依存関係に入っているが、`api/edge-tts.js` では**使っていない**（自前でWebSocket接続している）。`ws` パッケージは `edge-tts` の transitive dependency として入っている。

## 未検証の仮説・調査すべきポイント

1. **Vercel コールドスタート**: Hobbyプランのサーバーレス関数は使われないと停止する。コールドスタートに数秒〜10秒以上かかる可能性。実際のVercelログ（Functions tab）で関数の実行時間を確認すべき。

2. **Vercel Hobbyプランの実際のmaxDuration上限**: ドキュメント上は60秒まで設定可能だが、実際に効いているか未確認。

3. **edge-tts npmパッケージの直接利用**: 自前でWebSocket接続する代わりに、`edge-tts` パッケージ（既に依存関係にある）を使えば安定する可能性。参考: https://www.npmjs.com/package/edge-tts

4. **クライアント側の遅延**: サーバーは高速に返しているのにクライアント側の処理（MediaSource、blob化、Audio要素セットアップ）で遅延している可能性。ブラウザのDevTools Network tabでAPI応答時間を確認すべき。

5. **fetchWithRetryのAbortControllerタイムアウト (18秒)**: Edge TTS用の `fetchWithRetry` に18秒のAbortControllerが設定されている。サーバーの15秒タイムアウトとの兼ね合いで、タイムアウト→リトライ→再タイムアウトの連鎖が起きている可能性。

6. **openaiSpeakのblob化待ち**: `openaiSpeak` 内で `await res.blob()` を呼んでいる。サーバーがストリーミングで返しても、クライアントは全データ受信完了まで待つ。ここが遅延の原因の可能性。

7. **Vercelのリージョン**: デフォルトは `iad1`（米国東部）。日本からのアクセスだとネットワーク遅延が大きい。`vercel.json` に `"regions": ["hnd1"]`（東京）を設定すべきかもしれない。

8. **安定版 dc16c81 でも実は遅かった可能性**: 翻訳機能追加前は日本語テキストのみだったため遅延が目立たなかっただけで、元々Vercel経由のEdge TTSは遅かった可能性がある。安定版に完全に戻して再テストすべき。

## 再現手順

1. https://onsei-beta.vercel.app/ にアクセス
2. 英語のURLを入力して取得（例: 英語ニュース記事）
3. 「訳」ボタンで日本語に翻訳
4. 翻訳されたアイテム（JA、814字程度）の▶ボタンを押す
5. 音声が始まるまで30秒以上かかる

## ファイル構成

```
onsei/
├── api/
│   ├── edge-tts.js      # Edge TTS (Bing WebSocket → ストリーミング応答)
│   ├── openai-tts.js     # OpenAI TTS (REST API → ストリーミング応答)
│   ├── tts.js            # ElevenLabs TTS (REST API → ストリーミング応答)
│   ├── translate.js      # GPT-4o-mini 翻訳
│   ├── extract-url.js    # URL本文抽出 (cheerio)
│   └── el-check.js       # ElevenLabs APIキー検証
├── src/
│   └── App.jsx           # React SPA (2525行、全UI・ロジック)
├── vercel.json
├── package.json
└── vite.config.js
```

## 求めること

1. TTS再生開始が**数秒以内**になるようにする
2. Edge TTS / OpenAI TTS / ElevenLabs の3エンジン全てで動作すること
3. 翻訳機能（多言語対応）は壊さないこと
4. Vercel Hobbyプランの制約内で動作すること

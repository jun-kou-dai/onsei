# 引き継ぎ書 — onsei (EarFlow v5)

## 現在の状況

### 未解決の問題
**Vercelのデプロイが古く、`/api/gemini-tts` が404になっている。**

- コード修正は完了済み（GitHub `claude/migrate-earflow-vite-vercel-LPq0z` ブランチにpush済み）
- GitHub上に `main` ブランチが存在しない（`claude/...` がデフォルトブランチ）
- Vercelのプロダクションブランチ設定が `main` のままの可能性が高い
- **対処:** Vercelダッシュボード → Settings → Git → Production Branch を `claude/migrate-earflow-vite-vercel-LPq0z` に変更 → Redeploy

### 直近のコミット履歴
```
e358f22  fix: Gemini TTSモデル名 2.5→2.0 に修正
5da051b  ElevenLabs TTS削除
0b6e0bb  Gemini TTSエンジン追加
7143a49  UX改善（翻訳ボタン/一時停止表示/ツールチップ/再生時間/エラーメッセージ）
```

---

## プロジェクト概要

日本語テキスト読み上げWebアプリ。テキスト/PDF/URLから音声再生。

- **URL:** https://onsei-beta.vercel.app/
- **リポジトリ:** https://github.com/jun-kou-dai/onsei
- **ブランチ:** `claude/migrate-earflow-vite-vercel-LPq0z`（唯一のブランチ）
- **技術スタック:** React 18 + Vite 6 + Vercel Serverless Functions
- **リージョン:** hnd1（東京）

---

## TTSエンジン

| エンジン | 無料 | 方式 | 備考 |
|---------|------|------|------|
| **Edge TTS** | ○ | クライアントWebSocket→Bing | デフォルト。APIキー不要 |
| **OpenAI TTS** | × | `/api/openai-tts` → OpenAI API | MediaSourceストリーミング再生 |
| **Gemini TTS** | × | `/api/gemini-tts` → Gemini API | PCM→WAV変換。モデル: `gemini-2.0-flash-preview-tts` |
| **ブラウザTTS** | ○ | `speechSynthesis` API | フォールバック用 |

---

## ファイル構成

```
onsei/
├── src/App.jsx          # メインコンポーネント（約2525行、全UI＋音声ロジック）
├── src/main.jsx         # エントリーポイント
├── api/
│   ├── gemini-tts.js    # Gemini TTS（PCM→WAV変換）
│   ├── openai-tts.js    # OpenAI TTSストリーミングプロキシ
│   ├── edge-tts.js      # Edge TTS（現在未使用、クライアント側に移行済み）
│   ├── translate.js     # GPT-4o-mini翻訳
│   └── extract-url.js   # URL記事抽出（Cheerio）
├── vercel.json          # デプロイ設定（リージョン、maxDuration）
├── package.json         # type: module, 依存: react, cheerio, edge-tts
└── vite.config.js       # Viteビルド設定
```

---

## 主要機能

- **テキスト入力:** 手入力/PDF/TXT/URL
- **キュー管理:** 長文自動分割（10,000字超で分割）、ドラッグ並替え
- **再生制御:** 再生/一時停止/次へ/速度変更（0.5x-2.0x）
- **カラオケハイライト:** 再生中の文をリアルタイム強調表示
- **翻訳:** 英語/中国語/韓国語→日本語（OpenAI GPT-4o-mini）
- **言語自動検出:** テキスト言語に応じて音声自動切替
- **セッション保持:** localStorage でキュー・再生位置を保存
- **音声プリロード:** 次のアイテムを先読みキャッシュ（LRU 3件）

---

## APIキー（ユーザーが設定画面で入力）

- **OpenAI APIキー:** TTS + 翻訳に使用
- **Gemini APIキー:** Gemini TTSに使用
- Edge TTS / ブラウザTTS はキー不要

---

## 注意事項

- `src/App.jsx` が2525行の単一コンポーネント。全ロジックがここに集約
- Edge TTSはVercel API経由ではなくブラウザからBingに直接WebSocket接続
- Geminiはストリーミング非対応（フルバッファ後に再生、2-3秒遅延）
- Vercel Hobbyプランのため `maxDuration` 上限あり（60秒）

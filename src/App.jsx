import { useState, useRef, useEffect } from "react";
/* ================================================
   EarFlow v5 - Vite + Vercel edition
   Core principle: speak() is ALWAYS called
   synchronously from a click handler.
   No async, no setTimeout, no indirection.
   ================================================ */

// --- Modes ---
const MODES = {
  raw:      { label: "そのまま", icon: "📖", color: "#e8c468" },
  briefing: { label: "ブリーフ", icon: "⚡", color: "#50dcb4" },
  detailed: { label: "詳細",   icon: "📋", color: "#6ea8f0" },
  headline: { label: "一言",   icon: "🎯", color: "#e07070" },
};

// --- Summarize via server-side proxy ---
async function callSummarize(text, mode) {
  if (mode === "raw") return text;
  const max = 5000;
  const t = text.length > max ? text.slice(0, max) + "\n（以下省略）" : text;
  const inst = {
    briefing: "重要ポイントを3〜5つに絞り日本語で要約。各1〜2文。冒頭にテーマを一言。",
    detailed: "詳細に日本語で要約。重要な数字を含める。",
    headline: "1〜2文で超要約。",
  };
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: t,
        mode,
        instruction: inst[mode] || inst.briefing,
      }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.summary || null;
  } catch {
    return null;
  }
}

// --- File readers ---
const readBuf = (f) => new Promise((r, j) => { const x = new FileReader(); x.onload = () => r(x.result); x.onerror = j; x.readAsArrayBuffer(f); });
const readTxt = (f) => new Promise((r, j) => { const x = new FileReader(); x.onload = () => r(x.result); x.onerror = j; x.readAsText(f); });

// --- PDF ---
let pdfReady = false;
let pdfProm = null;
function loadPdf() {
  if (pdfReady) return Promise.resolve(true);
  if (pdfProm) return pdfProm;
  pdfProm = new Promise(r => {
    try {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
          pdfReady = true; r(true);
        } catch { r(false); }
      };
      s.onerror = () => r(false);
      document.head.appendChild(s);
      setTimeout(() => r(false), 8000);
    } catch { r(false); }
  });
  return pdfProm;
}

async function pdfToText(buf) {
  if (!(await loadPdf())) throw new Error("PDF.js読込失敗");
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const c = await pg.getTextContent();
    out += c.items.map(x => x.str).join("") + "\n\n";
  }
  return { text: out.trim(), pages: pdf.numPages };
}

// --- localStorage helpers ---
const lsGet = (key, fallback) => {
  try { const v = localStorage.getItem("earflow_" + key); return v !== null ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const lsSet = (key, val) => {
  try { localStorage.setItem("earflow_" + key, JSON.stringify(val)); } catch {}
};

// --- Unique ID ---
let _id = 0;
const uid = () => "i" + (++_id) + "_" + Date.now();

/* ================================================
   MAIN COMPONENT
   ================================================ */
export default function EarFlow() {
  // --- Core state ---
  const [queue, setQueue] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [rate, setRateRaw] = useState(() => lsGet("rate", 1.0));
  const [progress, setProgress] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [inputTab, setInputTab] = useState("file");
  const [inputText, setInputText] = useState("");
  const [status, setStatus] = useState("");
  const [isDrag, setIsDrag] = useState(false);
  const [audioTested, setAudioTested] = useState(false);
  const [audioWorks, setAudioWorks] = useState(null); // null=untested, true, false

  // --- ElevenLabs state (persisted to localStorage) ---
  const [ttsEngine, setTtsEngineRaw] = useState(() => lsGet("ttsEngine", "browser"));
  const [elApiKey, setElApiKeyRaw] = useState(() => lsGet("elApiKey", ""));
  const [elVoiceId, setElVoiceIdRaw] = useState(() => lsGet("elVoiceId", "Xb7hH8MSUJpSbSDYk0k2"));
  const [elQuota, setElQuota] = useState(null); // { used, limit, remaining, tier }
  const [elChecking, setElChecking] = useState(false);
  const [elVoices] = useState([
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice（落ち着いた女性）" },
    { id: "pqHfZKP75CvOlQylNhV4", name: "Bill（落ち着いた男性）" },
    { id: "nPczCjzI2devNBz1zQrb", name: "Brian（ナレーション男性）" },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah（明るい女性）" },
    { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel（ニュース男性）" },
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "George（深い男性）" },
  ]);

  const audioRef = useRef(null); // HTML Audio element for ElevenLabs
  const playIdRef = useRef(0); // Guard against race conditions in async TTS

  // Refs to avoid stale closures in callbacks
  const queueRef = useRef([]);
  const activeIdxRef = useRef(-1);
  const keepAliveRef = useRef(null);
  const progressRef = useRef(null);
  const dragCnt = useRef(0);

  // Persist-on-change wrappers
  const setTtsEngine = (v) => { setTtsEngineRaw(v); lsSet("ttsEngine", v); };
  const setElApiKey = (v) => { setElApiKeyRaw(v); lsSet("elApiKey", v); };
  const setElVoiceId = (v) => { setElVoiceIdRaw(v); lsSet("elVoiceId", v); };
  const setRate = (v) => { setRateRaw(v); lsSet("rate", v); };

  // --- ElevenLabs quota check (via server proxy to avoid CORS) ---
  const checkElQuota = async (key) => {
    const apiKey = key || elApiKey;
    if (!apiKey) { setElQuota(null); return null; }
    setElChecking(true);
    try {
      const res = await fetch("/api/el-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      setElChecking(false);
      if (!data.ok) {
        const st = data.elStatus;
        // Parse detail message from raw body
        let detail = "";
        try { const parsed = JSON.parse(data.rawBody || ""); detail = parsed?.detail?.message || (typeof parsed?.detail === "string" ? parsed.detail : "") || parsed?.message || ""; } catch { detail = (data.rawBody || "").slice(0, 300); }

        // 403 = key IS valid, just missing permissions (e.g. user_read)
        if (st === 403) {
          const info = { error: null, limited: true, tier: "unknown", used: 0, limit: 0, remaining: -1, detail };
          setElQuota(info);
          return info;
        }
        // 401 = truly invalid key
        if (st === 401) {
          setElQuota({ error: "invalid_key", detail, keyPreview: apiKey.slice(0, 6) + "..." });
          return { error: "invalid_key" };
        }
        // Anything else
        setElQuota({ error: "api_error", elStatus: st, detail, rawBody: (data.rawBody || "").slice(0, 300) });
        return { error: "api_error" };
      }
      const used = data.character_count || 0;
      const limit = data.character_limit || 0;
      const remaining = Math.max(0, limit - used);
      const tier = data.tier || "free";
      const info = { used, limit, remaining, tier, error: null };
      setElQuota(info);
      return info;
    } catch (e) {
      setElChecking(false);
      setElQuota({ error: "network", detail: e.message });
      return { error: "network" };
    }
  };

  // Check quota when API key changes
  const handleElApiKeyChange = (v) => {
    const trimmed = v.trim();
    setElApiKey(trimmed);
    if (trimmed.length > 10) {
      checkElQuota(trimmed);
    } else {
      setElQuota(null);
    }
  };

  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);

  useEffect(() => {
    if (status) {
      const dur = status.includes("⚠") ? 10000 : 5000;
      const t = setTimeout(() => setStatus(""), dur);
      return () => clearTimeout(t);
    }
  }, [status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; }
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      if (progressRef.current) clearInterval(progressRef.current);
    };
  }, []);

  const flash = (msg) => setStatus(msg);
  const upd = (id, u) => setQueue(q => q.map(x => x.id === id ? { ...x, ...u } : x));

  /* ================================================
     SPEECH FUNCTIONS
     All called synchronously from click handlers
     ================================================ */

  // Start keepalive (Chrome 15-sec workaround)
  const startKeepAlive = () => {
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = setInterval(() => {
      if (window.speechSynthesis?.speaking && !window.speechSynthesis?.paused) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 10000);
  };

  const stopKeepAlive = () => {
    if (keepAliveRef.current) { clearInterval(keepAliveRef.current); keepAliveRef.current = null; }
  };

  const startProgress = (len, r) => {
    if (progressRef.current) clearInterval(progressRef.current);
    const start = Date.now();
    const dur = (len / (4.5 * r)) * 1000;
    setProgress(0);
    progressRef.current = setInterval(() => {
      const p = Math.min(99, ((Date.now() - start) / dur) * 100);
      setProgress(Math.round(p));
    }, 400);
  };

  const stopProgress = () => {
    if (progressRef.current) { clearInterval(progressRef.current); progressRef.current = null; }
  };

  // Get best available Japanese voice
  const getJaVoice = () => {
    const voices = window.speechSynthesis?.getVoices() || [];
    return voices.find(v => v.lang.startsWith("ja") && v.name.toLowerCase().includes("google"))
      || voices.find(v => v.lang.startsWith("ja"))
      || null;
  };

  // --- ElevenLabs TTS (via server proxy to avoid CORS) ---
  const elSpeak = async (text, rateVal) => {
    if (!elApiKey) { flash("⚠ ElevenLabs APIキーが設定されていません。⚙設定から入力してください"); setSpeaking(false); return; }

    const myPlayId = ++playIdRef.current;

    try {
      flash("🔊 音声生成中（" + text.length + "文字）...");
      setSpeaking(true);

      let res;
      try {
        res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: elApiKey,
            voiceId: elVoiceId,
            text,
            modelId: "eleven_multilingual_v2",
            voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        });
      } catch (fetchErr) {
        flash("⚠ ネットワークエラー: サーバーに接続できません");
        setSpeaking(false);
        return;
      }

      if (playIdRef.current !== myPlayId) return;

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let detail = "";
        try { const parsed = JSON.parse(errBody); detail = parsed?.detail?.message || parsed?.detail || parsed?.error || ""; } catch { detail = errBody.slice(0, 150); }
        if (res.status === 401) {
          flash("⚠ APIキー認証失敗: " + (detail || "キーを確認してください"));
        }
        else if (res.status === 429) flash("⚠ レート制限に達しました。30秒ほど待ってから再試行してください");
        else {
          flash("⚠ ElevenLabs エラー " + res.status + (detail ? ": " + detail : ""));
        }
        setSpeaking(false); return;
      }

      const blob = await res.blob();
      if (playIdRef.current !== myPlayId) return;

      if (blob.size < 100) {
        flash("⚠ 音声データが空です。テキストまたはAPIキーを確認してください");
        setSpeaking(false); return;
      }

      const url = URL.createObjectURL(blob);

      // Stop previous audio if any
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.playbackRate = rateVal || 1.0;
      audio.volume = 1.0;

      audio.onplay = () => {
        setSpeaking(true); setPaused(false);
        flash(""); // clear "generating" message
      };

      audio.onended = () => {
        setSpeaking(false); setPaused(false); setProgress(100);
        stopProgress();
        URL.revokeObjectURL(url);
        // Update quota after successful playback
        checkElQuota();
        // Auto-play next
        const nextIdx = activeIdxRef.current + 1;
        const q = queueRef.current;
        if (nextIdx < q.length && q[nextIdx]?.status === "ready") {
          setActiveIdx(nextIdx);
          activeIdxRef.current = nextIdx;
          const nextText = q[nextIdx].mode === "raw" ? q[nextIdx].text : q[nextIdx].summary;
          if (nextText) elSpeak(nextText, rateVal);
        }
      };

      audio.onerror = () => {
        setSpeaking(false); flash("⚠ 音声再生エラー");
        URL.revokeObjectURL(url);
      };

      audio.ontimeupdate = () => {
        if (audio.duration > 0) setProgress(Math.round((audio.currentTime / audio.duration) * 100));
      };

      audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
    } catch (e) {
      flash("⚠ " + e.message);
      setSpeaking(false);
    }
  };

  // --- Unified stop (both engines) ---
  const stopAll = () => {
    playIdRef.current++; // Cancel any pending ElevenLabs requests

    // Browser TTS
    stoppedRef.current = true;
    chunksRef.current = [];
    chunkIdxRef.current = 0;
    window.speechSynthesis?.cancel();

    // ElevenLabs Audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }

    setSpeaking(false);
    setPaused(false);
    setProgress(0);
    setActiveIdx(-1);
    stopKeepAlive();
    stopProgress();
  };

  // --- AUDIO TEST (synchronous from click) ---
  const handleAudioTest = () => {
    setAudioTested(true);
    try {
      if (!window.speechSynthesis) {
        setAudioWorks(false);
        flash("⚠ この環境ではspeechSynthesis APIが利用できません");
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance("こんにちは。EarFlowの音声テストです。聞こえますか？");
      u.lang = "ja-JP";
      u.rate = 1.0;
      const v = getJaVoice();
      if (v) u.voice = v;
      let started = false;
      u.onstart = () => {
        started = true;
        flash("🔊 音声再生中...");
      };
      u.onend = () => {
        setAudioWorks(true);
        flash("✓ 音声テスト成功！");
      };
      u.onerror = (e) => {
        setAudioWorks(false);
        flash("⚠ 音声エラー: " + (e.error || "不明"));
      };
      window.speechSynthesis.speak(u);
      // 3秒後チェック
      setTimeout(() => {
        if (!started) {
          setAudioWorks(false);
          flash("⚠ 音声が開始されません。ブラウザの設定を確認してください。");
        }
      }, 3000);
    } catch (e) {
      setAudioWorks(false);
      flash("⚠ エラー: " + e.message);
    }
  };

  // --- TEXT CHUNKING for long text ---
  const chunksRef = useRef([]);
  const chunkIdxRef = useRef(0);
  const totalCharsRef = useRef(0);
  const spokenCharsRef = useRef(0);
  const stoppedRef = useRef(false);
  const currentRateRef = useRef(1.0);

  const splitText = (text) => {
    const maxLen = 200;
    const result = [];
    let buf = "";
    for (let i = 0; i < text.length; i++) {
      buf += text[i];
      const ch = text[i];
      if ((ch === "。" || ch === "！" || ch === "？" || ch === "\n") && buf.length >= 30) {
        result.push(buf.trim());
        buf = "";
      } else if (buf.length >= maxLen) {
        const lastBreak = Math.max(buf.lastIndexOf("、"), buf.lastIndexOf("，"), buf.lastIndexOf(" "));
        if (lastBreak > buf.length * 0.5) {
          result.push(buf.slice(0, lastBreak + 1).trim());
          buf = buf.slice(lastBreak + 1);
        } else {
          result.push(buf.trim());
          buf = "";
        }
      }
    }
    if (buf.trim()) result.push(buf.trim());
    return result.filter(c => c.length > 0);
  };

  const speakChunk = (chunkIdx, spRate) => {
    if (stoppedRef.current) return;
    const chunks = chunksRef.current;
    if (chunkIdx >= chunks.length) {
      // All done
      setSpeaking(false);
      setPaused(false);
      setProgress(100);
      stopKeepAlive();
      stopProgress();
      return;
    }

    chunkIdxRef.current = chunkIdx;
    const text = chunks[chunkIdx];
    const r = spRate || currentRateRef.current;

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = r;
    const v = getJaVoice();
    if (v) u.voice = v;

    u.onstart = () => {
      if (chunkIdx === 0) {
        setSpeaking(true);
        setPaused(false);
        startKeepAlive();
      }
    };

    u.onend = () => {
      spokenCharsRef.current += text.length;
      const total = totalCharsRef.current;
      if (total > 0) setProgress(Math.round((spokenCharsRef.current / total) * 100));
      // Speak next chunk
      speakChunk(chunkIdx + 1, r);
    };

    u.onerror = (e) => {
      if (!stoppedRef.current) {
        flash("⚠ 再生エラー: " + (e.error || "不明"));
      }
      setSpeaking(false);
      setPaused(false);
      stopKeepAlive();
      stopProgress();
    };

    window.speechSynthesis.speak(u);
  };

  // --- PLAY ITEM ---
  const handlePlay = (index) => {
    try {
      const item = queue[index];
      if (!item || item.status !== "ready") return;
      const fullText = item.mode === "raw" ? item.text : item.summary;
      if (!fullText || fullText.length === 0) {
        flash("⚠ 再生するテキストがありません");
        return;
      }

      // Stop everything first (but don't reset activeIdx yet)
      playIdRef.current++;
      stoppedRef.current = true;
      chunksRef.current = [];
      chunkIdxRef.current = 0;
      window.speechSynthesis?.cancel();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      setPaused(false);
      stopKeepAlive();
      stopProgress();

      setActiveIdx(index);
      activeIdxRef.current = index;
      setProgress(0);

      if (ttsEngine === "elevenlabs") {
        elSpeak(fullText, rate);
      } else {
        stoppedRef.current = false;
        const chunks = splitText(fullText);
        chunksRef.current = chunks;
        chunkIdxRef.current = 0;
        totalCharsRef.current = fullText.length;
        spokenCharsRef.current = 0;
        currentRateRef.current = rate;
        speakChunk(0, rate);
      }
    } catch (e) {
      flash("⚠ " + e.message);
    }
  };

  // --- PAUSE ---
  const handlePause = () => {
    try {
      if (ttsEngine === "elevenlabs" && audioRef.current) {
        audioRef.current.pause();
      } else {
        window.speechSynthesis?.pause();
      }
      setPaused(true);
      stopKeepAlive();
    } catch {}
  };

  // --- RESUME ---
  const handleResume = () => {
    try {
      if (ttsEngine === "elevenlabs" && audioRef.current) {
        audioRef.current.play();
      } else {
        window.speechSynthesis?.resume();
        startKeepAlive();
      }
      setPaused(false);
    } catch {}
  };

  // --- STOP ---
  const handleStop = () => { stopAll(); };

  // --- NEXT (synchronous from click) ---
  const handleNext = () => {
    const next = activeIdx + 1;
    if (next < queue.length && queue[next]?.status === "ready") {
      handlePlay(next);
    } else {
      handleStop();
    }
  };

  // --- SPEED CHANGE ---
  const handleSpeed = (newRate) => {
    setRate(newRate);
    currentRateRef.current = newRate;
    if (speaking && activeIdx >= 0) {
      if (ttsEngine === "elevenlabs" && audioRef.current) {
        audioRef.current.playbackRate = newRate;
      } else {
        stoppedRef.current = true;
        window.speechSynthesis?.cancel();
        stopKeepAlive();
        stoppedRef.current = false;
        speakChunk(chunkIdxRef.current, newRate);
      }
    }
  };

  /* ================================================
     QUEUE MANAGEMENT
     ================================================ */
  const addItem = async (text, title, sourceType, pageCount) => {
    if (!text || text.trim().length < 5) { flash("⚠ テキストが短すぎます"); return; }
    const id = uid();
    setQueue(q => [...q, {
      id, text, title: title || text.slice(0, 35),
      sourceType: sourceType || "text",
      mode: "briefing", summary: null,
      status: "processing", errorMsg: null,
      charCount: text.length, pageCount: pageCount || 0,
    }]);

    // Summarize async
    const s = await callSummarize(text, "briefing");
    if (s) {
      upd(id, { summary: s, status: "ready" });
    } else {
      upd(id, { summary: text.slice(0, 300), status: "ready", errorMsg: "要約失敗、テキスト冒頭を使用" });
    }
  };

  const changeMode = async (index, mode) => {
    const item = queue[index];
    if (!item) return;
    if (mode === "raw") {
      upd(item.id, { mode, summary: item.text, status: "ready" });
    } else {
      upd(item.id, { mode, summary: null, status: "processing" });
      const s = await callSummarize(item.text, mode);
      if (s) {
        upd(item.id, { summary: s, status: "ready" });
      } else {
        upd(item.id, { summary: item.text.slice(0, 300), status: "ready", errorMsg: "要約失敗" });
      }
    }
  };

  const removeItem = (index) => {
    if (index === activeIdx) handleStop();
    setQueue(q => q.filter((_, i) => i !== index));
    if (index < activeIdx) setActiveIdx(a => a - 1);
    if (index === activeIdx) setActiveIdx(-1);
  };

  /* ================================================
     FILE / PDF HANDLING
     ================================================ */
  const processFile = async (file) => {
    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        flash("📄 PDF読み込み中...");
        const buf = await readBuf(file);
        const { text, pages } = await pdfToText(buf);
        if (!text || text.trim().length < 20) {
          flash("⚠ PDFからテキストを抽出できませんでした");
          return;
        }
        flash(`✓ PDF: ${text.length.toLocaleString()}字 / ${pages}ページ`);
        await addItem(text, file.name.replace(/\.pdf$/i, ""), "pdf", pages);
      } else {
        const text = await readTxt(file);
        if (!text?.trim()) { flash("⚠ 空ファイル"); return; }
        await addItem(text, file.name, "file", 0);
      }
    } catch (e) {
      flash("⚠ ファイルエラー: " + e.message);
    }
  };

  const processFiles = (files) => files.forEach(f => processFile(f));

  const fileInputRef = useRef(null);
  const openPicker = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleFileInputChange = (e) => {
    if (e.target.files?.length) {
      processFiles(Array.from(e.target.files));
      e.target.value = ""; // Reset so same file can be selected again
    }
  };

  const addTextInput = () => {
    if (!inputText.trim()) return;
    addItem(inputText.trim(), inputText.trim().slice(0, 35), "text", 0);
    setInputText("");
  };

  const addDemos = () => {
    addItem(
      "日本銀行は本日の金融政策決定会合で、短期金利の誘導目標を0.5%に据え置くことを全員一致で決定しました。植田和男総裁は記者会見で、賃金と物価の好循環が確認されつつあるとしながらも、米国の関税政策による不確実性が高まっていることを指摘。追加利上げの時期についてはデータ次第と繰り返しました。市場では年内の追加利上げ観測がやや後退し、ドル円は一時149円台後半まで円安が進行しています。",
      "日銀 金融政策決定会合", "text", 0
    );
    addItem(
      "スタンフォード大学の研究チームが、大規模言語モデルの推論能力に関する画期的な論文を発表しました。Chain-of-Recursive-Thoughtと名付けられた新手法では、モデルが自身の推論過程を再帰的に検証修正することで、数学的証明タスクで従来比42%の精度向上を達成。この手法は追加の学習データを必要とせず、推論時のプロンプト設計のみで実現できる点が注目されています。一方で計算コストが3倍増という課題もあります。",
      "LLM推論の新手法", "text", 0
    );
    flash("✓ デモ追加");
  };

  // --- Drag & Drop ---
  const onDE = (e) => { e.preventDefault(); e.stopPropagation(); dragCnt.current++; setIsDrag(true); };
  const onDL = (e) => { e.preventDefault(); e.stopPropagation(); dragCnt.current--; if (dragCnt.current <= 0) { setIsDrag(false); dragCnt.current = 0; } };
  const onDO = (e) => { e.preventDefault(); e.stopPropagation(); };
  const onDD = (e) => { e.preventDefault(); e.stopPropagation(); setIsDrag(false); dragCnt.current = 0; if (e.dataTransfer?.files?.length) processFiles(Array.from(e.dataTransfer.files)); };

  /* ================================================
     RENDER
     ================================================ */
  const S = { // Style helpers
    card: { background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 14 },
    btn: (bg, c) => ({ background: bg, color: c, border: "none", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 600, padding: "12px 16px", fontFamily: "inherit" }),
    smBtn: (bg, c) => ({ background: bg, color: c, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, padding: "6px 12px", fontFamily: "inherit" }),
  };

  return (
    <div
      onDragEnter={onDE} onDragLeave={onDL} onDragOver={onDO} onDrop={onDD}
      style={{ minHeight: "100vh", background: "#0e0e16", color: "#e0e0e0", fontFamily: "'Helvetica Neue', 'Hiragino Sans', sans-serif" }}
    >
      <style>{`
        @keyframes wave { from { height: 4px; } to { height: 22px; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        button { cursor: pointer; font-family: inherit; }
        button:active { opacity: 0.8; }
        textarea:focus { outline: none; border-color: rgba(80,220,180,0.4) !important; }
        input:focus { outline: none; border-color: rgba(139,92,246,0.4) !important; }
      `}</style>

      {/* Drag overlay */}
      {isDrag && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(14,14,22,0.94)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>📥</div>
          <div style={{ fontSize: 18, color: "#50dcb4", fontWeight: 700 }}>ここにドロップ</div>
        </div>
      )}

      <div style={{ maxWidth: 620, margin: "0 auto", padding: "24px 20px 180px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #50dcb4, #3a9ed8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>🎧</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#50dcb4" }}>EarFlow</div>
              <div style={{ fontSize: 9, color: ttsEngine === "elevenlabs" ? "#a78bfa" : "#555" }}>
                {ttsEngine === "elevenlabs" ? "✨ ElevenLabs" : "目が塞がっていても、脳は空いている。"}
              </div>
            </div>
          </div>
          <button onClick={() => setShowSettings(s => !s)} style={{ background: "transparent", border: "1px solid #2a2a38", borderRadius: 8, padding: "6px 10px", color: "#777", fontSize: 13 }}>⚙</button>
        </div>

        {/* Status */}
        {status && (
          <div style={{
            padding: "8px 14px", borderRadius: 10, marginBottom: 12, fontSize: 13,
            background: status.includes("⚠") ? "rgba(232,100,100,0.08)" : "rgba(80,220,180,0.06)",
            color: status.includes("⚠") ? "#e08080" : "#50dcb4",
          }}>{status}</div>
        )}

        {/* ========== AUDIO TEST ========== */}
        {ttsEngine === "browser" && !audioTested && (
          <div style={{ ...S.card, padding: 20, marginBottom: 16, textAlign: "center" }}>
            <div style={{ fontSize: 14, color: "#bbb", marginBottom: 12 }}>
              まず音声が動作するか確認してください
            </div>
            <button onClick={handleAudioTest} style={{
              ...S.btn("#50dcb4", "#111"),
              padding: "14px 32px", fontSize: 16,
            }}>
              🔊 音声テスト
            </button>
          </div>
        )}

        {ttsEngine === "elevenlabs" && elApiKey && !audioTested && (
          <div style={{ ...S.card, padding: 20, marginBottom: 16, textAlign: "center", borderColor: "rgba(139,92,246,0.2)" }}>
            <div style={{ fontSize: 14, color: "#bbb", marginBottom: 12 }}>
              ElevenLabsの音声をテストしてください
            </div>
            <button onClick={async () => {
              setAudioTested(true);
              try {
                await elSpeak("こんにちは。ElevenLabsの音声テストです。聞こえますか？", 1.0);
              } catch {
                setAudioWorks(false);
              }
            }} style={{
              ...S.btn("#8b5cf6", "#fff"),
              padding: "14px 32px", fontSize: 16,
            }}>
              ✨ ElevenLabs テスト
            </button>
          </div>
        )}

        {ttsEngine === "elevenlabs" && !elApiKey && (
          <div style={{ ...S.card, padding: 16, marginBottom: 16, borderColor: "rgba(232,100,100,0.2)" }}>
            <div style={{ fontSize: 13, color: "#e08080", marginBottom: 8 }}>
              ⚠ まず⚙設定からElevenLabsのAPIキーを入力してください
            </div>
            <button onClick={() => setShowSettings(true)} style={{
              ...S.smBtn("rgba(139,92,246,0.15)", "#c4b5fd"),
              border: "1px solid rgba(139,92,246,0.2)",
            }}>⚙ 設定を開く</button>
          </div>
        )}

        {ttsEngine === "elevenlabs" && !speaking && (status.includes("無料枠") || status.includes("期限切れ")) && (
          <div style={{ ...S.card, padding: 16, marginBottom: 16, borderColor: "rgba(232,100,100,0.2)" }}>
            <div style={{ fontSize: 13, color: "#e08080", marginBottom: 8, fontWeight: 600 }}>
              ⚠ ElevenLabs 利用制限
            </div>
            <div style={{ fontSize: 12, color: "#999", lineHeight: 1.7, marginBottom: 10 }}>
              無料枠（月10,000文字）を使い切った可能性があります。<br />
              <b>対処法：</b><br />
              ・来月のリセットを待つ<br />
              ・ElevenLabsで有料プランにアップグレード<br />
              ・「ブラウザ内蔵」に切り替えて使用する
            </div>
            <button onClick={() => { setTtsEngine("browser"); setAudioTested(false); setAudioWorks(null); flash("ブラウザ内蔵に切り替えました"); }}
              style={{ ...S.smBtn("#50dcb4", "#111"), marginTop: 4 }}>
              🔊 ブラウザ内蔵に切り替え
            </button>
          </div>
        )}

        {ttsEngine === "elevenlabs" && audioTested && !speaking && status.includes("ネットワーク") && (
          <div style={{ ...S.card, padding: 16, marginBottom: 16, borderColor: "rgba(232,100,100,0.2)" }}>
            <div style={{ fontSize: 13, color: "#e08080", marginBottom: 8, fontWeight: 600 }}>
              ⚠ ElevenLabs に接続できません
            </div>
            <div style={{ fontSize: 12, color: "#999", lineHeight: 1.7 }}>
              ネットワークエラーが発生しました。APIキーを確認してください。<br /><br />
              <b>対処法：</b> ⚙設定で「🔊 ブラウザ内蔵」に切り替えるか、ElevenLabsのAPIキーを確認してください。
            </div>
            <button onClick={() => { setTtsEngine("browser"); setAudioTested(false); setAudioWorks(null); flash("ブラウザ内蔵に切り替えました"); }}
              style={{ ...S.smBtn("#50dcb4", "#111"), marginTop: 10 }}>
              🔊 ブラウザ内蔵に切り替え
            </button>
          </div>
        )}

        {ttsEngine === "browser" && audioTested && audioWorks === false && (
          <div style={{ ...S.card, padding: 16, marginBottom: 16, borderColor: "rgba(232,100,100,0.2)" }}>
            <div style={{ fontSize: 14, color: "#e08080", marginBottom: 8, fontWeight: 600 }}>
              ⚠ 音声が再生できませんでした
            </div>
            <div style={{ fontSize: 12, color: "#999", lineHeight: 1.7 }}>
              考えられる原因：<br />
              ・ブラウザの音量がミュートになっている<br />
              ・Macの音量が0になっている<br />
              ・Chromeの「サイトの設定」で音声がブロックされている<br />
              ・このページでの音声合成がブラウザに制限されている<br />
              <br />
              <b>対処法：</b> Chrome設定 → プライバシーとセキュリティ → サイトの設定 → 音声 を確認してください。
            </div>
            <button onClick={handleAudioTest} style={{ ...S.smBtn("rgba(80,220,180,0.1)", "#50dcb4"), marginTop: 10 }}>
              もう一度テスト
            </button>
          </div>
        )}

        {ttsEngine === "browser" && audioTested && audioWorks === true && (
          <div style={{ ...S.card, padding: "10px 14px", marginBottom: 16, borderColor: "rgba(80,220,180,0.15)" }}>
            <span style={{ fontSize: 13, color: "#50dcb4" }}>✓ 音声OK</span>
            <button onClick={handleAudioTest} style={{ ...S.smBtn("transparent", "#555"), marginLeft: 8, padding: "4px 8px", fontSize: 11 }}>再テスト</button>
          </div>
        )}

        {/* ========== SETTINGS ========== */}
        {showSettings && (
          <div style={{ ...S.card, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#777", marginBottom: 10, fontWeight: 600 }}>再生設定</div>

            {/* TTS Engine */}
            <div style={{ fontSize: 12, color: "#aaa", marginBottom: 6 }}>音声エンジン</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
              {[["browser", "🔊 ブラウザ内蔵"], ["elevenlabs", "✨ ElevenLabs"]].map(([k, l]) => (
                <button key={k} onClick={() => { setTtsEngine(k); setAudioTested(false); setAudioWorks(null); }} style={{
                  background: ttsEngine === k ? (k === "elevenlabs" ? "#8b5cf6" : "#50dcb4") : "rgba(255,255,255,0.04)",
                  color: ttsEngine === k ? "#fff" : "#666",
                  border: ttsEngine === k ? "none" : "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: ttsEngine === k ? 700 : 400,
                }}>{l}</button>
              ))}
            </div>

            {/* ElevenLabs settings */}
            {ttsEngine === "elevenlabs" && (
              <div style={{ background: "rgba(139,92,246,0.05)", borderRadius: 10, padding: 12, marginBottom: 12, border: "1px solid rgba(139,92,246,0.15)" }}>
                <div style={{ fontSize: 11, color: "#a78bfa", marginBottom: 8, fontWeight: 600 }}>ElevenLabs 設定</div>

                {/* API Key */}
                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>APIキー</div>
                <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                  <input
                    type="password"
                    value={elApiKey}
                    onChange={e => handleElApiKeyChange(e.target.value)}
                    placeholder="sk_xxxxxxxxxxxx..."
                    style={{
                      flex: 1, background: "#12121c", border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 8, color: "#ddd", padding: "8px 10px", fontSize: 12,
                    }}
                  />
                  <button
                    onClick={() => checkElQuota()}
                    disabled={!elApiKey || elChecking}
                    style={{
                      background: elApiKey ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.02)",
                      color: elApiKey ? "#c4b5fd" : "#444",
                      border: "1px solid rgba(139,92,246,0.2)", borderRadius: 8,
                      padding: "8px 10px", fontSize: 11, whiteSpace: "nowrap",
                    }}
                  >{elChecking ? "確認中..." : "キー確認"}</button>
                </div>

                {/* Quota display */}
                {elQuota && !elQuota.error && (
                  <div style={{
                    fontSize: 11, padding: "6px 8px", borderRadius: 6, marginBottom: 8,
                    background: (elQuota.limited || elQuota.remaining > 500) ? "rgba(80,220,180,0.06)" : "rgba(232,100,100,0.08)",
                    color: (elQuota.limited || elQuota.remaining > 500) ? "#50dcb4" : "#e08080",
                    lineHeight: 1.6,
                  }}>
                    {elQuota.limited
                      ? <>✓ キー有効 — 再生できます<br /><span style={{ color: "#888", fontSize: 10 }}>（残り文字数の確認権限がないため表示できません）</span></>
                      : <>
                        ✓ キー有効（{elQuota.tier}）
                        — 残り <b>{elQuota.remaining.toLocaleString()}</b>文字
                        （{elQuota.used.toLocaleString()} / {elQuota.limit.toLocaleString()} 使用済み）
                        {elQuota.remaining <= 0 && <><br />⚠ 無料枠を使い切りました。来月リセットされます。</>}
                        {elQuota.remaining > 0 && elQuota.remaining <= 1000 && <><br />⚠ 残りわずかです。長い文章は「ブラウザ内蔵」推奨</>}
                      </>
                    }
                  </div>
                )}
                {elQuota?.error === "invalid_key" && (
                  <div style={{ fontSize: 11, color: "#e08080", padding: "6px 8px", borderRadius: 6, marginBottom: 8, background: "rgba(232,100,100,0.08)", lineHeight: 1.7 }}>
                    ✕ APIキーが無効です（401 Unauthorized）<br />
                    {elQuota.keyPreview && <span style={{ color: "#888" }}>入力されたキー先頭: <code style={{ background: "#1a1a26", padding: "1px 4px", borderRadius: 3 }}>{elQuota.keyPreview}</code><br /></span>}
                    {elQuota.detail && <span style={{ color: "#888" }}>API応答: {elQuota.detail}<br /></span>}
                    <span style={{ color: "#c4b5fd" }}>確認事項：キーをコピーし直して、先頭や末尾に余分なスペースがないか確認してください</span>
                  </div>
                )}
                {elQuota?.error === "network" && (
                  <div style={{ fontSize: 11, color: "#e08080", padding: "6px 8px", borderRadius: 6, marginBottom: 8, background: "rgba(232,100,100,0.08)", lineHeight: 1.7 }}>
                    ✕ ネットワークエラー<br />
                    {elQuota.detail && <span style={{ color: "#888" }}>詳細: {elQuota.detail}</span>}
                  </div>
                )}
                {elQuota?.error === "api_error" && (
                  <div style={{ fontSize: 11, color: "#e08080", padding: "6px 8px", borderRadius: 6, marginBottom: 8, background: "rgba(232,100,100,0.08)", lineHeight: 1.7 }}>
                    ✕ APIエラー（ステータス: {elQuota.elStatus}）<br />
                    {elQuota.detail && <span style={{ color: "#888" }}>API応答: {elQuota.detail}<br /></span>}
                    {elQuota.rawBody && !elQuota.detail && <span style={{ color: "#888" }}>生レスポンス: {elQuota.rawBody}<br /></span>}
                  </div>
                )}

                <div style={{ fontSize: 10, color: "#555", marginBottom: 10, lineHeight: 1.5 }}>
                  elevenlabs.io → Profile + API key → API Keys で取得。無料枠: 月10,000文字
                </div>

                {/* Voice */}
                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>音声</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {elVoices.map(v => (
                    <button key={v.id} onClick={() => setElVoiceId(v.id)} style={{
                      background: elVoiceId === v.id ? "rgba(139,92,246,0.15)" : "transparent",
                      color: elVoiceId === v.id ? "#c4b5fd" : "#666",
                      border: elVoiceId === v.id ? "1px solid rgba(139,92,246,0.3)" : "1px solid rgba(255,255,255,0.04)",
                      borderRadius: 6, padding: "6px 10px", fontSize: 11, textAlign: "left",
                    }}>{v.name}</button>
                  ))}
                </div>

                {!elApiKey && (
                  <div style={{ fontSize: 11, color: "#e08080", marginTop: 8 }}>
                    ⚠ APIキーを入力してください
                  </div>
                )}
              </div>
            )}

            <div style={{ fontSize: 12, color: "#aaa", marginBottom: 8 }}>速度</div>
            <SpeedChips rate={rate} onChange={handleSpeed} />

            {ttsEngine === "browser" && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                音声はブラウザ内蔵の日本語音声を使用。⚙ Chrome設定の「言語」で日本語を追加すると音声品質が向上する場合があります。
              </div>
            )}
            {ttsEngine === "elevenlabs" && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                ElevenLabsの高品質AI音声を使用。速度変更は再生中にも可能です。
              </div>
            )}
          </div>
        )}

        {/* ========== INPUT ========== */}
        <div style={{ marginBottom: 20 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, marginBottom: 8, background: "#141420", borderRadius: 8, padding: 3, width: "fit-content" }}>
            {[["file", "📄 ファイル"], ["text", "✏️ テキスト"]].map(([k, l]) => (
              <button key={k} onClick={() => setInputTab(k)} style={{
                background: inputTab === k ? "#222234" : "transparent",
                color: inputTab === k ? "#50dcb4" : "#555",
                border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12,
                fontWeight: inputTab === k ? 600 : 400,
              }}>{l}</button>
            ))}
          </div>

          {inputTab === "file" ? (
            <div>
              <input
                id="earflow-file-input"
                type="file"
                accept=".pdf,.txt,.md,.csv,.html,.json"
                multiple
                onChange={handleFileInputChange}
                style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
              />
              <label
                htmlFor="earflow-file-input"
                style={{
                  ...S.card, display: "block", padding: "20px 16px", textAlign: "center", cursor: "pointer",
                  border: "2px dashed rgba(255,255,255,0.08)",
                }}>
                <div style={{ fontSize: 28, opacity: 0.25, marginBottom: 4 }}>📄</div>
                <div style={{ fontSize: 13, color: "#555" }}>クリックしてファイルを選択</div>
                <div style={{ fontSize: 10, color: "#444", marginTop: 4 }}>PDF, TXT, MD, CSV, HTML</div>
              </label>
            </div>
          ) : (
            <>
              <textarea value={inputText} onChange={e => setInputText(e.target.value)}
                placeholder="読みたいテキストをペースト..."
                style={{
                  width: "100%", minHeight: 80, background: "#12121c",
                  border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12,
                  color: "#ddd", padding: 14, fontSize: 13, lineHeight: 1.7, resize: "vertical",
                }}
              />
              <button onClick={addTextInput} disabled={!inputText.trim()}
                style={{ ...S.btn(inputText.trim() ? "#50dcb4" : "#1c1c28", inputText.trim() ? "#111" : "#444"), width: "100%", marginTop: 8 }}>
                🎙 キューに追加
              </button>
            </>
          )}

          <button onClick={addDemos} style={{
            ...S.smBtn("rgba(80,220,180,0.03)", "#449e85"),
            width: "100%", marginTop: 8, border: "1px solid rgba(80,220,180,0.08)",
          }}>デモ記事を追加</button>
        </div>

        {/* ========== QUEUE ========== */}
        {queue.length > 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "#666" }}>キュー {queue.length}件</span>
              <button onClick={() => { handleStop(); setQueue([]); }} style={S.smBtn("transparent", "#555")}>クリア</button>
            </div>

            {queue.map((item, i) => {
              const m = MODES[item.mode] || MODES.briefing;
              const ready = item.status === "ready";
              const loading = item.status === "processing";
              const isActive = i === activeIdx;

              return (
                <div key={item.id} style={{
                  ...S.card, padding: "12px 14px", marginBottom: 8,
                  borderColor: isActive ? "rgba(80,220,180,0.25)" : undefined,
                  background: isActive ? "rgba(80,220,180,0.04)" : undefined,
                  opacity: loading ? 0.7 : 1,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Meta */}
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, color: "#444" }}>#{i + 1}</span>
                        <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: `${m.color}15`, color: m.color, fontWeight: 600 }}>{m.icon} {m.label}</span>
                        <span style={{ fontSize: 9, color: "#444" }}>{item.charCount.toLocaleString()}字</span>
                        {item.pageCount > 0 && <span style={{ fontSize: 9, color: "#555" }}>{item.pageCount}p</span>}
                      </div>
                      {/* Title */}
                      <div style={{ fontSize: 14, color: "#ddd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.title}
                      </div>
                      {/* Preview */}
                      {ready && item.mode === "raw" && item.text && (
                        <div style={{ fontSize: 12, color: "#a89860", marginTop: 5, lineHeight: 1.6 }}>
                          📖 全文読み上げ: {item.text.slice(0, 100)}{item.text.length > 100 ? "…" : ""}
                        </div>
                      )}
                      {ready && item.mode !== "raw" && item.summary && (
                        <div style={{ fontSize: 12, color: "#777", marginTop: 5, lineHeight: 1.6 }}>
                          {item.summary.slice(0, 120)}{item.summary.length > 120 ? "…" : ""}
                        </div>
                      )}
                      {item.errorMsg && <div style={{ fontSize: 11, color: "#e08080", marginTop: 4 }}>{item.errorMsg}</div>}
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", flexShrink: 0 }}>
                      <div style={{ display: "flex", gap: 3 }}>
                        <button onClick={() => handlePlay(i)} disabled={!ready} style={{
                          width: 34, height: 34, borderRadius: 8, border: "none",
                          background: isActive ? "#50dcb4" : ready ? "#242434" : "#1a1a22",
                          color: isActive ? "#111" : ready ? "#ccc" : "#444",
                          fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
                        }}>▶</button>
                        <button onClick={() => removeItem(i)} style={{
                          width: 34, height: 34, borderRadius: 8,
                          background: "transparent", border: "1px solid #2a2a38",
                          color: "#555", fontSize: 12,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>✕</button>
                      </div>
                      <div style={{ display: "flex", gap: 2 }}>
                        {Object.entries(MODES).map(([k, v]) => (
                          <button key={k} onClick={() => changeMode(i, k)} style={{
                            background: item.mode === k ? `${v.color}18` : "transparent",
                            color: item.mode === k ? v.color : "#3a3a48",
                            border: item.mode === k ? `1px solid ${v.color}30` : "1px solid transparent",
                            borderRadius: 5, padding: "2px 5px", fontSize: 9,
                          }}>{v.icon}</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {loading && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "#50dcb4" }}>
                      <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> AI要約中...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {queue.length === 0 && (
          <div style={{ textAlign: "center", padding: "36px 16px" }}>
            <div style={{ fontSize: 32, opacity: 0.15, marginBottom: 8 }}>📻</div>
            <div style={{ fontSize: 13, color: "#444" }}>PDFをドロップ or テキスト貼り付け or デモ追加</div>
          </div>
        )}
      </div>

      {/* ========== PLAYER BAR ========== */}
      {speaking && (
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0,
          background: "rgba(12,12,20,0.97)", borderTop: "1px solid rgba(80,220,180,0.1)",
          padding: "8px 16px 14px",
        }}>
          <div style={{ maxWidth: 620, margin: "0 auto" }}>
            {/* Progress */}
            <div style={{ height: 3, background: "#1a1a26", borderRadius: 2, marginBottom: 8, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, #50dcb4, #7ec8e8)", borderRadius: 2, transition: "width 0.5s" }} />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* Waveform */}
              <div style={{ display: "flex", alignItems: "center", gap: 2, height: 28, flexShrink: 0 }}>
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} style={{
                    width: 3, borderRadius: 2,
                    background: `hsl(${158 + i * 5}, 65%, 55%)`,
                    animation: !paused ? `wave 1s ease-in-out ${(i * 0.08).toFixed(2)}s infinite alternate` : "none",
                    height: paused ? 6 : undefined,
                  }} />
                ))}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#ddd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {activeIdx >= 0 && queue[activeIdx] ? queue[activeIdx].title : "再生中"}
                </div>
                <div style={{ fontSize: 10, color: ttsEngine === "elevenlabs" ? "#a78bfa" : "#555" }}>
                  {paused ? "一時停止" : "再生中"} · {rate}x{ttsEngine === "elevenlabs" ? " · ElevenLabs" : ""}
                </div>
              </div>

              {/* Speed */}
              <SpeedChips rate={rate} onChange={handleSpeed} compact />

              {/* Controls */}
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={paused ? handleResume : handlePause} style={{
                  width: 38, height: 38, borderRadius: "50%", background: "#50dcb4", color: "#111",
                  border: "none", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700,
                }}>{paused ? "▶" : "⏸"}</button>
                <button onClick={handleNext} style={{
                  width: 38, height: 38, borderRadius: "50%", background: "#1a1a26", color: "#888",
                  border: "1px solid #252535", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center",
                }}>⏭</button>
                <button onClick={handleStop} style={{
                  width: 38, height: 38, borderRadius: "50%", background: "#1a1a26", color: "#555",
                  border: "1px solid #252535", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center",
                }}>⏹</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* --- Speed Chips Component --- */
function SpeedChips({ rate, onChange, compact }) {
  return (
    <div style={{ display: "flex", gap: compact ? 2 : 4, alignItems: "center" }}>
      {[0.8, 1.0, 1.25, 1.5, 2.0].map(r => {
        const on = Math.abs(rate - r) < 0.01;
        return (
          <button key={r} onClick={() => onChange(r)} style={{
            background: on ? "#50dcb4" : "rgba(255,255,255,0.04)",
            color: on ? "#111" : "#666",
            border: on ? "none" : "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6, padding: compact ? "3px 5px" : "5px 8px",
            fontSize: compact ? 10 : 12, fontWeight: on ? 700 : 400,
            minWidth: compact ? 28 : 36, fontFamily: "monospace",
          }}>{r}x</button>
        );
      })}
    </div>
  );
}

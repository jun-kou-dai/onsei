import { useState, useRef, useEffect } from "react";
/* ================================================
   EarFlow v5 - Vite + Vercel edition
   Core principle: speak() is ALWAYS called
   synchronously from a click handler.
   No async, no setTimeout, no indirection.
   ================================================ */



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

// Clean up text for natural TTS reading
function cleanTextForTTS(text) {
  let t = text;
  // Remove page numbers (standalone digits on their own line)
  t = t.replace(/\n\s*\d{1,4}\s*\n/g, "\n");
  // Remove common headers/footers patterns
  t = t.replace(/\n\s*[-–—]\s*\d+\s*[-–—]\s*\n/g, "\n");
  // Join lines that are mid-sentence (no sentence-ending punctuation before newline)
  // Japanese sentence endings: 。！？、）」』】
  // Keep paragraph breaks (double newlines)
  t = t.replace(/([^。！？\!\?\n\r」』】）\)\.])[ \t]*\n(?!\n)/g, "$1");
  // Collapse multiple spaces/tabs into single space
  t = t.replace(/[ \t]{2,}/g, " ");
  // Collapse 3+ newlines into double newline (paragraph break)
  t = t.replace(/\n{3,}/g, "\n\n");
  // Remove leading/trailing whitespace per line
  t = t.replace(/^[ \t]+|[ \t]+$/gm, "");
  return t.trim();
}

// Fetch with automatic retry (exponential backoff) and per-request timeout
async function fetchWithRetry(url, options, retries = 1, timeoutMs = 18000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (res.ok || res.status === 400) return res; // 400 = bad input, don't retry
      clearTimeout(timer);
      if (i < retries) { await new Promise(r => setTimeout(r, 800 * (i + 1))); continue; }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (i >= retries) throw err;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

// Split long text into sections for queue items (paragraph-aware, targets ~maxLen chars)
function splitIntoSections(text, maxLen = 10000) {
  // First try splitting by paragraphs
  const paragraphs = text.split(/\n\n+/);
  const sections = [];
  let buf = "";
  for (const p of paragraphs) {
    if (buf && (buf.length + p.length + 2) > maxLen) {
      sections.push(buf.trim());
      buf = p;
    } else {
      buf += (buf ? "\n\n" : "") + p;
    }
  }
  if (buf.trim()) sections.push(buf.trim());
  // If any section is still too long, split at sentence boundaries
  const result = [];
  for (const sec of sections) {
    if (sec.length <= maxLen * 1.2) {
      result.push(sec);
    } else {
      result.push(...splitTextSmart(sec, maxLen));
    }
  }
  return result.filter(s => s.length > 0);
}

// Smart text chunking: split at sentence boundaries, respecting maxLen (for TTS API)
function splitTextSmart(text, maxLen = 5000) {
  const minLen = Math.max(100, Math.floor(maxLen * 0.5)); // Don't split too eagerly
  const result = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    const ch = text[i];
    // Prefer splitting at sentence endings (。！？) or paragraph breaks
    if ((ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?") && buf.length >= minLen) {
      result.push(buf.trim());
      buf = "";
    } else if (ch === "\n" && text[i + 1] === "\n" && buf.length >= minLen) {
      result.push(buf.trim());
      buf = "";
      i++; // skip the second newline
    } else if (buf.length >= maxLen) {
      // Hard limit reached — find best break point
      const lastSentence = Math.max(buf.lastIndexOf("。"), buf.lastIndexOf("！"), buf.lastIndexOf("？"));
      if (lastSentence > buf.length * 0.3) {
        result.push(buf.slice(0, lastSentence + 1).trim());
        buf = buf.slice(lastSentence + 1);
      } else {
        const lastBreak = Math.max(buf.lastIndexOf("、"), buf.lastIndexOf("，"), buf.lastIndexOf("\n"), buf.lastIndexOf(" "));
        if (lastBreak > buf.length * 0.3) {
          result.push(buf.slice(0, lastBreak + 1).trim());
          buf = buf.slice(lastBreak + 1);
        } else {
          result.push(buf.trim());
          buf = "";
        }
      }
    }
  }
  if (buf.trim()) result.push(buf.trim());
  return result.filter(c => c.length > 0);
}

// Split text into display sentences for highlight tracking
function splitIntoSentences(text) {
  const result = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    const ch = text[i];
    if ((ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?") && buf.trim().length >= 5) {
      result.push(buf.trim());
      buf = "";
    } else if (ch === "\n" && buf.trim().length >= 5) {
      result.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim().length > 0) result.push(buf.trim());
  return result.filter(s => s.length > 0);
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

// --- Multi-language Edge TTS voice definitions ---
const EDGE_VOICE_GROUPS = [
  {
    lang: "ja", label: "日本語", voices: [
      { id: "ja-JP-NanamiNeural", name: "Nanami（女性）" },
      { id: "ja-JP-KeitaNeural", name: "Keita（男性）" },
    ],
  },
  {
    lang: "en", label: "English", voices: [
      { id: "en-US-JennyNeural", name: "Jenny（女性・US）" },
      { id: "en-US-GuyNeural", name: "Guy（男性・US）" },
      { id: "en-GB-SoniaNeural", name: "Sonia（女性・UK）" },
    ],
  },
  {
    lang: "zh", label: "中文", voices: [
      { id: "zh-CN-XiaoxiaoNeural", name: "Xiaoxiao（女性）" },
      { id: "zh-CN-YunxiNeural", name: "Yunxi（男性）" },
    ],
  },
  {
    lang: "ko", label: "한국어", voices: [
      { id: "ko-KR-SunHiNeural", name: "SunHi（女性）" },
      { id: "ko-KR-InJoonNeural", name: "InJoon（男性）" },
    ],
  },
];
const ALL_EDGE_VOICE_IDS = EDGE_VOICE_GROUPS.flatMap(g => g.voices.map(v => v.id));

// Simple language detection based on character analysis
function detectLanguage(text) {
  const sample = text.slice(0, 2000);
  let ja = 0, zh = 0, ko = 0, en = 0, total = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0);
    if (code < 0x20) continue;
    total++;
    // Hiragana / Katakana → Japanese
    if ((code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) { ja += 2; continue; }
    // CJK Unified (shared by ja/zh, but counted separately)
    if (code >= 0x4E00 && code <= 0x9FFF) { ja++; zh++; continue; }
    // Hangul → Korean
    if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF)) { ko += 2; continue; }
    // Latin letters → English
    if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) { en++; continue; }
  }
  if (total === 0) return "ja";
  // If hiragana/katakana present → definitely Japanese (even with kanji)
  const jaKana = [...sample].filter(ch => {
    const c = ch.codePointAt(0);
    return (c >= 0x3040 && c <= 0x309F) || (c >= 0x30A0 && c <= 0x30FF);
  }).length;
  if (jaKana > total * 0.05) return "ja";
  if (ko > total * 0.15) return "ko";
  if (zh > total * 0.15) return "zh";
  if (en > total * 0.3) return "en";
  return "ja"; // default
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
  const [rate, setRateRaw] = useState(() => lsGet("rate", 1.15));
  const [progress, setProgress] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [inputTab, setInputTab] = useState("file");
  const [inputText, setInputText] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [isDrag, setIsDrag] = useState(false);
  const [audioTested, setAudioTested] = useState(false);
  const [audioWorks, setAudioWorks] = useState(null); // null=untested, true, false

  // --- Highlight state ---
  const [sentences, setSentences] = useState([]);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [showTranscript, setShowTranscriptRaw] = useState(() => lsGet("showTranscript", true));
  const sentenceOffsetsRef = useRef([]); // cumulative char offsets
  const highlightIdxRef = useRef(-1);

  // --- Session resume state ---
  const [savedSession, setSavedSession] = useState(null);
  const pendingResumeRef = useRef(null);
  const seekAfterLoadRef = useRef(0);

  // Guard: skip edgeVoice useEffect when voice change comes from handlePlay
  const voiceChangeFromPlayRef = useRef(false);

  // --- ElevenLabs state (persisted to localStorage) ---
  const [ttsEngine, setTtsEngineRaw] = useState(() => lsGet("ttsEngine", "edge"));
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

  // --- OpenAI TTS state ---
  const [oaiApiKey, setOaiApiKeyRaw] = useState(() => lsGet("oaiApiKey", ""));
  const [oaiVoice, setOaiVoiceRaw] = useState(() => lsGet("oaiVoice", "nova"));
  const [oaiModel, setOaiModelRaw] = useState(() => lsGet("oaiModel", "tts-1"));

  // --- Edge TTS state ---
  const [edgeVoice, setEdgeVoiceRaw] = useState(() => {
    const saved = lsGet("edgeVoice", "ja-JP-NanamiNeural");
    return ALL_EDGE_VOICE_IDS.includes(saved) ? saved : "ja-JP-NanamiNeural";
  });

  const audioRef = useRef(null); // HTML Audio element
  const playIdRef = useRef(0); // Guard against race conditions in async TTS
  // Refs to avoid stale closures in callbacks
  const queueRef = useRef([]);
  const activeIdxRef = useRef(-1);
  const keepAliveRef = useRef(null);
  const progressRef = useRef(null);
  const dragCnt = useRef(0);
  const audioCacheRef = useRef(new Map()); // Preloaded audio: cacheKey → Blob (LRU, max 3)
  const CACHE_MAX = 3;
  const cacheSet = (key, blob) => {
    const cache = audioCacheRef.current;
    cache.delete(key); // move to end (most recent)
    cache.set(key, blob);
    // Evict oldest entries
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  };

  // Persist-on-change wrappers
  const setTtsEngine = (v) => { setTtsEngineRaw(v); lsSet("ttsEngine", v); };
  const setElApiKey = (v) => { setElApiKeyRaw(v); lsSet("elApiKey", v); };
  const setElVoiceId = (v) => { setElVoiceIdRaw(v); lsSet("elVoiceId", v); };
  const setRate = (v) => { setRateRaw(v); lsSet("rate", v); };
  const setOaiApiKey = (v) => { setOaiApiKeyRaw(v); lsSet("oaiApiKey", v); };
  const setOaiVoice = (v) => { setOaiVoiceRaw(v); lsSet("oaiVoice", v); };
  const setOaiModel = (v) => { setOaiModelRaw(v); lsSet("oaiModel", v); };
  const setShowTranscript = (v) => { setShowTranscriptRaw(v); lsSet("showTranscript", v); };
  const edgeVoiceRef = useRef(edgeVoice);
  const setEdgeVoice = (v) => {
    setEdgeVoiceRaw(v); lsSet("edgeVoice", v);
    edgeVoiceRef.current = v;
    audioCacheRef.current.clear(); // clear preload cache when voice changes
  };

  // --- ElevenLabs quota check (via server proxy to avoid CORS) ---
  const checkElQuota = async (key) => {
    const apiKey = key || elApiKey;
    if (!apiKey) { setElQuota(null); return null; }
    setElChecking(true);
    try {
      const res = await fetch("/api/el-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, voiceId: elVoiceId }),
      });
      const data = await res.json();
      setElChecking(false);

      if (!data.ok) {
        const st = data.elStatus;
        let detail = "";
        try {
          const parsed = JSON.parse(data.rawBody || "");
          detail = parsed?.detail?.message || (typeof parsed?.detail === "string" ? parsed.detail : "") || parsed?.message || "";
        } catch {
          detail = (data.rawBody || "").slice(0, 300);
        }

        const bodyHint = (detail + " " + (data.rawBody || "")).toLowerCase();
        if (bodyHint.includes("missing the permission") || bodyHint.includes("missing_permissions")) {
          const info = { error: null, limited: true, tier: "unknown", used: 0, limit: 0, remaining: -1 };
          setElQuota(info);
          return info;
        }
        if (st === 401) {
          setElQuota({ error: "invalid_key", detail, keyPreview: apiKey.slice(0, 6) + "..." });
          return { error: "invalid_key" };
        }
        setElQuota({ error: "api_error", elStatus: st, detail });
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

  // Restart playback when edge voice changes mid-play
  useEffect(() => {
    // Skip if voice change originated from handlePlay (it already called edgeSpeak)
    if (voiceChangeFromPlayRef.current) {
      voiceChangeFromPlayRef.current = false;
      return;
    }
    if (speaking && ttsEngine === "edge" && activeIdx >= 0) {
      const item = queue[activeIdx];
      if (item?.text) {
        // Stop current audio
        playIdRef.current++;
        if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; audioRef.current = null; }
        // Restart with new voice
        setupSentences(item.text);
        edgeSpeak(item.text, currentRateRef.current);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeVoice]);

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

  // --- Session restore on mount ---
  useEffect(() => {
    const s = lsGet("session", null);
    if (s && Array.isArray(s.queue) && s.queue.length > 0) {
      // Validate each queue item has required fields
      const valid = s.queue.every(item =>
        item && typeof item.id === "string" && typeof item.text === "string" && item.text.length > 0 && typeof item.status === "string"
      );
      if (valid) {
        const clampedIdx = typeof s.activeIdx === "number"
          ? Math.min(Math.max(s.activeIdx, -1), s.queue.length - 1)
          : -1;
        setSavedSession({
          queue: s.queue,
          activeIdx: clampedIdx,
          progress: typeof s.progress === "number" ? Math.min(Math.max(s.progress, 0), 100) : 0,
          savedAt: s.savedAt || Date.now(),
        });
      } else {
        lsSet("session", null);
      }
    }
  }, []);

  // Pending resume: trigger playback after queue is restored
  useEffect(() => {
    if (pendingResumeRef.current && queue.length > 0) {
      const { idx, progress: prog } = pendingResumeRef.current;
      if (idx >= 0 && idx < queue.length && queue[idx]?.status === "ready") {
        seekAfterLoadRef.current = prog || 0;
        // Use queueRef to avoid stale closure in setTimeout
        const qRef = queueRef.current;
        setTimeout(() => {
          pendingResumeRef.current = null;
          if (idx < qRef.length && qRef[idx]?.status === "ready") {
            handlePlay(idx);
          }
        }, 80);
      } else {
        // idx out of range or item not ready - just restore queue without playing
        pendingResumeRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  // Dismiss resume banner if user adds items manually
  useEffect(() => {
    if (savedSession && queue.length > 0 && !pendingResumeRef.current) {
      setSavedSession(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length]);

  // Auto-save queue changes
  useEffect(() => {
    if (pendingResumeRef.current) return; // Skip during resume flow
    if (queue.length > 0) {
      // Preserve current progress if actively playing (avoid resetting to 0)
      saveSessionData(queue, activeIdxRef.current, getCurrentProgress());
    } else if (!savedSession) {
      lsSet("session", null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  // Periodic progress save during playback (every 5s)
  useEffect(() => {
    if (!speaking) return;
    const interval = setInterval(() => {
      saveSessionData(queueRef.current, activeIdxRef.current, getCurrentProgress());
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaking]);

  // Save on page unload
  useEffect(() => {
    const onUnload = () => {
      saveSessionData(queueRef.current, activeIdxRef.current, getCurrentProgress());
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const flash = (msg) => setStatus(msg);
  const upd = (id, u) => setQueue(q => q.map(x => x.id === id ? { ...x, ...u } : x));

  // --- Session save/restore ---
  const saveSessionData = (q, idx, prog) => {
    if (!q || q.length === 0) {
      lsSet("session", null);
      return;
    }
    lsSet("session", {
      queue: q.map(item => ({
        id: item.id, text: item.text, title: item.title,
        sourceType: item.sourceType, status: item.status,
        charCount: item.charCount, pageCount: item.pageCount || 0,
        lang: item.lang || "ja",
      })),
      activeIdx: idx,
      progress: prog || 0,
      savedAt: Date.now(),
    });
  };

  const handleResumeSession = () => {
    const s = savedSession;
    if (!s) return;
    pendingResumeRef.current = { idx: s.activeIdx >= 0 ? s.activeIdx : -1, progress: s.progress || 0 };
    setQueue(s.queue);
    queueRef.current = s.queue;
    setSavedSession(null);
  };

  const handleDismissSession = () => {
    setSavedSession(null);
    lsSet("session", null);
  };

  // --- Highlight helpers ---
  const setupSentences = (text) => {
    const sents = splitIntoSentences(text);
    setSentences(sents);
    let cum = 0;
    sentenceOffsetsRef.current = sents.map(s => { cum += s.length; return cum; });
    if (sents.length > 0) {
      setHighlightIdx(0);
      highlightIdxRef.current = 0;
    } else {
      setHighlightIdx(-1);
      highlightIdxRef.current = -1;
    }
  };

  const resetHighlight = () => {
    setSentences([]);
    setHighlightIdx(-1);
    highlightIdxRef.current = -1;
    sentenceOffsetsRef.current = [];
  };

  const updateHighlightFromAudio = (currentTime, duration) => {
    const offsets = sentenceOffsetsRef.current;
    if (!offsets.length || !duration || !isFinite(duration)) return;
    const totalChars = offsets[offsets.length - 1];
    const charPos = (currentTime / duration) * totalChars;
    let idx = offsets.length - 1;
    for (let i = 0; i < offsets.length; i++) {
      if (charPos < offsets[i]) { idx = i; break; }
    }
    if (idx !== highlightIdxRef.current) {
      highlightIdxRef.current = idx;
      setHighlightIdx(idx);
    }
  };

  const updateHighlightFromCharPos = (charPos) => {
    const offsets = sentenceOffsetsRef.current;
    if (!offsets.length) return;
    let idx = offsets.length - 1;
    for (let i = 0; i < offsets.length; i++) {
      if (charPos < offsets[i]) { idx = i; break; }
    }
    if (idx !== highlightIdxRef.current) {
      highlightIdxRef.current = idx;
      setHighlightIdx(idx);
    }
  };

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
    currentRateRef.current = rateVal ?? 1.0;

    try {
      flash("🔊 音声生成中（" + text.length + "文字）...");
      setSpeaking(true);

      let res;
      try {
        const elCtrl = new AbortController();
        const elTimer = setTimeout(() => elCtrl.abort(), 55000);
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
          signal: elCtrl.signal,
        });
        clearTimeout(elTimer);
      } catch (fetchErr) {
        flash("⚠ ネットワークエラー: サーバーに接続できません");
        setSpeaking(false);
        return;
      }

      if (playIdRef.current !== myPlayId) return;

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let parsed = null;
        try { parsed = JSON.parse(errBody); } catch {}
        const detailObj = parsed?.detail;
        const detailStatus = typeof detailObj === "object" ? (detailObj?.status || detailObj?.detail?.status || "") : "";
        const detailMsg = typeof detailObj === "object" ? (detailObj?.message || detailObj?.detail?.message || "") : (typeof detailObj === "string" ? detailObj : "");
        const fallbackMsg = parsed?.error || parsed?.message || errBody.slice(0, 150);

        if (detailStatus === "quota_exceeded") {
          // Extract remaining/required credits from message if possible
          const credMatch = (detailMsg || "").match(/(\d[\d,]*)\s*credits?\s*remaining.*?(\d[\d,]*)\s*credits?\s*(?:are\s*)?required/i);
          if (credMatch) {
            flash(`⚠ 文字数上限を超えています。残り ${credMatch[1]} クレジット、このテキストには ${credMatch[2]} クレジット必要です。短いテキストで試してください`);
          } else {
            flash("⚠ 文字数上限を超えています。短いテキストで試すか、来月のリセットをお待ちください");
          }
        } else if (detailStatus === "detected_unusual_activity") {
          flash("⚠ ElevenLabs無料枠が停止されています（クラウドIPからのアクセス制限）。有料プランにするか、「ブラウザ内蔵」に切り替えてください");
          // 設定画面のステータスを即座に「停止中」に上書き
          setElQuota({
            error: "ban",
            detail: "Unusual activity detected. Free Tier usage disabled via API.",
            tier: "free_banned",
          });
        } else if (res.status === 401) {
          const bodyHint = (detailMsg + " " + errBody).toLowerCase();
          if (bodyHint.includes("missing the permission") || bodyHint.includes("missing_permissions")) {
            flash("⚠ APIキーに音声生成の権限がありません。ElevenLabsでキーの権限設定を確認してください");
          } else {
            flash("⚠ APIキー認証失敗: " + (detailMsg || fallbackMsg || "キーを確認してください"));
          }
        } else if (res.status === 429) {
          flash("⚠ レート制限に達しました。30秒ほど待ってから再試行してください");
        } else {
          flash("⚠ ElevenLabs エラー " + res.status + ": " + (detailMsg || fallbackMsg));
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
        audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null;
        audioRef.current.pause();
        audioRef.current.src = "";
      }

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.playbackRate = rateVal ?? 1.0;
      audio.volume = 1.0;

      audio.onplay = () => {
        setSpeaking(true); setPaused(false);
        flash(""); // clear "generating" message
        if (seekAfterLoadRef.current > 0) {
          const target = seekAfterLoadRef.current;
          seekAfterLoadRef.current = 0;
          const doSeek = () => { if (audio.duration > 0 && isFinite(audio.duration)) audio.currentTime = (target / 100) * audio.duration; };
          if (audio.duration > 0 && isFinite(audio.duration)) doSeek();
          else audio.addEventListener("durationchange", doSeek, { once: true });
        }
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
          setupSentences(q[nextIdx].text);
          const nextText = q[nextIdx].text;
          if (nextText) elSpeak(nextText, currentRateRef.current);
        } else {
          setActiveIdx(-1); activeIdxRef.current = -1;
          resetHighlight();
        }
      };

      audio.onerror = () => {
        setSpeaking(false); flash("⚠ 音声再生エラー");
        URL.revokeObjectURL(url);
      };

      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          setProgress(Math.round((audio.currentTime / audio.duration) * 100));
          updateHighlightFromAudio(audio.currentTime, audio.duration);
        }
      };

      audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
    } catch (e) {
      flash("⚠ " + e.message);
      setSpeaking(false);
    }
  };

  // --- OpenAI TTS ---
  const openaiSpeak = async (text, rateVal) => {
    if (!oaiApiKey) { flash("⚠ OpenAI APIキーが設定されていません。設定から入力してください"); setSpeaking(false); return; }

    const myPlayId = ++playIdRef.current;
    currentRateRef.current = rateVal ?? 1.0;

    try {
      flash("音声生成中...");
      setSpeaking(true);

      // OpenAI TTS has 4096 char limit — chunk at sentence boundaries
      const chunks = splitTextSmart(text, 4096);

      const blobs = [];
      for (const chunk of chunks) {
        if (playIdRef.current !== myPlayId) return;

        let res;
        try {
          const oaiCtrl = new AbortController();
          const oaiTimer = setTimeout(() => oaiCtrl.abort(), 55000);
          res = await fetch("/api/openai-tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              apiKey: oaiApiKey,
              text: chunk,
              voice: oaiVoice,
              model: oaiModel,
            }),
            signal: oaiCtrl.signal,
          });
          clearTimeout(oaiTimer);
        } catch (fetchErr) {
          flash("⚠ ネットワークエラー: サーバーに接続できません");
          setSpeaking(false);
          return;
        }

        if (playIdRef.current !== myPlayId) return;

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          let msg = "";
          try {
            const parsed = JSON.parse(errBody);
            msg = parsed?.detail?.error?.message || parsed?.error || errBody.slice(0, 150);
          } catch { msg = errBody.slice(0, 150); }

          if (res.status === 401) {
            flash("⚠ OpenAI APIキーが無効です。キーを確認してください");
          } else if (res.status === 429) {
            flash("⚠ レート制限。少し待ってから再試行してください");
          } else {
            flash("⚠ OpenAI TTS エラー: " + msg);
          }
          setSpeaking(false);
          return;
        }

        blobs.push(await res.blob());
      }

      if (playIdRef.current !== myPlayId) return;

      // Combine blobs if multiple chunks
      const combined = new Blob(blobs, { type: "audio/mpeg" });
      if (combined.size < 100) {
        flash("⚠ 音声データが空です");
        setSpeaking(false);
        return;
      }

      const url = URL.createObjectURL(combined);

      if (audioRef.current) {
        audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null;
        audioRef.current.pause();
        audioRef.current.src = "";
      }

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.playbackRate = rateVal ?? 1.0;
      audio.volume = 1.0;

      audio.onplay = () => {
        setSpeaking(true); setPaused(false);
        flash("");
        if (seekAfterLoadRef.current > 0) {
          const target = seekAfterLoadRef.current;
          seekAfterLoadRef.current = 0;
          const doSeek = () => { if (audio.duration > 0 && isFinite(audio.duration)) audio.currentTime = (target / 100) * audio.duration; };
          if (audio.duration > 0 && isFinite(audio.duration)) doSeek();
          else audio.addEventListener("durationchange", doSeek, { once: true });
        }
      };

      audio.onended = () => {
        setSpeaking(false); setPaused(false); setProgress(100);
        stopProgress();
        URL.revokeObjectURL(url);
        // Auto-play next
        const nextIdx = activeIdxRef.current + 1;
        const q = queueRef.current;
        if (nextIdx < q.length && q[nextIdx]?.status === "ready") {
          setActiveIdx(nextIdx);
          activeIdxRef.current = nextIdx;
          setupSentences(q[nextIdx].text);
          const nextText = q[nextIdx].text;
          if (nextText) openaiSpeak(nextText, currentRateRef.current);
        } else {
          setActiveIdx(-1); activeIdxRef.current = -1;
          resetHighlight();
        }
      };

      audio.onerror = () => {
        setSpeaking(false); flash("⚠ 音声再生エラー");
        URL.revokeObjectURL(url);
      };

      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          setProgress(Math.round((audio.currentTime / audio.duration) * 100));
          updateHighlightFromAudio(audio.currentTime, audio.duration);
        }
      };

      audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
    } catch (e) {
      flash("⚠ " + e.message);
      setSpeaking(false);
    }
  };

  // --- Edge TTS audio preloader (background fetch, no UI) ---
  const preloadEdgeAudio = (itemId, text) => {
    const v = edgeVoiceRef.current;
    const r = currentRateRef.current || 1.0;
    const key = `${itemId}_${v}_${r}`;
    if (audioCacheRef.current.has(key)) return;
    const chunks = splitTextSmart(text, 5000);
    Promise.all(chunks.map(chunk =>
      fetchWithRetry("/api/edge-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk, voice: v, rate: r }),
      }, 0).then(r => r.ok ? r.blob() : null).catch(() => null)
    )).then(blobs => {
      const valid = blobs.filter(b => b);
      if (valid.length > 0) {
        const combined = new Blob(valid, { type: "audio/mpeg" });
        if (combined.size >= 100) cacheSet(key, combined);
      }
    }).catch(() => {});
  };

  // --- Edge TTS (free, no API key) ---
  // Helper: set up audio event handlers and auto-play-next logic
  const setupEdgeAudio = (audio, urlToRevoke, rateVal) => {
    audio.onplay = () => {
      setSpeaking(true); setPaused(false); flash("");
      if (seekAfterLoadRef.current > 0) {
        const target = seekAfterLoadRef.current;
        seekAfterLoadRef.current = 0;
        const doSeek = () => { if (audio.duration > 0 && isFinite(audio.duration)) audio.currentTime = (target / 100) * audio.duration; };
        if (audio.duration > 0 && isFinite(audio.duration)) doSeek();
        else audio.addEventListener("durationchange", doSeek, { once: true });
      }
    };
    audio.onended = () => {
      setSpeaking(false); setPaused(false); setProgress(100); stopProgress();
      URL.revokeObjectURL(urlToRevoke);
      const nextIdx = activeIdxRef.current + 1;
      const q = queueRef.current;
      if (nextIdx < q.length && q[nextIdx]?.status === "ready") {
        setActiveIdx(nextIdx); activeIdxRef.current = nextIdx;
        setupSentences(q[nextIdx].text);
        if (nextIdx + 1 < q.length && q[nextIdx + 1]?.status === "ready")
          preloadEdgeAudio(q[nextIdx + 1].id, q[nextIdx + 1].text);
        if (q[nextIdx].text) edgeSpeak(q[nextIdx].text, currentRateRef.current);
      } else {
        setActiveIdx(-1); activeIdxRef.current = -1;
        resetHighlight();
      }
    };
    audio.onerror = () => { setSpeaking(false); flash("⚠ 再生エラー"); URL.revokeObjectURL(urlToRevoke); };
    audio.ontimeupdate = () => {
      if (audio.duration > 0 && isFinite(audio.duration)) {
        setProgress(Math.round((audio.currentTime / audio.duration) * 100));
        updateHighlightFromAudio(audio.currentTime, audio.duration);
      }
    };
  };

  const edgeSpeak = async (text, rateVal) => {
    const myPlayId = ++playIdRef.current;
    currentRateRef.current = rateVal ?? 1.0;

    try {
      setSpeaking(true);
      generatedRateRef.current = rateVal ?? 1.0; // track SSML rate for live speed changes

      // 1. Check preload cache — instant playback
      const activeItem = queueRef.current[activeIdxRef.current];
      const voice = edgeVoiceRef.current;
      const cacheKey = activeItem ? `${activeItem.id}_${voice}_${rateVal ?? 1.0}` : null;
      const cached = cacheKey ? audioCacheRef.current.get(cacheKey) : null;

      if (cached) {
        audioCacheRef.current.delete(cacheKey);
        const url = URL.createObjectURL(cached);
        if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.playbackRate = 1.0; // Edge TTS handles rate via SSML
        audio.volume = 1.0;
        setupEdgeAudio(audio, url, rateVal);
        audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
        return;
      }

      // 2. No cache — fetch with streaming playback via MediaSource
      flash("音声生成中...");

      const chunks = splitTextSmart(text, 5000);

      // For single chunk + MediaSource support: stream and play immediately
      if (chunks.length === 1 && window.MediaSource && MediaSource.isTypeSupported("audio/mpeg")) {
        let fetchRes;
        const _t0 = performance.now();
        try {
          fetchRes = await fetchWithRetry("/api/edge-tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: chunks[0], voice: voice, rate: rateVal ?? 1.0 }),
          }, 0);
        } catch {
          console.warn(`[TTS] fetch failed after ${Math.round(performance.now()-_t0)}ms`);
          flash("⚠ ネットワークエラー"); setSpeaking(false); return;
        }
        const _elapsed = Math.round(performance.now()-_t0);
        const _wsMs = fetchRes.headers.get("X-Timing-WsConnect");
        const _audioMs = fetchRes.headers.get("X-Timing-FirstAudio");
        console.log(`[TTS] fetch=${_elapsed}ms | server: ws=${_wsMs} firstAudio=${_audioMs}`);
        if (!fetchRes.ok) {
          const errBody = await fetchRes.text().catch(() => "");
          console.warn(`[TTS] error response:`, errBody);
          flash("⚠ 音声生成エラー: " + errBody.slice(0, 100));
          setSpeaking(false); return;
        }
        if (playIdRef.current !== myPlayId) return;

        const ms = new MediaSource();
        const msUrl = URL.createObjectURL(ms);
        if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
        const audio = new Audio();
        audioRef.current = audio;
        audio.src = msUrl;
        audio.playbackRate = 1.0; // Edge TTS handles rate via SSML; don't double-apply
        audio.volume = 1.0;
        setupEdgeAudio(audio, msUrl, rateVal);

        await new Promise((resolve) => {
          ms.addEventListener("sourceopen", async () => {
            try {
              const sb = ms.addSourceBuffer("audio/mpeg");
              const reader = fetchRes.body.getReader();
              let started = false;

              while (true) {
                const { done, value } = await reader.read();
                if (playIdRef.current !== myPlayId) { reader.cancel(); resolve(); return; }
                if (done) break;

                if (sb.updating)
                  await new Promise(r => sb.addEventListener("updateend", r, { once: true }));
                sb.appendBuffer(value);

                // Start playback after first chunk appended
                if (!started) {
                  await new Promise(r => sb.addEventListener("updateend", r, { once: true }));
                  audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
                  started = true;
                }
              }

              if (sb.updating)
                await new Promise(r => sb.addEventListener("updateend", r, { once: true }));
              if (ms.readyState === "open") ms.endOfStream();
            } catch (streamErr) {
              try { if (ms.readyState === "open") ms.endOfStream(); } catch {}
              if (streamErr?.name === "AbortError") {
                flash("⚠ 音声ストリーミングタイムアウト。再試行してください");
                setSpeaking(false);
              }
            }
            resolve();
          });
        });
        return;
      }

      // 3. Multi-chunk or no MediaSource — parallel fetch with retry, skip failed chunks
      const blobResults = await Promise.all(chunks.map(chunk =>
        fetchWithRetry("/api/edge-tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunk, voice: voice, rate: rateVal ?? 1.0 }),
        }, 0).then(async r => r.ok ? r.blob() : null).catch(() => null)
      ));
      const blobs = blobResults.filter(b => b && b.size >= 100);
      if (blobs.length === 0) {
        flash("⚠ 音声生成に失敗しました");
        setSpeaking(false); return;
      }
      if (blobs.length < chunks.length) {
        flash(`⚠ ${chunks.length - blobs.length}チャンクをスキップ`);
      }
      if (playIdRef.current !== myPlayId) return;

      const combined = new Blob(blobs, { type: "audio/mpeg" });
      if (combined.size < 100) { flash("⚠ 音声データが空です"); setSpeaking(false); return; }

      const url = URL.createObjectURL(combined);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.playbackRate = 1.0; // Edge TTS handles rate via SSML
      audio.volume = 1.0;
      setupEdgeAudio(audio, url, rateVal);
      audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
    } catch (e) {
      flash("⚠ " + e.message);
      setSpeaking(false);
    }
  };

  // Get current playback progress (0-100) for any engine
  const getCurrentProgress = () => {
    if (audioRef.current?.duration > 0 && isFinite(audioRef.current.duration)) {
      return Math.round((audioRef.current.currentTime / audioRef.current.duration) * 100);
    }
    if (totalCharsRef.current > 0 && spokenCharsRef.current > 0) {
      return Math.round((spokenCharsRef.current / totalCharsRef.current) * 100);
    }
    return 0;
  };

  // --- Unified stop (both engines) ---
  const stopAll = () => {
    // Save position before stopping
    const prog = getCurrentProgress();
    if (queueRef.current.length > 0) {
      saveSessionData(queueRef.current, activeIdxRef.current, prog);
    }

    playIdRef.current++; // Cancel any pending ElevenLabs requests
    seekAfterLoadRef.current = 0;

    // Browser TTS
    stoppedRef.current = true;
    chunksRef.current = [];
    chunkIdxRef.current = 0;
    window.speechSynthesis?.cancel();

    // ElevenLabs Audio
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.ontimeupdate = null;
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
    resetHighlight();
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
  const generatedRateRef = useRef(1.0); // rate baked into SSML for current audio

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
      // Auto-play next queue item (match behavior of Edge/OpenAI/ElevenLabs)
      const nextIdx = activeIdxRef.current + 1;
      const q = queueRef.current;
      if (nextIdx < q.length && q[nextIdx]?.status === "ready") {
        setActiveIdx(nextIdx); activeIdxRef.current = nextIdx;
        setupSentences(q[nextIdx].text);
        handlePlay(nextIdx);
      } else {
        setActiveIdx(-1); activeIdxRef.current = -1;
        resetHighlight();
      }
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
      // Update highlight based on spoken character position
      updateHighlightFromCharPos(spokenCharsRef.current);
    };

    // Word-level highlight updates within a chunk
    u.addEventListener("boundary", (e) => {
      if (e.name === "word") {
        updateHighlightFromCharPos(spokenCharsRef.current + (e.charIndex || 0));
      }
    });

    u.onend = () => {
      spokenCharsRef.current += text.length;
      const total = totalCharsRef.current;
      if (total > 0) setProgress(Math.round((spokenCharsRef.current / total) * 100));
      updateHighlightFromCharPos(spokenCharsRef.current);
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
      // Use ref to avoid stale closure when called from setTimeout
      const item = queueRef.current[index];
      if (!item || item.status !== "ready") return;
      const fullText = item.text;
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
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
        audioRef.current.ontimeupdate = null;
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
      setupSentences(fullText);

      if (ttsEngine === "edge") {
        // Auto-switch voice if item language doesn't match current voice
        const itemLang = item.lang || "ja";
        const voiceLangPrefix = edgeVoiceRef.current.slice(0, 2); // "ja", "en", etc.
        if (itemLang !== voiceLangPrefix) {
          const targetGroup = EDGE_VOICE_GROUPS.find(g => g.lang === itemLang);
          if (targetGroup && targetGroup.voices.length > 0) {
            const autoVoice = targetGroup.voices[0].id;
            voiceChangeFromPlayRef.current = true; // prevent useEffect double-call
            setEdgeVoice(autoVoice);
            flash(`🔄 音声を${targetGroup.label}に自動切替`);
          }
        }
        edgeSpeak(fullText, rate);
      } else if (ttsEngine === "openai") {
        openaiSpeak(fullText, rate);
      } else if (ttsEngine === "elevenlabs") {
        elSpeak(fullText, rate);
      } else {
        // Small delay after cancel() to avoid Chrome speechSynthesis hang
        setTimeout(() => {
          stoppedRef.current = false;
          const chunks = splitText(fullText);
          chunksRef.current = chunks;
          chunkIdxRef.current = 0;
          totalCharsRef.current = fullText.length;
          spokenCharsRef.current = 0;
          currentRateRef.current = rate;
          // Handle seek for browser TTS resume
          if (seekAfterLoadRef.current > 0) {
            const totalChunkChars = chunks.reduce((sum, c) => sum + c.length, 0);
            const targetChars = Math.floor((seekAfterLoadRef.current / 100) * totalChunkChars);
            seekAfterLoadRef.current = 0;
            let cumChars = 0;
            let startChunk = 0;
            for (let i = 0; i < chunks.length; i++) {
              if (cumChars + chunks[i].length >= targetChars) { startChunk = i; break; }
              cumChars += chunks[i].length;
              if (i === chunks.length - 1) startChunk = i; // last chunk fallback
            }
            spokenCharsRef.current = cumChars;
            speakChunk(startChunk, rate);
          } else {
            speakChunk(0, rate);
          }
        }, 100);
      }
    } catch (e) {
      flash("⚠ " + e.message);
    }
  };

  // --- PAUSE ---
  const handlePause = () => {
    try {
      if (ttsEngine !== "browser" && audioRef.current) {
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
      if (ttsEngine !== "browser" && audioRef.current) {
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
      flash("キューの最後です");
    }
  };

  // --- SPEED CHANGE ---
  const handleSpeed = (newRate) => {
    setRate(newRate);
    currentRateRef.current = newRate;
    if (speaking && activeIdx >= 0) {
      if (ttsEngine !== "browser" && audioRef.current) {
        // Audio was generated at generatedRateRef via SSML; adjust playbackRate as ratio
        audioRef.current.playbackRate = newRate / (generatedRateRef.current || 1.0);
      } else {
        stoppedRef.current = true;
        window.speechSynthesis?.cancel();
        stopKeepAlive();
        // Recalculate correct spoken chars to prevent double-counting
        const chunks = chunksRef.current;
        let correctChars = 0;
        for (let i = 0; i < chunkIdxRef.current; i++) correctChars += chunks[i].length;
        spokenCharsRef.current = correctChars;
        stoppedRef.current = false;
        speakChunk(chunkIdxRef.current, newRate);
      }
    }
  };

  /* ================================================
     QUEUE MANAGEMENT
     ================================================ */
  const SPLIT_THRESHOLD = 10000; // Auto-split texts longer than this

  const addItem = (rawText, title, sourceType, pageCount, lang) => {
    if (!rawText || rawText.trim().length < 5) { flash("⚠ テキストが短すぎます"); return; }
    const text = cleanTextForTTS(rawText);
    const detectedLang = lang || detectLanguage(text);

    // Auto-split long texts into manageable queue items
    if (text.length > SPLIT_THRESHOLD) {
      const sections = splitIntoSections(text, SPLIT_THRESHOLD);
      const baseTitle = title || text.slice(0, 25);
      const items = sections.map((sec, i) => ({
        id: uid(), text: sec,
        title: `${baseTitle} (${i + 1}/${sections.length})`,
        sourceType: sourceType || "text",
        status: "ready",
        charCount: sec.length, pageCount: 0, lang: detectedLang,
      }));
      setQueue(q => [...q, ...items]);
      if (ttsEngine === "edge" && items[0]) preloadEdgeAudio(items[0].id, items[0].text);
      flash(`✓ ${text.length.toLocaleString()}字 → ${sections.length}パートに分割`);
      return;
    }

    const id = uid();
    setQueue(q => [...q, {
      id, text, title: title || text.slice(0, 35),
      sourceType: sourceType || "text",
      status: "ready",
      charCount: text.length, pageCount: pageCount || 0, lang: detectedLang,
    }]);
    if (ttsEngine === "edge") preloadEdgeAudio(id, text);
  };


  const removeItem = (index) => {
    if (index === activeIdx) handleStop();
    setQueue(q => q.filter((_, i) => i !== index));
    if (index < activeIdx) setActiveIdx(a => a - 1);
    if (index === activeIdx) setActiveIdx(-1);
  };

  // --- TRANSLATE QUEUE ITEM ---
  const translateItem = async (index) => {
    const item = queueRef.current[index];
    if (!item) return;
    const itemId = item.id; // Track by ID, not index (index can shift during async)
    const apiKey = oaiApiKey;
    if (!apiKey || !apiKey.trim()) {
      flash("⚠ 翻訳にはOpenAI APIキーが必要です。⚙設定で入力してください");
      return;
    }
    const srcLang = item.lang || detectLanguage(item.text);
    if (srcLang === "ja") {
      flash("すでに日本語です");
      return;
    }
    flash("🌐 翻訳中...");
    setQueue(q => q.map(it => it.id === itemId ? { ...it, _translating: true } : it));
    try {
      const translateCtrl = new AbortController();
      const translateTimer = setTimeout(() => translateCtrl.abort(), 60000); // 60s for long texts
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim(), text: item.text, sourceLang: srcLang, targetLang: "ja" }),
        signal: translateCtrl.signal,
      });
      clearTimeout(translateTimer);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        flash("⚠ 翻訳エラー: " + (data.error || data.detail?.error?.message || "失敗"));
        setQueue(q => q.map(it => it.id === itemId ? { ...it, _translating: false } : it));
        return;
      }
      const langLabels = { en: "英語", zh: "中国語", ko: "韓国語" };
      const newItem = {
        id: uid(),
        text: data.text,
        title: `${item.title}（${langLabels[srcLang] || srcLang}→日本語）`,
        sourceType: "translated",
        status: "ready",
        charCount: data.text.length,
        pageCount: 0,
        lang: "ja",
      };
      setQueue(q => {
        const itemIndex = q.findIndex(it => it.id === itemId);
        if (itemIndex < 0) return q; // Item was deleted during translation
        const updated = q.map(it => it.id === itemId ? { ...it, _translating: false } : it);
        const result = [...updated];
        result.splice(itemIndex + 1, 0, newItem);
        return result;
      });
      flash(`✓ 翻訳完了（${(data.charCount || data.text?.length || 0).toLocaleString()}字）`);
    } catch (e) {
      flash("⚠ ネットワークエラー: " + e.message);
      setQueue(q => q.map(it => it.id === itemId ? { ...it, _translating: false } : it));
    }
  };

  /* ================================================
     FILE / PDF HANDLING
     ================================================ */
  const processFile = async (file) => {
    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        if (file.size > 50 * 1024 * 1024) {
          flash("⚠ PDFが大きすぎます（50MB上限）。短いファイルをお試しください");
          return;
        }
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
    const textLang = detectLanguage(inputText.trim());
    addItem(inputText.trim(), inputText.trim().slice(0, 35), "text", 0, textLang);
    if (textLang !== "ja") flash(`✓ 追加しました — 「訳」ボタンで日本語に翻訳できます`);
    setInputText("");
  };

  const addFromUrl = async () => {
    const url = inputUrl.trim();
    if (!url) return;
    setUrlLoading(true);
    flash("🌐 記事を取得中...");
    try {
      const urlCtrl = new AbortController();
      const urlTimer = setTimeout(() => urlCtrl.abort(), 20000);
      const res = await fetch("/api/extract-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: urlCtrl.signal,
      });
      clearTimeout(urlTimer);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        flash("⚠ " + (data.error || "記事の取得に失敗しました"));
        setUrlLoading(false);
        return;
      }
      const urlLang = detectLanguage(data.text);
      addItem(data.text, data.title || data.source, "url", 0, urlLang);
      const chars = (data.charCount || data.text?.length || 0).toLocaleString();
      const langHint = urlLang !== "ja" ? " — 「訳」ボタンで日本語に翻訳できます" : "";
      flash(`✓ ${data.source} から ${chars}字を取得${langHint}`);
      setInputUrl("");
    } catch (e) {
      flash("⚠ ネットワークエラー: " + e.message);
    }
    setUrlLoading(false);
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
            <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
              {[["edge", "Edge（推奨・無料）", "#0078d4"], ["openai", "OpenAI", "#10a37f"], ["elevenlabs", "ElevenLabs", "#8b5cf6"], ["browser", "ブラウザ内蔵", "#50dcb4"]].map(([k, l, clr]) => (
                <button key={k} onClick={() => { setTtsEngine(k); setAudioTested(false); setAudioWorks(null); }} style={{
                  background: ttsEngine === k ? clr : "rgba(255,255,255,0.04)",
                  color: ttsEngine === k ? "#fff" : "#666",
                  border: ttsEngine === k ? "none" : "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: ttsEngine === k ? 700 : 400,
                }}>{l}</button>
              ))}
            </div>

            {/* Edge TTS settings */}
            {ttsEngine === "edge" && (
              <div style={{ background: "rgba(0,120,212,0.05)", borderRadius: 10, padding: 12, marginBottom: 12, border: "1px solid rgba(0,120,212,0.15)" }}>
                <div style={{ fontSize: 11, color: "#60a5fa", marginBottom: 8, fontWeight: 600 }}>Edge TTS 設定（APIキー不要）</div>

                <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>音声</div>
                {EDGE_VOICE_GROUPS.map(group => (
                  <div key={group.lang} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 9, color: "#555", marginBottom: 3, fontWeight: 600 }}>{group.label}</div>
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {group.voices.map(v => (
                        <button key={v.id} onClick={() => setEdgeVoice(v.id)} style={{
                          background: edgeVoice === v.id ? "rgba(0,120,212,0.15)" : "transparent",
                          color: edgeVoice === v.id ? "#60a5fa" : "#666",
                          border: edgeVoice === v.id ? "1px solid rgba(0,120,212,0.3)" : "1px solid rgba(255,255,255,0.04)",
                          borderRadius: 6, padding: "5px 9px", fontSize: 10, textAlign: "left",
                        }}>{v.name}</button>
                      ))}
                    </div>
                  </div>
                ))}

                <div style={{ fontSize: 10, color: "#555", lineHeight: 1.5, marginTop: 4 }}>
                  Microsoft Edge TTSを使用。無料・APIキー不要。日本語・英語・中国語・韓国語に対応。
                </div>
              </div>
            )}

            {/* OpenAI settings */}
            {ttsEngine === "openai" && (
              <div style={{ background: "rgba(16,163,127,0.05)", borderRadius: 10, padding: 12, marginBottom: 12, border: "1px solid rgba(16,163,127,0.15)" }}>
                <div style={{ fontSize: 11, color: "#10a37f", marginBottom: 8, fontWeight: 600 }}>OpenAI TTS 設定</div>

                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>APIキー</div>
                <input
                  type="password"
                  value={oaiApiKey}
                  onChange={e => setOaiApiKey(e.target.value.trim())}
                  placeholder="sk-..."
                  style={{
                    width: "100%", background: "#12121c", border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8, color: "#ddd", padding: "8px 10px", fontSize: 12, marginBottom: 8,
                    boxSizing: "border-box",
                  }}
                />

                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>音声</div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 8 }}>
                  {[
                    ["nova", "Nova（女性・自然）"],
                    ["alloy", "Alloy（中性）"],
                    ["echo", "Echo（男性）"],
                    ["fable", "Fable（男性・語り）"],
                    ["onyx", "Onyx（男性・低音）"],
                    ["shimmer", "Shimmer（女性・明るい）"],
                  ].map(([id, label]) => (
                    <button key={id} onClick={() => setOaiVoice(id)} style={{
                      background: oaiVoice === id ? "rgba(16,163,127,0.15)" : "transparent",
                      color: oaiVoice === id ? "#34d399" : "#666",
                      border: oaiVoice === id ? "1px solid rgba(16,163,127,0.3)" : "1px solid rgba(255,255,255,0.04)",
                      borderRadius: 6, padding: "6px 10px", fontSize: 11, textAlign: "left",
                    }}>{label}</button>
                  ))}
                </div>

                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>モデル</div>
                <div style={{ display: "flex", gap: 3, marginBottom: 8 }}>
                  {[["tts-1", "標準（速い）"], ["tts-1-hd", "HD（高音質）"]].map(([id, label]) => (
                    <button key={id} onClick={() => setOaiModel(id)} style={{
                      background: oaiModel === id ? "rgba(16,163,127,0.15)" : "transparent",
                      color: oaiModel === id ? "#34d399" : "#666",
                      border: oaiModel === id ? "1px solid rgba(16,163,127,0.3)" : "1px solid rgba(255,255,255,0.04)",
                      borderRadius: 6, padding: "6px 10px", fontSize: 11,
                    }}>{label}</button>
                  ))}
                </div>

                {!oaiApiKey && (
                  <div style={{ fontSize: 11, color: "#e08080", marginTop: 4 }}>
                    APIキーを入力してください（platform.openai.com → API keys）
                  </div>
                )}

                <div style={{ fontSize: 10, color: "#555", marginTop: 6, lineHeight: 1.5 }}>
                  料金: 標準 $0.015/1K文字、HD $0.030/1K文字。日本語の音声品質が高くおすすめです。
                </div>
              </div>
            )}

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
                      ? <>✓ キー有効</>
                      : <>
                        ✓ キー有効（{elQuota.tier}）
                        — 残り <b>{elQuota.remaining.toLocaleString()}</b>文字
                        （{elQuota.used.toLocaleString()} / {elQuota.limit.toLocaleString()} 使用済み）
                        {elQuota.remaining <= 0 && <><br />⚠ 無料枠を使い切りました。来月リセットされます。</>}
                        {elQuota.remaining > 0 && elQuota.remaining <= 1000 && <><br />⚠ 残りわずかです。短いテキストで試してください</>}
                      </>
                    }
                  </div>
                )}
                {elQuota?.error === "ban" && (
                  <div style={{ fontSize: 11, color: "#e08080", padding: "6px 8px", borderRadius: 6, marginBottom: 8, background: "rgba(232,100,100,0.08)", lineHeight: 1.7 }}>
                    ⛔ ElevenLabs無料枠が停止されています<br />
                    <span style={{ color: "#c4b5fd" }}>対処法：有料プランにするか「ブラウザ内蔵」に切り替えてください</span>
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
                ブラウザ内蔵の日本語音声。音質は端末に依存します。
              </div>
            )}
            {ttsEngine === "edge" && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                Edge TTS。高品質な日本語AI音声を無料で利用できます。
              </div>
            )}
            {ttsEngine === "openai" && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                OpenAI TTS。高品質な日本語音声。速度変更は再生中にも可能です。
              </div>
            )}
            {ttsEngine === "elevenlabs" && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                ElevenLabsのAI音声を使用。速度変更は再生中にも可能です。
              </div>
            )}
          </div>
        )}

        {/* ========== INPUT ========== */}
        <div style={{ marginBottom: 20 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, marginBottom: 8, background: "#141420", borderRadius: 8, padding: 3, width: "fit-content" }}>
            {[["file", "📄 ファイル"], ["text", "✏️ テキスト"], ["url", "🌐 URL"]].map(([k, l]) => (
              <button key={k} onClick={() => setInputTab(k)} style={{
                background: inputTab === k ? "#222234" : "transparent",
                color: inputTab === k ? "#50dcb4" : "#555",
                border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12,
                fontWeight: inputTab === k ? 600 : 400,
              }}>{l}</button>
            ))}
          </div>

          {inputTab === "file" && (
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
          )}
          {inputTab === "text" && (
            <>
              <textarea value={inputText} onChange={e => setInputText(e.target.value)}
                placeholder="読みたいテキストをペースト..."
                style={{
                  width: "100%", minHeight: 80, background: "#12121c",
                  border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12,
                  color: "#ddd", padding: 14, fontSize: 13, lineHeight: 1.7, resize: "vertical",
                }}
              />
              {inputText.length > 0 && (
                <div style={{ fontSize: 10, color: inputText.length > SPLIT_THRESHOLD ? "#f0a040" : "#555", textAlign: "right", marginTop: 2 }}>
                  {inputText.length.toLocaleString()}字
                  {inputText.length > SPLIT_THRESHOLD && ` → ${Math.ceil(inputText.length / SPLIT_THRESHOLD)}パートに自動分割`}
                </div>
              )}
              <button onClick={addTextInput} disabled={!inputText.trim()}
                style={{ ...S.btn(inputText.trim() ? "#50dcb4" : "#1c1c28", inputText.trim() ? "#111" : "#444"), width: "100%", marginTop: 8 }}>
                🎙 キューに追加
              </button>
            </>
          )}
          {inputTab === "url" && (
            <>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="url"
                  value={inputUrl}
                  onChange={e => setInputUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && inputUrl.trim() && !urlLoading) addFromUrl(); }}
                  placeholder="https://example.com/article..."
                  style={{
                    flex: 1, background: "#12121c",
                    border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
                    color: "#ddd", padding: "10px 14px", fontSize: 13,
                  }}
                />
                <button
                  onClick={addFromUrl}
                  disabled={!inputUrl.trim() || urlLoading}
                  style={{
                    ...S.btn(inputUrl.trim() && !urlLoading ? "#50dcb4" : "#1c1c28", inputUrl.trim() && !urlLoading ? "#111" : "#444"),
                    padding: "10px 16px", whiteSpace: "nowrap", flexShrink: 0,
                  }}
                >{urlLoading ? "取得中..." : "🌐 取得"}</button>
              </div>
              <div style={{ fontSize: 10, color: "#555", marginTop: 6, lineHeight: 1.5 }}>
                ニュース記事やブログのURLを入力。本文を自動抽出してキューに追加します。英語等の記事は「訳」ボタンで日本語に翻訳できます。
              </div>
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
              <span style={{ fontSize: 12, color: "#666" }}>キュー {queue.length}件{queue.length > 0 && (() => {
                const totalChars = queue.reduce((sum, item) => sum + (item.charCount || 0), 0);
                const est = formatEstimatedTime(totalChars, rate);
                return est ? <span style={{ color: "#50dcb4", marginLeft: 6 }}>合計 {est}</span> : null;
              })()}</span>
              <button onClick={() => { handleStop(); setQueue([]); lsSet("session", null); }} style={S.smBtn("transparent", "#555")}>クリア</button>
            </div>

            {queue.map((item, i) => {
              const isActive = i === activeIdx;
              const estTime = formatEstimatedTime(item.charCount, rate);
              const itemLang = item.lang || "ja";
              const langColors = { en: "#f59e0b", zh: "#ef4444", ko: "#a78bfa", ja: "#60a5fa" };
              const langLabels = { en: "EN", zh: "ZH", ko: "KO", ja: "JA" };
              const canTranslate = itemLang !== "ja" && !item._translating;

              return (
                <div key={item.id} style={{
                  ...S.card, padding: "12px 14px", marginBottom: 8,
                  borderColor: isActive ? "rgba(80,220,180,0.25)" : undefined,
                  background: isActive ? "rgba(80,220,180,0.04)" : undefined,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Meta */}
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, color: "#444" }}>#{i + 1}</span>
                        <span style={{
                          fontSize: 8, fontWeight: 700, color: langColors[itemLang] || "#888",
                          background: `${langColors[itemLang] || "#888"}15`,
                          border: `1px solid ${langColors[itemLang] || "#888"}30`,
                          borderRadius: 3, padding: "1px 4px",
                        }}>{langLabels[itemLang] || itemLang.toUpperCase()}</span>
                        <span style={{ fontSize: 9, color: "#444" }}>{item.charCount.toLocaleString()}字</span>
                        {item.pageCount > 0 && <span style={{ fontSize: 9, color: "#555" }}>{item.pageCount}p</span>}
                        {estTime && (
                          <span style={{ fontSize: 9, color: "#50dcb4" }}>🕐 {estTime}</span>
                        )}
                        {item.sourceType === "translated" && (
                          <span style={{ fontSize: 8, color: "#10b981", background: "rgba(16,185,129,0.1)", borderRadius: 3, padding: "1px 4px" }}>翻訳済</span>
                        )}
                      </div>
                      {/* Title */}
                      <div style={{ fontSize: 14, color: "#ddd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.title}
                      </div>
                      {/* Preview */}
                      <div style={{ fontSize: 12, color: "#777", marginTop: 5, lineHeight: 1.6 }}>
                        {item.text.slice(0, 100)}{item.text.length > 100 ? "…" : ""}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                      {canTranslate && (
                        <button onClick={() => translateItem(i)} title="日本語に翻訳" style={{
                          width: 34, height: 34, borderRadius: 8,
                          background: "transparent", border: "1px solid rgba(245,158,11,0.3)",
                          color: "#f59e0b", fontSize: 11,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>訳</button>
                      )}
                      {item._translating && (
                        <span style={{
                          width: 34, height: 34, borderRadius: 8,
                          background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)",
                          color: "#f59e0b", fontSize: 9,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>...</span>
                      )}
                      <button onClick={() => handlePlay(i)} style={{
                        width: 34, height: 34, borderRadius: 8, border: "none",
                        background: isActive ? "#50dcb4" : "#242434",
                        color: isActive ? "#111" : "#ccc",
                        fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
                      }}>▶</button>
                      <button onClick={() => removeItem(i)} style={{
                        width: 34, height: 34, borderRadius: 8,
                        background: "transparent", border: "1px solid #2a2a38",
                        color: "#555", fontSize: 12,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>✕</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ========== RESUME BANNER ========== */}
        {savedSession && queue.length === 0 && (
          <div style={{
            ...S.card, padding: "16px 16px", marginBottom: 16,
            borderColor: "rgba(80,220,180,0.2)",
            background: "rgba(80,220,180,0.03)",
          }}>
            <div style={{ fontSize: 13, color: "#50dcb4", fontWeight: 600, marginBottom: 8 }}>
              前回の続きがあります
            </div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
              {savedSession.queue.length}件のキュー
              {(() => {
                const totalChars = savedSession.queue.reduce((sum, item) => sum + (item.charCount || 0), 0);
                const est = formatEstimatedTime(totalChars, rate);
                return est ? <span style={{ color: "#50dcb4" }}> · {est}</span> : null;
              })()}
              {savedSession.activeIdx >= 0 && savedSession.queue[savedSession.activeIdx] && (
                <> · 「{savedSession.queue[savedSession.activeIdx].title.slice(0, 25)}」
                  {savedSession.progress > 0 && <> ({savedSession.progress}%)</>}
                </>
              )}
            </div>
            <div style={{ fontSize: 10, color: "#555", marginBottom: 10 }}>
              {(() => {
                const diff = Date.now() - (savedSession.savedAt || 0);
                const mins = Math.floor(diff / 60000);
                if (mins < 1) return "たった今";
                if (mins < 60) return `${mins}分前`;
                const hours = Math.floor(mins / 60);
                if (hours < 24) return `${hours}時間前`;
                return `${Math.floor(hours / 24)}日前`;
              })()}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={handleResumeSession} style={{
                ...S.btn("#50dcb4", "#111"), padding: "10px 20px", fontSize: 13,
              }}>
                {savedSession.activeIdx >= 0 && savedSession.progress > 0 ? "続きから再生" : "キューを復元"}
              </button>
              <button onClick={handleDismissSession} style={{
                ...S.smBtn("transparent", "#555"),
                border: "1px solid rgba(255,255,255,0.06)",
              }}>破棄</button>
            </div>
          </div>
        )}

        {queue.length === 0 && !savedSession && (
          <div style={{ textAlign: "center", padding: "36px 16px" }}>
            <div style={{ fontSize: 32, opacity: 0.15, marginBottom: 8 }}>📻</div>
            <div style={{ fontSize: 13, color: "#444" }}>PDFをドロップ or テキスト貼り付け or デモ追加</div>
          </div>
        )}

        {/* ========== TRANSCRIPT HIGHLIGHT ========== */}
        {activeIdx >= 0 && sentences.length > 0 && (
          <div style={{ marginBottom: 20, marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "#555" }}>
                {showTranscript ? "読み上げテキスト" : ""}
              </span>
              <button
                onClick={() => setShowTranscript(!showTranscript)}
                style={{
                  background: "transparent", border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "#555", cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >{showTranscript ? "閉じる" : "字 テキスト表示"}</button>
            </div>
            {showTranscript && (
              <TextHighlight sentences={sentences} highlightIdx={highlightIdx} />
            )}
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
                <button onClick={() => setShowTranscript(!showTranscript)} title={showTranscript ? "テキスト非表示" : "テキスト表示"} style={{
                  width: 38, height: 38, borderRadius: "50%",
                  background: showTranscript ? "rgba(80,220,180,0.15)" : "#1a1a26",
                  color: showTranscript ? "#50dcb4" : "#555",
                  border: showTranscript ? "1px solid rgba(80,220,180,0.3)" : "1px solid #252535",
                  fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center",
                }}>字</button>
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

/* --- Text Highlight Component (karaoke-style) --- */
function TextHighlight({ sentences, highlightIdx }) {
  const scrollRef = useRef(null);
  const activeRef = useRef(null);

  useEffect(() => {
    if (activeRef.current && scrollRef.current) {
      const container = scrollRef.current;
      const el = activeRef.current;
      const elTop = el.offsetTop - container.offsetTop;
      const elH = el.offsetHeight;
      const scrollTop = container.scrollTop;
      const viewH = container.clientHeight;
      // Only scroll if element is outside the visible area (with padding)
      if (elTop < scrollTop + 20 || elTop + elH > scrollTop + viewH - 20) {
        container.scrollTo({ top: Math.max(0, elTop - viewH / 3), behavior: "smooth" });
      }
    }
  }, [highlightIdx]);

  if (!sentences.length) return null;

  return (
    <div ref={scrollRef} style={{
      maxHeight: 260, overflowY: "auto", padding: "14px 16px",
      background: "rgba(8,8,14,0.8)", borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.04)",
      lineHeight: 2.0, fontSize: 14,
      scrollbarWidth: "thin", scrollbarColor: "#333 transparent",
    }}>
      {sentences.map((s, i) => {
        const isCurrent = i === highlightIdx;
        const isPast = i < highlightIdx;
        return (
          <span key={i}>
            {i > 0 && " "}
            <span
              ref={isCurrent ? activeRef : null}
              style={{
                color: isCurrent ? "#fff" : isPast ? "#4a4a5a" : "#777",
                background: isCurrent ? "rgba(80,220,180,0.12)" : "transparent",
                borderRadius: isCurrent ? 4 : 0,
                padding: isCurrent ? "1px 3px" : "1px 0",
                transition: "color 0.3s, background 0.3s",
                borderBottom: isCurrent ? "2px solid rgba(80,220,180,0.4)" : "2px solid transparent",
              }}
            >{s}</span>
          </span>
        );
      })}
    </div>
  );
}

/* --- Estimated Reading Time --- */
const BASE_CHARS_PER_MIN = 370; // Japanese TTS ~370 chars/min at 1.0x

function formatEstimatedTime(charCount, rate) {
  if (!charCount || charCount <= 0) return null;
  const totalMin = Math.round(charCount / (BASE_CHARS_PER_MIN * rate));
  if (totalMin < 1) return "1分未満";
  if (totalMin < 60) return `約${totalMin}分`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `約${h}時間`;
  return `約${h}時間${m}分`;
}

/* --- Speed Chips Component --- */
function SpeedChips({ rate, onChange, compact }) {
  return (
    <div style={{ display: "flex", gap: compact ? 2 : 4, alignItems: "center" }}>
      {[0.8, 1.0, 1.15, 1.2, 1.25, 1.3, 1.5, 2.0].map(r => {
        const on = Math.abs(rate - r) < 0.01;
        return (
          <button key={r} onClick={() => onChange(r)} style={{
            background: on ? "#50dcb4" : "rgba(255,255,255,0.04)",
            color: on ? "#111" : "#666",
            border: on ? "none" : "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6, padding: compact ? "3px 5px" : "5px 8px",
            fontSize: compact ? 10 : 12, fontWeight: on ? 700 : 400,
            minWidth: compact ? 28 : 36, fontFamily: "monospace",
            outline: "none", cursor: "pointer",
          }}>{r}x</button>
        );
      })}
    </div>
  );
}

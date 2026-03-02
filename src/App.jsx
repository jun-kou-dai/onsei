import { useState, useRef, useEffect } from "react";
/* ================================================
   EarFlow v5 - Vite + Vercel edition
   Core principle: speak() is ALWAYS called
   synchronously from a click handler.
   No async, no setTimeout, no indirection.
   ================================================ */

// --- Client-side Edge TTS (direct WebSocket to Bing, no server proxy) ---
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_CHROMIUM = "143.0.3650.75";
const EDGE_GEC_VER = `1-${EDGE_CHROMIUM}`;

async function edgeComputeGEC() {
  const WIN_EPOCH = 116444736000000000n;
  const ticks = BigInt(Math.round(Date.now() / 1000)) * 10000000n + WIN_EPOCH;
  const FIVE_MIN = 3000000000n;
  const rounded = ticks - (ticks % FIVE_MIN);
  const input = `${rounded}${EDGE_TOKEN}`;
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function edgeDateString() {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function edgeEscapeSSML(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Client-side Edge TTS: returns a Promise<Blob> of audio/mpeg
// Connects directly from the user's browser → no cloud IP throttling
async function edgeTTSClient(text, voice, rate, timeoutMs = 20000) {
  const connId = crypto.randomUUID().replaceAll("-", "");
  const gec = await edgeComputeGEC();
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_GEC_VER}&ConnectionId=${connId}`;

  const ratePercent = Math.round(((rate || 1.0) - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
  const voiceName = voice || "ja-JP-NanamiNeural";
  const langMatch = voiceName.match(/^([a-z]{2}-[A-Z]{2})/);
  const xmlLang = langMatch ? langMatch[1] : "ja-JP";
  const ssmlBody = edgeEscapeSSML(text.slice(0, 5000));

  return new Promise((resolve, reject) => {
    const audioChunks = [];
    const ws = new WebSocket(wsUrl);
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; ws.close(); reject(new Error("timeout")); }
    }, timeoutMs);

    ws.onopen = () => {
      const ts = edgeDateString();
      const config = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat: "audio-24khz-96kbitrate-mono-mp3",
            },
          },
        },
      });
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`);
      ws.send(
        `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
        `<voice name='${voiceName}'><prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>` +
        `${ssmlBody}</prosody></voice></speak>`
      );
    };

    ws.onmessage = async (evt) => {
      if (done) return;
      if (typeof evt.data === "string") {
        if (evt.data.includes("turn.end")) {
          done = true; clearTimeout(timer); ws.close();
          if (audioChunks.length > 0) {
            resolve(new Blob(audioChunks, { type: "audio/mpeg" }));
          } else {
            reject(new Error("no audio"));
          }
        }
        return;
      }
      // Binary message — extract audio after "Path:audio\r\n"
      const buf = evt.data instanceof Blob ? await evt.data.arrayBuffer() : evt.data;
      const bytes = new Uint8Array(buf);
      const sep = new TextEncoder().encode("Path:audio\r\n");
      let idx = -1;
      outer: for (let i = 0; i <= bytes.length - sep.length; i++) {
        for (let j = 0; j < sep.length; j++) {
          if (bytes[i + j] !== sep[j]) continue outer;
        }
        idx = i + sep.length;
        break;
      }
      if (idx >= 0) {
        audioChunks.push(bytes.slice(idx));
      }
    };

    ws.onerror = () => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error("ws error")); }
    };
    ws.onclose = () => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error("ws closed")); }
    };
  });
}

// Client-side Edge TTS with streaming: calls onAudioChunk for each piece of audio data
// Returns a Promise that resolves when all audio is received
async function edgeTTSClientStream(text, voice, rate, onAudioChunk, timeoutMs = 25000) {
  const connId = crypto.randomUUID().replaceAll("-", "");
  const gec = await edgeComputeGEC();
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_GEC_VER}&ConnectionId=${connId}`;

  const ratePercent = Math.round(((rate || 1.0) - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
  const voiceName = voice || "ja-JP-NanamiNeural";
  const langMatch = voiceName.match(/^([a-z]{2}-[A-Z]{2})/);
  const xmlLang = langMatch ? langMatch[1] : "ja-JP";
  const ssmlBody = edgeEscapeSSML(text.slice(0, 5000));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    let hasAudio = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; ws.close(); reject(new Error("timeout")); }
    }, timeoutMs);

    ws.onopen = () => {
      const ts = edgeDateString();
      const config = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat: "audio-24khz-96kbitrate-mono-mp3",
            },
          },
        },
      });
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`);
      ws.send(
        `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
        `<voice name='${voiceName}'><prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>` +
        `${ssmlBody}</prosody></voice></speak>`
      );
    };

    ws.onmessage = async (evt) => {
      if (done) return;
      if (typeof evt.data === "string") {
        if (evt.data.includes("turn.end")) {
          done = true; clearTimeout(timer); ws.close();
          resolve(hasAudio);
        }
        return;
      }
      const buf = evt.data instanceof Blob ? await evt.data.arrayBuffer() : evt.data;
      const bytes = new Uint8Array(buf);
      const sep = new TextEncoder().encode("Path:audio\r\n");
      let idx = -1;
      outer: for (let i = 0; i <= bytes.length - sep.length; i++) {
        for (let j = 0; j < sep.length; j++) {
          if (bytes[i + j] !== sep[j]) continue outer;
        }
        idx = i + sep.length;
        break;
      }
      if (idx >= 0) {
        hasAudio = true;
        onAudioChunk(bytes.slice(idx));
      }
    };

    ws.onerror = () => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error("ws error")); }
    };
    ws.onclose = () => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error("ws closed")); }
    };
  });
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

  const [ttsEngine, setTtsEngineRaw] = useState(() => lsGet("ttsEngine", "edge"));

  // --- OpenAI TTS state ---
  const [oaiApiKey, setOaiApiKeyRaw] = useState(() => lsGet("oaiApiKey", ""));
  const [oaiVoice, setOaiVoiceRaw] = useState(() => lsGet("oaiVoice", "nova"));
  const [oaiModel, setOaiModelRaw] = useState(() => lsGet("oaiModel", "tts-1"));

  // --- Gemini TTS state ---
  const [gemApiKey, setGemApiKeyRaw] = useState(() => lsGet("gemApiKey", ""));
  const [gemVoice, setGemVoiceRaw] = useState(() => lsGet("gemVoice", "Kore"));

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
  const setRate = (v) => { setRateRaw(v); lsSet("rate", v); };
  const setOaiApiKey = (v) => { setOaiApiKeyRaw(v); lsSet("oaiApiKey", v); };
  const setOaiVoice = (v) => { setOaiVoiceRaw(v); lsSet("oaiVoice", v); };
  const setOaiModel = (v) => { setOaiModelRaw(v); lsSet("oaiModel", v); };
  const setGemApiKey = (v) => { setGemApiKeyRaw(v); lsSet("gemApiKey", v); };
  const setGemVoice = (v) => { setGemVoiceRaw(v); lsSet("gemVoice", v); };
  const setShowTranscript = (v) => { setShowTranscriptRaw(v); lsSet("showTranscript", v); };
  const edgeVoiceRef = useRef(edgeVoice);
  const setEdgeVoice = (v) => {
    setEdgeVoiceRaw(v); lsSet("edgeVoice", v);
    edgeVoiceRef.current = v;
    audioCacheRef.current.clear(); // clear preload cache when voice changes
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

  // --- OpenAI TTS (streaming via MediaSource for instant playback) ---
  const openaiSpeak = async (text, rateVal) => {
    if (!oaiApiKey) { flash("⚠ OpenAI APIキーが設定されていません。設定から入力してください"); setSpeaking(false); return; }

    const myPlayId = ++playIdRef.current;
    currentRateRef.current = rateVal ?? 1.0;
    generatedRateRef.current = 1.0; // OpenAI TTS generates at 1x; speed is purely via playbackRate

    try {
      setSpeaking(true);

      // Helper: set up audio event handlers for OpenAI TTS
      const setupOaiAudio = (audio, urlToRevoke) => {
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
          URL.revokeObjectURL(urlToRevoke);
          const nextIdx = activeIdxRef.current + 1;
          const q = queueRef.current;
          if (nextIdx < q.length && q[nextIdx]?.status === "ready") {
            setActiveIdx(nextIdx); activeIdxRef.current = nextIdx;
            setupSentences(q[nextIdx].text);
            // Preload the one after next
            if (nextIdx + 1 < q.length && q[nextIdx + 1]?.status === "ready")
              preloadOpenaiAudio(q[nextIdx + 1].id, q[nextIdx + 1].text);
            const nextText = q[nextIdx].text;
            if (nextText) openaiSpeak(nextText, currentRateRef.current);
          } else {
            setActiveIdx(-1); activeIdxRef.current = -1;
            resetHighlight();
          }
        };
        audio.onerror = () => {
          setSpeaking(false); flash("⚠ 音声再生エラー");
          URL.revokeObjectURL(urlToRevoke);
        };
        audio.ontimeupdate = () => {
          if (audio.duration > 0) {
            setProgress(Math.round((audio.currentTime / audio.duration) * 100));
            updateHighlightFromAudio(audio.currentTime, audio.duration);
          }
        };
      };

      // 1. Check preload cache — instant playback
      const activeItem = queueRef.current[activeIdxRef.current];
      const cacheKey = activeItem ? `oai_${activeItem.id}_${oaiVoice}_${oaiModel}` : null;
      const cached = cacheKey ? audioCacheRef.current.get(cacheKey) : null;

      if (cached) {
        audioCacheRef.current.delete(cacheKey);
        const url = URL.createObjectURL(cached);
        if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.playbackRate = rateVal ?? 1.0;
        audio.volume = 1.0;
        setupOaiAudio(audio, url);
        audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
        return;
      }

      flash("音声生成中...");

      // OpenAI TTS has 4096 char limit — chunk at sentence boundaries
      const chunks = splitTextSmart(text, 4096);

      // 2. Streaming playback via MediaSource (like Edge TTS) ---
      if (window.MediaSource && MediaSource.isTypeSupported("audio/mpeg")) {
        const ms = new MediaSource();
        const msUrl = URL.createObjectURL(ms);
        if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
        const audio = new Audio();
        audioRef.current = audio;
        audio.src = msUrl;
        audio.playbackRate = rateVal ?? 1.0;
        audio.volume = 1.0;
        setupOaiAudio(audio, msUrl);

        let started = false;
        let totalBytes = 0;

        await new Promise((resolve, reject) => {
          ms.addEventListener("sourceopen", async () => {
            try {
              const sb = ms.addSourceBuffer("audio/mpeg");

              for (const chunk of chunks) {
                if (playIdRef.current !== myPlayId) { resolve(); return; }

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
                  reject(new Error("network"));
                  return;
                }

                if (playIdRef.current !== myPlayId) { resolve(); return; }

                if (!res.ok) {
                  const errBody = await res.text().catch(() => "");
                  let msg = "";
                  try {
                    const parsed = JSON.parse(errBody);
                    msg = parsed?.detail?.error?.message || parsed?.error || errBody.slice(0, 150);
                  } catch { msg = errBody.slice(0, 150); }

                  if (res.status === 401) {
                    reject(new Error("auth"));
                  } else if (res.status === 429) {
                    reject(new Error("ratelimit"));
                  } else {
                    reject(new Error(msg));
                  }
                  return;
                }

                // Stream the response body into the SourceBuffer
                const reader = res.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (playIdRef.current !== myPlayId) { resolve(); return; }

                  totalBytes += value.byteLength;

                  // Append chunk to SourceBuffer
                  await new Promise((appendResolve) => {
                    const doAppend = () => {
                      if (sb.updating) {
                        sb.addEventListener("updateend", doAppend, { once: true });
                        return;
                      }
                      sb.appendBuffer(value);
                      sb.addEventListener("updateend", appendResolve, { once: true });
                    };
                    doAppend();
                  });

                  // Start playback as soon as first data arrives
                  if (!started) {
                    started = true;
                    audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
                  }
                }
              }

              // All chunks done — finalize
              if (sb.updating)
                await new Promise(r => sb.addEventListener("updateend", r, { once: true }));
              if (ms.readyState === "open") ms.endOfStream();
            } catch (err) {
              try { if (ms.readyState === "open") ms.endOfStream(); } catch {}
              reject(err);
              return;
            }
            resolve();
          });
        });

        if (totalBytes < 100 && !started) {
          flash("⚠ 音声データが空です");
          setSpeaking(false);
          URL.revokeObjectURL(msUrl);
        }
        return;
      }

      // --- Fallback: no MediaSource support — collect all blobs then play ---
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

      const combined = new Blob(blobs, { type: "audio/mpeg" });
      if (combined.size < 100) {
        flash("⚠ 音声データが空です");
        setSpeaking(false);
        return;
      }

      const url = URL.createObjectURL(combined);
      if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.playbackRate = rateVal ?? 1.0;
      audio.volume = 1.0;
      setupOaiAudio(audio, url);
      audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
    } catch (e) {
      if (e.message === "network") {
        flash("⚠ ネットワークエラー: サーバーに接続できません");
      } else if (e.message === "auth") {
        flash("⚠ OpenAI APIキーが無効です。キーを確認してください");
      } else if (e.message === "ratelimit") {
        flash("⚠ レート制限。少し待ってから再試行してください");
      } else {
        flash("⚠ " + e.message);
      }
      setSpeaking(false);
    }
  };

  // --- Gemini TTS (client-side direct API call, based on nano-storybook-v13) ---
  // PCM (base64) → WAV Blob conversion (client-side, proven working)
  const createWavFromPcm = (pcmBase64) => {
    const binaryString = atob(pcmBase64);
    const pcmData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      pcmData[i] = binaryString.charCodeAt(i);
    }
    const pcmLength = pcmData.length;
    const wavBuffer = new ArrayBuffer(44 + pcmLength);
    const view = new DataView(wavBuffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + pcmLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);   // PCM
    view.setUint16(22, 1, true);   // mono
    view.setUint32(24, 24000, true); // sample rate
    view.setUint32(28, 48000, true); // byte rate
    view.setUint16(32, 2, true);   // block align
    view.setUint16(34, 16, true);  // bits per sample
    writeString(36, 'data');
    view.setUint32(40, pcmLength, true);
    const wavUint8 = new Uint8Array(wavBuffer);
    wavUint8.set(pcmData, 44);
    return new Blob([wavBuffer], { type: 'audio/wav' });
  };

  // Convert TTS result to audio Blob (handles multiple mimeTypes)
  const ttsResultToBlob = (data, mimeType) => {
    if (mimeType.startsWith('audio/wav') || mimeType.startsWith('audio/mpeg') ||
        mimeType.startsWith('audio/mp3') || mimeType.startsWith('audio/ogg')) {
      const binaryString = atob(data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      return new Blob([bytes], { type: mimeType.split(';')[0] });
    }
    return createWavFromPcm(data);
  };

  // Gemini TTS: fetch audio for a single text chunk
  const geminiTTSFetch = async (chunkText, apiKey, voice) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: chunkText }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } }
            }
          }
        }),
      }
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody.error?.message || `HTTP ${res.status}`;
      if (res.status === 400 && /api.?key/i.test(msg)) throw new Error("auth");
      if (res.status === 429) throw new Error("ratelimit");
      throw new Error(`API ${res.status}: ${msg}`);
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        const mimeType = part.inlineData.mimeType || 'audio/L16;rate=24000';
        return ttsResultToBlob(part.inlineData.data, mimeType);
      }
    }
    throw new Error("APIレスポンスに音声データがありません");
  };

  const geminiSpeak = async (text, rateVal) => {
    if (!gemApiKey) { flash("⚠ Gemini APIキーが設定されていません。設定から入力してください"); setSpeaking(false); return; }
    const myPlayId = ++playIdRef.current;
    currentRateRef.current = rateVal ?? 1.0;
    generatedRateRef.current = 1.0;
    setSpeaking(true);

    // Check preload cache first — instant playback if available
    const activeItem = queueRef.current[activeIdxRef.current];
    const cacheKey = activeItem ? `gem_${activeItem.id}_${gemVoice}` : null;
    const cached = cacheKey ? audioCacheRef.current.get(cacheKey) : null;

    if (cached) {
      audioCacheRef.current.delete(cacheKey);
      flash("");
      const url = URL.createObjectURL(cached);
      if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.playbackRate = rateVal ?? 1.0;
      audio.volume = 1.0;
      audio.onplay = () => { setSpeaking(true); setPaused(false); flash(""); };
      audio.onended = () => {
        setSpeaking(false); setPaused(false); setProgress(100); stopProgress();
        URL.revokeObjectURL(url);
        const nextIdx = activeIdxRef.current + 1;
        const q = queueRef.current;
        if (nextIdx < q.length && q[nextIdx]?.status === "ready") {
          setActiveIdx(nextIdx); activeIdxRef.current = nextIdx;
          setupSentences(q[nextIdx].text);
          geminiSpeak(q[nextIdx].text, currentRateRef.current);
        } else { setActiveIdx(-1); activeIdxRef.current = -1; resetHighlight(); }
      };
      audio.onerror = () => { setSpeaking(false); flash("⚠ 音声再生エラー"); URL.revokeObjectURL(url); };
      audio.ontimeupdate = () => {
        if (audio.duration > 0) { setProgress(Math.round((audio.currentTime / audio.duration) * 100)); updateHighlightFromAudio(audio.currentTime, audio.duration); }
      };
      audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
      return;
    }

    flash("音声生成中...");

    try {
      // Split text into ~300 char chunks for faster first-chunk playback
      const chunks = splitTextSmart(text, 300);
      const blobQueue = []; // pre-fetched audio blobs
      let chunkIdx = 0;

      // Helper: play a blob and chain to next
      const playBlob = (blob) => {
        if (playIdRef.current !== myPlayId) return;
        const url = URL.createObjectURL(blob);
        if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.playbackRate = rateVal ?? 1.0;
        audio.volume = 1.0;

        audio.onplay = () => { setSpeaking(true); setPaused(false); flash(""); };
        audio.onended = () => {
          URL.revokeObjectURL(url);
          chunkIdx++;
          if (playIdRef.current !== myPlayId) return;
          if (chunkIdx < chunks.length) {
            // Play next chunk
            if (blobQueue[chunkIdx]) {
              playBlob(blobQueue[chunkIdx]);
            } else {
              // Next chunk not ready yet — fetch and play
              flash("音声生成中...");
              geminiTTSFetch(chunks[chunkIdx], gemApiKey, gemVoice).then(b => {
                if (playIdRef.current === myPlayId) playBlob(b);
              }).catch(() => { setSpeaking(false); flash("⚠ 音声生成エラー"); });
            }
          } else {
            // All chunks done — move to next queue item
            setSpeaking(false); setPaused(false); setProgress(100); stopProgress();
            const nextIdx = activeIdxRef.current + 1;
            const q = queueRef.current;
            if (nextIdx < q.length && q[nextIdx]?.status === "ready") {
              setActiveIdx(nextIdx); activeIdxRef.current = nextIdx;
              setupSentences(q[nextIdx].text);
              geminiSpeak(q[nextIdx].text, currentRateRef.current);
            } else {
              setActiveIdx(-1); activeIdxRef.current = -1; resetHighlight();
            }
          }
        };
        audio.onerror = () => { setSpeaking(false); flash("⚠ 音声再生エラー"); URL.revokeObjectURL(url); };
        audio.ontimeupdate = () => {
          if (audio.duration > 0) {
            // Calculate overall progress across all chunks
            const chunkProgress = audio.currentTime / audio.duration;
            const overall = ((chunkIdx + chunkProgress) / chunks.length) * 100;
            setProgress(Math.round(overall));
            // Calculate character position for highlight (across all chunks)
            const prevChars = chunks.slice(0, chunkIdx).reduce((s, c) => s + c.length, 0);
            const curChunkChars = chunks[chunkIdx].length;
            const charPos = prevChars + chunkProgress * curChunkChars;
            updateHighlightFromCharPos(charPos);
          }
        };
        audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
      };

      // Fetch first chunk (blocking — user waits for this)
      const firstBlob = await geminiTTSFetch(chunks[0], gemApiKey, gemVoice);
      if (playIdRef.current !== myPlayId) return;
      blobQueue[0] = firstBlob;

      // Start playing first chunk immediately
      playBlob(firstBlob);

      // Prefetch remaining chunks in background
      for (let i = 1; i < chunks.length; i++) {
        if (playIdRef.current !== myPlayId) break;
        geminiTTSFetch(chunks[i], gemApiKey, gemVoice).then(b => {
          blobQueue[i] = b;
        }).catch(() => {}); // errors handled at play time
      }

    } catch (e) {
      if (playIdRef.current !== myPlayId) return;
      if (e.message === "auth") flash("⚠ Gemini APIキーが無効です。キーを確認してください");
      else if (e.message === "ratelimit") flash("⚠ レート制限中です。少し待ってから再試行してください");
      else flash("⚠ " + e.message);
      setSpeaking(false);
    }
  };

  // --- Gemini TTS audio preloader (background) ---
  const preloadGeminiAudio = (itemId, text) => {
    if (!gemApiKey) return;
    const key = `gem_${itemId}_${gemVoice}`;
    if (audioCacheRef.current.has(key)) return;
    geminiTTSFetch(text, gemApiKey, gemVoice).then(blob => {
      if (blob && blob.size >= 100) cacheSet(key, blob);
    }).catch(() => {});
  };

  // --- Edge TTS audio preloader (background, server API) ---
  const preloadEdgeAudio = (itemId, text) => {
    const v = edgeVoiceRef.current;
    const r = currentRateRef.current || 1.0;
    const key = `${itemId}_${v}_${r}`;
    if (audioCacheRef.current.has(key)) return;
    (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch("/api/edge-tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice: v, rate: r }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return;
        const blob = await res.blob();
        if (blob && blob.size >= 100) cacheSet(key, blob);
      } catch {}
    })();
  };

  // --- OpenAI TTS audio preloader (background fetch) ---
  const preloadOpenaiAudio = (itemId, text) => {
    if (!oaiApiKey) return;
    const key = `oai_${itemId}_${oaiVoice}_${oaiModel}`;
    if (audioCacheRef.current.has(key)) return;
    const chunks = splitTextSmart(text, 4096);
    (async () => {
      try {
        const blobs = [];
        for (const chunk of chunks) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 55000);
          const res = await fetch("/api/openai-tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: oaiApiKey, text: chunk, voice: oaiVoice, model: oaiModel }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!res.ok) return;
          blobs.push(await res.blob());
        }
        const combined = new Blob(blobs, { type: "audio/mpeg" });
        if (combined.size >= 100) cacheSet(key, combined);
      } catch {}
    })();
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

      // 2. No cache — fetch from server API (browser WebSocket blocked by Microsoft)
      flash("音声生成中...");

      // Helper: fallback to browser TTS
      const fallbackToBrowser = (reason) => {
        flash(`⚠ Edge TTS ${reason} → ブラウザ音声に切替`);
        stoppedRef.current = false;
        chunksRef.current = splitText(text);
        totalCharsRef.current = text.length;
        spokenCharsRef.current = 0;
        speakChunk(0, rateVal);
      };

      try {
        const edgeCtrl = new AbortController();
        const edgeTimer = setTimeout(() => edgeCtrl.abort(), 30000);
        const res = await fetch("/api/edge-tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice, rate: rateVal ?? 1.0 }),
          signal: edgeCtrl.signal,
        });
        clearTimeout(edgeTimer);

        if (playIdRef.current !== myPlayId) return;

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          let msg = "";
          try { msg = JSON.parse(errBody)?.error || errBody.slice(0, 100); } catch { msg = errBody.slice(0, 100); }
          fallbackToBrowser(msg || "サーバーエラー");
          return;
        }

        const blob = await res.blob();
        if (playIdRef.current !== myPlayId) return;
        if (blob.size < 100) { fallbackToBrowser("音声データなし"); return; }

        const url = URL.createObjectURL(blob);
        if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.ontimeupdate = null; audioRef.current.pause(); audioRef.current.src = ""; }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.playbackRate = 1.0;
        audio.volume = 1.0;
        setupEdgeAudio(audio, url, rateVal);
        audio.play().catch(e => { flash("⚠ 再生失敗: " + e.message); setSpeaking(false); });
      } catch (err) {
        if (playIdRef.current !== myPlayId) return;
        if (err.name === "AbortError") fallbackToBrowser("タイムアウト");
        else fallbackToBrowser(err.message);
      }
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

    playIdRef.current++;
    seekAfterLoadRef.current = 0;

    // Browser TTS
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
      // Auto-play next queue item
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
        // Preload next item while current plays
        const nextIdx = index + 1;
        const q = queueRef.current;
        if (nextIdx < q.length && q[nextIdx]?.status === "ready")
          preloadOpenaiAudio(q[nextIdx].id, q[nextIdx].text);
        openaiSpeak(fullText, rate);
      } else if (ttsEngine === "gemini") {
        // Preload next item while current plays
        const nextIdx = index + 1;
        const q = queueRef.current;
        if (nextIdx < q.length && q[nextIdx]?.status === "ready")
          preloadGeminiAudio(q[nextIdx].id, q[nextIdx].text);
        geminiSpeak(fullText, rate);
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
      else if (ttsEngine === "openai" && items[0]) preloadOpenaiAudio(items[0].id, items[0].text);
      else if (ttsEngine === "gemini" && items[0]) preloadGeminiAudio(items[0].id, items[0].text);
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
    else if (ttsEngine === "openai") preloadOpenaiAudio(id, text);
    else if (ttsEngine === "gemini") preloadGeminiAudio(id, text);
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
        const raw = data.error || data.detail?.error?.message || "";
        let msg = "翻訳に失敗しました";
        if (res.status === 401 || /invalid.*key|auth/i.test(raw)) msg = "APIキーが無効です。設定を確認してください";
        else if (res.status === 429 || /rate.?limit|quota/i.test(raw)) msg = "レート制限中です。少し待ってから再試行してください";
        else if (res.status === 504 || /timeout/i.test(raw)) msg = "タイムアウト。テキストが長すぎる可能性があります";
        else if (raw) msg = raw.slice(0, 100);
        flash("⚠ " + msg);
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
        const raw = data.error || "";
        let urlMsg = "記事の取得に失敗しました";
        if (/extract|meaningful/i.test(raw)) urlMsg = "このサイトからテキストを抽出できません。手動コピーをお試しください";
        else if (/block|forbidden|403/i.test(raw)) urlMsg = "このサイトはアクセスをブロックしています。手動コピーをお試しください";
        else if (raw) urlMsg = raw.slice(0, 100);
        flash("⚠ " + urlMsg);
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
      if (e.name === "AbortError") flash("⚠ タイムアウト。URLが応答しないか、ページが大きすぎます");
      else flash("⚠ ネットワークエラー。インターネット接続を確認してください");
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
              <div style={{ fontSize: 9, color: "#555" }}>
                目が塞がっていても、脳は空いている。
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
              {[["edge", "Edge（推奨・無料）", "#0078d4"], ["gemini", "Gemini", "#4285f4"], ["openai", "OpenAI", "#10a37f"], ["browser", "ブラウザ内蔵", "#50dcb4"]].map(([k, l, clr]) => (
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

            {/* Gemini settings */}
            {ttsEngine === "gemini" && (
              <div style={{ background: "rgba(66,133,244,0.05)", borderRadius: 10, padding: 12, marginBottom: 12, border: "1px solid rgba(66,133,244,0.15)" }}>
                <div style={{ fontSize: 11, color: "#4285f4", marginBottom: 8, fontWeight: 600 }}>Gemini TTS 設定</div>

                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>APIキー</div>
                <input
                  type="password"
                  value={gemApiKey}
                  onChange={e => setGemApiKey(e.target.value.trim())}
                  placeholder="AIza..."
                  style={{
                    width: "100%", background: "#12121c", border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8, color: "#ddd", padding: "8px 10px", fontSize: 12, marginBottom: 8,
                    boxSizing: "border-box",
                  }}
                />

                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>音声</div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 8 }}>
                  {[
                    ["Kore", "Kore（女性・落ち着いた）"],
                    ["Puck", "Puck（男性・明るい）"],
                    ["Charon", "Charon（男性・クリア）"],
                    ["Fenrir", "Fenrir（男性・ダイナミック）"],
                    ["Aoede", "Aoede（女性・自然）"],
                    ["Leda", "Leda（女性・柔らか）"],
                    ["Orus", "Orus（男性・低音）"],
                    ["Zephyr", "Zephyr（中性）"],
                  ].map(([id, label]) => (
                    <button key={id} onClick={() => setGemVoice(id)} style={{
                      background: gemVoice === id ? "rgba(66,133,244,0.15)" : "transparent",
                      color: gemVoice === id ? "#60a5fa" : "#666",
                      border: gemVoice === id ? "1px solid rgba(66,133,244,0.3)" : "1px solid rgba(255,255,255,0.04)",
                      borderRadius: 6, padding: "6px 10px", fontSize: 11, textAlign: "left",
                    }}>{label}</button>
                  ))}
                </div>

                <div style={{ fontSize: 10, color: "#555", lineHeight: 1.5 }}>
                  Google AI StudioのAPIキーで利用できます。高品質なAI音声。
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
            {ttsEngine === "gemini" && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                Gemini TTS。Googleの高品質AI音声。多言語対応。
              </div>
            )}
            {ttsEngine === "openai" && (
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                OpenAI TTS。高品質な日本語音声。速度変更は再生中にも可能です。
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
                const totalMin = queue.reduce((sum, item) => {
                  const base = CHARS_PER_MIN[item.lang] || CHARS_PER_MIN.ja;
                  return sum + (item.charCount || 0) / (base * rate);
                }, 0);
                const rounded = Math.round(totalMin);
                if (rounded < 1) return <span style={{ color: "#50dcb4", marginLeft: 6 }}>合計 1分未満</span>;
                if (rounded < 60) return <span style={{ color: "#50dcb4", marginLeft: 6 }}>合計 約{rounded}分</span>;
                const h = Math.floor(rounded / 60); const m = rounded % 60;
                return <span style={{ color: "#50dcb4", marginLeft: 6 }}>合計 約{h}時間{m > 0 ? `${m}分` : ""}</span>;
              })()}</span>
              <button onClick={() => { if (queue.length <= 1 || window.confirm(`${queue.length}件のアイテムをすべて削除しますか？`)) { handleStop(); setQueue([]); lsSet("session", null); } }} style={S.smBtn("transparent", "#555")}>クリア</button>
            </div>

            {queue.map((item, i) => {
              const isActive = i === activeIdx;
              const estTime = formatEstimatedTime(item.charCount, rate, item.lang);
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
                      <div title={item.title} style={{ fontSize: 14, color: "#ddd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
                        <button onClick={() => oaiApiKey ? translateItem(i) : flash("⚠ 翻訳にはOpenAI APIキーが必要です。⚙設定から入力してください")} title={oaiApiKey ? "日本語に翻訳" : "翻訳にはOpenAI APIキーが必要です"} style={{
                          width: 34, height: 34, borderRadius: 8,
                          background: "transparent", border: `1px solid ${oaiApiKey ? "rgba(245,158,11,0.3)" : "rgba(100,100,100,0.3)"}`,
                          color: oaiApiKey ? "#f59e0b" : "#555", fontSize: 11,
                          opacity: oaiApiKey ? 1 : 0.5, cursor: oaiApiKey ? "pointer" : "default",
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
                const totalMin = savedSession.queue.reduce((sum, item) => {
                  const base = CHARS_PER_MIN[item.lang] || CHARS_PER_MIN.ja;
                  return sum + (item.charCount || 0) / (base * rate);
                }, 0);
                const rounded = Math.round(totalMin);
                if (rounded < 1) return <span style={{ color: "#50dcb4" }}> · 1分未満</span>;
                if (rounded < 60) return <span style={{ color: "#50dcb4" }}> · 約{rounded}分</span>;
                const h = Math.floor(rounded / 60); const m = rounded % 60;
                return <span style={{ color: "#50dcb4" }}> · 約{h}時間{m > 0 ? `${m}分` : ""}</span>;
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
              <div style={{ height: "100%", width: `${progress}%`, background: paused ? "#555" : "linear-gradient(90deg, #50dcb4, #7ec8e8)", borderRadius: 2, transition: "width 0.5s" }} />
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
                <div style={{ fontSize: 10, color: "#555" }}>
                  {paused ? "一時停止" : "再生中"} · {rate}x{ttsEngine === "gemini" ? " · Gemini" : ""}
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
const CHARS_PER_MIN = { ja: 370, zh: 300, ko: 320, en: 200 };

function formatEstimatedTime(charCount, rate, lang) {
  if (!charCount || charCount <= 0) return null;
  const base = CHARS_PER_MIN[lang] || CHARS_PER_MIN.ja;
  const totalMin = Math.round(charCount / (base * rate));
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

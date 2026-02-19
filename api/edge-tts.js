import { createHash, randomUUID, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import WebSocket from "ws";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const MAX_CHUNK_BYTES = 4096;

// Generate Sec-MS-GEC token (matches Python edge-tts v7.2.7 DRM logic)
function computeGEC() {
  const WIN_EPOCH = 116444736000000000n;
  const ticks = BigInt(Math.round(Date.now() / 1000)) * 10000000n + WIN_EPOCH;
  const FIVE_MIN = 3000000000n; // 5 minutes in 100-nanosecond intervals
  const rounded = ticks - (ticks % FIVE_MIN);
  const input = `${rounded}${TRUSTED_CLIENT_TOKEN}`;
  return createHash("sha256").update(input, "ascii").digest("hex").toUpperCase();
}

// Generate random MUID (matches Python edge-tts: secrets.token_hex(16).upper())
function generateMUID() {
  return randomBytes(16).toString("hex").toUpperCase();
}

// JavaScript-style date string (matches Python edge-tts date_to_string())
function dateToString() {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

// Escape text for embedding in SSML (XML entity escaping)
function escapeSSML(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Split text into chunks of at most MAX_CHUNK_BYTES (UTF-8 bytes of XML-escaped text)
// Matches Python edge-tts split_text_by_byte_length logic
function splitTextByByteLength(text, maxBytes) {
  const escaped = escapeSSML(text);
  const chunks = [];
  let remaining = escaped;

  while (remaining.length > 0) {
    const buf = Buffer.from(remaining, "utf8");
    if (buf.length <= maxBytes) {
      const trimmed = remaining.trim();
      if (trimmed) chunks.push(trimmed);
      break;
    }

    // Find a safe split point within maxBytes
    let splitIdx = maxBytes;
    // Walk back to avoid splitting a multi-byte UTF-8 character
    while (splitIdx > 0 && (buf[splitIdx] & 0xC0) === 0x80) {
      splitIdx--;
    }

    // Decode the chunk to get the character count
    const chunkStr = buf.subarray(0, splitIdx).toString("utf8");
    const charLen = chunkStr.length;

    // Try to split at last newline or space within this range
    let splitCharIdx = charLen;
    const lastNewline = chunkStr.lastIndexOf("\n");
    if (lastNewline > 0) {
      splitCharIdx = lastNewline + 1;
    } else {
      const lastSpace = chunkStr.lastIndexOf(" ");
      if (lastSpace > 0) {
        splitCharIdx = lastSpace + 1;
      }
    }

    // Avoid splitting inside XML entities (e.g., &amp;)
    const chunk = chunkStr.slice(0, splitCharIdx);
    const lastAmp = chunk.lastIndexOf("&");
    if (lastAmp >= 0) {
      const afterAmp = chunk.slice(lastAmp);
      if (!afterAmp.includes(";")) {
        splitCharIdx = lastAmp;
      }
    }

    const finalChunk = chunkStr.slice(0, splitCharIdx).trim();
    if (finalChunk) chunks.push(finalChunk);
    remaining = remaining.slice(splitCharIdx).trim();
  }

  return chunks.length > 0 ? chunks : [escaped];
}

// Streaming handler: pipes WebSocket audio chunks directly to HTTP response
export default async function handler(req, res) {
  const t0 = Date.now();

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

  // Split into 4096-byte chunks (XML-escaped UTF-8)
  const chunks = splitTextByByteLength(trimmed, MAX_CHUNK_BYTES);

  const muid = generateMUID();
  let headersSent = false;
  let finished = false;
  const timing = { wsConnect: 0, firstAudio: 0, done: 0 };

  const finish = (errMsg) => {
    if (finished) return;
    finished = true;
    timing.done = Date.now() - t0;
    clearTimeout(timer);
    if (!headersSent) {
      res.status(500).json({
        error: errMsg || "No audio generated",
        timing_ms: timing,
      });
    } else {
      try { res.end(); } catch {}
    }
  };

  const timer = setTimeout(() => finish("TTS timeout (30s)"), 30000);
  req.on("close", () => { finished = true; clearTimeout(timer); });

  // Process chunks sequentially (each chunk gets its own WebSocket connection, matching Python edge-tts)
  for (let i = 0; i < chunks.length; i++) {
    if (finished) break;

    const chunk = chunks[i];
    const connId = randomUUID().replaceAll("-", "");
    const gec = computeGEC();
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

    try {
      await new Promise((resolve, reject) => {
        if (finished) { resolve(); return; }

        const ws = new WebSocket(wsUrl, {
          host: "speech.platform.bing.com",
          origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          headers: {
            "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "en-US,en;q=0.9",
            "Pragma": "no-cache",
            "Cache-Control": "no-cache",
            "Cookie": `muid=${muid};`,
          },
          perMessageDeflate: {
            zlibDeflateOptions: { windowBits: 15 },
            zlibInflateOptions: { windowBits: 15 },
          },
        });

        const chunkTimer = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error("Chunk timeout (25s)"));
        }, 25000);

        ws.on("open", () => {
          if (i === 0) timing.wsConnect = Date.now() - t0;

          const ts = dateToString();

          // Speech config
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

          // SSML request (note: trailing Z on timestamp, matching Edge bug per Python edge-tts)
          ws.send(
            `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
            `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
            `<voice name='${voiceName}'><prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>` +
            `${chunk}</prosody></voice></speak>`
          );
        });

        ws.on("message", (rawData, isBinary) => {
          if (!isBinary) {
            if (rawData.toString("utf8").includes("turn.end")) {
              clearTimeout(chunkTimer);
              try { ws.close(); } catch {}
              resolve();
            }
            return;
          }
          const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
          const sep = "Path:audio\r\n";
          const idx = data.indexOf(sep);
          if (idx >= 0) {
            const audioData = data.subarray(idx + sep.length);
            if (!headersSent) {
              timing.firstAudio = Date.now() - t0;
              res.writeHead(200, {
                "Content-Type": "audio/mpeg",
                "X-Timing-WsConnect": `${timing.wsConnect}ms`,
                "X-Timing-FirstAudio": `${timing.firstAudio}ms`,
              });
              headersSent = true;
            }
            res.write(audioData);
          }
        });

        ws.on("error", (err) => {
          clearTimeout(chunkTimer);
          reject(err);
        });

        ws.on("close", (code) => {
          clearTimeout(chunkTimer);
          resolve();
        });
      });
    } catch (err) {
      if (!finished) finish(err.message);
      return;
    }
  }

  if (!finished) finish();
}

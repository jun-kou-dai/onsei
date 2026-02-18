import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import WebSocket from "ws";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION = "1-130.0.2849.68";

// Compute Sec-MS-GEC security token (required since late 2024)
function computeGEC() {
  // Windows FILETIME: 100-nanosecond intervals since 1601-01-01
  const EPOCH_DIFF = 621355968000000000n; // diff between 1601 and 1970 in 100ns
  const ticks = BigInt(Math.round(Date.now() * 10000)) + EPOCH_DIFF;
  const FIVE_MIN = 3000000000n; // 5 minutes in 100ns ticks
  const rounded = ticks - (ticks % FIVE_MIN);
  const input = `${rounded}${TOKEN}`;
  return createHash("sha256").update(input, "utf8").digest("hex").toUpperCase();
}

function edgeTTS(text, { voice = "ja-JP-NanamiNeural", rate = "+0%", pitch = "+0Hz", volume = "+0%" } = {}) {
  return new Promise((resolve, reject) => {
    const connId = crypto.randomUUID().replaceAll("-", "");
    const gec = computeGEC();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${connId}`;

    const ws = new WebSocket(url, {
      host: "speech.platform.bing.com",
      origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      },
    });

    const audioChunks = [];
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error("TTS timeout (30s)"));
      }
    }, 30000);

    ws.on("open", () => {
      // 1) Send speech config
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
        `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`
      );

      // 2) Send SSML
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const ssml =
        `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ja-JP'>` +
        `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
        `${escaped}</prosody></voice></speak>`;
      ws.send(ssml);
    });

    ws.on("message", (rawData, isBinary) => {
      if (!isBinary) {
        const msg = rawData.toString("utf8");
        if (msg.includes("turn.end")) {
          clearTimeout(timer);
          resolved = true;
          ws.close();
          resolve(Buffer.concat(audioChunks));
        }
        return;
      }
      // Binary: extract audio after "Path:audio\r\n"
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
      const sep = "Path:audio\r\n";
      const idx = data.indexOf(sep);
      if (idx >= 0) {
        audioChunks.push(data.subarray(idx + sep.length));
      }
    });

    ws.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        reject(err);
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        if (audioChunks.length > 0) {
          resolve(Buffer.concat(audioChunks));
        } else {
          reject(new Error("Connection closed without audio"));
        }
      }
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, voice, rate } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Missing text" });
  }

  const trimmed = text.slice(0, 5000);

  // Convert rate number (e.g. 1.0, 1.5) to edge-tts format (e.g. "+0%", "+50%")
  const ratePercent = Math.round(((rate || 1.0) - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

  try {
    const audioBuffer = await edgeTTS(trimmed, {
      voice: voice || "ja-JP-NanamiNeural",
      rate: rateStr,
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.byteLength);
    return res.status(200).send(audioBuffer);
  } catch (e) {
    console.error("Edge TTS error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}

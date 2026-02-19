import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import WebSocket from "ws";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

// Escape text for embedding in SSML (XML entity escaping only)
function escapeSSML(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Streaming handler: pipes WebSocket audio chunks directly to HTTP response
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

  const timer = setTimeout(() => finish("TTS timeout (25s)"), 25000);

  // Abort if client disconnects
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
    const ts = new Date().toISOString();
    ws.send(
      `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`
    );

    const ssmlBody = escapeSSML(trimmed);
    ws.send(
      `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
      `<voice name='${voiceName}'><prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>` +
      `${ssmlBody}</prosody></voice></speak>`
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

import { tts } from "edge-tts/out/index.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, voice, rate } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Missing text" });
  }

  // Limit text length to prevent abuse
  const trimmed = text.slice(0, 5000);

  // Convert rate number (e.g. 1.0, 1.5) to edge-tts format (e.g. "+0%", "+50%")
  const ratePercent = Math.round(((rate || 1.0) - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

  try {
    const audioBuffer = await tts(trimmed, {
      voice: voice || "ja-JP-NanamiNeural",
      rate: rateStr,
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.byteLength);
    return res.status(200).send(audioBuffer);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey, voiceId, text, modelId, voiceSettings } = req.body;
  if (!apiKey || !voiceId || !text) {
    return res.status(400).json({ error: "Missing apiKey, voiceId, or text" });
  }

  let headersSent = false;

  try {
    const controller = new AbortController();
    // Keep timer running for the ENTIRE operation (not just headers)
    const timer = setTimeout(() => controller.abort(), 55000);

    const elRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: modelId || "eleven_multilingual_v2",
          voice_settings: voiceSettings || { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: controller.signal,
      }
    );

    if (!elRes.ok) {
      clearTimeout(timer);
      const errBody = await elRes.text().catch(() => "");
      let errJson;
      try { errJson = JSON.parse(errBody); } catch { errJson = errBody; }
      return res.status(elRes.status).json({
        error: "ElevenLabs API error",
        status: elRes.status,
        detail: errJson,
      });
    }

    // Stream response directly — don't buffer entire audio in memory
    const contentType = elRes.headers.get("content-type") || "audio/mpeg";
    res.writeHead(200, { "Content-Type": contentType });
    headersSent = true;

    const reader = elRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    clearTimeout(timer);
    res.end();
  } catch (e) {
    if (!headersSent) {
      if (e.name === "AbortError") {
        return res.status(504).json({ error: "Timeout: TTS generation took too long" });
      }
      return res.status(500).json({ error: e.message });
    }
    try { res.end(); } catch {}
  }
}

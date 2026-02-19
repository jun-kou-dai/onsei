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
    // Keep timer running for the ENTIRE operation (not just headers)
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
      return res.status(oaiRes.status).json({
        error: "OpenAI TTS error",
        status: oaiRes.status,
        detail: errJson,
      });
    }

    // Stream response directly — don't buffer entire audio in memory
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
      if (e.name === "AbortError") {
        return res.status(504).json({ error: "Timeout: TTS generation took too long" });
      }
      return res.status(500).json({ error: e.message });
    }
    try { res.end(); } catch {}
  }
}

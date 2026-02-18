export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey, text, voice, model } = req.body;
  if (!apiKey || !text) {
    return res.status(400).json({ error: "Missing apiKey or text" });
  }

  // OpenAI TTS has a 4096 character limit per request
  const trimmed = text.slice(0, 4096);

  try {
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
    });

    if (!oaiRes.ok) {
      const errBody = await oaiRes.text().catch(() => "");
      let errJson;
      try { errJson = JSON.parse(errBody); } catch { errJson = errBody; }
      return res.status(oaiRes.status).json({
        error: "OpenAI TTS error",
        status: oaiRes.status,
        detail: errJson,
      });
    }

    const arrayBuf = await oaiRes.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", arrayBuf.byteLength);
    return res.status(200).send(Buffer.from(arrayBuf));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

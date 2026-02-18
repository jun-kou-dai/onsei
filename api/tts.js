export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey, voiceId, text, modelId, voiceSettings } = req.body;
  if (!apiKey || !voiceId || !text) {
    return res.status(400).json({ error: "Missing apiKey, voiceId, or text" });
  }

  try {
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
      }
    );

    if (!elRes.ok) {
      const errBody = await elRes.text().catch(() => "");
      let errJson;
      try { errJson = JSON.parse(errBody); } catch { errJson = errBody; }
      return res.status(elRes.status).json({
        error: "ElevenLabs API error",
        status: elRes.status,
        detail: errJson,
      });
    }

    const arrayBuf = await elRes.arrayBuffer();
    const contentType = elRes.headers.get("content-type") || "audio/mpeg";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", arrayBuf.byteLength);
    return res.status(200).send(Buffer.from(arrayBuf));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

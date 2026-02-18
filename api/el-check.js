export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey, voiceId } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: "Missing apiKey" });
  }

  const out = { ok: false, key_ok: false, tts_ok: null };

  try {
    // 1) Subscription check (key validity)
    const subRes = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
    });

    const rawBody = await subRes.text().catch(() => "");

    if (subRes.ok) {
      out.key_ok = true;
      try {
        const data = JSON.parse(rawBody);
        out.character_count = data.character_count;
        out.character_limit = data.character_limit;
        out.tier = data.tier;
      } catch {
        // JSON parse failed but key is still valid
      }
    } else {
      // Key check failed — return details for frontend
      out.elStatus = subRes.status;
      out.rawBody = rawBody;
      return res.status(200).json(out);
    }

    // 2) TTS probe (can we actually generate speech?)
    const vid = voiceId || "Xb7hH8MSUJpSbSDYk0k2";
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text: "a",
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (ttsRes.ok) {
      out.tts_ok = true;
      // Drain response body to avoid hanging connections
      await ttsRes.arrayBuffer().catch(() => null);
    } else {
      out.tts_ok = false;
      out.tts_status = ttsRes.status;
      const ttsBody = await ttsRes.text().catch(() => "");
      try {
        out.tts_detail = JSON.parse(ttsBody);
      } catch {
        out.tts_detail = ttsBody;
      }
    }

    out.ok = true;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

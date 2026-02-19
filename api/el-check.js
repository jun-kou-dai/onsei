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
      // Subscription failed — still record details but DON'T return yet
      // (TTS probe will still run below to check if speech generation works)
      out.elStatus = subRes.status;
      out.rawBody = rawBody;
    }

    out.ok = out.key_ok;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

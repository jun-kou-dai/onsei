export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: "Missing apiKey" });
  }

  try {
    // First try /v1/user/subscription for full quota info
    const elRes = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
    });

    if (elRes.ok) {
      const data = await elRes.json();
      return res.status(200).json({
        ok: true,
        character_count: data.character_count,
        character_limit: data.character_limit,
        tier: data.tier,
      });
    }

    // If 403 with missing permission, the key IS valid but lacks user_read scope.
    // Try /v1/voices as a lightweight validation (only needs voice read permission).
    const errBody = await elRes.text().catch(() => "");
    if (elRes.status === 403 && errBody.includes("missing the permission")) {
      const voiceRes = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey },
      });
      if (voiceRes.ok) {
        return res.status(200).json({
          ok: true,
          limited: true,
          tier: "unknown",
        });
      }
    }

    // 401 = truly invalid key
    return res.status(200).json({
      ok: false,
      status: elRes.status,
      detail: errBody,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: "Missing apiKey" });
  }

  try {
    const elRes = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
    });

    if (!elRes.ok) {
      const errBody = await elRes.text().catch(() => "");
      return res.status(200).json({
        ok: false,
        status: elRes.status,
        detail: errBody,
      });
    }

    const data = await elRes.json();
    return res.status(200).json({
      ok: true,
      character_count: data.character_count,
      character_limit: data.character_limit,
      tier: data.tier,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

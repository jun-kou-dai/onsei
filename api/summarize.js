export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
  }

  const { text, instruction } = req.body;
  if (!text || !instruction) {
    return res.status(400).json({ error: "Missing text or instruction" });
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: instruction + " マークダウン不要。\n\n" + text,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => "");
      return res.status(anthropicRes.status).json({
        error: "Anthropic API error",
        status: anthropicRes.status,
        detail: errBody,
      });
    }

    const data = await anthropicRes.json();
    const summary =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n") || null;

    return res.status(200).json({ summary });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

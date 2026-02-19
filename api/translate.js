export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey, text, sourceLang, targetLang } = req.body;
  if (!apiKey || !text) {
    return res.status(400).json({ error: "Missing apiKey or text" });
  }

  const srcLabel = { en: "English", zh: "Chinese", ko: "Korean", ja: "Japanese" }[sourceLang] || sourceLang || "the source language";
  const tgtLabel = { en: "English", zh: "Chinese", ko: "Korean", ja: "Japanese" }[targetLang] || "Japanese";

  // Chunk text for translation (GPT-4o-mini has ~128k context, but keep chunks manageable)
  const MAX_CHUNK = 3000;
  const chunks = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > MAX_CHUNK && buf.length > 0) {
      chunks.push(buf);
      buf = line;
    } else {
      buf += (buf ? "\n" : "") + line;
    }
  }
  if (buf) chunks.push(buf);

  try {
    const translated = [];

    for (const chunk of chunks) {
      const controller = new AbortController();
      const chunkTimer = setTimeout(() => controller.abort(), 30000);
      const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a professional translator. Translate the following ${srcLabel} text into natural, fluent ${tgtLabel}. Preserve the original paragraph structure. Output ONLY the translated text, no explanations or notes.`,
            },
            { role: "user", content: chunk },
          ],
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
      clearTimeout(chunkTimer);

      if (!oaiRes.ok) {
        const errBody = await oaiRes.text().catch(() => "");
        let detail;
        try { detail = JSON.parse(errBody); } catch { detail = errBody; }
        return res.status(oaiRes.status).json({
          error: "Translation API error",
          status: oaiRes.status,
          detail,
        });
      }

      const data = await oaiRes.json();
      const result = data.choices?.[0]?.message?.content?.trim();
      if (result) translated.push(result);
    }

    return res.status(200).json({
      ok: true,
      text: translated.join("\n\n"),
      charCount: translated.join("\n\n").length,
      sourceLang: sourceLang || "auto",
      targetLang: targetLang || "ja",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

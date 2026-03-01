// PCM (s16le, 24kHz, mono) → WAV header
function pcmToWav(pcmBuffer) {
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { apiKey, text, voice } = req.body;
  if (!apiKey || !text) {
    return res.status(400).json({ error: "Missing apiKey or text" });
  }

  const trimmed = text.slice(0, 4000);
  const voiceName = voice || "Kore";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);

    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: trimmed }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!gemRes.ok) {
      const errBody = await gemRes.text().catch(() => "");
      let errJson;
      try { errJson = JSON.parse(errBody); } catch { errJson = errBody; }
      return res.status(gemRes.status).json({
        error: "Gemini TTS error",
        status: gemRes.status,
        detail: errJson,
      });
    }

    const data = await gemRes.json();
    const audioData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      return res.status(500).json({ error: "No audio data in Gemini response" });
    }

    const pcmBuffer = Buffer.from(audioData, "base64");
    const wavBuffer = pcmToWav(pcmBuffer);

    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wavBuffer.length,
    });
    res.end(wavBuffer);
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Timeout: TTS generation took too long" });
    }
    return res.status(500).json({ error: e.message });
  }
}

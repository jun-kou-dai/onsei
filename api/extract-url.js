import * as cheerio from "cheerio";

// Selectors for elements that are noise (not article content)
const NOISE_SELECTORS = [
  "script", "style", "noscript", "iframe", "svg", "canvas",
  "nav", "header", "footer",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  ".nav", ".navbar", ".header", ".footer", ".sidebar", ".menu",
  ".breadcrumb", ".pagination", ".share", ".social",
  ".ad", ".ads", ".adsbygoogle", ".advertisement",
  ".comment", ".comments", "#comments",
  ".related", ".recommend", ".ranking",
  ".cookie", ".popup", ".modal", ".overlay",
].join(", ");

// Selectors to find article body (in priority order)
const ARTICLE_SELECTORS = [
  "article [class*='body']", "article [class*='content']",
  "[class*='article-body']", "[class*='article-content']", "[class*='article_body']",
  "[class*='entry-content']", "[class*='post-content']", "[class*='story-body']",
  "[class*='main-content']", "[class*='newsBody']", "[class*='news_body']",
  "[itemprop='articleBody']",
  "article", "main", "[role='main']",
  "#content", "#main", ".content",
];

function extractText(html, url) {
  const $ = cheerio.load(html);

  // Remove noise elements
  $(NOISE_SELECTORS).remove();

  // Extract title
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='title']").attr("content") ||
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    "";

  // Try each article selector in priority order
  let articleEl = null;
  for (const sel of ARTICLE_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
      articleEl = el;
      break;
    }
  }

  // Fallback: use body
  if (!articleEl) articleEl = $("body");

  // Remove remaining noise within the article
  articleEl.find("script, style, nav, footer, header, aside, [class*='share'], [class*='social'], [class*='ad-'], [class*='comment']").remove();

  // Extract text with paragraph awareness
  const blocks = [];
  articleEl.find("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, dt, dd, figcaption").each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 0) blocks.push(t);
  });

  let text = blocks.join("\n\n");

  // If paragraph extraction yielded too little, fall back to full text
  if (text.length < 200) {
    text = articleEl.text().replace(/\s+/g, " ").trim();
  }

  // Clean up
  text = text
    .replace(/\t/g, " ")
    .replace(/ {3,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  return { title: title.slice(0, 200), text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing URL" });
  }

  // Basic URL validation
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Only HTTP/HTTPS URLs supported" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const fetchRes = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!fetchRes.ok) {
      return res.status(502).json({ error: `Fetch failed: ${fetchRes.status} ${fetchRes.statusText}` });
    }

    const contentType = fetchRes.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return res.status(400).json({ error: "URL is not an HTML page" });
    }

    // Read response with size limit (5MB)
    const buffer = await fetchRes.arrayBuffer();
    if (buffer.byteLength > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Page too large (>5MB)" });
    }

    // Detect encoding from content-type or meta charset
    let html = new TextDecoder("utf-8").decode(buffer);

    // Check for different encoding in meta tag
    const charsetMatch = html.match(/charset=["']?([\w-]+)/i) || contentType.match(/charset=([\w-]+)/i);
    if (charsetMatch) {
      const charset = charsetMatch[1].toLowerCase();
      if (charset !== "utf-8" && charset !== "utf8") {
        try {
          html = new TextDecoder(charset).decode(buffer);
        } catch {
          // Keep UTF-8 version
        }
      }
    }

    const { title, text } = extractText(html, url);

    if (!text || text.length < 20) {
      return res.status(422).json({ error: "Could not extract meaningful text from this page" });
    }

    return res.status(200).json({
      ok: true,
      title,
      text,
      charCount: text.length,
      source: parsed.hostname,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Timeout: page took too long to load" });
    }
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));

// ── BODY LIMIT ────────────────────────────────────────────────────────────────
// 200kb covers an 800px JPEG at quality 0.6 with room to spare
app.use(express.json({ limit: "200kb" }));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const rateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutes
  max: 20,
  message: { error: "Too many requests — please try again shortly." }
});

const burstLimiter = rateLimit({
  windowMs: 10 * 1000,        // 10 seconds
  max: 5,
  message: { error: "Slow down — please wait a moment." }
});

app.use("/analyze", burstLimiter, rateLimiter);

// ── CLAUDE CALL (extracted so we can retry) ───────────────────────────────────
async function callClaude(image, goal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        temperature: 0.4,
        system: `You are an expert makeup artist for 11 Million Mothers, a warm luxury wellness brand for mothers. Be tender, specific, and celebratory. You see the unique beauty in every face.

RETURN JSON ONLY — no markdown, no explanation, nothing before or after. Use this exact structure:

{
  "face_reading": {
    "face_shape": "oval|round|heart|square|diamond|oblong",
    "skin_tone": "fair|light|light-medium|medium|tan|deep",
    "undertone": "warm|cool|neutral|olive",
    "eye_shape": "almond|round|hooded|monolid|upturned|downturned",
    "eye_colour": "specific description",
    "best_features": "2-3 warm poetic sentences about what makes this face beautiful",
    "skin_notes": "honest specific skin observation"
  },
  "colour_palette": [
    {"name":"colour name","hex":"#rrggbb","use":"where to apply"},
    {"name":"colour name","hex":"#rrggbb","use":"where to apply"},
    {"name":"colour name","hex":"#rrggbb","use":"where to apply"},
    {"name":"colour name","hex":"#rrggbb","use":"where to apply"},
    {"name":"colour name","hex":"#rrggbb","use":"where to apply"}
  ],
  "technique_steps": [
    {"step":1,"title":"title","instruction":"specific for this face"},
    {"step":2,"title":"title","instruction":"specific for this face"},
    {"step":3,"title":"title","instruction":"specific for this face"},
    {"step":4,"title":"title","instruction":"specific for this face"},
    {"step":5,"title":"title","instruction":"specific for this face"},
    {"step":6,"title":"title","instruction":"specific for this face"}
  ],
  "product_recommendations": [
    {"category":"Foundation / Base","product":"product name","why":"reason for this person"},
    {"category":"Blush / Bronzer","product":"product name","why":"reason for this person"},
    {"category":"Eyes","product":"product name","why":"reason for this person"},
    {"category":"Lips","product":"product name","why":"reason for this person"},
    {"category":"Setting / Finish","product":"product name","why":"reason for this person"}
  ],
  "closing_note": "Warm personal 2-sentence note spoken directly to this woman."
}`,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: image }
            },
            {
              type: "text",
              text: `Analyse this face for: "${goal}". Return JSON only.`
            }
          ]
        }]
      })
    });

    clearTimeout(timeout);
    return response;

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── ANALYZE ROUTE ─────────────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { image, goal } = req.body || {};

  // Validate
  if (!image || typeof image !== "string" || image.length < 1000) {
    return res.status(400).json({ error: "Invalid image" });
  }
  if (!goal || typeof goal !== "string") {
    return res.status(400).json({ error: "Invalid goal" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  try {
    // First attempt
    let response = await callClaude(image, goal);
    let text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      console.error("Non-JSON from Claude (attempt 1):", text.slice(0, 200));
      return res.status(500).json({ error: "Unexpected AI response" });
    }

    // Retry once if Claude returned an error
    if (data.error) {
      console.warn("Claude error on attempt 1, retrying:", data.error);
      response = await callClaude(image, goal);
      text = await response.text();
      try {
        data = JSON.parse(text);
      } catch {
        console.error("Non-JSON from Claude (attempt 2):", text.slice(0, 200));
        return res.status(500).json({ error: "Unexpected AI response" });
      }
    }

    if (!data.content) {
      console.error("No content in response:", data);
      return res.status(500).json({ error: "Bad AI response" });
    }

    return res.json(data);

  } catch (err) {
    console.error("Server error:", err.message);
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Upstream timeout" });
    }
    return res.status(500).json({ error: "Server error" });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`11MM proxy running on port ${PORT}`));

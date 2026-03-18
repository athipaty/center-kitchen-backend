const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/search
router.post("/", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Query is required" });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: `You are a JSON API. Return ONLY raw JSON, no text, no markdown.
Search Amazon and eBay for the product. Return:
{
  "query": "product name",
  "items": [
    {
      "product": "name",
      "amazon_price": 199.99,
      "amazon_url": "https://amazon.com/...",
      "ebay_competitor_price": 249.99,
      "currency": "USD",
      "profit_estimate": 40.00,
      "profit_margin_pct": 16.0,
      "notes": "short note"
    }
  ]
}
Only include items where amazon_price is lower than ebay_competitor_price. Return ONLY JSON.`,
      messages: [
        { role: "user", content: `Find arbitrage opportunities for: ${query}` },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("No response from AI");

    const parsed = JSON.parse(
      textBlock.text.replace(/```json|```/g, "").trim(),
    );
    res.json(parsed);
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

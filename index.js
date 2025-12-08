import express from "express";

// In Node 18+ fetch is built-in
const app = express();
app.use(express.json());

// In-memory config: userId -> { userId, currency, assets: [...] }
const alertConfigs = new Map();

// Last notification timestamps: userId#symbol#tierIndex -> ms since epoch
const lastNotified = new Map();

// --- HTTP endpoints ---

// iOS app calls this to update its tier config
app.post("/api/update-alert-config", (req, res) => {
  const cfg = req.body;

  if (!cfg || !cfg.userId || !Array.isArray(cfg.assets)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  alertConfigs.set(cfg.userId, cfg);
  console.log("Updated config for", cfg.userId, "assets:", cfg.assets.length);
  return res.json({ ok: true });
});

// Optional manual trigger (for testing from browser)
app.get("/internal/run-alerts", async (req, res) => {
  try {
    await runAlertCheck();
    res.json({ ok: true });
  } catch (err) {
    console.error("runAlertCheck error", err);
    res.status(500).json({ error: "runAlertCheck failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("ExitDeck Alert Service listening on", PORT);

  // Run every 60 seconds
  setInterval(() => {
    runAlertCheck().catch((err) => console.error("interval error", err));
  }, 60 * 1000);
});

// --------------- Core logic ---------------

async function runAlertCheck() {
  if (alertConfigs.size === 0) return;

  const symbolsSet = new Set();
  for (const cfg of alertConfigs.values()) {
    cfg.assets.forEach((a) => symbolsSet.add(a.symbol.toUpperCase()));
  }
  const symbols = Array.from(symbolsSet);
  if (symbols.length === 0) return;

  const prices = await fetchPrices(symbols); // { XRP: 0.62, HBAR: 0.11, ... }
  const now = Date.now();
  const minNotifyMs = 30 * 60 * 1000; // 30 minutes per tier

  for (const [userId, cfg] of alertConfigs.entries()) {
    for (const asset of cfg.assets) {
      const symbol = asset.symbol.toUpperCase();
      const price = prices[symbol];
      if (!price || price <= 0) continue;

      const tiers = [asset.tier1, asset.tier2, asset.tier3];
      const threshold = asset.thresholdPct > 0 ? asset.thresholdPct : 5;

      tiers.forEach((target, idx) => {
        if (!target || target <= 0) return;

        const distancePct = Math.abs(price - target) / target * 100;
        if (distancePct > threshold) return;

        const tierIndex = idx + 1;
        const key = `${userId}#${symbol}#${tierIndex}`;

        const last = lastNotified.get(key);
        if (last && now - last < minNotifyMs) {
          return;
        }

        lastNotified.set(key, now);

        const title = `Tier ${tierIndex} nearly hit for ${symbol}`;
        const body = `Current: ${price.toFixed(4)} vs target ${target.toFixed(
          4
        )} (${distancePct.toFixed(1)}% away).`;

        sendPushToUser(userId, title, body).catch((err) =>
          console.error("sendPush error", err)
        );
      });
    }
  }
}

async function fetchPrices(symbols) {
  // Map your tickers to CoinGecko IDs
  const idMap = {
    XRP: "ripple",
    HBAR: "hedera-hashgraph",
    XLM: "stellar",
    FET: "fetch-ai",
    NEAR: "near",
    RNDR: "render-token",
    ONDO: "ondo-finance",
    AKT: "akash-network"
  };

  const ids = symbols
    .map((s) => idMap[s])
    .filter(Boolean)
    .join(",");

  if (!ids) return {};

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    ids
  )}&vs_currencies=usd`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error("Price fetch failed", resp.status);
    return {};
  }

  const data = await resp.json();

  const result = {};
  for (const [sym, id] of Object.entries(idMap)) {
    if (data[id] && typeof data[id].usd === "number") {
      result[sym] = data[id].usd;
    }
  }
  return result;
}

async function sendPushToUser(userId, title, body) {
  const apiKey = process.env.ONESIGNAL_API_KEY;
  const appId = "9bc29b9e-76bf-48c9-95f4-5f5ffbedd8a9"; // your OneSignal App ID

  if (!appId || !apiKey) {
    console.warn("OneSignal not configured; skipping push.");
    return;
  }

  const url = "https://onesignal.com/api/v1/notifications";

  const payload = {
    app_id: appId,
    include_external_user_ids: [userId],
    headings: { en: title },
    contents: { en: body }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Basic ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    console.error("OneSignal push failed:", resp.status, await resp.text());
  }
}

// index.js – ExitDeck Alert Service (CoinGecko + OneSignal)

const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 10000;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || '';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';

// Require Node 18+ so global.fetch exists
const fetch = global.fetch;
if (!fetch) {
  throw new Error(
    '[AlertService] global.fetch is not available – use Node 18+ on Render'
  );
}

if (!ONESIGNAL_API_KEY) {
  console.warn('[AlertService] WARNING: ONESIGNAL_API_KEY not set – pushes will be skipped');
}
if (!ONESIGNAL_APP_ID) {
  console.warn('[AlertService] WARNING: ONESIGNAL_APP_ID not set – pushes will be skipped');
}

const app = express();
app.use(cors());
app.use(express.json());

// In-memory user configs and alert history
// userId -> { userId, currency, assets[] }
const configsByUser = new Map();
// "user:symbol:tier" -> timestamp ms
const lastAlertByKey = new Map();

// --- CoinGecko symbol resolution ---

// Manual overrides for tricky symbols; everything else is resolved dynamically
const SYMBOL_TO_COINGECKO_ID = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  XRP: 'ripple',
  HBAR: 'hedera-hashgraph',
  XLM: 'stellar',
  FET: 'fetch-ai',
  NEAR: 'near',
  RNDR: 'render-token',
  ONDO: 'ondo-finance',
  AKT: 'akash-network',
};

// Dynamic cache for CoinGecko's full coin list (all assets)
let cgListCache = null;
let cgListLastFetched = 0;
const CG_LIST_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function ensureCoinListLoaded() {
  const now = Date.now();
  if (cgListCache && now - cgListLastFetched < CG_LIST_TTL_MS) return;

  const resp = await fetch(
    'https://api.coingecko.com/api/v3/coins/list?include_platform=false'
  );
  if (!resp.ok) {
    console.warn(
      '[AlertService] CoinGecko /coins/list failed',
      resp.status,
      resp.statusText
    );
    return;
  }

  cgListCache = await resp.json();
  cgListLastFetched = now;
}

// Resolve a ticker like "INJ" to a CoinGecko id like "injective-protocol".
async function resolveCoinGeckoId(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;

  // 1) Static overrides / previously memoised matches
  if (SYMBOL_TO_COINGECKO_ID[sym]) {
    return SYMBOL_TO_COINGECKO_ID[sym];
  }

  // 2) Dynamic lookup in cached /coins/list
  await ensureCoinListLoaded();
  if (!cgListCache) return null;

  const matches = cgListCache.filter(
    (c) => String(c.symbol || '').toUpperCase() === sym
  );
  if (!matches.length) return null;

  // Prefer an id that exactly matches the lowercase symbol if present, else first match
  const exact = matches.find((c) => c.id === sym.toLowerCase());
  const chosen = exact || matches[0];

  // Memoise so we don’t have to re-scan next time
  SYMBOL_TO_COINGECKO_ID[sym] = chosen.id;
  return chosen.id;
}

// --- HTTP endpoints ---

// Simple health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    users: configsByUser.size,
  });
});

/**
 * Payload from app (AlertTierConfigPayload):
 *
 * {
 *   userId: "xxx",
 *   currency: "USD",
 *   assets: [
 *     {
 *       symbol: "XRP",
 *       tier1: 5.0,
 *       tier2: 10.0,
 *       tier3: 15.0,
 *       thresholdPct: 5
 *     },
 *     ...
 *   ]
 * }
 *
 * (For safety we ALSO accept the older shape:
 *  { symbol, alertWithinPct, tiersUSD: [ ... ] } )
 */
// Accept ANY POST path that contains "alert-config" so client path
// differences (/alert-config, /api/alert-config, /v1/alert-config, etc.) still work.
app.post(/.*alert-config.*/, (req, res) => {
  try {
    console.log('[AlertService] Incoming', req.method, req.path);

    const { userId, currency, assets } = req.body || {};
    if (!userId || !Array.isArray(assets)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid payload (userId/assets)' });
    }

    const normAssets = assets.map((a) => {
      const symbol = String(a.symbol || '').toUpperCase();

      // Normalise tiers: prefer explicit tiersUSD[] if present,
      // otherwise build from tier1/tier2/tier3.
      const tiersUSD = [];
      if (Array.isArray(a.tiersUSD) && a.tiersUSD.length) {
        for (const n of a.tiersUSD) {
          const v = Number(n);
          if (Number.isFinite(v) && v > 0) tiersUSD.push(v);
        }
      } else {
        const t1 = Number(a.tier1 ?? 0);
        const t2 = Number(a.tier2 ?? 0);
        const t3 = Number(a.tier3 ?? 0);
        if (Number.isFinite(t1) && t1 > 0) tiersUSD.push(t1);
        if (Number.isFinite(t2) && t2 > 0) tiersUSD.push(t2);
        if (Number.isFinite(t3) && t3 > 0) tiersUSD.push(t3);
      }

      // Normalise threshold: new field is thresholdPct, legacy is alertWithinPct.
      let threshold = Number(
        a.thresholdPct !== undefined ? a.thresholdPct : a.alertWithinPct
      );
      if (!Number.isFinite(threshold) || threshold <= 0) {
        threshold = 5; // sensible default
      }

      return {
        symbol,
        alertWithinPct: threshold,
        tiersUSD,
      };
    });

    configsByUser.set(userId, {
      userId,
      currency: currency || 'USD',
      assets: normAssets,
    });

    console.log(
      '[AlertService] Updated config for',
      userId,
      'assets:',
      normAssets.length
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[AlertService] /alert-config error', err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`ExitDeck Alert Service listening on ${PORT}`);
  console.log('Your service is live');
});

// --- Alert engine helpers ---

function collectAllSymbols() {
  const set = new Set();
  for (const cfg of configsByUser.values()) {
    for (const asset of cfg.assets) {
      if (asset.symbol) set.add(asset.symbol);
    }
  }
  return Array.from(set);
}

async function fetchPricesUSD(symbols) {
  const ids = [];
  const symbolForId = {};

  for (const sym of symbols) {
    const id = await resolveCoinGeckoId(sym);
    if (id) {
      ids.push(id);
      symbolForId[id] = sym;
    } else {
      console.warn('[AlertService] No CoinGecko ID for symbol', sym);
    }
  }

  if (!ids.length) return {};

  const url =
    'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(ids.join(',')) +
    '&vs_currencies=usd';

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error('CoinGecko error ' + resp.status);
  }
  const json = await resp.json();

  const out = {};
  for (const [id, v] of Object.entries(json)) {
    const sym = symbolForId[id];
    if (sym && v && typeof v.usd === 'number') {
      out[sym] = v.usd;
    }
  }
  return out;
}

function alertKey(userId, symbol, tierIndex) {
  return `${userId}:${symbol}:T${tierIndex}`;
}

// Prevent spamming the same alert: default 60 minutes between identical alerts
function shouldThrottle(key, minutes) {
  const now = Date.now();
  const last = lastAlertByKey.get(key) || 0;
  const minMs = minutes * 60 * 1000;
  if (now - last < minMs) return true;
  lastAlertByKey.set(key, now);
  return false;
}

async function sendOneSignalNotification({
  userId,
  symbol,
  tierIndex,
  priceUSD,
  targetUSD,
  distancePct,
}) {
  if (!ONESIGNAL_API_KEY || !ONESIGNAL_APP_ID) {
    console.warn('[AlertService] OneSignal not configured, skipping push');
    return;
  }

  const title = `Exit target near for ${symbol}`;
  const body = `Price $${priceUSD.toFixed(
    4
  )} is within ${distancePct.toFixed(2)}% of Tier ${
    tierIndex + 1
  } ($${targetUSD.toFixed(4)}).`;

  const payload = {
    app_id: ONESIGNAL_APP_ID,
    include_external_user_ids: [userId],
    channel_for_external_user_ids: 'push',
    headings: { en: title },
    contents: { en: body },
    data: {
      kind: 'tier_alert',
      symbol,
      tierIndex,
      priceUSD,
      targetUSD,
      distancePct,
    },
  };

  const resp = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Basic ${ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(
      '[AlertService] OneSignal error',
      resp.status,
      resp.statusText,
      text
    );
  } else {
    console.log(
      '[AlertService] Push sent',
      symbol,
      'tier',
      tierIndex + 1,
      'user',
      userId
    );
  }
}

async function runAlertScan() {
  try {
    const symbols = collectAllSymbols();
    if (!symbols.length) {
      return;
    }

    const prices = await fetchPricesUSD(symbols);

    for (const cfg of configsByUser.values()) {
      for (const asset of cfg.assets) {
        const sym = asset.symbol;
        const priceUSD = prices[sym];
        if (!priceUSD || !Array.isArray(asset.tiersUSD)) continue;

        const alertWithin = Math.max(1, asset.alertWithinPct || 0);

        asset.tiersUSD.forEach((tierUSD, index) => {
          const t = Number(tierUSD);
          if (!Number.isFinite(t) || t <= 0) return;

          const distancePct = (Math.abs(priceUSD - t) / t) * 100;

          if (distancePct <= alertWithin) {
            const key = alertKey(cfg.userId, sym, index);
            if (shouldThrottle(key, 60)) {
              // Already alerted recently for this user/symbol/tier
              return;
            }
            sendOneSignalNotification({
              userId: cfg.userId,
              symbol: sym,
              tierIndex: index,
              priceUSD,
              targetUSD: t,
              distancePct,
            }).catch((err) =>
              console.error(
                '[AlertService] sendOneSignalNotification failed',
                err
              )
            );
          }
        });
      }
    }
  } catch (err) {
    console.error('[AlertService] runAlertScan error', err);
  }
}

// Run every 5 minutes
setInterval(runAlertScan, 5 * 60 * 1000);

// Also run once shortly after boot
setTimeout(runAlertScan, 30 * 1000);

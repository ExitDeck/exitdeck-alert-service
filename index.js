// index.js – ExitDeck Alert Service (CoinGecko + OneSignal)

const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 10000;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;

// Fallback to node-fetch if global fetch is not available
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import('node-fetch').then(({ default: f }) => f(...args));
}
const fetch = fetchFn;

if (!ONESIGNAL_API_KEY) {
  console.warn('[AlertService] WARNING: ONESIGNAL_API_KEY not set');
}
if (!ONESIGNAL_APP_ID) {
  console.warn('[AlertService] WARNING: ONESIGNAL_APP_ID not set');
}

const app = express();
app.use(cors());
app.use(express.json());

// In-memory user configs and alert history
const configsByUser = new Map();     // userId -> { userId, currency, assets[] }
const lastAlertByKey = new Map();    // "user:symbol:tier" -> timestamp ms

// Supported symbols for price polling (CoinGecko IDs)
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
  AKT: 'akash-network'
};

// --- HTTP endpoints ---

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    users: configsByUser.size
  });
});

// Payload from app: { userId, currency, assets: [{ symbol, alertWithinPct, tiersUSD[] }] }
app.post('/alert-config', (req, res) => {
  try {
    const { userId, currency, assets } = req.body || {};
    if (!userId || !Array.isArray(assets)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid payload (userId/assets)' });
    }

    const normAssets = assets.map(a => ({
      symbol: String(a.symbol || '').toUpperCase(),
      alertWithinPct: Number(a.alertWithinPct || 0),
      tiersUSD: Array.isArray(a.tiersUSD)
        ? a.tiersUSD.map(n => Number(n) || 0)
        : []
    }));

    configsByUser.set(userId, {
      userId,
      currency: currency || 'USD',
      assets: normAssets
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
    const id = SYMBOL_TO_COINGECKO_ID[sym];
    if (id) {
      ids.push(id);
      symbolForId[id] = sym;
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
  distancePct
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
      distancePct
    }
  };

  const resp = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Basic ${ONESIGNAL_API_KEY}`
    },
    body: JSON.stringify(payload)
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
          if (!tierUSD || tierUSD <= 0) return;

          const distancePct =
            Math.abs(priceUSD - tierUSD) / tierUSD * 100;

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
              targetUSD: tierUSD,
              distancePct
            }).catch(err =>
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

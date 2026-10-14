/**
 * TweetCat Miner - Cloudflare Worker
 *
 * Model: every tweet that contains a miner link is its own "miner" (container).
 *   - Create a miner -> it is PENDING (not mining yet).
 *   - Tweet its link. Opening that tweet's card loads /embed?m=<id>.
 *   - Tap START MINING inside the tweet card -> that miner begins mining.
 *   - Rate: settings.rate_per_miner (default 0.02 $TWEETCAT / second, per miner).
 *   - Settings (contract address, token name, rate) are editable live via /admin.
 *
 * X loads the player iframe from the exact twitter:player URL of the crawled page,
 * so /m/<id> injects /embed?m=<id> into the card. That ties a tweet to one miner.
 */

const DEFAULT_RATE = 0.02;
const LEADERBOARD_MAX = 100;
const MINER_ID_RE = /^m[0-9a-f]{10}$/;

const DEFAULT_SETTINGS = {
  rate_per_miner: String(DEFAULT_RATE),
  contract_address: "0x0000000000000000000000000000000000000000",
  token_symbol: "$TWEETCAT",
  token_name: "TweetCat",
  chain_name: "Robinhood Chain",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }

      if (pathname.startsWith("/m/")) {
        const id = pathname.slice(3).replace(/\/+$/, "");
        const player =
          `${url.origin}/embed` + (MINER_ID_RE.test(id) ? `?m=${encodeURIComponent(id)}` : "");
        return serveLanding(env, request, url, player);
      }

      if (pathname === "/" || pathname === "/index.html") {
        return serveLanding(env, request, url, `${url.origin}/embed`);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: "server_error", message: String(err && err.message) }, 500);
    }
  },
};

/* --------------------------------- Landing -------------------------------- */

async function serveLanding(env, request, url, playerUrl) {
  const rootUrl = new URL("/", url.origin).toString();
  const res = await env.ASSETS.fetch(new Request(rootUrl, request));
  const html = (await res.text())
    .replaceAll("%ORIGIN%", url.origin)
    .replaceAll("%PLAYER_URL%", playerUrl);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ------------------------------- API router ------------------------------- */

async function handleApi(request, env, url) {
  const { pathname } = url;
  const now = Date.now();
  const settings = await getSettings(env);
  const rate = Number(settings.rate_per_miner) || DEFAULT_RATE;

  if (pathname === "/api/config" && request.method === "GET") {
    return json(publicConfig(settings));
  }
  if (pathname === "/api/leaderboard" && request.method === "GET") {
    return apiLeaderboard(env, url, now, rate);
  }
  if (pathname === "/api/wallet" && request.method === "POST") {
    return apiRegisterWallet(request, env, url, now, rate);
  }
  if (pathname === "/api/miner" && request.method === "POST") {
    return apiCreateMiner(request, env, url, now, rate);
  }

  /* admin */
  if (pathname === "/api/admin/settings" && request.method === "GET") {
    return apiAdminGetSettings(request, env);
  }
  if (pathname === "/api/admin/settings" && request.method === "POST") {
    return apiAdminSaveSettings(request, env, settings);
  }

  let m = pathname.match(/^\/api\/wallet\/(.+)$/);
  if (m && request.method === "GET") {
    const wallet = normalizeWallet(decodeURIComponent(m[1]));
    if (!wallet) return json({ error: "invalid_wallet" }, 400);
    return json(await walletSummary(env, wallet, url.origin, now, rate));
  }

  m = pathname.match(/^\/api\/miner\/([^/]+)\/start$/);
  if (m && request.method === "POST") {
    return apiStartMiner(request, env, decodeURIComponent(m[1]), now, rate);
  }

  m = pathname.match(/^\/api\/miner\/([^/]+)\/context$/);
  if (m && request.method === "POST") {
    return apiMinerContext(request, env, decodeURIComponent(m[1]), now);
  }

  m = pathname.match(/^\/api\/miner\/([^/]+)$/);
  if (m && request.method === "GET") {
    const miner = await getMiner(env, decodeURIComponent(m[1]));
    if (!miner) return json({ error: "not_found" }, 404);
    return json(publicMiner(miner, now, url.origin, rate));
  }

  return json({ error: "not_found" }, 404);
}

/* -------------------------------- Handlers -------------------------------- */

async function apiRegisterWallet(request, env, url, now, rate) {
  const body = await readJson(request);
  const wallet = normalizeWallet(body.wallet);
  if (!wallet) return json({ error: "invalid_wallet" }, 400);

  await env.DB.prepare(
    `INSERT INTO wallets (wallet, created_at) VALUES (?, ?) ON CONFLICT(wallet) DO NOTHING`
  )
    .bind(wallet, now)
    .run();

  return json(await walletSummary(env, wallet, url.origin, now, rate));
}

async function apiCreateMiner(request, env, url, now, rate) {
  const body = await readJson(request);
  const wallet = normalizeWallet(body.wallet);
  if (!wallet) return json({ error: "invalid_wallet" }, 400);

  await env.DB.prepare(
    `INSERT INTO wallets (wallet, created_at) VALUES (?, ?) ON CONFLICT(wallet) DO NOTHING`
  )
    .bind(wallet, now)
    .run();

  let id = null;
  for (let i = 0; i < 8 && !id; i++) {
    const candidate = newMinerId();
    const res = await env.DB.prepare(
      `INSERT INTO miners (id, wallet, balance, active, last_mined_at, created_at, started_at)
       VALUES (?, ?, 0, 0, ?, ?, NULL) ON CONFLICT(id) DO NOTHING`
    )
      .bind(candidate, wallet, now, now)
      .run();
    if (res.meta && res.meta.changes === 1) id = candidate;
  }
  if (!id) return json({ error: "could_not_create" }, 500);

  const miner = await getMiner(env, id);
  const pub = publicMiner(miner, now, url.origin, rate);
  return json({
    miner: pub,
    tweetText: tweetText(pub.link),
    wallet: await walletSummary(env, wallet, url.origin, now, rate),
  });
}

async function apiStartMiner(request, env, id, now, rate) {
  if (!MINER_ID_RE.test(id)) return json({ error: "invalid_miner" }, 400);
  const body = await readJson(request);
  const miner = await getMiner(env, id);
  if (!miner) return json({ error: "not_found" }, 404);

  // Only the first START begins the clock. Also record the tweet if we learned it.
  const startedAt = miner.started_at || now;
  const ref = parseTweetRef(body.referrer || "");
  const tweetUrl = miner.tweet_url || (ref && ref.url) || null;
  const tweetId = miner.tweet_id || (ref && ref.id) || null;

  await env.DB.prepare(
    `UPDATE miners
        SET active = 1, started_at = ?, last_mined_at = ?,
            tweet_url = COALESCE(?, tweet_url), tweet_id = COALESCE(?, tweet_id)
      WHERE id = ?`
  )
    .bind(startedAt, now, tweetUrl, tweetId, id)
    .run();

  const updated = await getMiner(env, id);
  return json(publicMiner(updated, now, "", rate));
}

async function apiMinerContext(request, env, id, now) {
  if (!MINER_ID_RE.test(id)) return json({ error: "invalid_miner" }, 400);
  const body = await readJson(request);
  const ref = parseTweetRef(body.referrer || "");
  if (!ref) return json({ ok: false, recorded: false });

  await env.DB.prepare(
    `UPDATE miners SET tweet_url = COALESCE(tweet_url, ?), tweet_id = COALESCE(tweet_id, ?)
      WHERE id = ?`
  )
    .bind(ref.url, ref.id, id)
    .run();

  return json({ ok: true, recorded: true, tweet: ref });
}

async function apiLeaderboard(env, url, now, rate) {
  const limit = Math.min(
    LEADERBOARD_MAX,
    Math.max(1, Number(url.searchParams.get("limit")) || 50)
  );

  const { results } = await env.DB.prepare(
    `SELECT wallet,
            COUNT(*) AS miner_count,
            SUM(balance) AS stored,
            SUM(CASE WHEN active = 1 THEN (? - last_mined_at) ELSE 0 END) AS active_ms
       FROM miners
      GROUP BY wallet
      ORDER BY stored DESC
      LIMIT 200`
  )
    .bind(now)
    .all();

  const rows = (results || [])
    .map((r) => ({
      wallet: r.wallet,
      miners: r.miner_count,
      balance: Number((r.stored + ((r.active_ms || 0) / 1000) * rate).toFixed(6)),
    }))
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));

  return json({ leaderboard: rows, updatedAt: now });
}

/* --------------------------------- Admin ---------------------------------- */

function isAdmin(request, env, body) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return false;
  const auth = request.headers.get("authorization") || "";
  let pw = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!pw && body && body.password) pw = String(body.password);
  return pw === expected;
}

async function apiAdminGetSettings(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
  return json(publicConfig(await getSettings(env)));
}

async function apiAdminSaveSettings(request, env, current) {
  const body = await readJson(request);
  if (!isAdmin(request, env, body)) return json({ error: "unauthorized" }, 401);

  const updates = {};
  if (typeof body.contractAddress === "string") updates.contract_address = body.contractAddress.trim();
  if (typeof body.tokenSymbol === "string") updates.token_symbol = body.tokenSymbol.trim();
  if (typeof body.tokenName === "string") updates.token_name = body.tokenName.trim();
  if (typeof body.chainName === "string") updates.chain_name = body.chainName.trim();
  if (body.ratePerMiner !== undefined && !isNaN(Number(body.ratePerMiner))) {
    updates.rate_per_miner = String(Number(body.ratePerMiner));
  }

  const keys = Object.keys(updates);
  if (!keys.length) return json({ error: "nothing_to_update" }, 400);

  await env.DB.batch(
    keys.map((k) =>
      env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(k, updates[k])
    )
  );

  return json({ ok: true, settings: publicConfig(await getSettings(env)) });
}

/* -------------------------------- Helpers --------------------------------- */

function publicConfig(s) {
  return {
    contractAddress: s.contract_address,
    tokenSymbol: s.token_symbol,
    tokenName: s.token_name,
    chainName: s.chain_name,
    ratePerMiner: Number(s.rate_per_miner) || DEFAULT_RATE,
  };
}

async function getSettings(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
    const s = Object.assign({}, DEFAULT_SETTINGS);
    (results || []).forEach((r) => (s[r.key] = r.value));
    return s;
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

async function walletSummary(env, wallet, origin, now, rate) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM miners WHERE wallet = ? ORDER BY created_at DESC`
  )
    .bind(wallet)
    .all();

  let total = 0;
  let activeRate = 0;
  const miners = (results || []).map((row) => {
    const pub = publicMiner(row, now, origin, rate);
    total += pub.balance;
    if (pub.active) activeRate += rate;
    return {
      id: pub.id,
      balance: pub.balance,
      active: pub.active,
      started: pub.started,
      status: pub.status,
      tweetUrl: pub.tweetUrl,
      createdAt: pub.createdAt,
      link: pub.link,
    };
  });

  return {
    wallet,
    balance: Number(total.toFixed(6)),
    ratePerSec: Number(activeRate.toFixed(6)),
    minerCount: miners.length,
    miners,
  };
}

function computeMinerBalance(miner, now, rate) {
  let balance = miner.balance;
  if (miner.active) {
    const elapsedSec = Math.max(0, (now - miner.last_mined_at) / 1000);
    balance += elapsedSec * rate;
  }
  return balance;
}

function publicMiner(miner, now, origin, rate) {
  const balance = computeMinerBalance(miner, now, rate);
  const started = !!miner.started_at;
  const active = !!miner.active;
  const status = active ? "mining" : started ? "paused" : "pending";
  return {
    id: miner.id,
    wallet: miner.wallet,
    balance: Number(balance.toFixed(6)),
    ratePerSec: rate,
    active,
    started,
    status,
    startedAt: miner.started_at || null,
    tweetUrl: miner.tweet_url || null,
    createdAt: miner.created_at,
    link: origin ? `${origin}/m/${miner.id}` : null,
  };
}

function parseTweetRef(ref) {
  if (!ref) return null;
  const m = String(ref).match(
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i
  );
  if (!m) return null;
  return { handle: m[1], id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` };
}

function tweetText(link) {
  return (
    "🐱⛏️ My TweetCat miner is ready — open this post and tap START MINING to begin earning $TWEETCAT.\n\n" +
    link
  );
}

async function getMiner(env, id) {
  if (!MINER_ID_RE.test(id)) return null;
  return env.DB.prepare(`SELECT * FROM miners WHERE id = ?`).bind(id).first();
}

function newMinerId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return "m" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeWallet(value) {
  if (typeof value !== "string") return null;
  const w = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(w) ? w : null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

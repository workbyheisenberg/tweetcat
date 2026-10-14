/* ==========================================================================
   TweetCat Miner - frontend logic
   Two modes:
     - Website (index.html): connect wallet -> create miners -> leaderboard
     - Embed   (embed.html):  watch ONE miner live + "create your own" button
   One miner = one tweet = one container. Rate is 0.02 $TWEETCAT/sec per miner.
   ========================================================================== */

(function () {
  "use strict";

  const CFG = Object.assign(
    {
      appName: "TweetCat Miner",
      tokenSymbol: "$TWEETCAT",
      chainName: "Robinhood Chain",
      contractAddress: "0x0000000000000000000000000000000000000000",
      ratePerMiner: 0.02,
      refreshIntervalMs: 5000,
    },
    window.TWEETCAT_CONFIG || {}
  );

  const WALLET_KEY = "tweetcat_wallet";
  let RATE = CFG.ratePerMiner;

  /* ------------------------------ helpers ---------------------------------- */

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const store = (function () {
    try {
      const k = "__tc__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) {
      const mem = {};
      return {
        getItem: (k) => (k in mem ? mem[k] : null),
        setItem: (k, v) => (mem[k] = String(v)),
        removeItem: (k) => delete mem[k],
      };
    }
  })();

  const show = (el, on) => el && el.classList.toggle("hidden", !on);
  const truncate = (w) => (w && w.length > 12 ? w.slice(0, 6) + "\u2026" + w.slice(-4) : w || "");

  function formatTokens(n) {
    if (!isFinite(n)) n = 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(3) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(3) + "M";
    if (a >= 10000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    const fixed = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    const parts = fixed.split(".");
    const whole = Number(parts[0]).toLocaleString("en-US");
    return parts[1] ? whole + "." + parts[1] : whole;
  }

  const isValidWallet = (w) => typeof w === "string" && /^0x[0-9a-fA-F]{40}$/.test(w.trim());

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    show(el, true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => show(el, false), 2400);
  }

  async function api(path, options) {
    const res = await fetch("/api" + path, Object.assign({ headers: { "content-type": "application/json" } }, options));
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}
    return { ok: res.ok, status: res.status, data };
  }

  function copy(text, okMsg) {
    try {
      navigator.clipboard.writeText(text).then(() => toast(okMsg || "Copied!"), () => toast("Copy failed"));
    } catch (e) {
      toast("Copy failed");
    }
  }

  function tweetIntent(text) {
    return "https://x.com/intent/tweet?text=" + encodeURIComponent(text);
  }

  /* -------------------------------- common --------------------------------- */

  const state = {
    wallet: store.getItem(WALLET_KEY) || null,
    data: null, // wallet summary snapshot
    syncedAt: 0,
  };

  document.addEventListener("DOMContentLoaded", function () {
    loadRemoteConfig().finally(function () {
      renderStatic();
      if (document.body.classList.contains("embed")) initEmbed();
      else initSite();
    });
  });

  // Admin-editable values (CA, token name, rate) come from the server.
  async function loadRemoteConfig() {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) return;
      const c = await res.json();
      if (c.contractAddress) CFG.contractAddress = c.contractAddress;
      if (c.tokenSymbol) CFG.tokenSymbol = c.tokenSymbol;
      if (c.chainName) CFG.chainName = c.chainName;
      if (c.ratePerMiner) {
        CFG.ratePerMiner = c.ratePerMiner;
        RATE = c.ratePerMiner;
      }
    } catch (e) {}
  }

  function renderStatic() {
    $$("[data-ca]").forEach((el) => (el.textContent = CFG.contractAddress));
    $$("[data-chain]").forEach((el) => (el.textContent = CFG.chainName));
    $$("[data-symbol]").forEach((el) => (el.textContent = CFG.tokenSymbol));
    $$("[data-app-name]").forEach((el) => (el.textContent = CFG.appName));
    $$("[data-rate]").forEach((el) => (el.textContent = RATE.toFixed(2)));
    $$("[data-site-link]").forEach((el) => (el.href = location.origin + "/"));
  }

  /* =============================== EMBED =================================== */

  function initEmbed() {
    const minerId = new URLSearchParams(location.search).get("m");
    if (minerId) {
      show($("#embed-generic"), false);
      show($("#embed-miner"), true);

      const start = $("#embed-start");
      if (start) start.addEventListener("click", () => startEmbedMiner(minerId));

      // Best-effort: tell the server which tweet this card is opened inside.
      api("/miner/" + encodeURIComponent(minerId) + "/context", {
        method: "POST",
        body: JSON.stringify({ referrer: document.referrer || "" }),
      });

      loadEmbedMiner(minerId);
      setInterval(() => loadEmbedMiner(minerId), CFG.refreshIntervalMs);
      setInterval(renderEmbed, 100);
    } else {
      show($("#embed-generic"), true);
      show($("#embed-miner"), false);
    }
  }

  const embedState = { balance: 0, active: false, started: false, syncedAt: 0, id: null };

  async function loadEmbedMiner(id) {
    const res = await api("/miner/" + encodeURIComponent(id));
    if (!res.ok) {
      const st = $("#embed-status");
      if (st) {
        st.textContent = "MINER NOT FOUND";
        st.className = "status status--off";
      }
      return;
    }
    applyEmbedMiner(res.data);
  }

  function applyEmbedMiner(m) {
    embedState.id = m.id;
    embedState.balance = m.balance;
    embedState.active = m.active;
    embedState.started = m.started;
    embedState.syncedAt = Date.now();

    const idEl = $("#embed-miner-id");
    if (idEl) idEl.textContent = m.id;
    const rateEl = $("#embed-rate");
    if (rateEl) rateEl.textContent = m.ratePerSec.toFixed(2);

    const st = $("#embed-status");
    if (st) {
      if (m.active) {
        st.textContent = "MINING ACTIVE";
        st.className = "status status--on";
      } else if (m.started) {
        st.textContent = "PAUSED";
        st.className = "status status--off";
      } else {
        st.textContent = "READY — TAP START";
        st.className = "status status--off";
      }
    }

    const start = $("#embed-start");
    if (start) show(start, !m.active);

    renderEmbed();
  }

  async function startEmbedMiner(id) {
    const btn = $("#embed-start");
    if (btn) btn.disabled = true;
    const res = await api("/miner/" + encodeURIComponent(id) + "/start", {
      method: "POST",
      body: JSON.stringify({ referrer: document.referrer || "" }),
    });
    if (btn) btn.disabled = false;
    if (res.ok) {
      applyEmbedMiner(res.data);
      toast("Mining started!");
    } else {
      toast("Could not start mining");
    }
  }

  function renderEmbed() {
    const el = $("#embed-mined");
    if (!el || !embedState.id) return;
    let b = embedState.balance;
    if (embedState.active) b += ((Date.now() - embedState.syncedAt) / 1000) * RATE;
    el.textContent = formatTokens(b);
  }

  /* =============================== SITE ==================================== */

  function initSite() {
    wireSiteWallet();

    const ref = location.pathname.match(/^\/m\/(.+)$/);
    if (ref) {
      const b = $("#ref-banner");
      if (b) {
        b.textContent = "You're viewing someone's miner (" + ref[1] + "). Create your own below.";
        show(b, true);
      }
    }

    if (state.wallet) loadWallet();
    else applySiteVisibility(false);

    setInterval(() => {
      if (state.wallet) loadWallet();
    }, CFG.refreshIntervalMs);
    setInterval(renderSite, 100);
    refreshLeaderboard();
    setInterval(refreshLeaderboard, 10000);
  }

  function applySiteVisibility(hasWallet) {
    show($("#connect-box"), !hasWallet);
    show($("#dashboard"), hasWallet);
    const chip = $("#wallet-chip-addr");
    if (chip) chip.textContent = hasWallet ? state.wallet : "";
  }

  async function loadWallet() {
    const res = await api("/wallet/" + encodeURIComponent(state.wallet));
    if (res.ok) {
      state.data = res.data;
      state.syncedAt = Date.now();
      applySiteVisibility(true);
      renderWallet();
    } else if (res.status === 400) {
      store.removeItem(WALLET_KEY);
      state.wallet = null;
      applySiteVisibility(false);
    }
  }

  function hasInjected() {
    return typeof window.ethereum !== "undefined" && window.ethereum !== null;
  }

  function wireSiteWallet() {
    $$("[data-connect]").forEach((btn) => btn.addEventListener("click", connectWallet));

    const inject = $("#wallet-inject");
    if (inject) inject.addEventListener("click", connectInjected);

    const cancel = $("#wallet-cancel");
    if (cancel) cancel.addEventListener("click", () => show($("#wallet-modal"), false));

    const save = $("#wallet-save");
    const input = $("#wallet-input");
    if (save && input) {
      save.addEventListener("click", submitWallet);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitWallet();
      });
    }

    const create = $("#btn-create-miner");
    if (create) create.addEventListener("click", createMiner);

    const dc = $("#wallet-disconnect");
    if (dc) dc.addEventListener("click", disconnect);

    // No browser wallet? hide the injected option.
    if (!hasInjected()) show($("#wallet-inject"), false);

    if (hasInjected() && window.ethereum.on) {
      window.ethereum.on("accountsChanged", (accs) => {
        if (accs && accs.length) registerAndSet(accs[0]);
        else disconnect();
      });
      window.ethereum.on("chainChanged", () => {
        if (state.wallet) ensureRobinhoodChain().catch(() => {});
      });
    }

    // Restore an already-authorized browser wallet without prompting.
    if (hasInjected() && !state.wallet) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accs) => {
          if (accs && accs.length) registerAndSet(accs[0]);
        })
        .catch(() => {});
    }
  }

  function connectWallet() {
    if (hasInjected()) connectInjected();
    else openWalletModal();
  }

  async function connectInjected() {
    if (!hasInjected()) return openWalletModal();
    try {
      const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!accs || !accs.length) return;
      await ensureRobinhoodChain();
      await registerAndSet(accs[0]);
    } catch (e) {
      if (e && e.code === 4001) toast("Connection cancelled");
      else toast("Could not connect wallet");
    }
  }

  // Make the wallet switch to Robinhood Chain (adds it if the wallet doesn't know it).
  async function ensureRobinhoodChain() {
    const c = CFG.chain;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: c.hexId }],
      });
    } catch (e) {
      const code = e && e.code;
      const msg = ((e && e.message) || "").toLowerCase();
      if (code === 4902 || code === -32603 || msg.indexOf("unrecognized") >= 0 || msg.indexOf("not added") >= 0) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: c.hexId,
              chainName: c.name,
              nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: c.decimals },
              rpcUrls: [c.rpc],
              blockExplorerUrls: [c.explorer],
            },
          ],
        });
      } else {
        throw e;
      }
    }
  }

  async function registerAndSet(address) {
    const res = await api("/wallet", { method: "POST", body: JSON.stringify({ wallet: address }) });
    if (!res.ok) {
      toast("Could not connect.");
      return;
    }
    state.wallet = String(address).toLowerCase();
    store.setItem(WALLET_KEY, state.wallet);
    state.data = res.data;
    state.syncedAt = Date.now();
    show($("#wallet-modal"), false);
    applySiteVisibility(true);
    renderWallet();
    toast("Wallet connected!");
  }

  function disconnect() {
    store.removeItem(WALLET_KEY);
    state.wallet = null;
    state.data = null;
    applySiteVisibility(false);
    const chip = $("#wallet-chip-addr");
    if (chip) chip.textContent = "";
  }

  function openWalletModal() {
    const input = $("#wallet-input");
    const err = $("#wallet-error");
    if (input && state.wallet) input.value = state.wallet;
    if (err) err.textContent = "";
    show($("#wallet-modal"), true);
    if (input) setTimeout(() => input.focus(), 50);
  }

  async function submitWallet() {
    const input = $("#wallet-input");
    const err = $("#wallet-error");
    const save = $("#wallet-save");
    if (!input) return;

    const value = input.value.trim();
    if (!isValidWallet(value)) {
      if (err) err.textContent = "Enter a valid Robinhood wallet (0x + 40 characters).";
      return;
    }

    if (save) save.disabled = true;
    await registerAndSet(value);
    if (save) save.disabled = false;
  }

  async function createMiner() {
    if (!state.wallet) return openWalletModal();
    const btn = $("#btn-create-miner");
    if (btn) btn.disabled = true;

    const res = await api("/miner", { method: "POST", body: JSON.stringify({ wallet: state.wallet }) });
    if (btn) btn.disabled = false;

    if (!res.ok) {
      toast("Could not create miner.");
      return;
    }

    state.data = res.data.wallet;
    state.syncedAt = Date.now();
    renderWallet();
    showNewMiner(res.data.miner, res.data.tweetText);
    refreshLeaderboard();
    toast("Miner created — tweet it, then tap START in the post");
  }

  function showNewMiner(miner, text) {
    const box = $("#new-miner");
    if (!box) return;
    const linkEl = $("#new-miner-link");
    if (linkEl) linkEl.textContent = miner.link;
    const copyBtn = $("#new-miner-copy");
    if (copyBtn) copyBtn.onclick = () => copy(miner.link, "Miner link copied!");
    const copyTweet = $("#new-miner-copytweet");
    if (copyTweet) copyTweet.onclick = () => copy(text, "Tweet text copied!");
    const tweetBtn = $("#new-miner-tweet");
    if (tweetBtn) tweetBtn.href = tweetIntent(text);
    show(box, true);
  }

  function renderWallet() {
    const d = state.data;
    if (!d) return;

    const count = $("#miner-count");
    if (count) count.textContent = d.minerCount;
    const rate = $("#total-rate");
    if (rate) rate.textContent = d.ratePerSec.toFixed(2) + " " + CFG.tokenSymbol;

    renderMinerList(d.miners);
    renderSite();
  }

  function renderMinerList(miners) {
    const body = $("#miner-list");
    if (!body) return;

    if (!miners.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">No miners yet. Tap CREATE MINER.</td></tr>';
      return;
    }

    body.innerHTML = miners
      .map(
        (m) =>
          '<tr data-miner="' +
          m.id +
          '" data-balance="' +
          m.balance +
          '" data-active="' +
          (m.active ? "1" : "0") +
          '">' +
          '<td class="mono">' +
          m.id +
          "</td>" +
          '<td class="' +
          (m.active ? "on" : "off") +
          '">' +
          (m.status === "mining" ? "MINING" : m.status === "paused" ? "PAUSED" : "PENDING") +
          "</td>" +
          '<td class="amount bal">' +
          formatTokens(m.balance) +
          "</td>" +
          '<td class="actions"><button class="btn btn--small" data-copy="' +
          m.id +
          '">LINK</button>' +
          (m.tweetUrl
            ? ' <a class="btn btn--small" href="' + m.tweetUrl + '" target="_blank" rel="noopener">TWEET</a>'
            : "") +
          "</td>" +
          "</tr>"
      )
      .join("");

    body.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-copy");
        copy(location.origin + "/m/" + id, "Miner link copied!");
      });
    });
  }

  function renderSite() {
    const d = state.data;
    if (!d) return;
    const elapsed = (Date.now() - state.syncedAt) / 1000;

    let total = 0;
    d.miners.forEach((m) => {
      if (m.active) total += elapsed * RATE;
    });
    total += d.balance;

    const el = $("#total-mined");
    if (el) el.textContent = formatTokens(total);

    // update each row's live balance
    const rows = document.querySelectorAll("#miner-list tr[data-miner]");
    rows.forEach((row) => {
      const base = parseFloat(row.getAttribute("data-balance")) || 0;
      const act = row.getAttribute("data-active") === "1";
      const shown = base + (act ? elapsed * RATE : 0);
      const cell = row.querySelector(".bal");
      if (cell) cell.textContent = formatTokens(shown);
    });
  }

  /* ----------------------------- leaderboard ------------------------------- */

  async function refreshLeaderboard() {
    const body = $("#leaderboard-body");
    if (!body) return;
    const res = await api("/leaderboard?limit=50");
    if (!res.ok) return;

    const rows = res.data.leaderboard || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">No miners yet. Be the first!</td></tr>';
      return;
    }
    const me = state.wallet;
    body.innerHTML = rows
      .map(
        (r) =>
          '<tr class="' +
          (me && r.wallet === me ? "me" : "") +
          '">' +
          '<td class="rank">#' +
          r.rank +
          "</td>" +
          "<td>" +
          truncate(r.wallet) +
          "</td>" +
          '<td class="tweets">' +
          r.miners +
          "</td>" +
          '<td class="amount">' +
          formatTokens(r.balance) +
          "</td>" +
          "</tr>"
      )
      .join("");
    const upd = $("#board-updated");
    if (upd) upd.textContent = "Updated " + new Date().toLocaleTimeString();
  }

  /* ------------------------------ copy buttons ----------------------------- */

  document.addEventListener("click", function (e) {
    const btn = e.target.closest && e.target.closest("[data-copy-ca]");
    if (btn) copy(CFG.contractAddress, "Contract address copied!");
  });
})();

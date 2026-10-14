/**
 * TweetCat Miner - easy settings
 * Edit this file to change the app without touching any code.
 * (Keep ratePerMiner in sync with src/index.js if you change it.)
 */
window.TWEETCAT_CONFIG = {
  appName: "TweetCat Miner",
  tokenSymbol: "$TWEETCAT",
  chainName: "Robinhood Chain",

  // Paste your real contract address here once you have it:
  contractAddress: "0x0000000000000000000000000000000000000000",

  // Mining speed: tokens per second, per miner (one miner = one tweet).
  ratePerMiner: 0.02,

  // How often the UI refreshes from the server (milliseconds).
  refreshIntervalMs: 5000,

  // Robinhood Chain network details (used for wallet connect).
  chain: {
    id: 4663,
    hexId: "0x1237",
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    symbol: "ETH",
    decimals: 18,
    explorer: "https://robinhoodchain.blockscout.com",
  },
};

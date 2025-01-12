const { log, error } = console;
const got = require("got");
const events = require("events");
const WebSocket = require("ws");
const { sort } = require("fast-sort");
const { promisify } = require("util");
const delay = promisify(setTimeout);

const requestRateLimit = { limit: 3, interval: 1000 };
let requestCounter = 0;
let pairs = [];
let symValJ = {};
const eventEmitter = new events();

const formatPair = (b, q) => `${b}-${q}`;

const getTickers = async () => {
  try {
    await enforceRateLimit();

    const resp = await got("https://api.kucoin.com/api/v1/market/allTickers");
    requestCounter++;

    const tickers = JSON.parse(resp.body).data.ticker;

    updateTickers(tickers);
    identifyPaths(tickers);

    log(`Finished identifying all the paths. Total symbols = ${new Set(tickers.flatMap(t => t.symbol.split('-'))).size}. Total Pairs = ${tickers.length}. Total paths = ${pairs.length}`);
  } catch (err) {
    error("Failed to fetch tickers:", err);
  }
};

const enforceRateLimit = async () => {
  if (requestCounter >= requestRateLimit.limit) {
    await delay(requestRateLimit.interval);
    requestCounter = 0;
  }
}

const updateTickers = (tickers) => {
  tickers.forEach(ticker => {
    const symbol = ticker.symbol;
    symValJ[symbol] = {
      bidPrice: parseFloat(ticker.buy),
      askPrice: parseFloat(ticker.sell)
    };
  });
};

const identifyPaths = (tickers) => {
  const symbols = [...new Set(tickers.flatMap(ticker => ticker.symbol.split('-')))];
  const validPairs = tickers.map(ticker => ticker.symbol);

  validPairs.forEach(p => {
    symbols.forEach(d3 => {
      const [d1, d2] = p.split("-");
      if (d1 !== d2 && d2 !== d3 && d3 !== d1) {
        const lv1 = findLevel(symValJ, formatPair(d1, d2), formatPair(d2, d1));
        const lv2 = findLevel(symValJ, formatPair(d2, d3), formatPair(d3, d2));
        const lv3 = findLevel(symValJ, formatPair(d3, d1), formatPair(d1, d3));

        if (lv1.length && lv2.length && lv3.length) {
          pairs.push({
            l1: lv1[1], l2: lv2[1], l3: lv3[1],
            d1, d2, d3,
            lv1: lv1[0], lv2: lv2[0], lv3: lv3[0],
            value: -100, tpath: ""
          });
        }
      }
    });
  });
};

const findLevel = (symValJ, pair1, pair2) => {
  if (symValJ[pair1]) return [pair1, "num"];
  if (symValJ[pair2]) return [pair2, "den"];
  return [];
};

const processData = (pl) => {
  try {
    const payload = JSON.parse(pl);
    const symbol = payload?.subject;
    const { data } = payload;
    if (!data) return;

    const { bestBid: bidPrice, bestAsk: askPrice } = data;
    if (!bidPrice && !askPrice) return;

    symValJ[symbol] = {
      bidPrice: bidPrice * 1 || symValJ[symbol].bidPrice,
      askPrice: askPrice * 1 || symValJ[symbol].askPrice
    };

    calculateArbitrage(symbol);
  } catch (err) {
    error(err);
  }
};

const calculateArbitrage = (symbol) => {
  pairs
    .filter(d => (d.lv1 + d.lv2 + d.lv3).includes(symbol))
    .forEach(d => {
      if (symValJ[d.lv1]?.bidPrice && symValJ[d.lv2]?.bidPrice && symValJ[d.lv3]?.bidPrice) {
        let lv_calc = calculateLevel(symValJ, d.l1, d.lv1, d.d1, d.d2);
        lv_calc *= calculateLevel(symValJ, d.l2, d.lv2, d.d2, d.d3);
        lv_calc *= calculateLevel(symValJ, d.l3, d.lv3, d.d3, d.d1);

        d.value = parseFloat(((lv_calc - 1) * 100).toFixed(3));
        d.tpath = generatePathString(d);
      }
    });

  eventEmitter.emit("ARBITRAGE", sort(pairs.filter(d => d.value > 0)).desc(u => u.value));
};

const calculateLevel = (symValJ, l, lv, d1, d2) => {
  if (l === "num") {
    return symValJ[lv].bidPrice;
  } else {
    return 1 / symValJ[lv].askPrice;
  }
};

const generatePathString = (d) => {
  return `${d.d1} to ${d.lv1}/${d.d2} to ${d.lv2}/${d.d3} to ${d.lv3}/${d.d1}`;
};

let ws = "";
let wspingTrigger = "";
let wsreconnectTrigger = "";
let wsClientID;

const wsconnect = async () => {
  try {
    log("Establishing all the required websocket connections. Please wait...");
    if (ws) ws.terminate();
    clearInterval(wspingTrigger);
    clearTimeout(wsreconnectTrigger);

    const resp = await got.post("https://api.kucoin.com/api/v1/bullet-public");
    const wsmeta = JSON.parse(resp.body);
    const wsToken = wsmeta?.data?.token;
    const wsURLx = wsmeta?.data?.instanceServers?.[0]?.endpoint;
    const wspingInterval = wsmeta?.data?.instanceServers?.[0]?.pingInterval;
    const wspingTimeout = wsmeta?.data?.instanceServers?.[0]?.pingTimeout + wspingInterval;
    wsClientID = Math.floor(Math.random() * 10 ** 10);

    ws = new WebSocket(`${wsURLx}?token=${wsToken}&[connectId=${wsClientID}]`);
    ws.on("open", handleWsOpen);
    ws.on("error", handleWsError);
    ws.on("message", processData);
    ws.on("pong", handleWsPong);

    wspingTrigger = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, wspingInterval);
  } catch (err) {
    error(err);
  }
};

const handleWsOpen = () => {
  ws.send(JSON.stringify({
    id: wsClientID,
    type: "subscribe",
    topic: "/market/ticker:all",
    privateChannel: false,
    response: true
  }));
  log("All connections established.");
  log("Open http://127.0.0.1:3000/ in the browser to access the tool.");
};

const handleWsError = (err) => {
  error("WebSocket error:", err);
  wsreconnectTrigger = setTimeout(wsconnect, 5000);
};

const handleWsPong = () => {
  clearTimeout(wsreconnectTrigger);
  wsreconnectTrigger = setTimeout(wsconnect, wspingTimeout);
};

module.exports = { getTickers, wsconnect, eventEmitter };

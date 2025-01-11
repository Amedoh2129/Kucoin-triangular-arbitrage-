const { log, error } = console;
const got = require("got");
const events = require("events");
const WebSocket = require("ws");
const { sort } = require("fast-sort");
const { promisify } = require("util");
const delay = promisify(setTimeout);

let pairs = [],
  symValJ = {};

const eventEmitter = new events();

const formatPair = (b, q) => b + "-" + q;

const getTickers = async () => {
  try {
    const resp = await got("https://api.kucoin.com/api/v1/market/allTickers");
    const tickers = JSON.parse(resp.body).data.ticker;
    
    tickers.forEach(ticker => {
      const symbol = ticker.symbol;
      symValJ[symbol] = { bidPrice: parseFloat(ticker.buy), askPrice: parseFloat(ticker.sell) };
    });

    const symbols = [...new Set(tickers.map(ticker => [ticker.symbol.split('-')[0], ticker.symbol.split('-')[1]]).flat())];
    const validPairs = tickers.map(ticker => ticker.symbol);

    validPairs.forEach((p) => {
      symbols.forEach((d3) => {
        const [d1, d2] = p.split("-");
        if (!(d1 === d2 || d2 === d3 || d3 === d1)) {
          let lv1 = [], lv2 = [], lv3 = [], l1 = "", l2 = "", l3 = "";

          const p12 = formatPair(d1, d2);
          const p21 = formatPair(d2, d1);

          const p23 = formatPair(d2, d3);
          const p32 = formatPair(d3, d2);

          const p31 = formatPair(d3, d1);
          const p13 = formatPair(d1, d3);

          if (symValJ[p12]) {
            lv1.push(p12);
            l1 = "num";
          }
          if (symValJ[p21]) {
            lv1.push(p21);
            l1 = "den";
          }

          if (symValJ[p23]) {
            lv2.push(p23);
            l2 = "num";
          }
          if (symValJ[p32]) {
            lv2.push(p32);
            l2 = "den";
          }

          if (symValJ[p31]) {
            lv3.push(p31);
            l3 = "num";
          }
          if (symValJ[p13]) {
            lv3.push(p13);
            l3 = "den";
          }

          if (lv1.length && lv2.length && lv3.length) {
            pairs.push({
              l1: l1,
              l2: l2,
              l3: l3,
              d1: d1,
              d2: d2,
              d3: d3,
              lv1: lv1[0],
              lv2: lv2[0],
              lv3: lv3[0],
              value: -100,
              tpath: "",
            });
          }
        }
      });
    });

    log(
      `Finished identifying all the paths. Total symbols = ${symbols.length}. Total Pairs = ${validPairs.length}. Total paths = ${pairs.length}`
    );
  } catch (err) {
    error("Failed to fetch tickers:", err);
  }
};

const processData = (pl) => {
  try {
    pl = JSON.parse(pl);
    const symbol = pl?.subject;
    const { data } = pl;
    if (!data) return;
    const { bestBid: bidPrice, bestAsk: askPrice } = data;
    if (!bidPrice && !askPrice) return;

    if (bidPrice) symValJ[symbol].bidPrice = bidPrice * 1;
    if (askPrice) symValJ[symbol].askPrice = askPrice * 1;

    // Perform calculation and send alerts
    pairs
      .filter((d) => {
        return (d.lv1 + d.lv2 + d.lv3).includes(symbol);
      })
      .forEach((d) => {
        // continue if price is not updated for any symbol
        if (
          symValJ[d.lv1]["bidPrice"] &&
          symValJ[d.lv2]["bidPrice"] &&
          symValJ[d.lv3]["bidPrice"]
        ) {
          // Level 1 calculation
          let lv_calc, lv_str;
          if (d.l1 === "num") {
            lv_calc = symValJ[d.lv1]["bidPrice"];
            lv_str =
              d.d1 +
              "->" +
              d.lv1 +
              "['bidP']['" +
              symValJ[d.lv1]["bidPrice"] +
              "']" +
              "->" +
              d.d2 +
              "<br/>";
          } else {
            lv_calc = 1 / symValJ[d.lv1]["askPrice"];
            lv_str =
              d.d1 +
              "->" +
              d.lv1 +
              "['askP']['" +
              symValJ[d.lv1]["askPrice"] +
              "']" +
              "->" +
              d.d2 +
              "<br/>";
          }

          // Level 2 calculation
          if (d.l2 === "num") {
            lv_calc *= symValJ[d.lv2]["bidPrice"];
            lv_str +=
              d.d2 +
              "->" +
              d.lv2 +
              "['bidP']['" +
              symValJ[d.lv2]["bidPrice"] +
              "']" +
              "->" +
              d.d3 +
              "<br/>";
          } else {
            lv_calc *= 1 / symValJ[d.lv2]["askPrice"];
            lv_str +=
              d.d2 +
              "->" +
              d.lv2 +
              "['askP']['" +
              symValJ[d.lv2]["askPrice"] +
              "']" +
              "->" +
              d.d3 +
              "<br/>";
          }

          // Level 3 calculation
          if (d.l3 === "num") {
            lv_calc *= symValJ[d.lv3]["bidPrice"];
            lv_str +=
              d.d3 +
              "->" +
              d.lv3 +
              "['bidP']['" +
              symValJ[d.lv3]["bidPrice"] +
              "']" +
              "->" +
              d.d1;
          } else {
            lv_calc *= 1 / symValJ[d.lv3]["askPrice"];
            lv_str +=
              d.d3 +
              "->" +
              d.lv3 +
              "['askP']['" +
              symValJ[d.lv3]["askPrice"] +
              "']" +
              "->" +
              d.d1;
          }

          d.tpath = lv_str;
          d.value = parseFloat(parseFloat((lv_calc - 1) * 100).toFixed(3));
        }
      });

    // Send Socket
    eventEmitter.emit(
      "ARBITRAGE",
      sort(pairs.filter((d) => d.value > 0)).desc((u) => u.value)
    );
  } catch (err) {
    error(err);
  }
};

const rateLimit = async (fn, limit, interval) => {
  let lastCall = 0;
  return async (...args) => {
    const now = Date.now();
    if (now - lastCall < interval) {
      await delay(interval - (now - lastCall));
    }
    lastCall = Date.now();
    return fn(...args);
  };
};

const getTickersWithRateLimit = rateLimit(getTickers, 15, 1000); // 15 requests per second

let ws = "";
let subs = [];
let wspingTrigger = "";
let wsreconnectTrigger = "";
let wsClientID;
let connectionCount = 0;
const maxConnections = 30;
const maxMessages = 100;
const messageInterval = 10000;
let messageCount = 0;
let messageTimeWindowStart = Date.now();

const wsconnect = async () => {
  try {
    if (connectionCount >= maxConnections) {
      console.error("Connection limit reached. Cannot establish a new connection.");
      return;
    }
    connectionCount++;
    console.log("Establishing all the required websocket connections. Please wait...");
    
    // Clear previous WebSocket connection
    if (ws) ws.terminate();
    clearInterval(wspingTrigger);
    clearTimeout(wsreconnectTrigger);

    // Get WebSocket metadata
    const resp = await got.post("https://api.kucoin.com/api/v1/bullet-public");
    const wsmeta = JSON.parse(resp.body);

    // Extract WebSocket connection data
    const wsToken = wsmeta?.data?.token;
    const wsURLx = wsmeta?.data?.instanceServers?.[0]?.endpoint;
    const wspingInterval = wsmeta?.data?.instanceServers?.[0]?.pingInterval;
    const wspingTimeout =
      wsmeta?.data?.instanceServers?.[0]?.pingTimeout + wspingInterval;
    wsClientID = Math.floor(Math.random() * 10 ** 10);

    // Establish WebSocket connection
    ws = new WebSocket(`${wsURLx}?token=${wsToken}&[connectId=${wsClientID}]`);
    
    ws.on("open", () => {
      // Subscribe to WebSocket topic
      ws.send(
        JSON.stringify({
          id: wsClientID,
          type: "subscribe",
          topic: "/market/ticker:all",
          privateChannel: false,
          response: true,
        })
      );

      console.log("All connections established.");
      console.log("Open http://127.0.0.1:3000/ in the browser to access the tool.");
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      wsreconnectTrigger = setTimeout(wsconnect, 5000);
      connectionCount--;
    });

    ws.on("message", processData);
    ws.on("close", () => {
      console.log("WebSocket connection closed. Reconnecting...");
      clearTimeout(wsreconnectTrigger);
      wsreconnectTrigger = setTimeout(wsconnect, 5000);
      connectionCount--;
    });

    ws.on("pong", () => {
      clearTimeout(wsreconnectTrigger);
      wsreconnectTrigger = setTimeout(wsconnect, wspingTimeout);
    });

    // Periodically send ping to maintain connection
    wspingTrigger = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, wspingInterval);
  } catch (err) {
    console.error("Failed to establish WebSocket connection:", err);
    wsreconnectTrigger = setTimeout(wsconnect, 5000);
    connectionCount--;
  }
};

// Function to return the pairs array
const getPairs = () => {
  return pairs;
};

// Call getTickersWithRateLimit to fetch tickers with rate limit
setInterval(() => getTickersWithRateLimit(), 100); // Call the function every 100ms

module.exports = { 
  getTickers, 
  wsconnect, 
  eventEmitter, 
  getPairs // Export the getPairs function
};

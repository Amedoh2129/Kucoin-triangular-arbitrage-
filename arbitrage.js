const got = require("got");
const events = require("events");
const WebSocket = require("ws");
const { sort } = require("fast-sort");
const { promisify } = require("util");
const delay = promisify(setTimeout);

// Configuration
const config = {
  api: {
    baseUrl: "https://api.kucoin.com",
    rateLimit: { limit: 3, interval: 1000 },
    timeout: 10000
  },
  trading: {
    fees: 0.001, // 0.1% per trade
    slippage: 0.01, // 1% slippage assumption
    minProfitThreshold: 0.1, // Minimum 0.1% profit to consider
    maxPositionSize: 1000, // Maximum position size in USD
    minTimeBetweenTrades: 5000 // 5 seconds between trades
  },
  filters: {
    maxDataAgeMs: 60000, // Ignore data older than 1 minute
    minLiquidity: 1000, // Minimum trading volume in USD
    maxPriceSpread: 0.05 // Max 5% spread to consider valid
  },
  websocket: {
    reconnectDelay: 1000,
    maxReconnectAttempts: 10,
    pingTimeout: 30000
  }
};

// Structured logging system
const logger = {
  levels: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  currentLevel: 1,
  
  format(level, message, data) {
    const timestamp = new Date().toISOString();
    const dataStr = data ? JSON.stringify(data) : '';
    return `[${timestamp}] ${level.padEnd(5)}: ${message} ${dataStr}`;
  },
  
  debug(message, data) {
    if (this.currentLevel <= this.levels.DEBUG) {
      console.log(this.format('DEBUG', message, data));
    }
  },
  
  info(message, data) {
    if (this.currentLevel <= this.levels.INFO) {
      console.log(this.format('INFO', message, data));
    }
  },
  
  warn(message, data) {
    if (this.currentLevel <= this.levels.WARN) {
      console.warn(this.format('WARN', message, data));
    }
  },
  
  error(message, error) {
    if (this.currentLevel <= this.levels.ERROR) {
      console.error(this.format('ERROR', message, { 
        message: error?.message,
        stack: error?.stack
      }));
    }
  },
  
  setLevel(level) {
    if (this.levels[level] !== undefined) {
      this.currentLevel = this.levels[level];
    }
  }
};

// Enhanced data structures
class MarketDataManager {
  constructor() {
    this.marketData = new Map(); // Symbol -> price data
    this.arbitragePaths = [];
    this.symbolToPathsIndex = new Map(); // Symbol -> array of path indices
    this.requestCounter = 0;
    this.lastRequestReset = Date.now();
  }

  async enforceRateLimit() {
    const now = Date.now();
    if (now - this.lastRequestReset >= config.api.rateLimit.interval) {
      this.requestCounter = 0;
      this.lastRequestReset = now;
    }

    if (this.requestCounter >= config.api.rateLimit.limit) {
      const waitTime = config.api.rateLimit.interval - (now - this.lastRequestReset);
      if (waitTime > 0) {
        await delay(waitTime);
        this.requestCounter = 0;
        this.lastRequestReset = Date.now();
      }
    }
    this.requestCounter++;
  }

  validatePriceData(symbol, bidPrice, askPrice) {
    // Basic validation
    if (isNaN(bidPrice) || isNaN(askPrice) || bidPrice <= 0 || askPrice <= 0) {
      return false;
    }

    // Check spread
    const spread = (askPrice - bidPrice) / bidPrice;
    if (spread > config.filters.maxPriceSpread) {
      logger.warn(`Large spread detected for ${symbol}: ${(spread * 100).toFixed(2)}%`);
      return false;
    }

    // Bid should be less than ask
    if (bidPrice >= askPrice) {
      logger.warn(`Invalid price order for ${symbol}: bid=${bidPrice}, ask=${askPrice}`);
      return false;
    }

    return true;
  }

  updateMarketData(symbol, bidPrice, askPrice) {
    if (!this.validatePriceData(symbol, bidPrice, askPrice)) {
      return false;
    }

    this.marketData.set(symbol, {
      bidPrice: parseFloat(bidPrice),
      askPrice: parseFloat(askPrice),
      timestamp: Date.now(),
      spread: (askPrice - bidPrice) / bidPrice
    });

    return true;
  }

  getMarketData(symbol) {
    const data = this.marketData.get(symbol);
    if (!data) return null;

    // Check if data is stale
    if (Date.now() - data.timestamp > config.filters.maxDataAgeMs) {
      logger.debug(`Stale data for ${symbol}`);
      return null;
    }

    return data;
  }

  // Optimized path identification
  identifyArbitragePaths(tickers) {
    logger.info("Starting path identification...");
    
    // Create efficient data structures
    const pairsByBase = new Map();
    const pairsByQuote = new Map();
    const allCurrencies = new Set();
    
    // Index all trading pairs
    tickers.forEach(ticker => {
      const [base, quote] = ticker.symbol.split('-');
      allCurrencies.add(base);
      allCurrencies.add(quote);
      
      // Index by base currency
      if (!pairsByBase.has(base)) {
        pairsByBase.set(base, []);
      }
      pairsByBase.get(base).push({ quote, symbol: ticker.symbol });
      
      // Index by quote currency
      if (!pairsByQuote.has(quote)) {
        pairsByQuote.set(quote, []);
      }
      pairsByQuote.get(quote).push({ base, symbol: ticker.symbol });
    });

    // Find triangular paths more efficiently
    const currencies = Array.from(allCurrencies);
    this.arbitragePaths = [];
    
    for (const startCurrency of currencies) {
      // Get all pairs where startCurrency is the base
      const directPairs = pairsByBase.get(startCurrency) || [];
      
      for (const { quote: secondCurrency, symbol: firstPairSymbol } of directPairs) {
        if (secondCurrency === startCurrency) continue;
        
        // Find all currencies that can be reached from secondCurrency
        const secondPairs = pairsByBase.get(secondCurrency) || [];
        const secondPairsAsQuote = pairsByQuote.get(secondCurrency) || [];
        
        // Check direct pairs from secondCurrency
        for (const { quote: thirdCurrency, symbol: secondPairSymbol } of secondPairs) {
          if (thirdCurrency === startCurrency || thirdCurrency === secondCurrency) continue;
          
          // Check if we can get back to startCurrency from thirdCurrency
          const returnPairs = pairsByBase.get(thirdCurrency) || [];
          const returnPair = returnPairs.find(p => p.quote === startCurrency);
          
          if (returnPair) {
            this.addArbitragePath(
              startCurrency, secondCurrency, thirdCurrency,
              firstPairSymbol, secondPairSymbol, returnPair.symbol
            );
          }
          
          // Also check if startCurrency can be base in a pair with thirdCurrency as quote
          const reverseReturnPairs = pairsByQuote.get(thirdCurrency) || [];
          const reverseReturnPair = reverseReturnPairs.find(p => p.base === startCurrency);
          
          if (reverseReturnPair) {
            this.addArbitragePath(
              startCurrency, secondCurrency, thirdCurrency,
              firstPairSymbol, secondPairSymbol, reverseReturnPair.symbol
            );
          }
        }
        
        // Check pairs where secondCurrency is quote
        for (const { base: thirdCurrency, symbol: secondPairSymbol } of secondPairsAsQuote) {
          if (thirdCurrency === startCurrency || thirdCurrency === secondCurrency) continue;
          
          // Check return path
          const returnPairs = pairsByBase.get(thirdCurrency) || [];
          const returnPair = returnPairs.find(p => p.quote === startCurrency);
          
          if (returnPair) {
            this.addArbitragePath(
              startCurrency, secondCurrency, thirdCurrency,
              firstPairSymbol, secondPairSymbol, returnPair.symbol
            );
          }
        }
      }
    }
    
    this.buildPathsIndex();
    logger.info(`Identified ${this.arbitragePaths.length} potential arbitrage paths`);
  }

  addArbitragePath(d1, d2, d3, symbol1, symbol2, symbol3) {
    // Determine trade directions
    const leg1 = this.determineLegType(symbol1, d1, d2);
    const leg2 = this.determineLegType(symbol2, d2, d3);
    const leg3 = this.determineLegType(symbol3, d3, d1);

    this.arbitragePaths.push({
      d1, d2, d3,
      lv1: symbol1, lv2: symbol2, lv3: symbol3,
      l1: leg1, l2: leg2, l3: leg3,
      value: -100,
      tpath: this.generatePathString(d1, d2, d3, symbol1, symbol2, symbol3),
      timestamp: Date.now(),
      calculationCount: 0
    });
  }

  determineLegType(pairSymbol, fromCurrency, toCurrency) {
    const [base, quote] = pairSymbol.split('-');
    
    if (base === fromCurrency && quote === toCurrency) {
      return "sell_base"; // Selling base for quote
    } else if (base === toCurrency && quote === fromCurrency) {
      return "buy_base"; // Buying base with quote
    } else {
      throw new Error(`Invalid path: ${pairSymbol} doesn't connect ${fromCurrency} to ${toCurrency}`);
    }
  }

  generatePathString(d1, d2, d3, symbol1, symbol2, symbol3) {
    return `${d1} → ${symbol1} → ${d2} → ${symbol2} → ${d3} → ${symbol3} → ${d1}`;
  }

  buildPathsIndex() {
    this.symbolToPathsIndex.clear();
    
    this.arbitragePaths.forEach((path, index) => {
      [path.lv1, path.lv2, path.lv3].forEach(symbol => {
        if (!this.symbolToPathsIndex.has(symbol)) {
          this.symbolToPathsIndex.set(symbol, []);
        }
        this.symbolToPathsIndex.get(symbol).push(index);
      });
    });
  }

  // Improved arbitrage calculation
  calculateArbitrage(updatedSymbol) {
    if (!this.symbolToPathsIndex.has(updatedSymbol)) return;
    
    const affectedPathIndices = this.symbolToPathsIndex.get(updatedSymbol);
    const profitablePaths = [];
    
    for (const index of affectedPathIndices) {
      const path = this.arbitragePaths[index];
      
      // Get current market data for all legs
      const data1 = this.getMarketData(path.lv1);
      const data2 = this.getMarketData(path.lv2);
      const data3 = this.getMarketData(path.lv3);
      
      if (!data1 || !data2 || !data3) continue;
      
      // Calculate the arbitrage value
      let multiplier = 1.0;
      
      // First leg
      multiplier *= this.calculateLegMultiplier(data1, path.l1);
      
      // Second leg  
      multiplier *= this.calculateLegMultiplier(data2, path.l2);
      
      // Third leg
      multiplier *= this.calculateLegMultiplier(data3, path.l3);
      
      // Account for trading fees and slippage
      const feeMultiplier = Math.pow(1 - config.trading.fees, 3);
      const slippageMultiplier = Math.pow(1 - config.trading.slippage, 3);
      const netMultiplier = multiplier * feeMultiplier * slippageMultiplier;
      
      // Calculate profit percentage
      path.value = parseFloat(((netMultiplier - 1) * 100).toFixed(4));
      path.calculationCount++;
      path.lastCalculated = Date.now();
      
      if (path.value > config.trading.minProfitThreshold) {
        profitablePaths.push({ ...path }); // Create copy to avoid reference issues
      }
    }
    
    if (profitablePaths.length > 0) {
      const sortedPaths = sort(profitablePaths).desc(p => p.value);
      eventEmitter.emit("ARBITRAGE", sortedPaths);
      
      logger.info(`Found ${profitablePaths.length} profitable paths, best: ${sortedPaths[0].value.toFixed(4)}%`);
    }
  }

  calculateLegMultiplier(marketData, legType) {
    switch (legType) {
      case "sell_base":
        // Selling base currency for quote currency at bid price
        return marketData.bidPrice;
      case "buy_base":
        // Buying base currency with quote currency at ask price
        return 1 / marketData.askPrice;
      default:
        throw new Error(`Unknown leg type: ${legType}`);
    }
  }

  getStats() {
    return {
      totalPairs: this.marketData.size,
      totalPaths: this.arbitragePaths.length,
      activeConnections: wsManager.isConnected() ? 1 : 0,
      dataAgeAvg: this.getAverageDataAge()
    };
  }

  getAverageDataAge() {
    if (this.marketData.size === 0) return 0;
    
    const now = Date.now();
    let totalAge = 0;
    
    for (const data of this.marketData.values()) {
      totalAge += (now - data.timestamp);
    }
    
    return totalAge / this.marketData.size;
  }
}

// WebSocket Manager with proper reconnection logic
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.pongTimeout = null;
    this.reconnectAttempts = 0;
    this.isManuallyDisconnected = false;
    this.connectionState = 'disconnected'; // disconnected, connecting, connected
  }

  async connect() {
    if (this.connectionState === 'connecting') {
      logger.warn("Connection already in progress");
      return;
    }

    try {
      this.cleanup();
      this.connectionState = 'connecting';
      this.isManuallyDisconnected = false;
      
      logger.info("Establishing WebSocket connection...");
      
      await marketDataManager.enforceRateLimit();
      
      const resp = await got.post(`${config.api.baseUrl}/api/v1/bullet-public`, {
        timeout: config.api.timeout
      });
      
      const wsmeta = JSON.parse(resp.body);
      
      if (!wsmeta?.data?.token || !wsmeta?.data?.instanceServers?.length) {
        throw new Error("Invalid WebSocket metadata received");
      }
      
      const wsToken = wsmeta.data.token;
      const wsURL = wsmeta.data.instanceServers[0].endpoint;
      const pingInterval = wsmeta.data.instanceServers[0].pingInterval;
      const pingTimeout = wsmeta.data.instanceServers[0].pingTimeout || config.websocket.pingTimeout;
      const clientID = `arbbot_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      
      this.ws = new WebSocket(`${wsURL}?token=${wsToken}&connectId=${clientID}`);
      
      // Set up event handlers
      this.ws.on("open", () => this.onOpen(clientID));
      this.ws.on("message", data => this.onMessage(data));
      this.ws.on("error", err => this.onError(err));
      this.ws.on("close", (code, reason) => this.onClose(code, reason));
      this.ws.on("pong", () => this.onPong());
      
      // Set up ping mechanism
      this.pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
          
          // Set timeout for pong response
          this.pongTimeout = setTimeout(() => {
            logger.warn("No pong received within timeout, reconnecting...");
            this.reconnect();
          }, pingTimeout);
        }
      }, pingInterval);
      
    } catch (err) {
      logger.error("Failed to establish WebSocket connection", err);
      this.connectionState = 'disconnected';
      this.scheduleReconnect();
    }
  }

  onOpen(clientID) {
    logger.info("WebSocket connection established");
    this.connectionState = 'connected';
    this.reconnectAttempts = 0;
    
    // Subscribe to all tickers
    if (this.ws) {
      this.ws.send(JSON.stringify({
        id: clientID,
        type: "subscribe",
        topic: "/market/ticker:all",
        privateChannel: false,
        response: true
      }));
    }
    
    eventEmitter.emit("WS_CONNECTED");
  }

  onMessage(data) {
    try {
      const dataStr = data instanceof Buffer ? data.toString() : data;
      const payload = JSON.parse(dataStr);
      
      // Handle different message types
      if (payload.type === 'error') {
        logger.error("WebSocket error message", payload);
        return;
      }
      
      if (payload.type === 'ack') {
        logger.debug("Subscription acknowledged");
        return;
      }
      
      if (payload.type !== 'message' || !payload.topic?.startsWith('/market/ticker')) {
        return;
      }
      
      this.processMarketData(payload);
      
    } catch (err) {
      logger.error("Error processing WebSocket message", err);
    }
  }

  processMarketData(payload) {
    const symbol = payload?.subject;
    if (!symbol || typeof symbol !== 'string') {
      logger.debug("Invalid symbol in message", { symbol });
      return;
    }
    
    const data = payload.data;
    if (!data || typeof data !== 'object') {
      logger.debug("Missing data in message", { symbol });
      return;
    }

    const bidPrice = parseFloat(data.bestBid);
    const askPrice = parseFloat(data.bestAsk);
    
    if (marketDataManager.updateMarketData(symbol, bidPrice, askPrice)) {
      marketDataManager.calculateArbitrage(symbol);
    }
  }

  onError(err) {
    logger.error("WebSocket error", err);
    // Don't reconnect here, wait for close event
  }

  onClose(code, reason) {
    logger.warn(`WebSocket closed: ${code} - ${reason}`);
    this.connectionState = 'disconnected';
    
    if (!this.isManuallyDisconnected) {
      this.scheduleReconnect();
    }
  }

  onPong() {
    clearTimeout(this.pongTimeout);
  }

  scheduleReconnect() {
    if (this.isManuallyDisconnected) return;
    
    if (this.reconnectAttempts >= config.websocket.maxReconnectAttempts) {
      logger.error(`Exceeded maximum reconnection attempts (${config.websocket.maxReconnectAttempts})`);
      eventEmitter.emit("WS_FAILED");
      return;
    }
    
    // Exponential backoff with jitter
    const baseDelay = config.websocket.reconnectDelay;
    const backoffDelay = baseDelay * Math.pow(2, this.reconnectAttempts);
    const jitter = Math.random() * 1000;
    const totalDelay = Math.min(backoffDelay + jitter, 60000); // Cap at 1 minute
    
    this.reconnectAttempts++;
    
    logger.info(`Scheduling reconnection in ${(totalDelay/1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, totalDelay);
  }

  reconnect() {
    this.cleanup();
    this.connect();
  }

  disconnect() {
    this.isManuallyDisconnected = true;
    this.cleanup();
    logger.info("WebSocket manually disconnected");
  }

  cleanup() {
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.pongTimeout);
    
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        
        if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) {
          this.ws.terminate();
        }
      } catch (err) {
        logger.error("Error cleaning up WebSocket", err);
      }
      this.ws = null;
    }
    
    this.connectionState = 'disconnected';
  }

  isConnected() {
    return this.connectionState === 'connected';
  }

  getConnectionState() {
    return this.connectionState;
  }
}

// Risk Management System
class RiskManager {
  constructor() {
    this.stats = {
      totalTrades: 0,
      successfulTrades: 0,
      totalProfitLoss: 0,
      consecutiveLosses: 0,
      lastTradeTime: 0,
      dailyVolume: 0,
      dailyProfitLoss: 0
    };
    
    this.limits = {
      maxConsecutiveLosses: 3,
      maxDailyVolume: 50000,
      maxDailyLoss: 1000,
      minTimeBetweenTrades: config.trading.minTimeBetweenTrades
    };
    
    this.resetDailyCounters();
  }

  canExecuteTrade(amount) {
    const now = Date.now();
    
    // Check time between trades
    if (now - this.stats.lastTradeTime < this.limits.minTimeBetweenTrades) {
      return { allowed: false, reason: "Trade frequency limit exceeded" };
    }
    
    // Check daily volume
    if (this.stats.dailyVolume + amount > this.limits.maxDailyVolume) {
      return { allowed: false, reason: "Daily volume limit exceeded" };
    }
    
    // Check consecutive losses
    if (this.stats.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      return { allowed: false, reason: "Too many consecutive losses" };
    }
    
    // Check daily losses
    if (this.stats.dailyProfitLoss < -this.limits.maxDailyLoss) {
      return { allowed: false, reason: "Daily loss limit exceeded" };
    }
    
    return { allowed: true };
  }

  recordTrade(tradeResult) {
    this.stats.totalTrades++;
    this.stats.lastTradeTime = Date.now();
    this.stats.dailyVolume += tradeResult.startAmount;
    
    const profit = tradeResult.profitAmount || 0;
    this.stats.totalProfitLoss += profit;
    this.stats.dailyProfitLoss += profit;
    
    if (profit > 0) {
      this.stats.successfulTrades++;
      this.stats.consecutiveLosses = 0;
    } else {
      this.stats.consecutiveLosses++;
    }
    
    logger.info("Trade recorded", {
      totalTrades: this.stats.totalTrades,
      successRate: (this.stats.successfulTrades / this.stats.totalTrades * 100).toFixed(1) + '%',
      totalPL: this.stats.totalProfitLoss.toFixed(2),
      consecutiveLosses: this.stats.consecutiveLosses
    });
  }

  resetDailyCounters() {
    this.stats.dailyVolume = 0;
    this.stats.dailyProfitLoss = 0;
    
    // Schedule next reset for midnight UTC
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(now.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    
    setTimeout(() => {
      this.resetDailyCounters();
      logger.info("Daily counters reset");
    }, tomorrow - now);
  }

  getStats() {
    return { ...this.stats };
  }
}

// Initialize core components
const eventEmitter = new events.EventEmitter();
const marketDataManager = new MarketDataManager();
const wsManager = new WebSocketManager();
const riskManager = new RiskManager();

// Main functions
const getTickers = async () => {
  try {
    logger.info("Fetching initial ticker data...");
    
    await marketDataManager.enforceRateLimit();
    
    const resp = await got(`${config.api.baseUrl}/api/v1/market/allTickers`, {
      timeout: config.api.timeout
    });
    
    const tickers = JSON.parse(resp.body).data.ticker;
    
    // Update initial market data
    let validTickers = 0;
    tickers.forEach(ticker => {
      const bidPrice = parseFloat(ticker.buy);
      const askPrice = parseFloat(ticker.sell);
      
      if (marketDataManager.updateMarketData(ticker.symbol, bidPrice, askPrice)) {
        validTickers++;
      }
    });
    
    logger.info(`Loaded ${validTickers} valid tickers out of ${tickers.length} total`);
    
    // Identify arbitrage paths
    marketDataManager.identifyArbitragePaths(tickers);
    
    const stats = marketDataManager.getStats();
    logger.info("Initialization complete", stats);
    
  } catch (err) {
    logger.error("Failed to fetch tickers", err);
    throw err;
  }
};

const wsconnect = async () => {
  await wsManager.connect();
};

const disconnect = () => {
  wsManager.disconnect();
};

// Event handlers
eventEmitter.on("ARBITRAGE", (opportunities) => {
  if (opportunities.length > 0) {
    logger.info(`Best arbitrage opportunity: ${opportunities[0].tpath} - ${opportunities[0].value}%`);
    
    // Here you could add actual trading logic
    // For now, just log the top opportunities
    opportunities.slice(0, 5).forEach((opp, i) => {
      logger.info(`${i + 1}. ${opp.tpath}: ${opp.value}%`);
    });
  }
});

eventEmitter.on("WS_CONNECTED", () => {
  logger.info("WebSocket connection established and subscriptions active");
});

eventEmitter.on("WS_FAILED", () => {
  logger.error("WebSocket connection failed permanently");
});

// Utility functions
const getArbitragePaths = () => {
  return marketDataManager.arbitragePaths;
};

const getMarketData = () => {
  return Array.from(marketDataManager.marketData.entries()).map(([symbol, data]) => ({
    symbol,
    ...data
  }));
};

const getSystemStats = () => {
  return {
    market: marketDataManager.getStats(),
    websocket: {
      state: wsManager.getConnectionState(),
      reconnectAttempts: wsManager.reconnectAttempts
    },
    risk: riskManager.getStats()
  };
};

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info("Shutting down gracefully...");
  disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info("Shutting down gracefully...");
  disconnect();
  process.exit(0);
});

// Export public interface
module.exports = {
  getTickers,
  wsconnect,
  disconnect,
  eventEmitter,
  getArbitragePaths,
  getMarketData,
  getSystemStats,
  setLogLevel: logger.setLevel.bind(logger),
  config
};

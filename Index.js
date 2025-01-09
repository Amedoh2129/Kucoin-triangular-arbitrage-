const { log, error } = console;
const socket = require("socket.io");
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000; // Use the port provided by Replit or default to 3000
const server = app.listen(port, () => 
  log(`Kucoin triangular arbitrage finder has started on port ${port}. Please wait while the bot identifies possible paths.....`)
);

app.use(cors());
app.use("/JS", express.static(path.join(__dirname, "./Pages/JS")));
app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "./Pages/index.html"));
});

const io = socket(server);

const arbitrage = require("./arbitrage");

const initialize = async () => {
  await arbitrage.getPairs();
  arbitrage.wsconnect();
};

arbitrage.eventEmitter.on("ARBITRAGE", (pl) => {
  io.sockets.emit("ARBITRAGE", pl);
});

initialize();

// Global error handling for express routes
app.use((err, req, res, next) => {
  error("Unhandled error:", err);
  res.status(500).send("Something went wrong.");
});

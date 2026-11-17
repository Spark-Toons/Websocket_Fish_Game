const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/fish.png", ["fish.png", "image/png"]],
  ["/fish-assets/clownfish.png", ["fish-assets/clownfish.png", "image/png"]],
  ["/fish-assets/goldfish.png", ["fish-assets/goldfish.png", "image/png"]],
  ["/fish-assets/fantail.png", ["fish-assets/fantail.png", "image/png"]],
  ["/fish-assets/tang.png", ["fish-assets/tang.png", "image/png"]],
  ["/fish-assets/bass.png", ["fish-assets/bass.png", "image/png"]],
  ["/fish-assets/blue-cichlid.png", ["fish-assets/blue-cichlid.png", "image/png"]],
  ["/fish-assets/ocean.png", ["fish-assets/ocean.png", "image/png"]],
  ["/input.html", ["input.html", "text/html; charset=utf-8"]],
  ["/output.html", ["output.html", "text/html; charset=utf-8"]]
]);
const clients = new Set();
const drawingHistory = [];
const maxMessageBytes = 64 * 1024;
const maxDrawingLines = 2000;
const fishTypes = ["clownfish", "goldfish", "fantail", "tang", "bass", "blue-cichlid"];

const server = http.createServer((request, response) => {
  const file = staticFiles.get(new URL(request.url, "http://localhost").pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  fs.readFile(path.join(__dirname, file[0]), (error, contents) => {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Could not read the requested file.");
      console.error(`Could not read ${file[0]}: ${error.message}`);
      return;
    }
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(contents);
  });
});

function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendFrame(client, opcode, payload) {
  if (!client.socket.destroyed && client.socket.writable) client.socket.write(frame(opcode, payload));
}

function sendJson(client, message) {
  sendFrame(client, 1, Buffer.from(JSON.stringify(message)));
}

function broadcast(channel, message, except) {
  const payload = JSON.stringify({ channel, ...message });
  for (const client of clients) {
    if (client.joined && client !== except) sendFrame(client, 1, Buffer.from(payload));
  }
}

function validCoordinate(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function handleMessage(client, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    sendJson(client, { channel: "room", type: "error", message: "Invalid message format." });
    return;
  }
  if (!message || typeof message !== "object" || typeof message.channel !== "string") {
    sendJson(client, { channel: "room", type: "error", message: "A message channel is required." });
    return;
  }

  if (message.channel === "room") {
    if (message.type === "join") {
      if (client.joined) return;
      const name = typeof message.name === "string" ? message.name.trim().slice(0, 20) : "";
      client.player = {
        id: client.id,
        name: name || "Little Fish",
        x: .12 + Math.random() * .76,
        y: .2 + Math.random() * .55,
        direction: 1,
        fishType: fishTypes[Math.floor(Math.random() * fishTypes.length)]
      };
      client.joined = true;
      sendJson(client, {
        channel: "room",
        type: "state",
        selfId: client.id,
        players: Array.from(clients, entry => entry.player).filter(Boolean)
      });
      broadcast("room", { type: "player-joined", player: client.player }, client);
      sendJson(client, { channel: "drawing", type: "snapshot", strokes: drawingHistory });
      return;
    }
    if (!client.joined) {
      sendJson(client, { channel: "room", type: "error", message: "Join the tank before sending messages." });
      return;
    }
    if (message.type === "move") {
      if (!validCoordinate(message.x) || !validCoordinate(message.y)) return;
      client.player.x = message.x;
      client.player.y = message.y;
      if (Number.isInteger(message.direction) && message.direction >= 0 && message.direction < 6) {
        client.player.direction = message.direction;
      }
      broadcast("room", {
        type: "move",
        playerId: client.id,
        x: client.player.x,
        y: client.player.y,
        direction: client.player.direction
      }, client);
    } else if (message.type === "chat") {
      if (typeof message.text !== "string") return;
      const text = message.text.trim().slice(0, 240);
      if (text) {
        broadcast("room", {
          type: "chat",
          playerId: client.id,
          name: client.player.name,
          text
        });
      }
    } else {
      sendJson(client, { channel: "room", type: "error", message: "Unknown room message." });
    }
    return;
  }

  if (message.channel === "drawing") {
    if (!client.joined) {
      sendJson(client, { channel: "room", type: "error", message: "Join the tank before drawing." });
      return;
    }
    if (message.type === "clear") {
      drawingHistory.length = 0;
      broadcast("drawing", { type: "clear", playerId: client.id });
      return;
    }
    if (message.type !== "line" || !message.line || typeof message.line !== "object") return;
    const line = message.line;
    if (line.mode !== undefined && line.mode !== "pen" && line.mode !== "erase") return;
    const validPoint = point => point && validCoordinate(point.x) && validCoordinate(point.y);
    if (!validPoint(line.from) || !validPoint(line.to)) return;
    if (typeof line.color !== "string" || !/^#[0-9a-f]{6}$/i.test(line.color)) return;
    if (!Number.isFinite(line.size) || line.size < .001 || line.size > .08) return;
    const cleanLine = {
      from: { x: line.from.x, y: line.from.y },
      to: { x: line.to.x, y: line.to.y },
      color: line.color,
      size: line.size,
      mode: line.mode || "pen"
    };
    drawingHistory.push(cleanLine);
    if (drawingHistory.length > maxDrawingLines) drawingHistory.shift();
    broadcast("drawing", { type: "line", playerId: client.id, line: cleanLine }, client);
    return;
  }

  sendJson(client, { channel: "room", type: "error", message: "Unknown channel." });
}

function closeClient(client, code = 1000) {
  if (client.closed) return;
  client.closed = true;
  if (client.joined) {
    clients.delete(client);
    broadcast("room", { type: "player-left", playerId: client.id });
  } else {
    clients.delete(client);
  }
  sendFrame(client, 8, Buffer.from([code >> 8, code & 0xff]));
  client.socket.end();
}

function consumeFrames(client) {
  while (client.buffer.length >= 2 && !client.closed) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (!fin || (first & 0x70) !== 0 || !masked) {
      closeClient(client, 1002);
      return;
    }
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const largeLength = client.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(maxMessageBytes)) {
        closeClient(client, 1009);
        return;
      }
      length = Number(largeLength);
      offset = 10;
    }
    if (length > maxMessageBytes) {
      closeClient(client, 1009);
      return;
    }
    if (client.buffer.length < offset + 4 + length) return;
    const mask = client.buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(client.buffer.subarray(offset + 4, offset + 4 + length));
    client.buffer = client.buffer.subarray(offset + 4 + length);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

    if (opcode === 8) {
      closeClient(client);
    } else if (opcode === 9) {
      sendFrame(client, 10, payload);
    } else if (opcode === 1) {
      handleMessage(client, payload.toString("utf8"));
    } else if (opcode !== 10) {
      closeClient(client, 1003);
    }
  }
}

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
  if (request.url !== "/ws" || !isWebSocket || request.headers["sec-websocket-version"] !== "13" || !key) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));

  const client = {
    id: crypto.randomUUID(),
    socket,
    buffer: Buffer.alloc(0),
    player: null,
    joined: false,
    closed: false
  };
  clients.add(client);
  socket.on("data", chunk => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    if (client.buffer.length > maxMessageBytes + 14) {
      closeClient(client, 1009);
      return;
    }
    consumeFrames(client);
  });
  socket.on("error", error => {
    console.error(`WebSocket client error: ${error.message}`);
    if (!client.closed) {
      client.closed = true;
      clients.delete(client);
      if (client.joined) broadcast("room", { type: "player-left", playerId: client.id });
    }
  });
  socket.on("close", () => {
    if (!client.closed) {
      client.closed = true;
      clients.delete(client);
      if (client.joined) broadcast("room", { type: "player-left", playerId: client.id });
    }
  });
});

server.listen(port, () => {
  console.log(`Little Fish Tank is running at http://localhost:${port}`);
  console.log("WebSocket endpoint: /ws (room and drawing channels)");
});

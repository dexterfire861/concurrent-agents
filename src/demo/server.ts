/**
 * Serves the table UI and runs one conversation at a time.
 * Each run is a child process because Mozaik cannot initialize twice.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listGames, previewGame } from "./games.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 3847);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

let busy = false;

function send(res: http.ServerResponse, status: number, body: string, type = "text/plain"): void {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(body);
}

async function file(res: http.ServerResponse, rel: string): Promise<void> {
  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) {
    send(res, 403, "no");
    return;
  }
  try {
    await stat(filePath);
  } catch {
    send(res, 404, "not found");
    return;
  }
  const type = TYPES[path.extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function runConversation(res: http.ServerResponse, payload: string): void {
  busy = true;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src/demo/play.ts")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.write(payload);
  child.stdin.end();

  const push = (payload: string) => {
    res.write(`data: ${payload}\n\n`);
  };

  let leftover = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    leftover += chunk;
    const parts = leftover.split("\n");
    leftover = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) push(trimmed);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (!text) return;
    if (text.includes("mozaik cloud")) return;
    process.stderr.write(chunk);
  });

  const finish = () => {
    busy = false;
    if (!res.writableEnded) res.end();
  };

  child.on("close", (code) => {
    if (leftover.trim().startsWith("{")) push(leftover.trim());
    if (code && code !== 0) {
      push(JSON.stringify({ type: "error", message: "the conversation stopped early" }));
    }
    finish();
  });

  reqOnClose(res, () => {
    if (!child.killed) child.kill("SIGTERM");
  });
}

function reqOnClose(res: http.ServerResponse, fn: () => void): void {
  res.on("close", fn);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/games") {
    send(res, 200, JSON.stringify(listGames()), "application/json");
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/games/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/games/".length));
    try {
      send(res, 200, JSON.stringify(previewGame(id)), "application/json");
    } catch {
      send(res, 404, JSON.stringify({ error: "unknown game" }), "application/json");
    }
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await file(res, "index.html");
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/")) {
    await file(res, url.pathname.slice(1));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    if (busy) {
      send(res, 409, JSON.stringify({ error: "a conversation is already running" }), "application/json");
      return;
    }
    let scenario = "";
    let game = "";
    try {
      const body = JSON.parse(await readBody(req)) as { scenario?: unknown; game?: unknown };
      scenario = typeof body.scenario === "string" ? body.scenario.trim() : "";
      game = typeof body.game === "string" ? body.game.trim() : "";
    } catch {
      send(res, 400, JSON.stringify({ error: "could not read the situation" }), "application/json");
      return;
    }
    if (game) {
      runConversation(res, JSON.stringify({ game }));
      return;
    }
    if (scenario.length < 8) {
      send(res, 400, JSON.stringify({ error: "write a situation first" }), "application/json");
      return;
    }
    runConversation(res, JSON.stringify({ scenario }));
    return;
  }

  send(res, 404, "not found");
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Table → http://127.0.0.1:${PORT}\n`);
});

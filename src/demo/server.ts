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
// Loopback locally. A container sets HOST=0.0.0.0 so its proxy can reach us.
const HOST = process.env.HOST ?? "127.0.0.1";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Runs may overlap: each conversation is its own child process, so they share
 * nothing. The ceiling is here because every run holds a Node child and an
 * open stream, and the work is spent waiting on the model rather than on CPU.
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 3);

let running = 0;

/**
 * A public link spends a real API key: one run is roughly a dozen model calls.
 * Two ceilings, both overridable by env so a local run is unconstrained:
 * a per-visitor allowance, and a total for the life of the process.
 */
const RUNS_PER_IP = Number(process.env.RUNS_PER_IP ?? 6);
const IP_WINDOW_MS = Number(process.env.IP_WINDOW_MS ?? 30 * 60 * 1000);
const RUNS_TOTAL = Number(process.env.RUNS_TOTAL ?? 300);

const hits = new Map<string, number[]>();
let runsSoFar = 0;

/**
 * Behind the host's proxy the socket address is the proxy, not the visitor.
 * Take the last X-Forwarded-For entry: the proxy appends it, while anything to
 * its left came from the client and can be forged to dodge the per-IP limit.
 */
function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const joined = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  const last = joined?.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
  return last ?? req.socket.remoteAddress ?? "unknown";
}

/** Returns a reason to refuse, or null to allow. Counts the run when allowed. */
function refuse(req: http.IncomingMessage): string | null {
  if (runsSoFar >= RUNS_TOTAL) {
    return "This demo has used up its run budget. Clone the repo and run it with your own key.";
  }
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < IP_WINDOW_MS);
  if (recent.length >= RUNS_PER_IP) {
    const minutes = Math.max(1, Math.ceil((IP_WINDOW_MS - (now - recent[0]!)) / 60000));
    const runs = `${RUNS_PER_IP} conversation${RUNS_PER_IP === 1 ? "" : "s"}`;
    return `You have run ${runs}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  recent.push(now);
  hits.set(ip, recent);
  runsSoFar += 1;
  return null;
}

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
    if (!(await stat(filePath)).isFile()) throw new Error("not a file");
  } catch {
    send(res, 404, "not found");
    return;
  }
  const type = TYPES[path.extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
}

/** A situation is a paragraph. Anything far past that is spend, not a scene. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_SCENARIO_CHARS = 2000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function runConversation(res: http.ServerResponse, payload: string): void {
  running += 1;
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

  // A counter, unlike the boolean this replaced, must not be decremented twice.
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    running -= 1;
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
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  } catch {
    // A path like "//" is not a valid relative URL and used to crash the process.
    send(res, 400, "bad request");
    return;
  }

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
    if (running >= MAX_CONCURRENT) {
      send(
        res,
        409,
        JSON.stringify({ error: "Every table is busy right now. Try again in a moment." }),
        "application/json",
      );
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
    if (!game && scenario.length < 8) {
      send(res, 400, JSON.stringify({ error: "write a situation first" }), "application/json");
      return;
    }
    if (scenario.length > MAX_SCENARIO_CHARS) {
      send(
        res,
        400,
        JSON.stringify({ error: `Keep the situation under ${MAX_SCENARIO_CHARS} characters.` }),
        "application/json",
      );
      return;
    }
    // Only count against the budget once we know we are really going to run.
    const refusal = refuse(req);
    if (refusal) {
      send(res, 429, JSON.stringify({ error: refusal }), "application/json");
      return;
    }
    runConversation(res, JSON.stringify(game ? { game } : { scenario }));
    return;
  }

  send(res, 404, "not found");
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Table → http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}\n`);
});

/**
 * Harness of the integration tests: the real built app (`next start`) in front of a fake Django.
 * startApp() registers before/after hooks, so both servers run while the tests of one file run.
 * `node --test` runs the test files in parallel, so each file passes its own two ports.
 * `env` adds environment variables for next start (they win over .env.local).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

/** Sends the fake Django's answer: a status and an optional JSON body. */
export type Answer = (status: number, data?: object) => void;

/**
 * The fake Django of one test file. `path` is the part after /api/v1, `body` the parsed JSON ({} for
 * any other body), `raw` the bytes as sent (for example an image upload as multipart/form-data).
 */
export type FakeDjango = (req: IncomingMessage, path: string, body: Record<string, string>, answer: Answer, raw: Buffer) => unknown;

export function startApp({ nextPort, djangoPort, django, env = {} }: {
  nextPort: number;
  djangoPort: number;
  django: FakeDjango;
  env?: Record<string, string>;
}) {
  const djangoServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const json = raw.length > 0 && (req.headers["content-type"] ?? "").startsWith("application/json");
    await django(req, req.url!.replace("/api/v1", ""), json ? JSON.parse(raw.toString("utf8")) : {}, (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data && JSON.stringify(data));
    }, raw);
  });

  let next: ChildProcess;
  let nextErrors = "";
  before(async () => {
    await new Promise<void>((resolve) => djangoServer.listen(djangoPort, "127.0.0.1", resolve));
    next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(nextPort)], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DJANGO_API_URL: `http://127.0.0.1:${djangoPort}/api/v1`, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    next.stderr!.on("data", (chunk) => (nextErrors += chunk));
    for (let attempt = 0; ; attempt++) {
      try {
        await fetch(`http://localhost:${nextPort}/login`);
        return;
      } catch {
        if (next.exitCode !== null || attempt === 100) throw new Error(`next start failed:\n${nextErrors}`);
        await sleep(200);
      }
    }
  });
  after(() => {
    next.kill();
    djangoServer.close();
  });
}

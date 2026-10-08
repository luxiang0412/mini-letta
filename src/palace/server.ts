import { agentsSummary, commitDiff, conversations, fileAtHead, history, memoryTree, prompts } from "./data";
import { PALACE_PAGE } from "./page";

/**
 * The Memory Palace: a read-only web view over every agent's memory.
 * letta-code renders a static HTML file for /palace; a tiny server lets
 * mini-letta's Palace also run as the deployed service in Lab 6.
 */
export function startPalace(input: { home: string; port: number; hostname?: string }) {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const AGENT = /^\/api\/agents\/([\w~.-]+)\/(tree|file|history|commit|conversations|prompt)$/;

  return Bun.serve({
    port: input.port,
    hostname: input.hostname ?? "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET") return json({ error: "read-only" }, 405);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(PALACE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (url.pathname === "/api/agents") return json(agentsSummary(input.home));
      const match = url.pathname.match(AGENT);
      if (!match) return json({ error: "not found" }, 404);
      const [, agentId = "", view] = match;
      try {
        switch (view) {
          case "tree":
            return json(memoryTree(input.home, agentId));
          case "file": {
            const content = fileAtHead(input.home, agentId, url.searchParams.get("path") ?? "");
            return content === null ? json({ error: "no such file" }, 404) : json({ content });
          }
          case "history":
            return json(history(input.home, agentId));
          case "commit": {
            const diff = commitDiff(input.home, agentId, url.searchParams.get("sha") ?? "");
            return diff === null ? json({ error: "no such commit" }, 404) : json({ diff });
          }
          case "conversations":
            return json(conversations(input.home, agentId));
          case "prompt":
            return json(prompts(input.home, agentId, url.searchParams.get("conversation") ?? "default"));
        }
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
      return json({ error: "not found" }, 404);
    },
  });
}

import { RECALL_TOOL_NAME, searchRecall } from "@/recall/search";
import { stringArg, type Tool } from "./types";

/**
 * letta-code delegates recall to a forked `recall` subagent that runs
 * `letta messages search`; mini-letta exposes the search as a direct tool.
 */
export const recallSearchTool: Tool = {
  schema: {
    name: RECALL_TOOL_NAME,
    description:
      "Search ALL past messages (every conversation, including ones no longer in context). Use when you lack context from the past.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Distinctive keywords" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  async run(args, ctx) {
    const hits = searchRecall({
      home: ctx.home,
      agentId: ctx.agent.id,
      query: stringArg(args, "query"),
      limit: typeof args.limit === "number" ? args.limit : 5,
      currentConversationId: ctx.conversationId,
    });
    if (!hits.length) return "No matching messages.";
    return hits
      .map((h) => `[${h.createdAt} · ${h.conversationId} · ${h.role}] ${h.text.replace(/\s+/g, " ").slice(0, 200)}`)
      .join("\n");
  },
};

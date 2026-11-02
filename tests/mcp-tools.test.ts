import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Money rule 1 at the agent boundary: whatever an agent connects with, it gets no tool that moves money.

async function toolNames(env: Record<string, string>): Promise<string[]> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const { MILESTONE_API_KEY: _key, ...rest } = process.env as Record<string, string>;
  void _key;
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "mcp/server.mts"], env: { ...rest, MILESTONE_API: "http://localhost:9", ...env } }));
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

const BASE = ["accept_terms", "attack_terms", "create_milestone", "draft_terms", "get_milestone", "get_status", "submit_work"];

describe("MCP tools", () => {
  it("are exactly these, with or without a platform key, and none moves money", async () => {
    assert.deepEqual(await toolNames({}), BASE);
    const withKey = await toolNames({ MILESTONE_API_KEY: "msk_test" });
    assert.deepEqual(withKey, [...BASE, "list_milestones"].sort());
    for (const name of withKey) assert.doesNotMatch(name, /fund|capture|release|void|refund|payout|pay_|authorize/i);
  });
});

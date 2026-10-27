import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { closeClaudeProcesses } from "../src/claude-cli.ts";
import { streamClaudeCode } from "../src/stream.ts";

// Models sometimes call a tool name that is not in the request's tool list.
// Pi answers such calls with "Tool X not found" so the model can correct
// itself; the provider must hand the call to Pi instead of failing the turn.
test("passes tool calls outside Pi's inventory through to Pi", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-code-unknown-tool-")));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "max"}));
  process.exit(0);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1};
  const block = {type: "tool_use", id: "tool_1", name: process.env.FAKE_TOOL_NAME, input: {}};
  const events = [
    {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: block},
    {type: "content_block_delta", index: 0, delta: {type: "input_json_delta", partial_json: "{\\"path\\":\\"a\\"}"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "tool_use"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  const content = [{...block, input: {path: "a"}}];
  console.log(JSON.stringify({type: "assistant", message: {id: "m", role: "assistant", content, stop_reason: "tool_use", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "error_max_turns", is_error: true, usage}));
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);

  const model = {
    id: "sonnet",
    name: "Sonnet",
    api: "claude-code-stream-json",
    provider: "claude-code",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<any>;
  const context: TranscriptContext = {
    messages: [
      {
        role: "system",
        content: "system",
        toolsAdded: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } } as never,
          },
        ],
      },
      { role: "user", content: "read a", timestamp: 0 },
    ],
  } as TranscriptContext;

  const call = async (nativeName: string) => {
    const message = await streamClaudeCode(model, context, {
      cacheRetention: "none",
      env: { PI_CLAUDE_CODE_COMMAND: executable, FAKE_TOOL_NAME: nativeName },
      timeoutMs: 5_000,
    }).result();
    assert.equal(message.errorMessage, undefined);
    assert.equal(message.stopReason, "toolUse");
    const toolCalls = message.content.filter((block) => block.type === "toolCall");
    assert.equal(toolCalls.length, 1);
    assert.deepEqual(toolCalls[0]!.arguments, { path: "a" });
    return toolCalls[0]!.name;
  };

  try {
    assert.equal(await call("mcp__pi__read"), "read");
    // A blend of two registered namespaces, as seen from real models.
    assert.equal(await call("mcp__pi__mcp__paperplane__read"), "mcp__paperplane__read");
    // A bare name without the Pi prefix, such as a Claude Code built-in.
    assert.equal(await call("Read"), "Read");
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});

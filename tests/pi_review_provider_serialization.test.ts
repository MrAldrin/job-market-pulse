import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Optional installed-SDK inspection. Explicit package path, synthetic auth,
// throw at onPayload before transport, and a fetch tripwire: never live IO.
const sdk = process.env.PULSE_PI_AI_DIR;
const check = sdk ? test : test.skip;
const syntheticToken = `e30.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-offline" },
})).toString("base64url")}.synthetic`;

for (const [api, expectedField, compat] of [
  ["openai-responses", "max_output_tokens", undefined],
  ["openai-responses", undefined, { supportsMaxOutputTokens: false }],
  ["openai-completions", "max_completion_tokens", undefined],
  ["openai-completions", "max_tokens", { maxTokensField: "max_tokens" }],
  ["openai-codex-responses", undefined, undefined],
] as const) {
  check(`${api} installed serializer: ${expectedField ?? "cap omitted"}`, async () => {
    const { streamSimple } = await import(pathToFileURL(resolve(sdk!, "dist/api", `${api}.js`)).href);
    let payload: any;
    let transportCalls = 0;
    const model = {
      id: "gpt-6-luna", provider: api === "openai-codex-responses" ? "openai-codex" : "openai",
      api, baseUrl: "https://offline.invalid/v1", reasoning: true,
      input: ["text"], contextWindow: 100_000, maxTokens: 100_000,
      thinkingLevelMap: { xhigh: "xhigh" },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat,
    };
    const stream = streamSimple(model, {
      systemPrompt: "Synthetic offline serializer check",
      messages: [{ role: "user", content: "Synthetic candidate", timestamp: 0 }],
    }, {
      apiKey: api === "openai-codex-responses" ? syntheticToken : "sk-synthetic-offline",
      maxTokens: 50_000, reasoning: "xhigh", maxRetries: 0,
      transport: "sse", cacheRetention: "none", toolChoice: "none",
      onPayload: (body: any) => { payload = body; throw new Error("offline payload captured"); },
      fetch: () => { transportCalls++; throw new Error("transport forbidden"); },
    });
    await stream.result();
    expect(payload).toBeDefined();
    expect(transportCalls).toBe(0);
    if (api === "openai-codex-responses") {
      expect(payload.reasoning.effort).toBe("xhigh");
    }
    if (expectedField) expect(payload[expectedField]).toBe(50_000);
    else {
      expect(payload.max_output_tokens).toBeUndefined();
      expect(payload.max_tokens).toBeUndefined();
      expect(payload.max_completion_tokens).toBeUndefined();
    }
  });
}

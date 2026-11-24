import { createInterface } from "node:readline";
import { Predicate } from "effect";

const [harness, ...args] = process.argv.slice(2);

// The isolated spec uses the initial list. The full suite edits it first.
const preferredTermFixtures = [["old preferred term"], ["woodwork", "boat building"]];

if (harness === "pi" && args.includes("rpc") && args.includes("--offline") && args.includes("--no-extensions")) {
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, type } = JSON.parse(line);

    if (type !== "get_available_models") throw new Error("Unexpected Pi request");
    console.log(JSON.stringify({ type: "response", id, command: type, success: true, data: { models: [
      { provider: "invented-provider", id: "invented-next-model", reasoning: true, thinkingLevelMap: { high: null, xhigh: "xhigh" }, metadata: "Not for the browser" },
      { provider: "invented-provider", id: "without-reasoning", reasoning: false },
    ] } }));
  }
} else if (harness === "pi" && args.includes("--print") && args.includes("--no-tools") && args.includes("--no-session")
  && args.includes("--no-extensions") && args.includes("--offline") && args[args.indexOf("--model") + 1] === "openai/synthetic-pi-model") {
  const input = JSON.parse(await Bun.stdin.text());
  const system = args[args.indexOf("--system-prompt") + 1];
  const profile = system?.includes("tentative preference evidence");
  let reply;

  if (profile && Predicate.isString(input.profile_text) && input.reactions.length === 2
    && input.reactions[0].signal === "liked" && input.reactions[1].signal === "disliked") {
    const text = input.profile_text.includes("Prefers building tools")
      ? input.profile_text.replace("building tools", "building\u200B tools").replaceAll("\n", "\r\n")
      : input.profile_text + "\nPrefers building tools over direct sales.\n";

    reply = { reason: "One liked title and one disliked title suggest a preference.", text,
      job_ids: input.reactions.map((item: { job_id: string }) => item.job_id) };
  } else if (system?.includes("shared by at least two") && Object.keys(input).length === 1 && input.titles.length === 2
      && input.titles.every((title: string) => title.startsWith("Sales role"))) {
    reply = { reason: "Two saved sales roles have poor fit.", term: "Sales role" };
  } else if (system?.includes("repeated poor fit") && JSON.stringify(input) === JSON.stringify([{
    employer: "Fictional Quiet Beacon 10", titles: ["Sales role for a fictional demo service", "Sales role at an invented boat show"],
  }])) {
    reply = { candidate: 0 };
  } else if (system?.includes("not already covered") && preferredTermFixtures.some((preferred_terms) =>
    JSON.stringify(input) === JSON.stringify({ liked_titles: ["Datautvikler for oppdiktede tjenester"], preferred_terms }))) {
    reply = { reason: "The term occurs in the liked title.", term: "Datautvikler" };
  } else if (system?.includes("not past blocking evidence") && JSON.stringify(input) === JSON.stringify([{
    rule: "Datautvikler", list: "excluded_title_terms", liked_title: "Datautvikler for oppdiktede tjenester",
  }])) {
    reply = { candidate: 0 };
  } else throw new Error("Unexpected suggestion input");

  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "synthetic-pi-model", stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify(reply) }] } }));
} else if (harness === "claude" && args.includes("--no-session-persistence") && args[args.indexOf("--max-turns") + 1] === "1"
  && args[args.indexOf("--tools") + 1] === "" && (await Bun.stdin.text()).trim() === "Reply with OK.") {
  const model = args[args.indexOf("--model") + 1];
  const effort = args[args.indexOf("--effort") + 1];

  if (model === "sonnet" && effort === "high") {
    console.log(JSON.stringify({ type: "result", is_error: false, subtype: "success", stop_reason: "end_turn", num_turns: 1,
      modelUsage: { "claude-sonnet-4-6": {} }, result: "OK", usage: { input_tokens: 18, output_tokens: 1 } }));
  } else {
    console.log(JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "Private fake stderr or response must not surface" }));
  }
} else throw new Error("Unexpected harness arguments");

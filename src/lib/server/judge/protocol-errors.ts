import { Data } from "effect";

export class JudgeProtocolError extends Data.TaggedError("JudgeProtocolError")<{
  readonly code: "protocol_input_invalid" | "protocol_message_too_large" | "protocol_attempt_mismatch" | "protocol_output_invalid";
}> {}

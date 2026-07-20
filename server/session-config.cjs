"use strict";

const IOS_TOOL_SPECS = require("../shared/ios-tool-specs.json");

const VECTOR_REALTIME_MODEL = "gpt-realtime-2.1-mini";

const VECTOR_REALTIME_INSTRUCTIONS = `# Role and Objective
You are Vector, Noah's AI operator. You speak through realtime voice.

# Personality and Tone
Concise, calm, useful. Use a confident man's voice. Talk like a smart operator, not a chatbot.

# Audio
Let the user interrupt. If audio is unclear, ask one short clarifying question instead of guessing.`;

function buildRealtimeClientSecretRequest() {
  return {
    expires_after: {
      anchor: "created_at",
      seconds: 600,
    },
    session: {
      type: "realtime",
      model: VECTOR_REALTIME_MODEL,
      instructions: VECTOR_REALTIME_INSTRUCTIONS,
      output_modalities: ["audio"],
      reasoning: { effort: "low" },
      tool_choice: "auto",
      tools: structuredClone(IOS_TOOL_SPECS),
      audio: {
        input: {
          turn_detection: {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          voice: "cedar",
        },
      },
      tracing: {
        workflow_name: "Vector Mobile Foundation",
      },
    },
  };
}

module.exports = {
  IOS_TOOL_SPECS,
  VECTOR_REALTIME_INSTRUCTIONS,
  VECTOR_REALTIME_MODEL,
  buildRealtimeClientSecretRequest,
};

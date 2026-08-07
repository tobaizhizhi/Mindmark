import type { AgentToolCall, ToolCallingModel } from "../src/runtime-types.js";
import type { Hex } from "viem";

export const hex = (nibble: string): Hex => `0x${nibble.repeat(64)}` as Hex;
export const address = (nibble: string): `0x${string}` =>
  `0x${nibble.repeat(40)}` as `0x${string}`;

export class ScriptedModel implements ToolCallingModel {
  calls = 0;
  readonly inputs: Parameters<ToolCallingModel["nextTool"]>[0][] = [];

  constructor(private readonly script: AgentToolCall[]) {}

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    this.inputs.push(input);
    const call = this.script[this.calls];
    this.calls += 1;
    if (!call) throw new Error("Scripted model has no remaining tool call");
    return structuredClone(call);
  }
}

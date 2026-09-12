import { intakeSource } from "@mindmark/shared";
import { describe, expect, it } from "vitest";
import {
  detectLearningOutputLanguage,
  learnerFacingLanguageIssues,
} from "../src/language-policy.js";

describe("learning output language policy", () => {
  it("keeps Chinese technical material in Simplified Chinese", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: "CPU 调度器通过时间片和优先级平衡 fairness，并使用 IPC 完成进程通信。",
    }]);

    expect(detectLearningOutputLanguage(source.blocks)).toBe("zh-CN");
    expect(learnerFacingLanguageIssues([
      { field: "title", text: "CPU Scheduling and IPC" },
    ], "zh-CN")).toEqual(["title must be written in Simplified Chinese"]);
    expect(learnerFacingLanguageIssues([
      { field: "title", text: "CPU 调度与进程通信" },
    ], "zh-CN")).toEqual([]);
  });

  it("keeps English material in English", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: "The scheduler balances fairness and real-time deadlines across runnable processes.",
    }]);

    expect(detectLearningOutputLanguage(source.blocks)).toBe("en");
    expect(learnerFacingLanguageIssues([
      { field: "title", text: "CPU Scheduling" },
    ], "en")).toEqual([]);
  });
});

import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  listJourneysForOwner,
  prepareJourneyForOwner,
  type JourneyListStore,
  type JourneyStore,
  type StoredJourney,
} from "@/lib/server/journeys";

const journeyId = `0x${"31".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;

class RecordingStore implements JourneyStore {
  journey: Record<string, unknown> | undefined;
  chunks: Record<string, unknown>[] | undefined;

  async savePrepared(
    journey: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<void> {
    this.journey = journey;
    this.chunks = chunks;
  }

  async findOwned(): Promise<StoredJourney | null> {
    return null;
  }

  async markCreated(): Promise<void> {}
  async recordCreateTransaction(): Promise<void> {}
}

describe("prepare Journey service", () => {
  it("uses the authenticated owner and never returns stored source text", async () => {
    const store = new RecordingStore();
    const response = await prepareJourneyForOwner(
      {
        goal: "Understand callback ordering",
        pages: [
          {
            pageNumber: 1,
            text:
              "An external call transfers control. A callback can reenter while state is stale. Effects should be committed before interaction.",
          },
        ],
      },
      owner,
      store,
      journeyId,
    );

    expect(store.journey?.learner_address).toBe(owner);
    expect(store.journey?.journey_id).toBe(journeyId);
    expect(store.chunks).toHaveLength(2);
    expect(store.chunks?.every((chunk) => typeof chunk.source_text === "string")).toBe(true);
    expect(JSON.stringify(response)).not.toContain("source_text");
    expect(JSON.stringify(response)).not.toContain(
      "A callback can reenter while state is stale",
    );
    expect(response.chunks).toHaveLength(2);
  });
});

describe("list Journey service", () => {
  it("returns compact owner summaries without card content or FSRS internals", async () => {
    const store: JourneyListStore = {
      async listOwned() {
        return [
          {
            journey_id: journeyId,
            goal: "理解重入攻击与防御方式",
            status: "READY",
            deck: [{ question: "不应返回的问题正文" }, { question: "第二张卡" }],
            fsrs_states: {
              cardA: { due: "2026-07-22T00:00:00.000Z", stability: 1 },
              cardB: { due: "2026-07-25T00:00:00.000Z", stability: 2 },
            },
            plan_version: 2,
            created_at: "2026-07-20T00:00:00.000Z",
            updated_at: "2026-07-23T00:00:00.000Z",
          },
        ];
      },
    };

    const response = await listJourneysForOwner(
      owner,
      store,
      new Date("2026-07-23T00:00:00.000Z"),
    );

    expect(response.journeys[0]).toMatchObject({
      journeyId,
      cardCount: 2,
      studiedCardCount: 2,
      dueCount: 1,
      planVersion: 2,
    });
    expect(JSON.stringify(response)).not.toContain("不应返回的问题正文");
    expect(JSON.stringify(response)).not.toContain("stability");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChapterStudyCard } from "@mindmark/shared";
import { StudySessionView } from "@/features/learning-workspace/study-session-view";

const card: ChapterStudyCard = {
  id: `0x${"ab".repeat(32)}`,
  position: 0,
  type: "qa",
  question: "什么是时间片？",
  answer: "时间片是进程一次获得处理机的最大连续时间。",
  keyPoint: "限制连续执行时间",
  source: { page: 11, quote: "每个进程每次最多运行一个时间片，然后重新进入就绪队列。" },
  tags: ["调度"],
  importance: 4,
  initialDifficulty: 3,
  state: "NEW",
  dueAt: null,
  reps: 0,
  lapses: 0,
};

describe("Study Session view", () => {
  it("labels card state/type and keeps ratings hidden before answer reveal", () => {
    const markup = renderToStaticMarkup(<StudySessionView
      scope="chapter"
      cards={[card]}
      currentCard={card}
      studyIndex={0}
      answerVisible={false}
      ratingBusy={false}
      studyDone={false}
      studyFinishing={false}
      onExit={() => undefined}
      onReveal={() => undefined}
      onRate={() => undefined}
      onFeedback={async () => undefined}
    />);
    expect(markup).toContain("新卡");
    expect(markup).toContain("问答卡");
    expect(markup).toContain("显示答案");
    expect(markup).toContain("study-session-toolbar");
    expect(markup).toContain("study-session-card-stage");
    expect(markup).toContain("study-question-panel");
    expect(markup).not.toContain("掌握");
  });

  it("separates the answer, key point, feedback, and rating hierarchy", () => {
    const markup = renderToStaticMarkup(<StudySessionView
      scope="chapter"
      cards={[card]}
      currentCard={card}
      studyIndex={0}
      answerVisible
      ratingBusy={false}
      studyDone={false}
      studyFinishing={false}
      onExit={() => undefined}
      onReveal={() => undefined}
      onRate={() => undefined}
      onFeedback={async () => undefined}
    />);
    expect(markup).toContain("study-answer-panel");
    expect(markup).toContain("限制连续执行时间");
    expect(markup).toContain("报告卡片问题");
    expect(markup).toContain("掌握程度");
    expect(markup).not.toContain("这张卡片怎么样？");
  });

  it("renders a saving completion state before allowing exit", () => {
    const markup = renderToStaticMarkup(<StudySessionView
      scope="project"
      cards={[card]}
      currentCard={null}
      studyIndex={0}
      answerVisible={false}
      ratingBusy={false}
      studyDone
      studyFinishing
      onExit={() => undefined}
      onReveal={() => undefined}
      onRate={() => undefined}
      onFeedback={async () => undefined}
    />);
    expect(markup).toContain("项目今日复习完成");
    expect(markup).toContain("正在保存复习进度");
    expect(markup).toContain("disabled");
  });
});

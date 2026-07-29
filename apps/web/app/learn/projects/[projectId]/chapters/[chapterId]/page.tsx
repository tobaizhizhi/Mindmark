import type { Metadata } from "next";
import { ProjectLearningWorkspace } from "@/components/project-learning-workspace";

export const metadata: Metadata = { title: "章节学习 | Mindmark" };

export default async function ChapterPage(
  props: { params: Promise<{ projectId: `0x${string}`; chapterId: string }> },
) {
  const { projectId, chapterId } = await props.params;
  return <ProjectLearningWorkspace initialProjectId={projectId} initialChapterId={Number(chapterId)} />;
}

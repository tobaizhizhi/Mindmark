import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectLearningWorkspace } from "@/components/project-learning-workspace";

export const metadata: Metadata = { title: "章节学习 | Mindmark" };

export default async function ChapterPage(
  props: { params: Promise<{ projectId: `0x${string}`; chapterId: string }> },
) {
  const { projectId, chapterId } = await props.params;
  return <Suspense fallback={null}><ProjectLearningWorkspace initialProjectId={projectId} initialChapterId={Number(chapterId)} /></Suspense>;
}

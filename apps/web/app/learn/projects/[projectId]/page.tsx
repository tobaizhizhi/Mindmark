import type { Metadata } from "next";
import { ProjectLearningWorkspace } from "@/components/project-learning-workspace";

export const metadata: Metadata = { title: "项目章节 | Mindmark" };

export default async function ProjectPage(
  props: { params: Promise<{ projectId: `0x${string}` }> },
) {
  const { projectId } = await props.params;
  return <ProjectLearningWorkspace initialProjectId={projectId} />;
}

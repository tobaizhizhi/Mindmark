import type { Metadata } from "next";
import { ProjectCreationWorkbench } from "@/components/project-creation-workbench";

export const metadata: Metadata = {
  title: "确认章节结构 | Mindmark",
  description: "检查并调整 AI 从学习资料中整理出的章节结构。",
};

export default function ProjectOutlinePage() {
  return <ProjectCreationWorkbench mode="outline" />;
}

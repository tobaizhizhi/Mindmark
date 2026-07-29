import type { Metadata } from "next";
import { ProjectCreationWorkbench } from "@/components/project-creation-workbench";

export const metadata: Metadata = {
  title: "新建 Chapter Project | Mindmark",
  description: "先确认 AI 章节大纲，再创建可验证的学习 Project。",
};

export default function NewProjectPage() {
  return <ProjectCreationWorkbench />;
}

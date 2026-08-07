import type { Metadata } from "next";
import { ProjectCreationWorkbench } from "@/components/project-creation-workbench";

export const metadata: Metadata = {
  title: "新建学习资料 | Mindmark",
  description: "先确认 AI 生成的章节大纲，再创建可验证的学习项目。",
};

export default function NewProjectPage() {
  return <ProjectCreationWorkbench />;
}

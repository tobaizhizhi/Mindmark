import type { Metadata } from "next";
import { LearningWorkbench } from "@/components/learning-workbench";

export const metadata: Metadata = {
  title: "学习工作台 | Mindmark",
  description: "新建 AI 知识卡学习项目，或继续以前的间隔复习。",
};

export default function LearnPage() {
  return <LearningWorkbench />;
}

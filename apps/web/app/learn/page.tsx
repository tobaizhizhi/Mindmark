import type { Metadata } from "next";
import { DocumentLibraryWorkspace } from "@/components/document-library-workspace";

export const metadata: Metadata = {
  title: "资料和文件夹 | Mindmark",
  description: "整理上传资料和预置卡包，从章节进入知识卡学习。",
};

export default function LearnPage() {
  return <DocumentLibraryWorkspace />;
}

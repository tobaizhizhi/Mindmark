import type { Metadata } from "next";
import { OperationsWorkspace } from "@/components/operations-workspace";

export const metadata: Metadata = {
  title: "运行诊断 | Mindmark",
  description: "受限访问的 Mindmark 工作流运行诊断。",
};

export default function OperationsPage() {
  return <OperationsWorkspace />;
}

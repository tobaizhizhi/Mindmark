import type { Metadata } from "next";
import { CardPackCatalogWorkspace } from "@/components/card-pack-catalog-workspace";

export const metadata: Metadata = {
  title: "发现卡包 | Mindmark",
  description: "浏览可立即学习的预置知识卡包。",
};

export default function CardPacksPage() {
  return <CardPackCatalogWorkspace />;
}

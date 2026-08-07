import type { Metadata } from "next";
import { CardPackDetailWorkspace } from "@/components/card-pack-catalog-workspace";

export const metadata: Metadata = {
  title: "卡包详情 | Mindmark",
};

export default async function CardPackDetailPage({
  params,
}: {
  params: Promise<{ packVersionId: string }>;
}) {
  const { packVersionId } = await params;
  return <CardPackDetailWorkspace packVersionId={packVersionId} />;
}

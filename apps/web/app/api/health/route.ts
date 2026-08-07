export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { status: "ok", service: "mindmark-web" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

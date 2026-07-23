import fixture from "../../../../../../fixtures/reentrancy-demo-zh.json";

export function GET() {
  return Response.json({ goal: fixture.goal, pages: fixture.pages });
}

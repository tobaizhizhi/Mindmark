import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectSourceInput } from "@/components/project-source-input";

describe("ProjectSourceInput", () => {
  it("renders a PDF chooser in the V2 project flow", () => {
    const markup = renderToStaticMarkup(
      <ProjectSourceInput
        mode="pdf"
        onModeChange={() => undefined}
        text=""
        onTextChange={() => undefined}
        fileInputRef={createRef<HTMLInputElement>()}
        onFile={() => undefined}
        fileName=""
        pageCount={0}
        characterCount={0}
        isExtracting={false}
      />,
    );

    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept=".pdf,application/pdf"');
    expect(markup).toContain("选择 PDF 资料");
  });
});

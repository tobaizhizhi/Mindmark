"use client";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  FileWarning,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type PdfPageLike = {
  getViewport: (options: { scale: number }) => { width: number; height: number; scale: number };
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number; scale: number };
    transform?: [number, number, number, number, number, number];
  }) => { promise: Promise<void>; cancel?: () => void };
  getTextContent: () => Promise<{ items: unknown[] }>;
  cleanup?: () => void;
};

type PdfDocumentLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  destroy: () => Promise<void>;
};

type TextLayerLike = {
  render: () => Promise<void>;
  cancel?: () => void;
};

type PdfJsLike = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (source: { url: string }) => { promise: Promise<PdfDocumentLike>; destroy?: () => Promise<void> };
  TextLayer: new (options: {
    textContentSource: { items: unknown[] };
    container: HTMLDivElement;
    viewport: { width: number; height: number; scale: number };
  }) => TextLayerLike;
};

function isRenderingCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "RenderingCancelledException"
    || (typeof candidate.message === "string" && /rendering cancelled/iu.test(candidate.message));
}

function ensurePdfJsMapCompatibility(): void {
  const prototype = Map.prototype as Map<unknown, unknown> & {
    getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown;
  };
  if (prototype.getOrInsertComputed) return;
  Object.defineProperty(prototype, "getOrInsertComputed", {
    configurable: true,
    writable: true,
    value(this: Map<unknown, unknown>, key: unknown, callback: (key: unknown) => unknown) {
      if (this.has(key)) return this.get(key);
      const value = callback(key);
      this.set(key, value);
      return value;
    },
  });
}

type PdfDocumentViewerProps = {
  fileUrl: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  targetPage?: number | null;
  onUnavailable?: () => void;
  uploadError?: string | null;
  uploading?: boolean;
  onUploadRequest?: () => void;
  onPageChange?: (pageNumber: number) => void;
  sourceLoading?: boolean;
  toolbarModes?: ReactNode;
  toolbarEnd?: ReactNode;
};

export function nearbyPdfPages(pageNumbers: number[], center: number): number[] {
  const first = pageNumbers[0] ?? center;
  const last = pageNumbers.at(-1) ?? center;
  return [center - 1, center, center + 1].filter((pageNumber) => (
    pageNumber >= first && pageNumber <= last
  ));
}

function textFromItems(items: unknown[]): string {
  return items
    .flatMap((item) => {
      if (!item || typeof item !== "object" || !("str" in item)) return [];
      const value = (item as { str?: unknown }).str;
      return typeof value === "string" && value.trim() ? [value.trim()] : [];
    })
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function copyTextWithTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

export async function copyPdfText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | null | undefined = navigator.clipboard,
  legacyCopy: (value: string) => boolean = copyTextWithTextarea,
): Promise<void> {
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return;
    }
  } catch {
    // Clipboard permissions vary by browser; the selection-based fallback works without them.
  }
  if (!legacyCopy(text)) throw new Error("Browser rejected clipboard access");
}

export function PdfDocumentViewer(props: PdfDocumentViewerProps) {
  const [pdfjs, setPdfjs] = useState<PdfJsLike | null>(null);
  const [documentProxy, setDocumentProxy] = useState<PdfDocumentLike | null>(null);
  const [loadedFileUrl, setLoadedFileUrl] = useState<string | null>(null);
  const [pageNumbers, setPageNumbers] = useState<number[]>([]);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(() => new Set());
  const [pageTexts, setPageTexts] = useState<Map<number, string>>(() => new Map());
  const [scale, setScale] = useState(1);
  const [activePage, setActivePage] = useState(props.pageStart ?? 1);
  const [loading, setLoading] = useState(Boolean(props.fileUrl));
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{
    pageNumber: number;
    state: "copying" | "copied" | "error";
  } | null>(null);
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const renderedScaleRef = useRef(new Map<number, number>());
  const unavailableRef = useRef(props.onUnavailable);
  const onPageChangeRef = useRef(props.onPageChange);

  useEffect(() => {
    unavailableRef.current = props.onUnavailable;
  }, [props.onUnavailable]);

  useEffect(() => {
    onPageChangeRef.current = props.onPageChange;
  }, [props.onPageChange]);

  useEffect(() => {
    onPageChangeRef.current?.(activePage);
  }, [activePage]);

  useEffect(() => {
    let active = true;
    ensurePdfJsMapCompatibility();
    void import("pdfjs-dist")
      .then((module) => {
        if (!active) return;
        const loaded = module as unknown as PdfJsLike;
        loaded.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        setPdfjs(loaded);
      })
      .catch(() => {
        if (active) setError("PDF 阅读器加载失败");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!props.fileUrl || !pdfjs) {
      return;
    }
    let active = true;
    const loadingTask = pdfjs.getDocument({ url: props.fileUrl });
    void loadingTask.promise
      .then((loaded) => {
        if (!active) {
          void loaded.destroy();
          return;
        }
        const first = Math.max(1, props.pageStart ?? 1);
        const last = Math.min(loaded.numPages, props.pageEnd ?? loaded.numPages);
        setDocumentProxy(loaded);
        setLoadedFileUrl(props.fileUrl);
        const nextPageNumbers = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
        setPageNumbers(nextPageNumbers);
        setRenderedPages(new Set(nextPageNumbers.slice(0, 2)));
        setPageTexts(new Map());
        renderedScaleRef.current.clear();
        setActivePage(first);
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError("原版 PDF 暂时无法加载");
          unavailableRef.current?.();
        }
      });
    return () => {
      active = false;
      if (loadingTask.destroy) void loadingTask.destroy();
    };
  }, [pdfjs, props.fileUrl, props.pageEnd, props.pageStart]);

  useEffect(() => {
    if (!documentProxy || !pdfjs || loadedFileUrl !== props.fileUrl || pageNumbers.length === 0) return;
    let active = true;
    const renderTasks: Array<{ cancel?: () => void }> = [];
    void (async () => {
      const pagesToRender = [...renderedPages]
        .filter((pageNumber) => pageNumbers.includes(pageNumber))
        .sort((left, right) => left - right);
      for (const pageNumber of pagesToRender) {
        const container = pageRefs.current.get(pageNumber);
        if (!container || !active) continue;
        const canvas = container.querySelector("canvas");
        const textLayerContainer = container.querySelector(".pdf-text-layer");
        if (!(canvas instanceof HTMLCanvasElement) || !(textLayerContainer instanceof HTMLDivElement)) continue;
        const page = await documentProxy.getPage(pageNumber);
        if (!active) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = container.clientWidth > 0
          ? Math.min(1, container.clientWidth / baseViewport.width)
          : 1;
        const viewport = page.getViewport({ scale: Number((scale * fitScale).toFixed(4)) });
        if (renderedScaleRef.current.get(pageNumber) === viewport.scale) continue;
        const deviceScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * deviceScale);
        canvas.height = Math.floor(viewport.height * deviceScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        textLayerContainer.style.width = `${viewport.width}px`;
        textLayerContainer.style.height = `${viewport.height}px`;
        textLayerContainer.style.setProperty("--total-scale-factor", String(viewport.scale));
        textLayerContainer.replaceChildren();
        const context = canvas.getContext("2d");
        if (!context) continue;
        const renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: [deviceScale, 0, 0, deviceScale, 0, 0],
        });
        renderTasks.push(renderTask);
        const textContent = await page.getTextContent();
        await renderTask.promise;
        if (!active) return;
        const textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        // TextLayer writes CSS round() dimensions. Explicit pixels keep the layer
        // aligned in browsers that do not yet support that function.
        textLayerContainer.style.width = `${viewport.width}px`;
        textLayerContainer.style.height = `${viewport.height}px`;
        await textLayer.render();
        renderedScaleRef.current.set(pageNumber, viewport.scale);
        setPageTexts((current) => new Map(current).set(pageNumber, textFromItems(textContent.items)));
        page.cleanup?.();
      }
    })().catch((caught: unknown) => {
      if (!active || isRenderingCancellation(caught)) return;
      console.error("PDF page rendering failed", caught);
      setError("PDF 页面渲染失败");
    });
    return () => {
      active = false;
      renderTasks.forEach((task) => task.cancel?.());
    };
  }, [documentProxy, loadedFileUrl, pageNumbers, pdfjs, props.fileUrl, renderedPages, scale]);

  useEffect(() => {
    if (!props.targetPage) return;
    const frame = window.requestAnimationFrame(() => {
      setRenderedPages((current) => {
        if (current.has(props.targetPage!)) return current;
        const next = new Set(current);
        next.add(props.targetPage!);
        return next;
      });
      window.requestAnimationFrame(() => {
        pageRefs.current.get(props.targetPage!)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.targetPage, pageNumbers]);

  useEffect(() => {
    if (pageNumbers.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .map((entry) => Number((entry.target as HTMLElement).dataset.page))
        .filter(Number.isInteger)
        .sort((left, right) => left - right)[0];
      if (!visible) return;
      setActivePage(visible);
      setRenderedPages((current) => {
        const next = new Set(current);
        nearbyPdfPages(pageNumbers, visible).forEach((pageNumber) => next.add(pageNumber));
        return next.size === current.size ? current : next;
      });
    }, { rootMargin: "500px 0px", threshold: 0.01 });
    pageNumbers.forEach((pageNumber) => {
      const page = pageRefs.current.get(pageNumber);
      if (page) observer.observe(page);
    });
    return () => observer.disconnect();
  }, [pageNumbers]);

  const visiblePageNumbers = useMemo(
    () => loadedFileUrl === props.fileUrl ? pageNumbers : [],
    [loadedFileUrl, pageNumbers, props.fileUrl],
  );
  const pageIndex = useMemo(() => Math.max(0, visiblePageNumbers.indexOf(activePage)), [activePage, visiblePageNumbers]);
  const displayError = error && (loadedFileUrl === props.fileUrl || !pdfjs) ? error : null;
  const displayLoading = Boolean(props.sourceLoading || (props.fileUrl && !displayError && (loading || loadedFileUrl !== props.fileUrl)));
  const activeCopyState = copyStatus?.pageNumber === activePage ? copyStatus.state : null;
  const activePageText = pageTexts.get(activePage);
  const copyLabel = activeCopyState === "copying"
    ? "正在复制本页"
    : activeCopyState === "copied"
      ? "本页已复制"
      : activeCopyState === "error"
        ? "复制失败"
        : activePageText
          ? "复制本页文字"
          : "本页没有可复制文字";

  function jumpToPage(pageNumber: number) {
    const bounded = Math.min(visiblePageNumbers.at(-1) ?? pageNumber, Math.max(visiblePageNumbers[0] ?? pageNumber, pageNumber));
    setRenderedPages((current) => new Set(current).add(bounded));
    window.requestAnimationFrame(() => {
      pageRefs.current.get(bounded)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    setActivePage(bounded);
  }

  async function copyPage(pageNumber: number) {
    const text = pageTexts.get(pageNumber);
    if (!text) return;
    setCopyStatus({ pageNumber, state: "copying" });
    try {
      await copyPdfText(text);
      setCopyStatus({ pageNumber, state: "copied" });
    } catch {
      setCopyStatus({ pageNumber, state: "error" });
    } finally {
      window.setTimeout(() => setCopyStatus((current) => (
        current?.pageNumber === pageNumber ? null : current
      )), 1_500);
    }
  }

  return (
    <section className="pdf-document-viewer" aria-label="原版 PDF">
      <div className="pdf-viewer-toolbar">
        <div className="pdf-reader-modes">{props.toolbarModes}</div>
        <div className="pdf-reader-controls">
          <div className="pdf-viewer-page-control">
            <button type="button" aria-label="上一页" title="上一页" disabled={pageIndex <= 0 || visiblePageNumbers.length === 0} onClick={() => jumpToPage(pageNumbers[pageIndex - 1] ?? activePage)}><ChevronLeft /></button>
            <span>{visiblePageNumbers.length > 0 ? `${activePage} / ${documentProxy?.numPages ?? "…"}` : "- / -"}</span>
            <button type="button" aria-label="下一页" title="下一页" disabled={pageIndex < 0 || pageIndex >= pageNumbers.length - 1} onClick={() => jumpToPage(pageNumbers[pageIndex + 1] ?? activePage)}><ChevronRight /></button>
          </div>
          <div className="pdf-reader-zoom">
            <button type="button" aria-label="缩小" title="缩小" disabled={!documentProxy} onClick={() => setScale((value) => Math.max(0.7, Number((value - 0.1).toFixed(2))))}><Minus /></button>
            <span>{Math.round(scale * 100)}%</span>
            <button type="button" aria-label="放大" title="放大" disabled={!documentProxy} onClick={() => setScale((value) => Math.min(2.2, Number((value + 0.1).toFixed(2))))}><Plus /></button>
          </div>
          <button
            type="button"
            className="pdf-reader-copy"
            data-status={activeCopyState ?? "idle"}
            aria-label={copyLabel}
            title={copyLabel}
            disabled={!activePageText || activeCopyState === "copying"}
            onClick={() => void copyPage(activePage)}
          >
            {activeCopyState === "copying" ? <LoaderCircle className="animate-spin" /> : activeCopyState === "copied" ? <Check /> : activeCopyState === "error" ? <CircleAlert /> : <Copy />}
          </button>
          {props.fileUrl ? <a href={props.fileUrl} target="_blank" rel="noreferrer" aria-label="在新窗口打开 PDF" title="在新窗口打开 PDF"><Download /></a> : null}
          {props.toolbarEnd}
        </div>
      </div>
      {props.sourceLoading ? (
        <div className="pdf-viewer-state"><LoaderCircle className="animate-spin" /><span>正在读取原版 PDF</span></div>
      ) : !props.fileUrl ? (
        <div className="pdf-viewer-state">
          <FileWarning />
          <strong>这个项目还没有保存原版 PDF</strong>
          {props.uploadError ? <span className="text-[var(--danger)]">{props.uploadError}</span> : null}
          {props.onUploadRequest ? (
            <button type="button" disabled={props.uploading} onClick={props.onUploadRequest}>
              {props.uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}
              {props.uploading ? "正在上传 PDF" : "重新上传 PDF"}
            </button>
          ) : null}
        </div>
      ) : displayError ? (
        <div className="pdf-viewer-state pdf-viewer-error">
          <FileWarning />
          <span>{displayError}</span>
          <button type="button" onClick={() => window.location.reload()}><RotateCcw />重试</button>
        </div>
      ) : (
        <>
          {displayLoading ? <div className="pdf-viewer-state"><LoaderCircle className="animate-spin" /><span>正在加载原版 PDF</span></div> : null}
          <div className="pdf-pages" aria-busy={displayLoading}>
            {visiblePageNumbers.map((pageNumber) => (
              <article
                key={pageNumber}
                ref={(element) => { if (element) pageRefs.current.set(pageNumber, element); else pageRefs.current.delete(pageNumber); }}
                className="pdf-page-shell"
                data-page={pageNumber}
              >
                <div className="pdf-page-label">
                  <span>第 {pageNumber} 页</span>
                  {pageTexts.has(pageNumber) && !pageTexts.get(pageNumber) ? <span className="pdf-page-copy-note">本页没有可复制文字</span> : null}
                </div>
                <div className="pdf-page-surface" data-rendered={renderedPages.has(pageNumber)}>
                  {renderedPages.has(pageNumber) ? <><canvas /><div className="pdf-text-layer" /></> : <LoaderCircle className="size-5 animate-spin text-[var(--muted)]" />}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

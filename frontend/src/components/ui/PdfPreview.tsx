import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { attachmentsApi, type Attachment } from "@/lib/api";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Preview policy:
//   - File size ≤ 10 MB: show all pages, but at most 50.
//   - File size > 10 MB: show only the first 5 pages.
const MAX_FULL_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_PAGES_SMALL = 50;
const MAX_PAGES_LARGE = 5;

interface PdfPreviewProps {
  attachment: Attachment;
}

export function PdfPreview({ attachment }: PdfPreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [maxPages, setMaxPages] = useState(MAX_PAGES_SMALL);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  // Load document — fetch base64-wrapped JSON (served as application/json)
  // so download managers never see application/pdf and can't hijack it.
  useEffect(() => {
    let cancelled = false;
    let loadedDoc: pdfjsLib.PDFDocumentProxy | null = null;
    setLoading(true);
    setError(null);

    attachmentsApi
      .previewData(attachment.id)
      .then((resp) => {
        if (cancelled) return;
        // Decode base64 into raw bytes for PDF.js.
        const bin = atob(resp.data_base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // Apply the size/page policy based on the real file size.
        const limit = resp.size <= MAX_FULL_SIZE ? MAX_PAGES_SMALL : MAX_PAGES_LARGE;
        setMaxPages(limit);
        return pdfjsLib.getDocument({
          data: bytes,
          // CJK character maps — required for Chinese/Japanese/Korean PDFs
          // that use CID font encoding instead of Unicode. Without these,
          // Chinese text renders as boxes/garbage.
          cMapUrl: "/cmaps/",
          cMapPacked: true,
          // Standard font data for PDFs that don't embed their fonts.
          standardFontDataUrl: "/standard_fonts/",
        }).promise;
      })
      .then((d) => {
        if (cancelled || !d) return;
        loadedDoc = d;
        setDoc(d);
        setNumPages(d.numPages);
        setPage(1);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg || t("pdfPreview.loadFailed"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (loadedDoc) loadedDoc.destroy().catch(() => {});
    };
  }, [attachment.id]);

  // Render current page
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    setRendering(true);
    doc.getPage(page)
      .then((pdfPage) => {
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const viewport = pdfPage.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTask = pdfPage.render({ canvasContext: ctx, viewport });
        return renderTask.promise;
      })
      .then(() => {
        if (!cancelled) setRendering(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "";
        if (!/cancelled/i.test(msg)) setRendering(false);
      });

    return () => {
      cancelled = true;
      if (renderTask) renderTask.cancel();
    };
  }, [doc, page, scale]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-label-14 text-secondary gap-2">
        <Loader2 size={16} className="animate-spin" /> {t("pdfPreview.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-label-14 text-secondary">
        <span>{t("pdfPreview.pdfLoadFailed")}</span>
        <span className="text-label-12">{error}</span>
      </div>
    );
  }

  const effectivePages = Math.min(numPages, maxPages);
  const truncated = numPages > maxPages;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-center gap-3 px-4 py-1.5 border-b shrink-0 text-secondary"
        style={{ backgroundColor: "var(--geist-bg-200)", borderColor: "var(--geist-border)" }}
      >
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || rendering}
          className="h-7 w-7 inline-flex items-center justify-center rounded-geist hover:bg-[var(--geist-bg-300)] disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={t("pdfPreview.prevPage")}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-label-12 tabular-nums min-w-[60px] text-center">
          {page} / {effectivePages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(effectivePages, p + 1))}
          disabled={page >= effectivePages || rendering}
          className="h-7 w-7 inline-flex items-center justify-center rounded-geist hover:bg-[var(--geist-bg-300)] disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={t("pdfPreview.nextPage")}
        >
          <ChevronRight size={16} />
        </button>
        <div className="w-px h-4 mx-1" style={{ backgroundColor: "var(--geist-border)" }} />
        <button
          onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(1)))}
          disabled={rendering}
          className="h-7 w-7 inline-flex items-center justify-center rounded-geist hover:bg-[var(--geist-bg-300)] disabled:opacity-40"
          aria-label={t("pdfPreview.zoomOut")}
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-label-12 tabular-nums min-w-[44px] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(1)))}
          disabled={rendering}
          className="h-7 w-7 inline-flex items-center justify-center rounded-geist hover:bg-[var(--geist-bg-300)] disabled:opacity-40"
          aria-label={t("pdfPreview.zoomIn")}
        >
          <ZoomIn size={16} />
        </button>
      </div>

      {/* Truncation notice */}
      {truncated && (
        <div
          className="flex items-center justify-center gap-1.5 px-4 py-1 text-label-12 shrink-0"
          style={{ backgroundColor: "var(--geist-warning-bg, rgba(247,184,71,0.12))", color: "var(--geist-warning, #b45309)" }}
        >
          <AlertTriangle size={12} />
          {attachment.size > MAX_FULL_SIZE
            ? t("pdfPreview.fileLarge", { size: formatSize(attachment.size), shown: MAX_PAGES_LARGE, total: numPages })
            : t("pdfPreview.fileManyPages", { shown: MAX_PAGES_SMALL, total: numPages })}
        </div>
      )}

      {/* Page canvas */}
      <div
        className="flex-1 min-h-0 overflow-auto flex justify-center p-4"
        style={{ backgroundColor: "#525659" }}
      >
        <canvas
          ref={canvasRef}
          className="shadow-lg bg-white"
          style={{ display: "block" }}
        />
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

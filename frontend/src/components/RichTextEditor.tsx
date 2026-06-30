import {
  useRef,
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Heading1,
  Heading2,
  Pilcrow,
  List,
  ListOrdered,
  Link as LinkIcon,
  Image as ImageIcon,
  Undo2,
  Redo2,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useTranslation } from "react-i18next";

export interface InlineImageInfo {
  cid: string;
  dataUrl: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  onImageAdd?: (image: InlineImageInfo) => void;
  onFilesDrop?: (files: FileList | File[]) => void;
  toolbarExtra?: ReactNode;
  dragOverlayText?: string;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  /** Called when the user selects text inside the editor. `text` is the
   *  selected plain-text content; `rect` is the bounding rect of the
   *  selection (useful for positioning a floating button). */
  onSelectionChange?: (text: string, rect: DOMRect | null) => void;
}

/** Methods exposed to the parent via `ref`. */
export interface RichTextEditorHandle {
  /** The underlying contentEditable div element. */
  editorEl: HTMLDivElement | null;
  /** Replace the current selection with `html`. No-op if there is no selection. */
  replaceSelection: (html: string) => void;
}

const EDITOR_CSS = `
.rt-editor {
  color: var(--geist-primary);
  caret-color: var(--geist-primary);
}
.rt-editor:focus { outline: none; }
.rt-editor::selection,
.rt-editor *::selection {
  background: var(--geist-bg-200);
  color: var(--geist-primary);
}
.rt-editor:empty:before {
  content: attr(data-placeholder);
  color: var(--geist-tertiary);
  pointer-events: none;
}
.rt-editor img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  cursor: pointer;
  transition: outline 0.15s;
  vertical-align: middle;
}
.rt-editor img.rt-img-selected {
  outline: 2px solid var(--geist-secondary);
  outline-offset: 2px;
}
.rt-editor a,
.rt-editor a:visited,
.rt-editor a:hover,
.rt-editor a:active {
  color: inherit !important;
  text-decoration: underline;
  text-decoration-color: currentColor;
}
.rt-editor [style*="color: blue"],
.rt-editor [style*="color:blue"],
.rt-editor [style*="color: #0000ff"],
.rt-editor [style*="color:#0000ff"],
.rt-editor [style*="color: rgb(0, 0, 255)"],
.rt-editor [style*="color:rgb(0,0,255)"],
.rt-editor [style*="color: -webkit-link"],
.rt-editor [style*="color:-webkit-link"] {
  color: inherit !important;
}
.rt-editor h1 { font-size: 1.5em; font-weight: 700; margin: 0.5em 0; }
.rt-editor h2 { font-size: 1.25em; font-weight: 600; margin: 0.5em 0; }
.rt-editor p { margin: 0.4em 0; }
.rt-editor ul { list-style: disc; padding-left: 1.5em; margin: 0.4em 0; }
.rt-editor ol { list-style: decimal; padding-left: 1.5em; margin: 0.4em 0; }
.rt-editor blockquote {
  border-left: 3px solid var(--geist-border);
  padding-left: 1em;
  margin: 0.5em 0;
  color: var(--geist-secondary);
}
.rt-editor pre {
  background: var(--geist-bg-200);
  padding: 0.75em;
  border-radius: 6px;
  font-family: monospace;
  font-size: 0.875em;
  overflow-x: auto;
}
.rt-editor code {
  background: var(--geist-bg-200);
  padding: 0.15em 0.3em;
  border-radius: 3px;
  font-family: monospace;
  font-size: 0.875em;
}
.rt-divider {
  width: 1px;
  height: 16px;
  background: var(--geist-border);
  margin: 0 2px;
  flex-shrink: 0;
}
`;

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  {
    value,
    onChange,
    onImageAdd,
    onFilesDrop,
    toolbarExtra,
    dragOverlayText,
    placeholder,
    className,
    style,
    onSelectionChange,
  },
  ref,
) {
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const lastHtmlRef = useRef(value);
  const [selectedImg, setSelectedImg] = useState<HTMLImageElement | null>(
    null,
  );
  const [handle, setHandle] = useState({ x: 0, y: 0, show: false });
  const [dragActive, setDragActive] = useState(false);

  // Expose imperative handle to parent.
  useImperativeHandle(ref, () => ({
    get editorEl() {
      return editorRef.current;
    },
    replaceSelection(html: string) {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      document.execCommand("insertHTML", false, html);
      // Sync the updated content back to state.
      const updated = sanitizeEditorHtml(el.innerHTML);
      lastHtmlRef.current = updated;
      onChange(updated);
    },
  }), [onChange]);

  // Track text selection inside the editor for the "Add to AI context" button.
  useEffect(() => {
    if (!onSelectionChange) return;
    const handleSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) {
        onSelectionChange("", null);
        return;
      }
      // Only care about selections inside our editor.
      const range = sel.getRangeAt(0);
      const el = editorRef.current;
      if (!el || !el.contains(range.commonAncestorContainer)) {
        onSelectionChange("", null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        onSelectionChange("", null);
        return;
      }
      const rect = range.getBoundingClientRect();
      onSelectionChange(text, rect);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [onSelectionChange]);

  // Sync external value → editor (e.g., loading a draft)
  useEffect(() => {
    if (editorRef.current && value !== lastHtmlRef.current) {
      editorRef.current.innerHTML = value;
      lastHtmlRef.current = value;
    }
  }, [value]);

  // Cleanup selected image on unmount
  useEffect(() => {
    return () => {
      selectedImg?.classList.remove("rt-img-selected");
    };
  }, [selectedImg]);

  const syncToState = useCallback(() => {
    if (editorRef.current) {
      const html = sanitizeEditorHtml(editorRef.current.innerHTML);
      if (html !== editorRef.current.innerHTML) {
        editorRef.current.innerHTML = html;
      }
      lastHtmlRef.current = html;
      onChange(html);
    }
  }, [onChange]);

  const exec = useCallback(
    (command: string, val?: string) => {
      if (selectedImg) {
        selectedImg.classList.remove("rt-img-selected");
        setSelectedImg(null);
        setHandle((h) => ({ ...h, show: false }));
      }
      document.execCommand(command, false, val);
      editorRef.current?.focus();
      syncToState();
    },
    [syncToState, selectedImg],
  );

  const handleInput = useCallback(() => {
    syncToState();
  }, [syncToState]);

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types || []).includes("Files");

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!onFilesDrop || !isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    },
    [onFilesDrop],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!onFilesDrop || !isFileDrag(event)) return;
      event.preventDefault();
      setDragActive(false);
      if (event.dataTransfer.files.length > 0) {
        onFilesDrop(event.dataTransfer.files);
      }
    },
    [onFilesDrop],
  );

  // --- Image insertion (from paste or file picker) ---
  const insertImageFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const cid = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const img = document.createElement("img");
        img.src = dataUrl;
        img.setAttribute("data-cid", cid);
        img.style.maxWidth = "100%";
        img.style.height = "auto";

        // Insert at cursor position
        const sel = window.getSelection();
        if (
          sel &&
          sel.rangeCount > 0 &&
          editorRef.current?.contains(sel.anchorNode)
        ) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(img);
          const space = document.createTextNode("\u00a0");
          range.setStartAfter(img);
          range.insertNode(space);
          range.setStartAfter(space);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else if (editorRef.current) {
          editorRef.current.appendChild(img);
        }

        // Extract metadata from data URL
        const mimeMatch = dataUrl.match(/^data:([^;]+);/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
        const base64 = dataUrl.split(",")[1] || "";
        const size = Math.round((base64.length * 3) / 4);

        onImageAdd?.({ cid, dataUrl, filename: file.name || "pasted-image.png", mimeType, size });
        syncToState();
      };
      reader.readAsDataURL(file);
    },
    [onImageAdd, syncToState],
  );

  // --- Paste handler: detect images in clipboard ---
  const handlePaste = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (file) insertImageFile(file);
          return;
        }
      }
      // No image — default paste proceeds
    },
    [insertImageFile],
  );

  // --- Image selection ---
  const updateHandlePos = useCallback((img: HTMLImageElement) => {
    const rect = img.getBoundingClientRect();
    setHandle({ x: rect.right, y: rect.bottom, show: true });
  }, []);

  const handleEditorClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "IMG") {
        if (selectedImg && selectedImg !== target) {
          selectedImg.classList.remove("rt-img-selected");
        }
        target.classList.add("rt-img-selected");
        setSelectedImg(target as HTMLImageElement);
        updateHandlePos(target as HTMLImageElement);
      } else {
        if (selectedImg) {
          selectedImg.classList.remove("rt-img-selected");
        }
        setSelectedImg(null);
        setHandle((h) => ({ ...h, show: false }));
      }
    },
    [selectedImg, updateHandlePos],
  );

  // --- Image resize via drag handle ---
  const startResize = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectedImg) return;
      const img = selectedImg;
      const startX = e.clientX;
      const startWidth = img.offsetWidth;
      const startHeight = img.offsetHeight;
      const ratio = startWidth > 0 ? startHeight / startWidth : 1;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const newWidth = Math.max(50, Math.min(1200, startWidth + dx));
        img.style.width = `${newWidth}px`;
        img.style.height = `${Math.round(newWidth * ratio)}px`;
        updateHandlePos(img);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        syncToState();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [selectedImg, syncToState, updateHandlePos],
  );

  // Update handle on scroll/resize
  useEffect(() => {
    if (!handle.show || !selectedImg) return;
    const update = () => updateHandlePos(selectedImg);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [handle.show, selectedImg, updateHandlePos]);

  // --- Link insertion ---
  const insertLink = useCallback(() => {
    const url = prompt("Enter URL:", "https://");
    if (!url) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) {
      exec("createLink", url);
    } else if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const text = document.createTextNode(url);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.style.color = "inherit";
      anchor.appendChild(text);
      range.deleteContents();
      range.insertNode(anchor);
      range.setStartAfter(anchor);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      syncToState();
    }
  }, [exec, syncToState]);

  // --- Keyboard shortcuts ---
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        exec("bold");
      } else if (key === "i") {
        e.preventDefault();
        exec("italic");
      } else if (key === "u") {
        e.preventDefault();
        exec("underline");
      } else if (key === "k") {
        e.preventDefault();
        insertLink();
      }
    },
    [exec, insertLink],
  );

  const ToolbarBtn = useCallback(
    ({
      label,
      onClick,
      children,
    }: {
      label: string;
      onClick: () => void;
      children: ReactNode;
    }) => (
      <Tooltip content={label}>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className="h-7 w-7 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--geist-bg-200)]"
          style={{ color: "var(--geist-secondary)" }}
          aria-label={label}
        >
          {children}
        </button>
      </Tooltip>
    ),
    [],
  );

  return (
    <div className={className} style={style}>
      <style>{EDITOR_CSS}</style>

      {/* Toolbar */}
      <div
        className="flex items-center gap-0.5 h-9 border-b mb-3 flex-wrap"
        style={{ borderColor: "var(--geist-border)" }}
      >
        <ToolbarBtn label={t("richEditor.bold")} onClick={() => exec("bold")}>
          <Bold size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.italic")} onClick={() => exec("italic")}>
          <Italic size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.underline")} onClick={() => exec("underline")}>
          <Underline size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.strikethrough")} onClick={() => exec("strikeThrough")}>
          <Strikethrough size={14} />
        </ToolbarBtn>
        <span className="rt-divider" />
        <ToolbarBtn label={t("richEditor.heading1")} onClick={() => exec("formatBlock", "<h1>")}>
          <Heading1 size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.heading2")} onClick={() => exec("formatBlock", "<h2>")}>
          <Heading2 size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.paragraph")} onClick={() => exec("formatBlock", "<p>")}>
          <Pilcrow size={14} />
        </ToolbarBtn>
        <span className="rt-divider" />
        <ToolbarBtn label={t("richEditor.bulletedList")} onClick={() => exec("insertUnorderedList")}>
          <List size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.numberedList")} onClick={() => exec("insertOrderedList")}>
          <ListOrdered size={14} />
        </ToolbarBtn>
        <span className="rt-divider" />
        <ToolbarBtn label={t("richEditor.link")} onClick={insertLink}>
          <LinkIcon size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.image")} onClick={() => imageInputRef.current?.click()}>
          <ImageIcon size={14} />
        </ToolbarBtn>
        {toolbarExtra}
        <span className="rt-divider" />
        <ToolbarBtn label={t("richEditor.undo")} onClick={() => exec("undo")}>
          <Undo2 size={14} />
        </ToolbarBtn>
        <ToolbarBtn label={t("richEditor.redo")} onClick={() => exec("redo")}>
          <Redo2 size={14} />
        </ToolbarBtn>
      </div>

      {/* contentEditable body */}
      <div
        className="relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onPaste={handlePaste}
          onClick={handleEditorClick}
          onKeyDown={handleKeyDown}
          data-placeholder={placeholder}
          className="rt-editor w-full min-h-[420px] text-copy-14"
          style={{ lineHeight: 1.65, wordBreak: "break-word" }}
        />
        {dragActive && (
          <div
            className="absolute inset-0 z-10 rounded-geist border-2 border-dashed flex items-center justify-center text-label-14 font-medium pointer-events-none"
            style={{
              borderColor: "var(--geist-secondary)",
              backgroundColor: "color-mix(in srgb, var(--geist-bg-100) 82%, transparent)",
              color: "var(--geist-primary)",
            }}
          >
            <div
              className="px-4 py-2 rounded-geist border"
              style={{
                borderColor: "var(--geist-border)",
                backgroundColor: "var(--geist-bg-100)",
              }}
            >
              {dragOverlayText}
            </div>
          </div>
        )}
      </div>

      {/* Image resize handle */}
      {handle.show && (
        <div
          onMouseDown={startResize}
          style={{
            position: "fixed",
            left: handle.x - 6,
            top: handle.y - 6,
            width: 12,
            height: 12,
            backgroundColor: "var(--geist-secondary)",
            border: "2px solid white",
            borderRadius: "50%",
            cursor: "nwse-resize",
            zIndex: 1000,
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          }}
        />
      )}

      {/* Hidden image file picker */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.[0]) {
            insertImageFile(e.target.files[0]);
            e.currentTarget.value = "";
          }
        }}
      />
    </div>
  );
});

function sanitizeEditorHtml(html: string): string {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("a").forEach((anchor) => {
    anchor.removeAttribute("color");
    const style = anchor.getAttribute("style") || "";
    anchor.setAttribute("style", stripBlueColor(style));
  });
  doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const style = el.getAttribute("style") || "";
    const cleaned = stripBlueColor(style);
    if (cleaned) el.setAttribute("style", cleaned);
    else el.removeAttribute("style");
  });
  doc.querySelectorAll("[color]").forEach((el) => {
    const value = (el.getAttribute("color") || "").trim().toLowerCase();
    if (isBlueColor(value)) el.removeAttribute("color");
  });
  return doc.body.innerHTML;
}

function stripBlueColor(style: string): string {
  if (!style) return "";
  return style
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const [prop, ...rest] = part.split(":");
      if (!prop || rest.length === 0) return true;
      if (prop.trim().toLowerCase() !== "color") return true;
      return !isBlueColor(rest.join(":").trim().toLowerCase());
    })
    .join("; ");
}

function isBlueColor(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return (
    normalized === "blue" ||
    normalized === "#00f" ||
    normalized === "#0000ff" ||
    normalized === "rgb(0,0,255)" ||
    normalized === "-webkit-link"
  );
}

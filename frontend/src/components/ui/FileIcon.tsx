import {
  File,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileJson,
  FileClock,
  type LucideIcon,
} from "lucide-react";

export interface FileIconProps {
  filename: string;
  mimeType?: string;
  size?: number;
  className?: string;
  /** When true, tint the icon with a color that hints at the file type. */
  colored?: boolean;
}

interface TypeRule {
  Icon: LucideIcon;
  color: string;
  exts: string[];
  mimes?: string[];
}

// Order matters: more specific rules first.
const RULES: TypeRule[] = [
  {
    Icon: FileText,
    color: "#E53935",
    exts: ["pdf"],
    mimes: ["application/pdf", "application/x-pdf"],
  },
  {
    Icon: FileText,
    color: "#2196F3",
    exts: ["doc", "docx", "odt", "rtf", "pages"],
    mimes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  {
    Icon: FileSpreadsheet,
    color: "#43A047",
    exts: ["xls", "xlsx", "ods", "csv"],
    mimes: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
    ],
  },
  {
    Icon: FileText,
    color: "#FB8C00",
    exts: ["ppt", "pptx", "odp", "key"],
    mimes: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
  {
    Icon: FileImage,
    color: "#8E24AA",
    exts: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico", "heic"],
    mimes: ["image/"],
  },
  {
    Icon: FileVideo,
    color: "#D81B60",
    exts: ["mp4", "webm", "avi", "mov", "mkv", "flv", "wmv", "m4v"],
    mimes: ["video/"],
  },
  {
    Icon: FileAudio,
    color: "#3949AB",
    exts: ["mp3", "ogg", "wav", "flac", "aac", "m4a", "wma"],
    mimes: ["audio/"],
  },
  {
    Icon: FileArchive,
    color: "#6D4C41",
    exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
    mimes: [
      "application/zip",
      "application/x-zip-compressed",
      "application/x-rar-compressed",
      "application/x-7z-compressed",
      "application/gzip",
      "application/x-tar",
    ],
  },
  {
    Icon: FileJson,
    color: "#00897B",
    exts: ["json"],
    mimes: ["application/json"],
  },
  {
    Icon: FileCode,
    color: "#00897B",
    exts: [
      "js", "ts", "jsx", "tsx", "html", "htm", "css", "scss", "less",
      "xml", "py", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb",
      "php", "sh", "bash", "yml", "yaml", "toml", "ini", "sql",
    ],
    mimes: [
      "text/html", "text/css", "text/xml", "application/xml",
      "application/javascript", "text/javascript",
      "application/typescript", "application/json",
    ],
  },
  {
    Icon: FileText,
    color: "#546E7A",
    exts: ["txt", "md", "markdown", "log", "rtf"],
    mimes: ["text/plain", "text/markdown"],
  },
  {
    Icon: FileClock,
    color: "#546E7A",
    exts: ["eml", "msg"],
    mimes: ["message/rfc822"],
  },
];

function getExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function matchRule(filename: string, mimeType?: string): TypeRule {
  const ext = getExt(filename);
  const mt = (mimeType || "").toLowerCase();
  for (const rule of RULES) {
    if (ext && rule.exts.includes(ext)) return rule;
    if (mt && rule.mimes) {
      for (const m of rule.mimes) {
        if (m.endsWith("/")) {
          if (mt.startsWith(m)) return rule;
        } else if (mt === m) {
          return rule;
        }
      }
    }
  }
  return { Icon: File, color: "#78909C", exts: [] };
}

export function FileIcon({
  filename,
  mimeType,
  size = 16,
  className,
  colored = true,
}: FileIconProps) {
  const { Icon, color } = matchRule(filename, mimeType);
  return (
    <Icon
      size={size}
      className={className}
      style={colored ? { color } : undefined}
    />
  );
}

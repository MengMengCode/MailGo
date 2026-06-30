import type { FolderRole } from "./api";
import {
  Inbox,
  Send,
  FileEdit,
  Trash2,
  Archive,
  AlertTriangle,
  Folder,
  Star,
  type LucideIcon,
} from "lucide-react";

export const FOLDER_ROLE_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileEdit,
  trash: Trash2,
  archive: Archive,
  spam: AlertTriangle,
  starred: Star,
};

export function folderIconFor(role?: FolderRole | null): LucideIcon {
  if (role && FOLDER_ROLE_ICON[role]) return FOLDER_ROLE_ICON[role];
  return Folder;
}

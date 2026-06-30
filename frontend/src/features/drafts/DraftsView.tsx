import { MailFolderView } from "@/components/message/MailFolderView";

/**
 * Drafts view — a thin wrapper around the shared MailFolderView shell.
 *
 * When `drafts` mode is active, MailFolderView fetches both local compose
 * drafts (from the `drafts` table) and IMAP-synced drafts (from the
 * `messages` table with is_draft=1), merges them into a unified list, and
 * renders them with the standard message list / detail layout.
 */
export function DraftsView() {
  return <MailFolderView drafts />;
}

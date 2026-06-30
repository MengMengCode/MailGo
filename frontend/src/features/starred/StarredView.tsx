import { MailFolderView } from "@/components/message/MailFolderView";

/** 星标视图 — 复用 MailFolderView 模板，传入 starred 标志。 */
export function StarredView() {
  return <MailFolderView starred />;
}

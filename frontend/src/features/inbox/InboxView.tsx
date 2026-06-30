import { MailFolderView } from "@/components/message/MailFolderView";

/** 收件箱视图 — 5 个文件夹角色 (inbox/sent/spam/trash/archive) 共用此入口。
 *  activeFolderRole 由 MailFolderView 从 store 读取。 */
export function InboxView() {
  return <MailFolderView />;
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search as SearchIcon, Inbox, ArrowLeft } from "lucide-react";
import { useMessagesQuery } from "@/hooks/queries/useMessages";
import { useAppStore } from "@/stores/appStore";
import { MessageItem } from "@/components/message/MessageItem";
import { MessageDetail } from "@/components/message/MessageDetail";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAccountsQuery } from "@/hooks/queries/useAccounts";
import { useMemo } from "react";
import { assignAccountColors } from "@/lib/accountColors";
import { useIsMobile } from "@/hooks/useBreakpoint";

export function SearchView() {
  const { t } = useTranslation();
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const selectedMessageId = useAppStore((s) => s.selectedMessageId);
  const setSelectedMessageId = useAppStore((s) => s.setSelectedMessageId);
  const { data: accounts = [] } = useAccountsQuery();
  const accountColors = useMemo(() => assignAccountColors(accounts), [accounts]);
  const isMobile = useIsMobile();

  const [debounced, setDebounced] = useState(searchQuery);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const { data, isLoading } = useMessagesQuery({
    q: debounced || undefined,
    page: 1,
    page_size: 100,
  });
  const messages = data?.messages ?? [];

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-3 px-4 lg:px-6 h-12 border-b shrink-0"
        style={{ borderColor: "var(--geist-border)" }}
      >
        {isMobile && selectedMessageId ? (
          <button
            onClick={() => setSelectedMessageId(null)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--mailgo-sidebar-hover)]"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <SearchIcon size={16} className="text-secondary" />
        )}
        <input
          autoFocus
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          className="flex-1 bg-transparent text-label-14 outline-none placeholder:text-disabled"
        />
      </div>
      {debounced && (
        <div
          className="px-4 lg:px-6 py-2 text-label-12 text-secondary border-b shrink-0"
          style={{ borderColor: "var(--geist-border)" }}
        >
          {t("search.resultsCount", { count: data?.total ?? 0, query: debounced })}
        </div>
      )}
      <div className="flex-1 flex min-h-0">
        {/* Results list — hidden on mobile when a message is selected */}
        {(!isMobile || !selectedMessageId) && (
        <div
          className="flex flex-col min-w-0 h-full border-r"
          style={{
            width: isMobile ? "100%" : selectedMessageId ? "50%" : "100%",
            borderColor: "var(--geist-border)",
          }}
        >
          <div className="flex-1 overflow-y-auto">
            {!debounced ? (
              <EmptyState
                icon={<SearchIcon size={22} />}
                title={t("search.title")}
                description="Type to search through your messages"
              />
            ) : isLoading ? (
              <div className="p-6 text-center text-secondary">{t("common.loading")}</div>
            ) : messages.length === 0 ? (
              <EmptyState
                icon={<Inbox size={22} />}
                title={t("search.noResults")}
                description={t("search.noResultsHint", { query: debounced })}
              />
            ) : (
              <ul>
                {messages.map((m) => (
                  <li key={m.id}>
                    <MessageItem
                      message={m}
                      isSelected={m.id === selectedMessageId}
                      onSelect={() =>
                        setSelectedMessageId(
                          selectedMessageId === m.id ? null : m.id,
                        )
                      }
                      accountColor={accountColors.get(m.account_id)}
                      accountLabel={
                        accounts.find((a) => a.id === m.account_id)?.email
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        )}
        {/* Detail pane — full-width on mobile */}
        {selectedMessageId && (
          <div className="flex-1 min-w-0 h-full">
            <MessageDetail
              messageId={selectedMessageId}
              onBack={() => setSelectedMessageId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

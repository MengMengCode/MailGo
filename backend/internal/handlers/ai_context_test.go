package handlers

import (
	"strings"
	"testing"
)

func TestApplyLatestContextSummary(t *testing.T) {
	messages := []AIChatMessage{
		{Role: "user", Content: "old"},
		{Role: "assistant", Content: "old response"},
		{Role: "user", Content: "checkpoint", ContextSummary: "summary one"},
		{Role: "assistant", Content: "recent"},
		{Role: "user", Content: "latest", ContextSummary: "summary two"},
		{Role: "assistant", Content: "newest"},
	}
	history, summary, offset := applyLatestContextSummary(messages)
	if summary != "summary two" {
		t.Fatalf("summary = %q", summary)
	}
	if offset != 4 || len(history) != 2 || history[0].Content != "latest" {
		t.Fatalf("unexpected checkpoint: offset=%d history=%+v", offset, history)
	}
}

func TestEstimateTextTokensCountsCJKConservatively(t *testing.T) {
	if got := estimateTextTokens("abcdefghijklmnop"); got != 4 {
		t.Fatalf("ASCII estimate = %d, want 4", got)
	}
	if got := estimateTextTokens("这是十个左右的中文字符"); got < 9 {
		t.Fatalf("CJK estimate too small: %d", got)
	}
}

func TestFindContextValue(t *testing.T) {
	metadata := map[string]interface{}{
		"model_info": map[string]interface{}{
			"qwen.context_length": float64(32768),
		},
	}
	if got := findContextValue(metadata); got != 32768 {
		t.Fatalf("context value = %d", got)
	}
}

func TestLimitTextToTokenBudget(t *testing.T) {
	value := strings.Repeat("测试", 1000)
	limited := limitTextToTokenBudget(value, 100)
	if estimateTextTokens(limited) > 120 {
		t.Fatalf("limited text still too large: %d tokens", estimateTextTokens(limited))
	}
	if !strings.Contains(limited, "truncated") {
		t.Fatal("truncation marker missing")
	}
}

func TestModelCompactionThreshold(t *testing.T) {
	if got := modelCompactionThreshold(8192); got != 5734 {
		t.Fatalf("8K threshold = %d", got)
	}
	if got := modelCompactionThreshold(200000); got != maxCompactionThreshold {
		t.Fatalf("large-model threshold = %d", got)
	}
}

func TestSanitizeConversationTitle(t *testing.T) {
	tests := map[string]string{
		"\"季度销售邮件总结\"\n这是解释":          "季度销售邮件总结",
		"标题：项目进度跟进":                   "项目进度跟进",
		"Title: Follow up with Alice": "Follow up with Alice",
	}
	for input, expected := range tests {
		if got := sanitizeConversationTitle(input); got != expected {
			t.Errorf("sanitizeConversationTitle(%q) = %q, want %q", input, got, expected)
		}
	}
}

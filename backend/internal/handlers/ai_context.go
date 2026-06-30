package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"mailgo/internal/database"
)

const (
	defaultAIContextWindow = 16_384
	maxCompactionThreshold = 80_000
)

type agentContextInfo struct {
	ContextWindow   int    `json:"context_window"`
	TokenThreshold  int    `json:"token_threshold"`
	EstimatedTokens int    `json:"estimated_tokens"`
	Source          string `json:"source"`
	Summary         string `json:"summary,omitempty"`
	Compacted       bool   `json:"compacted"`
	CheckpointIndex int    `json:"checkpoint_index,omitempty"`
}

type modelContextCacheEntry struct {
	window    int
	source    string
	expiresAt time.Time
}

var modelContextCache = struct {
	sync.Mutex
	values map[string]modelContextCacheEntry
}{values: make(map[string]modelContextCacheEntry)}

func prepareAgentContext(
	r *http.Request,
	baseURL, apiKey, model, systemPrompt string,
	input []AIChatMessage,
) ([]AIChatMessage, string, agentContextInfo) {
	history, previousSummary, historyOffset := applyLatestContextSummary(input)
	window, source := resolveModelContextWindow(r, baseURL, apiKey, model)
	threshold := modelCompactionThreshold(window)
	estimated := estimateAgentRequestTokens(systemPrompt, previousSummary, history)
	info := agentContextInfo{
		ContextWindow:   window,
		TokenThreshold:  threshold,
		EstimatedTokens: estimated,
		Source:          source,
	}
	if estimated <= threshold || len(history) <= 3 {
		return history, previousSummary, info
	}

	keepCount := len(history) * 2 / 5
	if keepCount < 2 {
		keepCount = 2
	}
	boundary := len(history) - keepCount
	if boundary < 1 {
		return history, previousSummary, info
	}

	compacted := history[:boundary]
	recent := history[boundary:]
	summary, err := generateAgentContextSummary(
		r, baseURL, apiKey, model, previousSummary, compacted, recent,
	)
	if err != nil {
		log.Printf("AI context compaction summary failed, using deterministic fallback: %v", err)
		summary = fallbackContextSummary(previousSummary, compacted)
	}
	if strings.TrimSpace(summary) == "" {
		return history, previousSummary, info
	}

	info.Summary = summary
	info.Compacted = true
	info.CheckpointIndex = historyOffset + boundary
	info.EstimatedTokens = estimateAgentRequestTokens(systemPrompt, summary, recent)
	return recent, summary, info
}

func applyLatestContextSummary(messages []AIChatMessage) ([]AIChatMessage, string, int) {
	last := -1
	summary := ""
	for i, message := range messages {
		if strings.TrimSpace(message.ContextSummary) != "" {
			last = i
			summary = strings.TrimSpace(message.ContextSummary)
		}
	}
	if last < 0 {
		return messages, "", 0
	}
	return messages[last:], summary, last
}

func generateAgentContextSummary(
	r *http.Request,
	baseURL, apiKey, model, previousSummary string,
	compacted, recent []AIChatMessage,
) (string, error) {
	prompt := `Summarize the conversation history that is being compacted out of an AI agent's active context.

Preserve key facts, user preferences, decisions, constraints, relevant email details, tool outcomes, current task state, unresolved questions, and next steps.
Be factual and concise. Do not invent information. The summary must allow the agent to continue seamlessly.

Previous summary:
` + previousSummary + `

Messages being compacted:
` + formatMessagesForSummary(compacted) + `

Recent messages kept in context:
` + formatMessagesForSummary(recent)

	response, err := callAICompletion(r, baseURL, apiKey, map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"temperature": 0,
	})
	if err != nil {
		return "", err
	}
	if response.Error.Message != "" {
		return "", fmt.Errorf("%s", response.Error.Message)
	}
	if len(response.Choices) == 0 {
		return "", fmt.Errorf("summary model returned no choices")
	}
	return strings.TrimSpace(response.Choices[0].Message.Content), nil
}

func formatMessagesForSummary(messages []AIChatMessage) string {
	var out strings.Builder
	for _, message := range messages {
		content := strings.TrimSpace(message.Content)
		if content == "" {
			continue
		}
		out.WriteString(strings.ToUpper(message.Role))
		out.WriteString(": ")
		out.WriteString(content)
		out.WriteString("\n\n")
	}
	return out.String()
}

func fallbackContextSummary(previous string, messages []AIChatMessage) string {
	var out strings.Builder
	if strings.TrimSpace(previous) != "" {
		out.WriteString("Previous context:\n")
		out.WriteString(strings.TrimSpace(previous))
		out.WriteString("\n\n")
	}
	out.WriteString("Compacted conversation:\n")
	for _, message := range messages {
		content := strings.TrimSpace(message.Content)
		if content == "" {
			continue
		}
		if len([]rune(content)) > 800 {
			content = string([]rune(content)[:800]) + "…"
		}
		fmt.Fprintf(&out, "- %s: %s\n", message.Role, content)
		if out.Len() >= 6000 {
			break
		}
	}
	return out.String()
}

func estimateAgentRequestTokens(systemPrompt, summary string, messages []AIChatMessage) int {
	total := estimateTextTokens(systemPrompt) + estimateTextTokens(summary)
	for _, message := range messages {
		total += 4 + estimateTextTokens(message.Content)
	}
	if tools, err := json.Marshal(aiAgentTools()); err == nil {
		total += estimateTextTokens(string(tools))
	}
	return total + 32
}

func estimateTextTokens(value string) int {
	if value == "" {
		return 0
	}
	asciiLike := 0
	tokens := 0
	for _, r := range value {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
			unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r) {
			tokens++
		} else {
			asciiLike++
		}
	}
	tokens += (asciiLike + 3) / 4
	if tokens < 1 {
		return 1
	}
	return tokens
}

func limitTextToTokenBudget(value string, budget int) string {
	if budget <= 0 || estimateTextTokens(value) <= budget {
		return value
	}
	runes := []rune(value)
	low, high := 0, len(runes)
	for low < high {
		mid := (low + high + 1) / 2
		if estimateTextTokens(string(runes[:mid])) <= budget {
			low = mid
		} else {
			high = mid - 1
		}
	}
	return string(runes[:low]) + "\n...[tool result truncated to fit model context]"
}

func modelCompactionThreshold(window int) int {
	if window <= 0 {
		window = defaultAIContextWindow
	}
	threshold := window * 7 / 10
	if threshold > maxCompactionThreshold {
		threshold = maxCompactionThreshold
	}
	return threshold
}

func resolveModelContextWindow(
	r *http.Request,
	baseURL, apiKey, model string,
) (int, string) {
	if override := loadAIContextWindowOverride(); override > 0 {
		return override, "configured"
	}

	cacheKey := strings.TrimRight(baseURL, "/") + "|" + model
	modelContextCache.Lock()
	if cached, ok := modelContextCache.values[cacheKey]; ok && time.Now().Before(cached.expiresAt) {
		modelContextCache.Unlock()
		return cached.window, cached.source
	}
	modelContextCache.Unlock()

	window, source := probeOpenAIModelContext(r, baseURL, apiKey, model)
	if window <= 0 {
		window, source = probeOllamaModelContext(r, baseURL, model)
	}
	if window <= 0 {
		window, source = knownModelContextWindow(model)
	}
	if window <= 0 {
		window, source = defaultAIContextWindow, "conservative_default"
	}

	modelContextCache.Lock()
	modelContextCache.values[cacheKey] = modelContextCacheEntry{
		window: window, source: source, expiresAt: time.Now().Add(time.Hour),
	}
	modelContextCache.Unlock()
	return window, source
}

func loadAIContextWindowOverride() int {
	var value string
	if err := database.DB.QueryRow(
		"SELECT setting_value FROM settings WHERE setting_key = 'ai_context_window'",
	).Scan(&value); err != nil {
		return 0
	}
	parsed, _ := strconv.Atoi(strings.TrimSpace(value))
	if parsed > 0 {
		return parsed
	}
	return 0
}

func probeOpenAIModelContext(
	r *http.Request,
	baseURL, apiKey, model string,
) (int, string) {
	req, err := http.NewRequestWithContext(
		r.Context(), http.MethodGet, strings.TrimRight(baseURL, "/")+"/models", nil,
	)
	if err != nil {
		return 0, ""
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, ""
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return 0, ""
	}
	var payload interface{}
	if json.Unmarshal(data, &payload) != nil {
		return 0, ""
	}
	if object := findModelObject(payload, model); object != nil {
		if value := findContextValue(object); value > 0 {
			return value, "openai_models_metadata"
		}
	}
	return 0, ""
}

func probeOllamaModelContext(
	r *http.Request,
	baseURL, model string,
) (int, string) {
	root := strings.TrimSuffix(strings.TrimRight(baseURL, "/"), "/v1")
	payload, _ := json.Marshal(map[string]string{"model": model})
	req, err := http.NewRequestWithContext(
		r.Context(), http.MethodPost, root+"/api/show", bytes.NewReader(payload),
	)
	if err != nil {
		return 0, ""
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, ""
	}
	var body map[string]interface{}
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body) != nil {
		return 0, ""
	}
	if value := findContextValue(body); value > 0 {
		return value, "ollama_show"
	}
	return 0, ""
}

func findModelObject(value interface{}, model string) map[string]interface{} {
	switch current := value.(type) {
	case map[string]interface{}:
		id, _ := current["id"].(string)
		name, _ := current["name"].(string)
		if id == model || name == model {
			return current
		}
		for _, child := range current {
			if found := findModelObject(child, model); found != nil {
				return found
			}
		}
	case []interface{}:
		for _, child := range current {
			if found := findModelObject(child, model); found != nil {
				return found
			}
		}
	}
	return nil
}

func findContextValue(value interface{}) int {
	switch current := value.(type) {
	case map[string]interface{}:
		for key, child := range current {
			normalized := strings.ToLower(key)
			if normalized == "context_length" || normalized == "context_window" ||
				normalized == "max_context_length" || normalized == "max_model_len" ||
				normalized == "max_position_embeddings" || normalized == "num_ctx" ||
				normalized == "input_token_limit" || strings.HasSuffix(normalized, ".context_length") {
				if parsed := positiveInt(child); parsed > 0 {
					return parsed
				}
			}
		}
		for _, child := range current {
			if parsed := findContextValue(child); parsed > 0 {
				return parsed
			}
		}
	case []interface{}:
		for _, child := range current {
			if parsed := findContextValue(child); parsed > 0 {
				return parsed
			}
		}
	}
	return 0
}

func positiveInt(value interface{}) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		fields := strings.Fields(typed)
		for i := len(fields) - 1; i >= 0; i-- {
			if parsed, err := strconv.Atoi(fields[i]); err == nil && parsed > 0 {
				return parsed
			}
		}
	}
	return 0
}

func knownModelContextWindow(model string) (int, string) {
	name := strings.ToLower(model)
	switch {
	case strings.Contains(name, "gpt-3.5"):
		return 16_384, "model_family"
	case strings.Contains(name, "gpt-4"), strings.HasPrefix(name, "o1"),
		strings.HasPrefix(name, "o3"), strings.HasPrefix(name, "o4"),
		strings.Contains(name, "gpt-5"):
		return 128_000, "model_family"
	case strings.Contains(name, "claude"):
		return 200_000, "model_family"
	case strings.Contains(name, "gemini"):
		return 128_000, "model_family"
	}
	return 0, ""
}

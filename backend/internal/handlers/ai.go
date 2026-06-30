package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mailgo/internal/database"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type AIChatMessage struct {
	Role           string `json:"role"`
	Content        string `json:"content"`
	ContextSummary string `json:"context_summary,omitempty"`
}

type AIChatRequest struct {
	Messages []AIChatMessage `json:"messages"`
	Stream   bool            `json:"stream"`
	Model    string          `json:"model,omitempty"`
}

type AIAgentRequest struct {
	Messages []AIChatMessage `json:"messages"`
	Model    string          `json:"model,omitempty"`
	Stream   bool            `json:"stream,omitempty"`
}

type AITitleRequest struct {
	Prompt   string `json:"prompt"`
	Response string `json:"response,omitempty"`
	Model    string `json:"model,omitempty"`
}

func AIChat(w http.ResponseWriter, r *http.Request) {
	var req AIChatRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(req.Messages) == 0 {
		respondError(w, http.StatusBadRequest, "messages is required")
		return
	}

	baseURL, apiKey, model, err := loadAISettings()
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Model) != "" {
		model = strings.TrimSpace(req.Model)
	}

	// Filter out empty messages that would cause upstream APIs to reject
	// with HTTP 400.
	filtered := make([]AIChatMessage, 0, len(req.Messages))
	for _, m := range req.Messages {
		if strings.TrimSpace(m.Content) == "" && m.Role == "assistant" {
			continue
		}
		filtered = append(filtered, m)
	}

	body := map[string]interface{}{
		"model":       model,
		"messages":    filtered,
		"stream":      req.Stream,
		"temperature": 1,
	}
	upstreamBody, _ := json.Marshal(body)
	upstreamURL := strings.TrimRight(baseURL, "/") + "/chat/completions"
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(upstreamBody))
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create AI request")
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	if req.Stream {
		client.Timeout = 0
	}
	resp, err := client.Do(upstreamReq)
	if err != nil {
		log.Printf("AI upstream request error: %v", err)
		respondError(w, http.StatusBadGateway, "AI service unavailable")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		w.Header().Set("Content-Type", contentTypeOrJSON(resp.Header.Get("Content-Type")))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(payload)
		return
	}

	if req.Stream {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		buf := make([]byte, 32*1024)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := w.Write(buf[:n]); writeErr != nil {
					return
				}
				if flusher, ok := w.(http.Flusher); ok {
					flusher.Flush()
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					log.Printf("AI stream read error: %v", readErr)
				}
				return
			}
		}
	}

	w.Header().Set("Content-Type", contentTypeOrJSON(resp.Header.Get("Content-Type")))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, resp.Body)
}

func AITitle(w http.ResponseWriter, r *http.Request) {
	var req AITitleRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		respondError(w, http.StatusBadRequest, "prompt is required")
		return
	}

	baseURL, apiKey, model, err := loadAISettings()
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Model) != "" {
		model = strings.TrimSpace(req.Model)
	}

	prompt := `Generate a concise title for this conversation.
Use the same language as the user. Return only the title, with no quotes, markdown, colon, or explanation.
For Chinese, use at most 12 Chinese characters. For other languages, use at most 8 words.

User message:
` + limitTextToTokenBudget(req.Prompt, 800)
	if strings.TrimSpace(req.Response) != "" {
		prompt += "\n\nAssistant response:\n" + limitTextToTokenBudget(req.Response, 800)
	}

	result, err := callAICompletion(r, baseURL, apiKey, map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"temperature": 0.2,
	})
	if err != nil {
		respondError(w, http.StatusBadGateway, err.Error())
		return
	}
	if result.Error.Message != "" || len(result.Choices) == 0 {
		respondError(w, http.StatusBadGateway, "AI returned no title")
		return
	}

	title := sanitizeConversationTitle(result.Choices[0].Message.Content)
	if title == "" {
		respondError(w, http.StatusBadGateway, "AI returned an empty title")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"title": title})
}

func sanitizeConversationTitle(value string) string {
	value = strings.TrimSpace(value)
	if idx := strings.IndexAny(value, "\r\n"); idx >= 0 {
		value = value[:idx]
	}
	value = strings.Trim(value, "`\"'“”‘’#* ")
	value = strings.TrimSpace(strings.TrimPrefix(value, "标题："))
	value = strings.TrimSpace(strings.TrimPrefix(value, "Title:"))
	runes := []rune(value)
	if len(runes) > 48 {
		value = string(runes[:48])
	}
	return strings.TrimSpace(value)
}

func AIAgent(w http.ResponseWriter, r *http.Request) {
	var req AIAgentRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(req.Messages) == 0 {
		respondError(w, http.StatusBadRequest, "messages is required")
		return
	}

	baseURL, apiKey, model, err := loadAISettings()
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Model) != "" {
		model = strings.TrimSpace(req.Model)
	}

	// Build message history
	defaultSystemPrompt := "你是 MailGo 邮件助手。你只能使用两个系统工具：mail_access 用于读取邮件列表/正文，draft_create 用于新建邮件草稿。没有发送邮件、删除邮件、修改账户、访问文件或其他系统操作能力。用户要求发送邮件时，必须调用 draft_create 创建草稿，然后说明已创建草稿、需要用户手动检查并发送。需要邮件内容时必须调用 mail_access。不要说你无法访问邮件系统；你可以通过工具访问允许范围内的邮件和草稿箱。\n\n重要规则：\n1. 用户提到收件人、发件人、抄送等邮箱地址时，必须提取并填入 draft_create 的对应参数（to_addresses、account_email 等），不要留空。\n2. 用户说「使用邮箱 X」或「用 X 发送」时，把 X 填入 account_email 参数。\n3. 用户说「发到 X」或「发给 X」时，把 X 填入 to_addresses 参数。\n4. 不要省略用户已明确提供的信息。"
	customPrompt := loadAISystemPrompt()
	systemPrompt := defaultSystemPrompt
	if customPrompt != "" {
		systemPrompt = customPrompt
	}

	messages := make([]map[string]interface{}, 0, len(req.Messages)+8)
	messages = append(messages, map[string]interface{}{
		"role":    "system",
		"content": systemPrompt,
	})
	for _, msg := range req.Messages {
		content := strings.TrimSpace(msg.Content)
		if msg.Role == "assistant" && content == "" {
			continue
		}
		messages = append(messages, map[string]interface{}{
			"role":    msg.Role,
			"content": content,
		})
	}

	systemPrompt, _ = messages[0]["content"].(string)
	history, contextSummary, contextInfo := prepareAgentContext(
		r, baseURL, apiKey, model, systemPrompt, req.Messages,
	)
	messages = messages[:1]
	if contextSummary != "" {
		messages = append(messages, map[string]interface{}{
			"role": "system",
			"content": "Conversation context summary from earlier messages:\n" +
				contextSummary,
		})
	}
	for _, msg := range history {
		content := strings.TrimSpace(msg.Content)
		if msg.Role == "assistant" && content == "" {
			continue
		}
		messages = append(messages, map[string]interface{}{
			"role":    msg.Role,
			"content": content,
		})
	}

	if req.Stream {
		runAgentStream(w, r, baseURL, apiKey, model, messages, contextInfo)
		return
	}

	// Non-streaming path: use blocking callAICompletion
	runAgentBlocking(w, r, baseURL, apiKey, model, messages, contextInfo)
}

// sseWriter wraps http.ResponseWriter with SSE helpers.
type sseWriter struct {
	w   http.ResponseWriter
	f   http.Flusher
	ctx context.Context
}

func newSSEWriter(w http.ResponseWriter, r *http.Request) *sseWriter {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	f, _ := w.(http.Flusher)
	if f != nil {
		f.Flush()
	}
	return &sseWriter{w: w, f: f, ctx: r.Context()}
}

func (s *sseWriter) send(event, data string) bool {
	if s.ctx.Err() != nil {
		return false
	}
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, data)
	if s.f != nil {
		s.f.Flush()
	}
	return true
}

// runAgentStream runs the full agent loop as a real-time SSE stream. Every
// upstream delta (reasoning, content, tool calls) is relayed to the client
// immediately — no blocking on tool-calling iterations.
func runAgentStream(w http.ResponseWriter, r *http.Request, baseURL, apiKey, model string, messages []map[string]interface{}, contextInfo agentContextInfo) {
	sse := newSSEWriter(w, r)
	if payload, err := json.Marshal(contextInfo); err == nil {
		sse.send("context", string(payload))
	}
	lastUserText := ""
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i]["role"] == "user" {
			lastUserText, _ = messages[i]["content"].(string)
			break
		}
	}

	forceFailed := false
	var finalContent string

	for step := 0; step < 6; step++ {
		if sse.ctx.Err() != nil {
			return
		}

		sse.send("step", fmt.Sprintf(`{"step":%d,"status":"start"}`, step))

		toolChoice := interface{}("auto")
		if step == 0 && !forceFailed {
			if shouldForceDraftCreate(lastUserText) {
				toolChoice = map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "draft_create"}}
			} else if shouldForceMailAccess(lastUserText) {
				toolChoice = map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "mail_access"}}
			}
		}

		reqBody := map[string]interface{}{
			"model":       model,
			"messages":    messages,
			"tools":       aiAgentTools(),
			"tool_choice": toolChoice,
			"stream":      true,
			"temperature": 1,
		}

		payload, _ := json.Marshal(reqBody)
		upstreamURL := strings.TrimRight(baseURL, "/") + "/chat/completions"
		upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(payload))
		if err != nil {
			sse.send("error", `{"message":"Failed to create request"}`)
			return
		}
		upstreamReq.Header.Set("Content-Type", "application/json")
		upstreamReq.Header.Set("Authorization", "Bearer "+apiKey)

		client := &http.Client{Timeout: 0}
		resp, err := client.Do(upstreamReq)
		if err != nil {
			// Fallback: tools not supported → retry without tools
			if step == 0 && !forceFailed {
				log.Printf("AIAgent stream: tools failed (%v), retrying without tools", err)
				reqBody2 := map[string]interface{}{"model": model, "messages": messages, "stream": true, "temperature": 1}
				payload2, _ := json.Marshal(reqBody2)
				upstreamReq2, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(payload2))
				upstreamReq2.Header.Set("Content-Type", "application/json")
				upstreamReq2.Header.Set("Authorization", "Bearer "+apiKey)
				resp2, err2 := client.Do(upstreamReq2)
				if err2 != nil {
					sse.send("error", fmt.Sprintf(`{"message":"%s"}`, escapeJSON(err2.Error())))
					return
				}
				relayUpstreamSSE(sse, resp2)
				sse.send("done", "{}")
				return
			}
			sse.send("error", fmt.Sprintf(`{"message":"%s"}`, escapeJSON(err.Error())))
			return
		}

		// Read upstream SSE and relay deltas; accumulate tool calls
		type partialTC struct {
			id        string
			name      string
			arguments string
		}
		toolCalls := map[int]*partialTC{}
		var stepContent, stepReasoning string
		flusher := bufio.NewScanner(resp.Body)
		flusher.Buffer(make([]byte, 0, 64*1024), 1<<20)

		for flusher.Scan() {
			line := strings.TrimSpace(flusher.Text())
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			payload := strings.TrimPrefix(line, "data: ")
			if payload == "[DONE]" {
				break
			}

			var chunk struct {
				Choices []struct {
					Delta struct {
						Content          string `json:"content"`
						ReasoningContent string `json:"reasoning_content"`
						ToolCalls        []struct {
							Index    int    `json:"index"`
							ID       string `json:"id"`
							Function struct {
								Name      string `json:"name"`
								Arguments string `json:"arguments"`
							} `json:"function"`
						} `json:"tool_calls"`
					} `json:"delta"`
					FinishReason string `json:"finish_reason"`
				} `json:"choices"`
			}
			if json.Unmarshal([]byte(payload), &chunk) != nil || len(chunk.Choices) == 0 {
				continue
			}
			delta := chunk.Choices[0].Delta

			// Relay reasoning immediately
			if delta.ReasoningContent != "" {
				stepReasoning += delta.ReasoningContent
				sse.send("reasoning", fmt.Sprintf(`{"text":"%s"}`, escapeJSON(delta.ReasoningContent)))
			}
			// Relay content immediately
			if delta.Content != "" {
				stepContent += delta.Content
				sse.send("content", fmt.Sprintf(`{"text":"%s"}`, escapeJSON(delta.Content)))
			}
			// Accumulate tool calls
			for _, tc := range delta.ToolCalls {
				existing, ok := toolCalls[tc.Index]
				if !ok {
					existing = &partialTC{}
					toolCalls[tc.Index] = existing
				}
				if tc.ID != "" {
					existing.id = tc.ID
				}
				if tc.Function.Name != "" {
					existing.name += tc.Function.Name
				}
				existing.arguments += tc.Function.Arguments
			}

			// Check finish_reason
			if chunk.Choices[0].FinishReason == "tool_calls" {
				break
			}
			if chunk.Choices[0].FinishReason == "stop" {
				finalContent = stepContent
				break
			}
		}
		resp.Body.Close()

		// No tool calls → final response done
		if len(toolCalls) == 0 {
			if stepContent != "" {
				finalContent = stepContent
			}
			if step == 0 && !forceFailed && (shouldForceDraftCreate(lastUserText) || shouldForceMailAccess(lastUserText)) && finalContent == "" {
				messages = append(messages, map[string]interface{}{"role": "user", "content": "你刚才没有调用工具。这个请求必须使用允许的系统工具完成：写邮件/发送邮件必须调用 draft_create；读取、总结、翻译邮件必须调用 mail_access。请现在调用对应工具。"})
				continue
			}
			sse.send("step", fmt.Sprintf(`{"step":%d,"status":"end","finish_reason":"stop"}`, step))
			break
		}

		// Has tool calls → execute them and continue
		sse.send("step", fmt.Sprintf(`{"step":%d,"status":"end","finish_reason":"tool_calls","tool_count":%d}`, step, len(toolCalls)))

		// Build assistant message for history
		assistantMsg := map[string]interface{}{"role": "assistant", "content": stepContent}
		if stepReasoning != "" {
			assistantMsg["reasoning_content"] = stepReasoning
		}
		var assembledToolCalls []map[string]interface{}
		maxIdx := -1
		for idx := range toolCalls {
			if idx > maxIdx {
				maxIdx = idx
			}
		}
		for i := 0; i <= maxIdx; i++ {
			tc, ok := toolCalls[i]
			if !ok {
				continue
			}
			assembledToolCalls = append(assembledToolCalls, map[string]interface{}{
				"id": tc.id, "type": "function",
				"function": map[string]interface{}{"name": tc.name, "arguments": tc.arguments},
			})
		}
		assistantMsg["tool_calls"] = assembledToolCalls
		messages = append(messages, assistantMsg)

		// Execute tools and relay results
		for _, tc := range toolCalls {
			sse.send("tool_call", fmt.Sprintf(`{"id":"%s","name":"%s","status":"running"}`, tc.id, escapeJSON(tc.name)))
			result := executeAIAgentTool(tc.name, tc.arguments)
			resultJSON, _ := json.Marshal(result)
			toolContent := limitTextToTokenBudget(
				string(resultJSON),
				max(1024, contextInfo.TokenThreshold/3),
			)
			resultStr := toolContent
			if len(resultStr) > 500 {
				resultStr = resultStr[:500] + "…"
			}
			resultPreview, _ := json.Marshal(resultStr)
			sse.send("tool_result", fmt.Sprintf(`{"id":"%s","name":"%s","result":%s}`, tc.id, escapeJSON(tc.name), string(resultPreview)))
			messages = append(messages, map[string]interface{}{"role": "tool", "tool_call_id": tc.id, "content": toolContent})
		}

		sse.send("step", fmt.Sprintf(`{"step":%d,"status":"tools_done"}`, step))
	}

	if finalContent == "" {
		finalContent = "AI 没有返回内容。"
	}
	sse.send("done", "{}")
}

// relayUpstreamSSE proxies an upstream SSE response to the client as-is
// (for the no-tools fallback where we just relay the raw stream).
func relayUpstreamSSE(sse *sseWriter, resp *http.Response) {
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errPayload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		sse.send("error", fmt.Sprintf(`{"message":"Upstream error: %s"}`, escapeJSON(string(errPayload))))
		return
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			return
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil || len(chunk.Choices) == 0 {
			continue
		}
		delta := chunk.Choices[0].Delta
		if delta.ReasoningContent != "" {
			sse.send("reasoning", fmt.Sprintf(`{"text":"%s"}`, escapeJSON(delta.ReasoningContent)))
		}
		if delta.Content != "" {
			sse.send("content", fmt.Sprintf(`{"text":"%s"}`, escapeJSON(delta.Content)))
		}
	}
}

// runAgentBlocking runs the agent loop without streaming (original behavior).
func runAgentBlocking(w http.ResponseWriter, r *http.Request, baseURL, apiKey, model string, messages []map[string]interface{}, contextInfo agentContextInfo) {
	lastUserText := ""
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i]["role"] == "user" {
			lastUserText, _ = messages[i]["content"].(string)
			break
		}
	}

	forceFailed := false
	for step := 0; step < 6; step++ {
		toolChoice := interface{}("auto")
		if step == 0 && !forceFailed {
			if shouldForceDraftCreate(lastUserText) {
				toolChoice = map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "draft_create"}}
			} else if shouldForceMailAccess(lastUserText) {
				toolChoice = map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": "mail_access"}}
			}
		}
		resp, err := callAICompletion(r, baseURL, apiKey, map[string]interface{}{
			"model": model, "messages": messages, "tools": aiAgentTools(), "tool_choice": toolChoice, "temperature": 1,
		})
		if err != nil {
			if step == 0 && toolChoice != "auto" && !forceFailed {
				log.Printf("AIAgent: forced tool_choice failed (%v), retrying with auto", err)
				forceFailed = true
				step = -1
				continue
			}
			if step == 0 {
				log.Printf("AIAgent: tools not supported (%v), falling back to plain chat", err)
				resp2, err2 := callAICompletion(r, baseURL, apiKey, map[string]interface{}{"model": model, "messages": messages, "temperature": 1})
				if err2 != nil {
					respondError(w, http.StatusBadGateway, err2.Error())
					return
				}
				if resp2.Error.Message != "" {
					respondError(w, http.StatusBadGateway, resp2.Error.Message)
					return
				}
				if len(resp2.Choices) == 0 {
					respondError(w, http.StatusBadGateway, "AI returned no choices")
					return
				}
				respondJSON(w, http.StatusOK, map[string]interface{}{"message": resp2.Choices[0].Message.Content})
				return
			}
			respondError(w, http.StatusBadGateway, err.Error())
			return
		}
		if resp.Error.Message != "" {
			respondError(w, http.StatusBadGateway, resp.Error.Message)
			return
		}
		if len(resp.Choices) == 0 {
			respondError(w, http.StatusBadGateway, "AI returned no choices")
			return
		}
		assistant := resp.Choices[0].Message
		if len(assistant.ToolCalls) == 0 {
			if step == 0 && !forceFailed && (shouldForceDraftCreate(lastUserText) || shouldForceMailAccess(lastUserText)) {
				messages = append(messages, map[string]interface{}{"role": "user", "content": "你刚才没有调用工具。请现在调用对应工具。"})
				continue
			}
			respondJSON(w, http.StatusOK, map[string]interface{}{"message": assistant.Content})
			return
		}
		assistantMsg := map[string]interface{}{"role": "assistant", "content": assistant.Content, "tool_calls": assistant.ToolCalls}
		if assistant.Reasoning != "" {
			assistantMsg["reasoning_content"] = assistant.Reasoning
		}
		messages = append(messages, assistantMsg)
		for _, toolCall := range assistant.ToolCalls {
			result := executeAIAgentTool(toolCall.Function.Name, toolCall.Function.Arguments)
			resultJSON, _ := json.Marshal(result)
			messages = append(messages, map[string]interface{}{
				"role":         "tool",
				"tool_call_id": toolCall.ID,
				"content": limitTextToTokenBudget(
					string(resultJSON),
					max(1024, contextInfo.TokenThreshold/3),
				),
			})
		}
	}
	respondError(w, http.StatusBadGateway, "AI tool loop exceeded limit")
}

func latestUserMessage(messages []AIChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			return messages[i].Content
		}
	}
	return ""
}

func shouldForceDraftCreate(text string) bool {
	text = strings.ToLower(text)
	return strings.Contains(text, "起草") ||
		strings.Contains(text, "草稿") ||
		strings.Contains(text, "写一封邮件") ||
		strings.Contains(text, "写封邮件") ||
		strings.Contains(text, "回复邮件") ||
		strings.Contains(text, "发送到") ||
		strings.Contains(text, "发送给") ||
		strings.Contains(text, "send email") ||
		strings.Contains(text, "draft email") ||
		strings.Contains(text, "compose email")
}

func shouldForceMailAccess(text string) bool {
	text = strings.ToLower(text)
	return strings.Contains(text, "读取邮件") ||
		strings.Contains(text, "查看邮件") ||
		strings.Contains(text, "邮件正文") ||
		strings.Contains(text, "总结邮件") ||
		strings.Contains(text, "未读邮件") ||
		strings.Contains(text, "翻译邮件") ||
		strings.Contains(text, "mail_access") ||
		strings.Contains(text, "read email") ||
		strings.Contains(text, "summarize email")
}

type aiCompletionResponse struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
	Choices []struct {
		Message aiCompletionMessage `json:"message"`
	} `json:"choices"`
}

type aiCompletionMessage struct {
	Role      string       `json:"role,omitempty"`
	Content   string       `json:"content,omitempty"`
	Reasoning string       `json:"reasoning_content,omitempty"`
	ToolCalls []aiToolCall `json:"tool_calls,omitempty"`
}

type aiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

func callAICompletion(r *http.Request, baseURL, apiKey string, body map[string]interface{}) (*aiCompletionResponse, error) {
	payload, _ := json.Marshal(body)
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(upstreamReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("AI upstream error: status=%d body=%s", resp.StatusCode, string(data))
		var upstreamErr struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &upstreamErr) == nil && upstreamErr.Error.Message != "" {
			return nil, errAIUpstream{message: upstreamErr.Error.Message}
		}
		raw := strings.TrimSpace(string(data))
		if len(raw) > 500 {
			raw = raw[:500] + "…"
		}
		if raw != "" {
			return nil, errAIUpstream{message: "AI request failed (HTTP " + resp.Status + "): " + raw}
		}
		return nil, errAIUpstream{message: "AI request failed: HTTP " + resp.Status}
	}

	// Some providers (e.g. kimi) always return SSE even when stream=false.
	// Detect SSE format and reconstruct the final response from chunks.
	if len(data) > 5 && string(data[:6]) == "data: " {
		return collectSSEChunks(data)
	}

	var out aiCompletionResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// collectSSEChunks parses an SSE stream and accumulates content, tool calls,
// and reasoning into a single aiCompletionResponse.
func collectSSEChunks(data []byte) (*aiCompletionResponse, error) {
	out := &aiCompletionResponse{}
	// Track tool calls by index for incremental argument assembly
	type partialToolCall struct {
		id        string
		name      string
		arguments string
	}
	toolCalls := map[int]*partialToolCall{}
	reasoning := ""

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			continue
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					ToolCalls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Content != "" {
				if len(out.Choices) == 0 {
					out.Choices = []struct {
						Message aiCompletionMessage `json:"message"`
					}{{}}
				}
				out.Choices[0].Message.Content += choice.Delta.Content
			}
			if choice.Delta.ReasoningContent != "" {
				reasoning += choice.Delta.ReasoningContent
			}
			for _, tc := range choice.Delta.ToolCalls {
				existing, ok := toolCalls[tc.Index]
				if !ok {
					existing = &partialToolCall{}
					toolCalls[tc.Index] = existing
				}
				if tc.ID != "" {
					existing.id = tc.ID
				}
				if tc.Function.Name != "" {
					existing.name += tc.Function.Name
				}
				existing.arguments += tc.Function.Arguments
			}
		}
	}

	// Assemble accumulated tool calls
	if len(toolCalls) > 0 {
		if len(out.Choices) == 0 {
			out.Choices = []struct {
				Message aiCompletionMessage `json:"message"`
			}{{}}
		}
		// Sort by index to maintain order
		maxIdx := -1
		for idx := range toolCalls {
			if idx > maxIdx {
				maxIdx = idx
			}
		}
		for i := 0; i <= maxIdx; i++ {
			tc, ok := toolCalls[i]
			if !ok {
				continue
			}
			out.Choices[0].Message.ToolCalls = append(out.Choices[0].Message.ToolCalls, aiToolCall{
				ID:   tc.id,
				Type: "function",
			})
			last := &out.Choices[0].Message.ToolCalls[len(out.Choices[0].Message.ToolCalls)-1]
			last.Function.Name = tc.name
			last.Function.Arguments = tc.arguments
		}
		out.Choices[0].Message.Reasoning = reasoning
	}

	return out, nil
}

type errAIUpstream struct {
	message string
}

func (e errAIUpstream) Error() string {
	return e.message
}

func aiAgentTools() []map[string]interface{} {
	return []map[string]interface{}{
		{
			"type": "function",
			"function": map[string]interface{}{
				"name":        "mail_access",
				"description": "读取 MailGo 中的邮件列表或指定邮件正文。只用于用户要求总结、查找、翻译、分析邮件时。",
				"parameters": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"query": map[string]interface{}{
							"type":        "string",
							"description": "搜索关键词，可匹配主题、发件人、收件人、摘要和正文。",
						},
						"unread": map[string]interface{}{
							"type":        "boolean",
							"description": "是否只读取未读邮件。",
						},
						"message_ids": map[string]interface{}{
							"type": "array",
							"items": map[string]interface{}{
								"type": "integer",
							},
							"description": "指定要读取正文的邮件 ID 列表。",
						},
						"include_body": map[string]interface{}{
							"type":        "boolean",
							"description": "是否返回正文。列表浏览默认 false；总结/翻译/回复草稿应为 true。",
						},
						"limit": map[string]interface{}{
							"type":        "integer",
							"description": "最多返回多少封邮件，默认 10，最大 50。",
						},
					},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]interface{}{
				"name":        "draft_create",
				"description": "在 MailGo 草稿箱中新建一封邮件草稿。只能创建草稿，不能发送。",
				"parameters": map[string]interface{}{
					"type":     "object",
					"required": []string{"subject", "body_text"},
					"properties": map[string]interface{}{
						"account_id": map[string]interface{}{
							"type":        "integer",
							"description": "发件账户 ID；未知时省略。",
						},
						"account_email": map[string]interface{}{
							"type":        "string",
							"description": "发件邮箱地址（如 admin@tz.kg）。传入时自动匹配账户 ID，优先级高于 account_id。",
						},
						"to_addresses": map[string]interface{}{
							"type": "array",
							"items": map[string]interface{}{
								"type": "string",
							},
							"description": "收件人邮箱列表。",
						},
						"cc_addresses": map[string]interface{}{
							"type":  "array",
							"items": map[string]interface{}{"type": "string"},
						},
						"bcc_addresses": map[string]interface{}{
							"type":  "array",
							"items": map[string]interface{}{"type": "string"},
						},
						"subject": map[string]interface{}{
							"type": "string",
						},
						"body_text": map[string]interface{}{
							"type": "string",
						},
						"body_html": map[string]interface{}{
							"type": "string",
						},
						"in_reply_to": map[string]interface{}{
							"type": "string",
						},
						"references": map[string]interface{}{
							"type": "string",
						},
					},
				},
			},
		},
	}
}

func executeAIAgentTool(name, rawArgs string) map[string]interface{} {
	switch name {
	case "mail_access":
		return toolMailAccess(rawArgs)
	case "draft_create":
		return toolDraftCreate(rawArgs)
	default:
		return map[string]interface{}{"ok": false, "error": "Tool not allowed"}
	}
}

func toolMailAccess(rawArgs string) map[string]interface{} {
	var args struct {
		Query       string  `json:"query"`
		Unread      bool    `json:"unread"`
		MessageIDs  []int64 `json:"message_ids"`
		IncludeBody bool    `json:"include_body"`
		Limit       int     `json:"limit"`
	}
	if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
		return map[string]interface{}{"ok": false, "error": "Invalid mail_access arguments"}
	}
	if args.Limit <= 0 {
		args.Limit = 10
	}
	if args.Limit > 50 {
		args.Limit = 50
	}

	type mailRow struct {
		ID          int64  `json:"id"`
		AccountID   int64  `json:"account_id"`
		Subject     string `json:"subject"`
		FromAddress string `json:"from_address"`
		FromName    string `json:"from_name"`
		ToAddresses string `json:"to_addresses"`
		Snippet     string `json:"snippet"`
		BodyText    string `json:"body_text,omitempty"`
		ReceivedAt  string `json:"received_at"`
		IsRead      bool   `json:"is_read"`
	}

	where := "WHERE is_deleted = 0 AND is_draft = 0"
	values := make([]interface{}, 0)
	if len(args.MessageIDs) > 0 {
		placeholders := make([]string, 0, len(args.MessageIDs))
		for _, id := range args.MessageIDs {
			placeholders = append(placeholders, "?")
			values = append(values, id)
		}
		where += " AND id IN (" + strings.Join(placeholders, ",") + ")"
	} else {
		if args.Unread {
			where += " AND is_read = 0"
		}
		if strings.TrimSpace(args.Query) != "" {
			like := "%" + strings.TrimSpace(args.Query) + "%"
			where += ` AND (
				subject LIKE ? OR from_name LIKE ? OR from_address LIKE ?
				OR to_addresses LIKE ? OR cc_addresses LIKE ? OR bcc_addresses LIKE ?
				OR body_text LIKE ? OR body_html LIKE ? OR snippet LIKE ?
			)`
			values = append(values, like, like, like, like, like, like, like, like, like)
		}
	}
	values = append(values, args.Limit)

	rows, err := database.DB.Query(`SELECT id, account_id, subject, from_address, from_name, to_addresses,
		snippet, body_text, body_html, received_at, is_read
		FROM messages `+where+` ORDER BY received_at DESC LIMIT ?`, values...)
	if err != nil {
		return map[string]interface{}{"ok": false, "error": err.Error()}
	}
	defer rows.Close()

	messages := make([]mailRow, 0)
	for rows.Next() {
		var row mailRow
		var bodyHTML string
		if err := rows.Scan(&row.ID, &row.AccountID, &row.Subject, &row.FromAddress, &row.FromName, &row.ToAddresses, &row.Snippet, &row.BodyText, &bodyHTML, &row.ReceivedAt, &row.IsRead); err != nil {
			continue
		}
		if args.IncludeBody {
			if strings.TrimSpace(row.BodyText) == "" {
				row.BodyText = stripSimpleHTML(bodyHTML)
			}
			if len(row.BodyText) > 12000 {
				row.BodyText = row.BodyText[:12000] + "\n...[truncated]"
			}
		} else {
			row.BodyText = ""
		}
		messages = append(messages, row)
	}
	return map[string]interface{}{"ok": true, "messages": messages}
}

func toolDraftCreate(rawArgs string) map[string]interface{} {
	var args struct {
		AccountID    *int64   `json:"account_id"`
		AccountEmail string   `json:"account_email"`
		ToAddresses  []string `json:"to_addresses"`
		CcAddresses  []string `json:"cc_addresses"`
		BccAddresses []string `json:"bcc_addresses"`
		Subject      string   `json:"subject"`
		BodyText     string   `json:"body_text"`
		BodyHTML     string   `json:"body_html"`
		InReplyTo    string   `json:"in_reply_to"`
		References   string   `json:"references"`
	}
	if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
		return map[string]interface{}{"ok": false, "error": "Invalid draft_create arguments"}
	}
	if strings.TrimSpace(args.Subject) == "" || strings.TrimSpace(args.BodyText) == "" {
		return map[string]interface{}{"ok": false, "error": "subject and body_text are required"}
	}
	if args.BodyHTML == "" {
		args.BodyHTML = strings.ReplaceAll(escapeHTML(args.BodyText), "\n", "<br/>")
	}

	// Resolve account_email → account_id (takes priority over account_id)
	accountID := args.AccountID
	if strings.TrimSpace(args.AccountEmail) != "" {
		var resolvedID int64
		err := database.DB.QueryRow("SELECT id FROM accounts WHERE email = ? LIMIT 1", strings.TrimSpace(args.AccountEmail)).Scan(&resolvedID)
		if err == nil {
			accountID = &resolvedID
		} else {
			log.Printf("draft_create: account_email %q not found, using provided account_id", args.AccountEmail)
		}
	}

	toJSON := jsonStringList(args.ToAddresses)
	ccJSON := jsonStringList(args.CcAddresses)
	bccJSON := jsonStringList(args.BccAddresses)

	result, err := database.DB.Exec(`INSERT INTO drafts (account_id, to_addresses, cc_addresses, bcc_addresses,
		subject, body_html, body_text, in_reply_to, ref_references)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		accountID, toJSON, ccJSON, bccJSON,
		args.Subject, args.BodyHTML, args.BodyText, args.InReplyTo, args.References)
	if err != nil {
		return map[string]interface{}{"ok": false, "error": err.Error()}
	}
	id, _ := result.LastInsertId()
	return map[string]interface{}{
		"ok":       true,
		"draft_id": id,
		"message":  "Draft created. The user must review and send it manually.",
	}
}

func jsonStringList(items []string) string {
	if items == nil {
		items = []string{}
	}
	data, err := json.Marshal(items)
	if err != nil {
		return "[]"
	}
	return string(data)
}

// escapeJSON escapes a string for safe embedding in a JSON string value
// (handles newlines, quotes, backslashes, tabs, etc.).
func escapeJSON(s string) string {
	b, _ := json.Marshal(s)
	// Marshal wraps in quotes — strip them to get just the escaped content.
	if len(b) >= 2 {
		return string(b[1 : len(b)-1])
	}
	return s
}

func loadAISettings() (baseURL string, apiKey string, model string, err error) {
	values := map[string]string{}
	rows, queryErr := database.DB.Query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('ai_base_url', 'ai_api_key', 'ai_model')")
	if queryErr != nil {
		return "", "", "", queryErr
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if scanErr := rows.Scan(&key, &value); scanErr == nil {
			values[key] = value
		}
	}

	baseURL = strings.TrimSpace(values["ai_base_url"])
	apiKey = strings.TrimSpace(values["ai_api_key"])
	model = strings.TrimSpace(values["ai_model"])
	if model == "" {
		model = "gpt-4o-mini"
	}
	if baseURL == "" || apiKey == "" {
		return "", "", "", errAISettingsMissing{}
	}
	// SSRF protection: block AI endpoints pointing to private/local addresses.
	if u, parseErr := url.Parse(baseURL); parseErr == nil && isPrivateHost(u.Hostname()) {
		return "", "", "", fmt.Errorf("AI base URL cannot point to a private address")
	}
	return baseURL, apiKey, model, nil
}

// loadAISystemPrompt reads the user-configured system prompt from settings.
// Returns empty string if not set (caller should use built-in default).
func loadAISystemPrompt() string {
	var value string
	err := database.DB.QueryRow("SELECT setting_value FROM settings WHERE setting_key = 'ai_system_prompt'").Scan(&value)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

type errAISettingsMissing struct{}

func (errAISettingsMissing) Error() string {
	return "Please configure AI API in Settings first"
}

// loadTranslateAISettings returns the AI credentials for translation.
// When ai_translate_use_global is "true" (or unset), it falls back to the
// global AI settings.  Otherwise it reads the dedicated translation keys.
func loadTranslateAISettings() (baseURL string, apiKey string, model string, err error) {
	values := map[string]string{}
	rows, queryErr := database.DB.Query(
		"SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('ai_translate_use_global', 'ai_translate_base_url', 'ai_translate_api_key', 'ai_translate_model', 'ai_base_url', 'ai_api_key', 'ai_model')")
	if queryErr != nil {
		return "", "", "", queryErr
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if scanErr := rows.Scan(&key, &value); scanErr == nil {
			values[key] = value
		}
	}

	useGlobal := values["ai_translate_use_global"] == "" || values["ai_translate_use_global"] == "true"
	if useGlobal {
		return loadAISettings()
	}

	baseURL = strings.TrimSpace(values["ai_translate_base_url"])
	apiKey = strings.TrimSpace(values["ai_translate_api_key"])
	model = strings.TrimSpace(values["ai_translate_model"])
	if model == "" {
		model = "gpt-4o-mini"
	}
	if baseURL == "" || apiKey == "" {
		return "", "", "", errAISettingsMissing{}
	}
	return baseURL, apiKey, model, nil
}

// AITranslate handles POST /api/v1/ai/translate — a simple chat completion
// that uses translation-specific AI settings (or falls back to global).
func AITranslate(w http.ResponseWriter, r *http.Request) {
	var req AIChatRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(req.Messages) == 0 {
		respondError(w, http.StatusBadRequest, "messages is required")
		return
	}

	baseURL, apiKey, model, err := loadTranslateAISettings()
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Model) != "" {
		model = strings.TrimSpace(req.Model)
	}

	body := map[string]interface{}{
		"model":       model,
		"messages":    req.Messages,
		"temperature": 1,
	}
	upstreamBody, _ := json.Marshal(body)
	upstreamURL := strings.TrimRight(baseURL, "/") + "/chat/completions"
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(upstreamBody))
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create AI request")
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(upstreamReq)
	if err != nil {
		log.Printf("AI translate upstream request error: %v", err)
		respondError(w, http.StatusBadGateway, "AI request failed: "+err.Error())
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		log.Printf("AI translate upstream error (status %d): %s", resp.StatusCode, func() string {
			s := string(respBody)
			if len(s) > 200 {
				return s[:200] + "…"
			}
			return s
		}())
		respondError(w, http.StatusBadGateway, "Translation service returned an error")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(respBody)
}

func contentTypeOrJSON(value string) string {
	if strings.TrimSpace(value) == "" {
		return "application/json; charset=utf-8"
	}
	return value
}

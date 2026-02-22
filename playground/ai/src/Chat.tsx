import { useState, useRef, useEffect, useCallback } from "react";
import { fetchStream } from "vite-cloud/client";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Props {
  model: string;
}

export default function Chat({ model }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 128) + "px";
    }
  }, [input]);

  async function send() {
    const content = input.trim();
    if (!content || streaming) return;

    const userMessage: Message = { role: "user", content };
    const history = [...messages, userMessage];

    setMessages(history);
    setInput("");
    setStreaming(true);

    // Build messages array for the API
    const apiMessages: Array<{ role: string; content: string }> = [];
    if (systemPrompt.trim()) {
      apiMessages.push({ role: "system", content: systemPrompt.trim() });
    }
    for (const msg of history) {
      if (msg.role !== "system") {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const assistantIndex = history.length;
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      for await (const chunk of fetchStream("/api/chat" as any, {
        method: "POST",
        body: { model, messages: apiMessages },
        signal: abort.signal,
      })) {
        setMessages((prev) => {
          const next = [...prev];
          next[assistantIndex] = {
            ...next[assistantIndex],
            content: next[assistantIndex].content + chunk,
          };
          return next;
        });
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          next[assistantIndex] = {
            ...next[assistantIndex],
            content:
              next[assistantIndex].content || `Error: ${err.message || "Failed to get response"}`,
          };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function clearChat() {
    if (streaming && abortRef.current) {
      abortRef.current.abort();
    }
    setMessages([]);
    setStreaming(false);
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="model-name">{model}</span>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "1px solid #3b3440",
              borderRadius: "3px",
              color: "rgba(255,255,255,0.5)",
              padding: "0.125rem 0.5rem",
              fontSize: "0.6875rem",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="system-toggle">
        <label>System</label>
        <input
          type="text"
          placeholder="Optional system prompt..."
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </div>

      <div className="messages" ref={messagesRef}>
        {messages.length === 0 ? (
          <div className="empty-state">Send a message to start chatting</div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className="message">
              <div className={`message-role ${msg.role}`}>{msg.role}</div>
              <div className={`message-content ${msg.role === "system" ? "system-content" : ""}`}>
                {msg.content}
                {msg.role === "assistant" && streaming && i === messages.length - 1 && (
                  <span className="cursor-blink" />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="chat-input">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={streaming}
        />
        <button onClick={send} disabled={streaming || !input.trim()}>
          {streaming ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}

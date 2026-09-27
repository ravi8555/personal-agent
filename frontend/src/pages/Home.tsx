import { useEffect, useRef, useState } from "react";
import { Logo } from "../components/Logo";

interface Message {
  id: number;
  role: "bot" | "user";
  text: string;
  senderName?: string;
  senderRole?: string;
  timestamp?: string;
  status?: "sent" | "delivered" | "read";
}

const SEED: Message[] = [
  {
    id: 1,
    role: "bot",
    senderName: "NeuroGraph",
    senderRole: "AI Memory Agent",
    timestamp: "11:30 AM",
    status: "read",
    text: "Good morning! ☀️ I recall from our Neo4j knowledge graph that you prefer tea over coffee and were planning a move to Pune. Want to pick up where we left off?",
  },
  {
    id: 2,
    role: "user",
    senderName: "You",
    timestamp: "11:31 AM",
    status: "read",
    text: "Actually, I like coffee now.",
  },
  {
    id: 3,
    role: "bot",
    senderName: "NeuroGraph",
    senderRole: "AI Memory Agent",
    timestamp: "11:35 AM",
    status: "read",
    text: "Updated in graph! ☕ Retired old tea preference and confirmed your coffee preference. I will remember this going forward.",
  },
];

/** Central, single-fold chat view (Grok-style): scrollable message list + bottom composer. */
export function Home() {
  const [messages, setMessages] = useState<Message[]>(SEED);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  const handleSendText = (textToSend: string) => {
    const text = textToSend.trim();
    if (!text) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const userMsgId = (messages.at(-1)?.id ?? 0) + 1;
    setMessages(m => [
      ...m,
      {
        id: userMsgId,
        role: "user",
        senderName: "You",
        timestamp: timeStr,
        status: "read",
        text,
      },
    ]);
    setDraft("");

    // Local preview echo only — this frontend is isolated and makes no network calls.
    setTimeout(() => {
      setMessages(m => [
        ...m,
        {
          id: userMsgId + 1,
          role: "bot",
          senderName: "NeuroGraph",
          senderRole: "AI Memory Agent",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          status: "read",
          text: botReply(text),
        },
      ]);
    }, 500);
  };

  const handleSend = () => handleSendText(draft);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <main className="chat-page">
      <div className="chat-hero">
        <div className="chat-hero__header">
          <div className="chat-hero__title-row">
            <div className="chat-hero__brand-lockup">
              <Logo size={44} />
              <div>
                <h1 className="chat-hero__title">
                  Personal Agent<span className="chat-hero__tag"> memory.</span>
                </h1>
                <p className="chat-hero__tagline">
                  Graph-augmented personal assistant with persistent Neo4j memory, conflict-safe updates, and proactive recall.
                </p>
              </div>
            </div>
          </div>

          <div className="chat-hero__avatars-row" aria-hidden="true">
            <span className="hero-avatar hero-avatar--lavender">🧑‍💻</span>
            <span className="hero-avatar hero-avatar--sun">👩‍🦰</span>
            <span className="hero-avatar hero-avatar--rose">👩</span>
          </div>
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-stack">
          <section className="chat-card chat-card--compact" aria-label="Active team">
            <div className="chat-card__top">
              <div className="avatar-stack" aria-hidden="true">
                <span className="avatar-chip avatar-chip--1">🧠</span>
                <span className="avatar-chip avatar-chip--2">⚡</span>
                <span className="avatar-chip avatar-chip--3">🌐</span>
              </div>
              <div>
                <div className="chat-card__names">🦄 Team Unicorns · NeuroGraph</div>
                <div className="chat-card__sub">last seen 45 minutes ago · graph memory linked</div>
              </div>
            </div>
          </section>

          <section className="chat-card chat-card--room" aria-label="Live conversation">
            <ul ref={listRef} className="chat-list" role="log" aria-label="Chat conversation">
              <li className="chat-date-divider" role="separator" aria-label="Timeline indicator">
                <span>8/20/2026 · Active Memory Graph</span>
              </li>
              {messages.map(m => {
                const isUser = m.role === "user";
                return (
                  <li key={m.id} className={`msg msg--${m.role}`}>
                    {!isUser && (
                      <div className="msg__avatar-wrapper">
                        <span className="avatar avatar--bot" aria-hidden="true">
                          🤖
                        </span>
                      </div>
                    )}

                    <div className="msg__body">
                      <div className="msg__header">
                        <span className="msg__author">{m.senderName ?? (isUser ? "You" : "NeuroGraph")}</span>
                        {m.senderRole && <span className="msg__badge">{m.senderRole}</span>}
                      </div>
                      <div className="msg__bubble">
                        <span className="msg__content">{m.text}</span>
                        <div className="msg__footer">
                          <span className="msg__time">{m.timestamp ?? "11:35 AM"}</span>
                          {isUser && (
                            <span className="msg__ticks" title="Delivered to graph">
                              ✓✓
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {isUser && (
                      <div className="msg__avatar-wrapper">
                        <span className="avatar avatar--user" aria-hidden="true">
                          🧑‍💻
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="chat-card chat-card--preview" aria-label="Condensed preview" aria-hidden="true">
            <ul className="chat-list" tabIndex={-1}>
              {messages.slice(-3).map(m => {
                const isUser = m.role === "user";
                return (
                  <li key={`preview-${m.id}`} className={`msg msg--${m.role}`}>
                    <div className="msg__body">
                      <div className="msg__header">
                        <span className="msg__author">{isUser ? "You" : "NeuroGraph"}</span>
                      </div>
                      <div className="msg__bubble">
                        <span className="msg__content">{m.text}</span>
                        <div className="msg__footer">
                          <span className="msg__time">{m.timestamp ?? "11:35 AM"}</span>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

      <div className="composer-container">
        <div className="composer-wrapper">
          <div className="composer">
            <textarea
              value={draft}
              placeholder="Message NeuroGraph or ask about graph memory…"
              aria-label="Message NeuroGraph"
              rows={1}
              maxLength={2000}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <button
              type="button"
              className="cta-btn cta-btn--primary composer__send-btn"
              disabled={!draft.trim()}
              aria-label="Send message"
              onClick={handleSend}
            >
              <span>Send</span>
              <span className="send-icon" aria-hidden="true">
                ⭢
              </span>
            </button>
          </div>

          <aside className="quick-dock" aria-label="Quick shortcuts">
            <button
              type="button"
              className="quick-dock__btn"
              title="Graph entity lookup"
              onClick={() => setDraft(prev => prev + " @Entity ")}
            >
              @
            </button>
            <button
              type="button"
              className="quick-dock__btn"
              title="Insert emoji"
              onClick={() => setDraft(prev => prev + " ☕ ")}
            >
              😊
            </button>
            <button
              type="button"
              className="quick-dock__btn"
              title="Verify memory graph synchronization"
              onClick={() => handleSendText("Check memory synchronization status.")}
            >
              ✓✓
            </button>
            <button
              type="button"
              className="quick-dock__btn quick-dock__btn--send"
              title="Send now"
              onClick={handleSend}
              disabled={!draft.trim()}
            >
              ⭢
            </button>
          </aside>
        </div>
      </div>
      </div>
    </main>
  );
}

/** Tiny inline-only reply generator (preview behaviour, no backend). */
function botReply(input: string): string {
  const s = input.toLowerCase();
  if (s.includes("hello") || s.includes("hi ") || s.includes("hey")) {
    return "Hi team! 👋 NeuroGraph active memory and agent skills are online.";
  }
  if (s.includes("pune") || s.includes("weather")) {
    return "Tool calling [fetchWeatherInfo('Pune')]: The weather in Pune is currently Sunny, 29°C. Indexed into graph.";
  }
  if (s.includes("coffee") || s.includes("tea") || s.includes("espresso")) {
    return "Conflict detector resolved! Retired outdated fact (tea) and recorded (User)-[:PREFERS]->(Coffee) in Neo4j.";
  }
  if (s.includes("inspect") || s.includes("variant") || s.includes("graph")) {
    return "Active Graph Subgraph:\n• (User)-[:LOCATED_IN]->(Pune) [Target relocation]\n• (User)-[:PREFERS]->(Coffee) [Confidence: 0.98]\n• Context Watcher: 3 entity nodes injected into prompt.";
  }
  if (s.includes("recall") || s.includes("free")) {
    return "Recall summary: You relocated your beverage preference to coffee, are tracking Pune transit, and have autonomous tool execution enabled.";
  }
  if (s.includes("lunch") || s.includes("down") || s.includes("idea")) {
    return "I'm down for whatever! 🍽️ Any ideas? Let's check nearby spots.";
  }
  return `Acknowledged: "${input}". (Local preview echo — the full agent loop with Neo4j context watcher and tools will handle live conversations upon server bridge attachment.)`;
}

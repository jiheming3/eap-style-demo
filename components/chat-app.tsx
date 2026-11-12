"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { scenarios, getScenario } from "@/lib/scenarios";
import { PROMPT_VERSION } from "@/lib/prompt";
import type { ChatEvent, Message, ModelStatus, Rating, Session } from "@/lib/types";
import { Icon, Mark } from "./icons";
import SettingsDialog from "./settings-dialog";
import ServiceCards, { AgentActivity } from "./service-cards";

const INITIAL_STATUS: ModelStatus = { model: "qwen3.8-max", baseUrl: "", hasKey: false, configured: false, verified: false, checkedAt: null };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers }, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "操作未完成，请重试。");
  return result;
}

function insertSession(list: Session[], session: Session) {
  return [session, ...list.filter((item) => item.id !== session.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export default function ChatApp() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<ModelStatus>(INITIAL_STATUS);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ user: Message; assistant: Message } | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [demo, setDemo] = useState<{ profile: { name: string }; sampleQueries: string[] } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const aborter = useRef<AbortController | null>(null);
  const nearBottom = useRef(true);
  const drafts = useRef<Record<string, string>>({});
  const active = sessions.find((session) => session.id === activeId) ?? null;
  const scenario = getScenario(active?.scenarioId);
  const messages = [...(active?.messages ?? []), ...(pending ? [pending.user, pending.assistant] : [])];
  const latestAssistantId = messages.findLast((message) => message.role === "assistant")?.id;
  const locked = generating || actionBusy || creating || !ready;

  useEffect(() => {
    let alive = true;
    Promise.all([api<{ sessions: Session[] }>("/api/sessions"), api<ModelStatus>("/api/settings")]).then(([data, modelStatus]) => {
      if (!alive) return;
      setSessions(data.sessions); setStatus(modelStatus);
      void api<{ profile: { name: string }; sampleQueries: string[] }>("/api/demo").then((value) => { if (alive) setDemo(value); }).catch(() => {});
      const saved = localStorage.getItem("eap_active_session");
      const restored = data.sessions.find((item) => item.id === saved) ?? data.sessions.find((item) => item.messages.length > 0);
      if (restored) setActiveId(restored.id);
    }).catch((reason) => { if (alive) setError(reason.message ?? "无法连接本地服务，请刷新页面。"); }).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (activeId) localStorage.setItem("eap_active_session", activeId); }, [activeId]);
  useEffect(() => { if (nearBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [messages.length, pending?.assistant.content, activeId]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!composer.current) return; composer.current.style.height = "auto"; composer.current.style.height = Math.min(composer.current.scrollHeight, 150) + "px"; }, [draft]);

  function rememberDraft() { drafts.current[activeId ?? "welcome"] = draft; }
  function switchTo(session: Session) {
    if (locked) return;
    rememberDraft(); setActiveId(session.id); setDraft(drafts.current[session.id] ?? ""); setError(""); setPending(null); setNoteFor(null); setMobileOpen(false); nearBottom.current = true;
  }

  async function newSession(scenarioId: string | null) {
    if (locked) return;
    setCreating(true); setError("");
    try {
      const session = await api<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ scenarioId }) });
      rememberDraft(); setSessions((list) => insertSession(list, session)); setActiveId(session.id);
      setDraft(getScenario(scenarioId)?.starter ?? ""); setPending(null); setNoteFor(null); setMobileOpen(false); nearBottom.current = true;
      requestAnimationFrame(() => composer.current?.focus());
    } catch (reason) { setError((reason as Error).message); }
    finally { setCreating(false); }
  }

  async function send(contentOverride?: string) {
    const fromCard = typeof contentOverride === "string";
    const content = (contentOverride ?? draft).trim();
    if (!content || locked) return;
    if (!status.configured) { setSettingsOpen(true); return; }
    if (content.length > 6000) { setError("每条内容请控制在 6000 字以内。"); return; }
    const controller = new AbortController(); aborter.current = controller;
    setGenerating(true); setError(""); setAgentStatus("主 Agent 正在梳理需求"); nearBottom.current = true;
    let current = active;
    let finished = false;
    try {
      if (!current) {
        current = await api<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ scenarioId: null }), signal: controller.signal });
        setSessions((list) => insertSession(list, current!)); setActiveId(current.id);
      }
      if (!fromCard) { setDraft(""); drafts.current[current.id] = ""; }
      const optimistic: Message = { id: "pending-user", role: "user", content, createdAt: new Date().toISOString() };
      setPending({ user: optimistic, assistant: { id: "pending-assistant", role: "assistant", content: "", createdAt: new Date().toISOString() } });
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: current.id, content }), signal: controller.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error ?? "发送未完成，请重试。"); }
      if (!response.body) throw new Error("暂时没有收到模型回复，请重试。");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      function handle(line: string) {
        if (!line.trim()) return;
        const event: ChatEvent = JSON.parse(line);
        if (event.type === "start") setPending({ user: event.user, assistant: { id: event.assistantId, role: "assistant", content: "", createdAt: new Date().toISOString() } });
        if (event.type === "delta") setPending((previous) => previous ? { ...previous, assistant: { ...previous.assistant, content: previous.assistant.content + event.text } } : previous);
        if (event.type === "status") setAgentStatus(event.label);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") { finished = true; setSessions((list) => insertSession(list, event.session)); setPending(null); }
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); handle(line); }
          if (done) { if (buffer.trim()) handle(buffer); break; }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!finished) throw new Error("回复中断，你的输入已保留，可以重试。");
      setStatus(await api<ModelStatus>("/api/settings"));
    } catch (reason) {
      let committed = false;
      if (current) {
        try {
          const restored = await api<Session>(`/api/sessions/${current.id}`);
          committed = restored.messages.length > current.messages.length;
          setSessions((list) => insertSession(list, restored));
        } catch { /* Keep the last confirmed transcript if reconnection also fails. */ }
      }
      if (!committed && !fromCard) { setDraft(content); if (current) drafts.current[current.id] = content; }
      setError(controller.signal.aborted ? (committed ? "生成已完成，回复已保留。" : "已停止生成，输入已放回编辑框。") : ((reason as Error).message || "暂时无法连接，请重试。"));
    } finally { setPending(null); setGenerating(false); setAgentStatus(""); aborter.current = null; }
  }

  async function bookAppointment(expertId: string, slotId: string) {
    if (!active || locked) return;
    setActionBusy(true); setError(""); nearBottom.current = true;
    try {
      const result = await api<{ session: Session }>("/api/appointments", { method: "POST", body: JSON.stringify({ sessionId: active.id, expertId, slotId }) });
      setSessions((list) => insertSession(list, result.session));
      setToast("预约成功");
    } catch (reason) {
      setError((reason as Error).message || "预约没有完成，请重新选择。");
    } finally { setActionBusy(false); }
  }

  async function feedback(messageId: string, rating: Rating, value = "") {
    if (!active || feedbackBusy) return;
    setFeedbackBusy(true);
    try {
      const updated = await api<Session>(`/api/sessions/${active.id}/feedback`, { method: "POST", body: JSON.stringify({ messageId, rating, note: value }) });
      setSessions((list) => insertSession(list, updated)); setNoteFor(null); setToast("反馈已记录");
    } catch (reason) { setError((reason as Error).message); }
    finally { setFeedbackBusy(false); }
  }

  function exportSession() {
    if (!active?.messages.length || generating) return;
    const data = { exportedAt: new Date().toISOString(), productStage: "多智能体协作演示版", provider: "千问", configuredModel: status.model, promptVersion: PROMPT_VERSION, scenario, session: active };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `EAP-对话评审-${active.id.slice(0, 8)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("本次对话与反馈已导出");
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); setToast("已复制回复"); } catch { setToast("复制未完成，可以直接选中文字复制"); }
  }

  const filtered = scenarios.filter((item) => (item.title + item.description + item.code).toLowerCase().includes(search.toLowerCase()));
  const history = sessions.filter((session) => session.messages.length > 0);
  const visibleHistory = allHistory ? history : history.slice(0, 4);

  return <div className="app-shell">
    {mobileOpen && <button className="sidebar-scrim" aria-label="关闭侧栏" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <a className="brand" href="/" aria-label="陪伴空间首页"><Mark /><span><strong>陪伴空间<span className="brand-dot">.</span></strong><small>EAP · 员工支持</small></span></a>
      <button className="new-chat" onClick={() => void newSession(null)} disabled={locked}><Icon name="plus" size={19} /><span>开启新的对话</span><span className="new-chat-hint">↗</span></button>
      <div className="nav-section-head"><span>对话话题</span><span className="count-tag">12</span></div>
      <label className="scenario-search"><Icon name="message" size={15} /><input aria-label="查找对话话题" placeholder="找一个想聊的话题" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <nav className="scenario-list" aria-label="对话话题">
        {filtered.map((item) => <button key={item.id} className={`scenario-item ${scenario?.id === item.id ? "selected" : ""}`} onClick={() => void newSession(item.id)} disabled={locked} title={item.description}><Icon name={item.icon} size={17} /><span>{item.title}</span><span className="scenario-code">{item.code}</span></button>)}
        {filtered.length === 0 && <p className="nav-empty">没有找到这个话题</p>}
      </nav>
      {visibleHistory.length > 0 && <div className={`recent-section ${allHistory ? "history-expanded" : ""}`}><div className="nav-section-head"><span>历史对话</span>{history.length > 4 && <button className="history-toggle" onClick={() => setAllHistory(!allHistory)} aria-expanded={allHistory}>{allHistory ? "收起" : `全部 ${history.length} 条`}<Icon name="down" size={11} /></button>}</div><div className="history-list">{visibleHistory.map((session) => <button key={session.id} className={`history-item ${session.id === activeId ? "active" : ""}`} onClick={() => switchTo(session)} disabled={locked}><span className="history-dot" /><span>{session.title}</span></button>)}</div></div>}
      <div className="sidebar-footer"><div className="local-avatar"><Icon name="leaf" size={19} /></div><div><strong>{demo?.profile.name ?? "林晓"} · 员工账户</strong><span>EAP 员工服务</span></div><button className="icon-button" aria-label="打开模型设置" onClick={() => setSettingsOpen(true)} disabled={generating}><Icon name="settings" size={18} /></button></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="打开侧栏" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button><span className="header-dot" /><span>{scenario ? scenario.title : "自由对话"}</span><span className="header-divider">/</span><span className="topbar-subtitle">慢慢说，我在听</span></div><div className="topbar-actions"><button className={`connection-badge ${status.verified ? "connected" : ""}`} onClick={() => setSettingsOpen(true)} disabled={generating}><span className="status-dot" />{!ready ? "正在准备" : status.verified ? "模型已连接" : status.configured ? "待验证连接" : "连接模型"}<Icon name="down" size={12} /></button><span className="toolbar-divider" /><button className={`icon-button ${reviewOpen ? "is-active" : ""}`} title="查看评审提示" aria-label="查看评审提示" aria-pressed={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}><Icon name="book" size={19} /></button><button className="icon-button" title="导出对话与反馈" aria-label="导出对话与反馈" disabled={!active?.messages.length || generating} onClick={exportSession}><Icon name="download" size={19} /></button></div></header>

      <div className="workspace"><section className="conversation-column" aria-label="对话空间">
        <div className="demo-account-strip"><span><Icon name="shield" size={13} />员工账户 · {demo?.profile.name ?? "林晓"}</span><span>咨询、预约与账户服务</span></div>
        <div className="conversation-scroll" ref={scroller} onScroll={() => { if (scroller.current) nearBottom.current = scroller.current.scrollHeight - scroller.current.scrollTop - scroller.current.clientHeight < 150; }}>
          {messages.length === 0 ? <div className={`welcome ${scenario ? "scenario-welcome" : ""}`}>
            <div className="welcome-emblem"><svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><circle cx="65" cy="31" r="19" fill="#E8B8A1" /><path d="M17 81C17 48 39 35 59 43c9 25-8 43-27 43H17v-5Z" fill="#879C85" /><path d="m21 85 24-30" stroke="#F9F8F4" strokeWidth="1.6" /><path d="M61 85c-5-18 3-31 21-30 2 17-6 29-21 30Z" fill="#D4D9C8" /><path d="M10 87h80" stroke="#B5B8A9" strokeWidth="1.2" strokeLinecap="round" /></svg></div>
            <span className="welcome-eyebrow">{scenario ? `场景 ${scenario.code} · ${scenario.category}` : "给自己，一点喘息的空间"}</span>
            <h1>{scenario ? scenario.title : <>把心事放下片刻，<br />从一句话开始。</>}</h1>
            <p className="welcome-description">{scenario ? scenario.description : <>想聊聊工作中的消耗，分享一件小事，<br className="desktop-break" />或一起梳理眼前的难题，都可以。</>}</p>
            {scenario ? <div className="scenario-intro"><div className="scenario-intro-head"><span><Icon name="book" size={15} />这次可以观察</span><button onClick={() => setReviewOpen(true)}>更多提示<Icon name="chevron" size={12} /></button></div><ul>{scenario.watch.map((item) => <li key={item}><span />{item}</li>)}</ul><p>输入已准备好，你也可以先改一改，再发送。</p></div> : <div className="starter-grid">{["work", "advice", "memory", "positive"].map((id) => { const item = getScenario(id)!; return <button key={id} className={`starter-card starter-${id}`} onClick={() => void newSession(id)} disabled={locked}><span className="starter-icon"><Icon name={item.icon} size={21} /></span><Icon name="chevron" size={14} className="starter-chevron" /><strong>{item.title}</strong><span>{item.description}</span></button>; })}</div>}
          </div> : <div className="message-list"><div className="conversation-date"><span />{scenario ? `${scenario.title} · 对话` : "这一段对话，从这里开始"}<span /></div>{messages.map((message) => <article key={message.id} className={`message message-${message.role}`} aria-label={message.role === "user" ? "你的消息" : "AI 回复"}>
            {message.role === "assistant" && <div className="assistant-avatar"><Mark small /></div>}
            <div className="message-main">{message.role === "assistant" && <span className="assistant-label">陪伴空间<span>AI</span></span>}<div className="message-content">{message.content ? <ReactMarkdown>{message.content}</ReactMarkdown> : <div className="thinking" aria-label="正在等待模型回复"><span /><span /><span /></div>}</div>
              {message.truncated && <p className="truncated-note">本次回复达到长度限制，可继续追问。</p>}
              {message.role === "assistant" && <ServiceCards attachments={message.attachments} disabled={locked || message.id !== latestAssistantId} onChoose={(text) => void send(text)} onBook={(expertId, slotId) => void bookAppointment(expertId, slotId)} />}
              {message.role === "assistant" && <AgentActivity trace={message.trace} />}
              {message.role === "assistant" && message.content && !generating && <div className="message-tools"><button title="复制回复" aria-label="复制回复" onClick={() => void copyText(message.content)}><Icon name="copy" size={14} /></button><span /><button className={active?.feedback[message.id]?.rating === "good" ? "rated" : ""} disabled={feedbackBusy} onClick={() => void feedback(message.id, "good", active?.feedback[message.id]?.note ?? "")}><Icon name="like" size={14} />合适</button><button className={active?.feedback[message.id]?.rating === "adjust" ? "rated adjust" : ""} disabled={feedbackBusy} onClick={() => { setNoteFor(noteFor === message.id ? null : message.id); setNote(active?.feedback[message.id]?.note ?? ""); }}><Icon name="edit" size={14} />需调整</button></div>}
              {noteFor === message.id && <form className="feedback-form" onSubmit={(event) => { event.preventDefault(); void feedback(message.id, "adjust", note); }}><label htmlFor="feedback-note">这句话哪里可以更好？</label><textarea id="feedback-note" placeholder="例如：重复安慰、问过的问题又问了一次……" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /><div><button type="button" className="text-button" onClick={() => setNoteFor(null)}>取消</button><button type="submit" className="small-primary" disabled={feedbackBusy}>保存反馈</button></div></form>}
            </div>
          </article>)}</div>}
        </div>

        <div className="composer-section">
          {!active?.messages.length && demo && <div className="demo-quick-prompts">{demo.sampleQueries.slice(0, 4).map((text) => <button key={text} disabled={locked} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}<Icon name="chevron" size={11} /></button>)}</div>}
          {(generating || actionBusy) && <div className="agent-progress" role="status"><span className="spinner" />{actionBusy ? "预约智能体正在确认预约" : agentStatus}</div>}
          {scenario && active?.messages.length && !generating ? <div className="followup-row"><span>继续聊聊</span>{scenario.followups.map((text, index) => <button key={text} onClick={() => { setDraft(text); composer.current?.focus(); }} title={text}>追加一句 {index + 1}<Icon name="plus" size={12} /></button>)}</div> : null}
          {error && <div className="chat-error" role="alert"><Icon name="info" size={16} /><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}><Icon name="close" size={14} /></button></div>}
          <form className={`composer ${generating ? "is-generating" : ""}`} onSubmit={(event) => { event.preventDefault(); void send(); }}><textarea ref={composer} aria-label="输入你的消息" placeholder={scenario ? "从准备好的这句话开始，也可以自由输入……" : "不必组织好语言，想到什么就说什么……"} value={draft} maxLength={6000} disabled={generating || actionBusy || creating} onChange={(event) => setDraft(event.target.value)} rows={2} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-bottom"><span className="composer-context"><Icon name={scenario?.icon ?? "leaf"} size={14} />{scenario ? `${scenario.title} · 对话话题` : "此刻，想聊什么都可以"}</span><div><span className="enter-hint">Shift + Enter 换行</span>{generating ? <button className="send-button stop-button" type="button" aria-label="停止生成" title="停止生成" onClick={() => aborter.current?.abort()}><Icon name="stop" size={17} /></button> : <button className="send-button" type="submit" aria-label={status.configured ? "发送消息" : "连接模型后发送"} title={status.configured ? "发送消息" : "先连接模型"} disabled={!draft.trim() || locked}><Icon name="arrow" size={19} /></button>}</div></div></form>
          <div className="composer-caption">{status.configured ? <span>AI 回复由千问生成，不能替代专业诊断或紧急救援。</span> : <button onClick={() => setSettingsOpen(true)}><span className="caption-dot" />连接模型后即可发送，Key 仅保存在本机<Icon name="chevron" size={11} /></button>}</div>
        </div>
      </section>

      {reviewOpen && <aside className="review-panel" aria-label="评审提示"><div className="review-heading"><span><Icon name="book" size={17} />本轮观察</span><button className="icon-button" aria-label="收起评审提示" onClick={() => setReviewOpen(false)}><Icon name="close" size={17} /></button></div><div className="review-kicker">STYLE REVIEW</div><h2>{scenario?.title ?? "亲切、沉稳、专业"}</h2><p className="review-intro">看它是否理解你，也看它如何顺着对话的变化调整。</p><div className="review-label">关注这些表现</div><ul className="watch-list">{(scenario?.watch ?? ["具体回应，减少重复安慰", "多意图由合适的智能体分别处理", "记住信息，接受纠正与拒绝", "查询有数据依据，写入前先确认"]).map((item, index) => <li key={item}><span>{String(index + 1).padStart(2, "0")}</span>{item}</li>)}</ul><div className="review-label">对话摘录</div>{active?.messages.some((item) => item.role === "user") ? <div className="context-excerpts">{active.messages.filter((item) => item.role === "user").slice(-6).map((item) => <blockquote key={item.id}>{item.content}</blockquote>)}</div> : <p className="review-empty">发送后，可以在这里核对已经说过的信息。</p>}<div className="review-scope"><Icon name="info" size={17} /><div><strong>EAP 服务</strong><p>你可以在这里获得心理支持，查询账户权益，或安排咨询预约。</p></div></div><div className="review-version">风格规则 · {PROMPT_VERSION}</div></aside>}
      </div>
    </main>
    {settingsOpen && <SettingsDialog status={status} onStatus={setStatus} onClose={() => setSettingsOpen(false)} />}
    {toast && <div className="toast" role="status"><Icon name="check" size={16} />{toast}</div>}
  </div>;
}

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { AppError } from "./errors.ts";
import { getScenario } from "./scenarios.ts";
import { createDemoContext, commitDemoContext } from "./demo-tools.ts";
import type { DemoContext } from "./demo-types.ts";
import type { Feedback, Message, Session } from "./types.ts";

type StoredSession = Session & { owner: string; busy: string | null };
const state = globalThis as typeof globalThis & { eapSessions?: Map<string, StoredSession>; eapWorkspaceLocks?: Set<string> };
const sessions = state.eapSessions ??= new Map<string, StoredSession>();
const workspaceLocks = state.eapWorkspaceLocks ??= new Set<string>();

export function lockWorkspace(owner: string) {
  if (workspaceLocks.has(owner)) throw new AppError("当前账户还有一轮处理正在进行，请稍候再操作。", 409);
  workspaceLocks.add(owner);
  return () => { workspaceLocks.delete(owner); };
}

export async function workspace() {
  const jar = await cookies();
  let owner = jar.get("eap_workspace")?.value;
  if (!owner || !/^[\da-f-]{36}$/.test(owner)) owner = randomUUID();
  jar.set("eap_workspace", owner, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 365 * 86400 });
  return owner;
}

export function serialize(session: StoredSession): Session {
  return structuredClone({ id: session.id, title: session.title, scenarioId: session.scenarioId, createdAt: session.createdAt, updatedAt: session.updatedAt, messages: session.messages, feedback: session.feedback });
}

async function hydrate(owner: string) {
  const context = await createDemoContext(owner, "");
  for (const saved of context.account.sessions) {
    const existing = sessions.get(saved.id);
    if (existing && existing.owner !== owner) throw new AppError("本地聊天记录的账户归属异常。", 500);
    if (!existing?.busy) sessions.set(saved.id, { ...structuredClone(saved), owner, busy: null });
  }
  return context;
}

async function persistSession(session: StoredSession, next: Session, context: DemoContext) {
  if (context.owner !== session.owner) throw new AppError("无法保存其他账户的对话。", 403);
  // Chat, feedback, exercise progress and service changes share one atomic account write.
  context.account.sessions = [...context.account.sessions.filter((item) => item.id !== next.id), structuredClone(next)];
  context.dirty = true;
  await commitDemoContext(context);
  Object.assign(session, structuredClone(next));
  sessions.set(session.id, session);
}

export async function listSessions(owner: string) {
  await hydrate(owner);
  return [...sessions.values()].filter((session) => session.owner === owner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(serialize);
}

export async function createSession(owner: string, scenarioId: string | null) {
  const unlock = lockWorkspace(owner);
  try {
    const context = await hydrate(owner);
    const scenario = getScenario(scenarioId);
    if (scenarioId && !scenario) throw new AppError("没有找到这个测试场景。");
    const now = new Date().toISOString();
    const session: StoredSession = { id: randomUUID(), owner, busy: null, title: scenario?.title ?? "新的对话", scenarioId: scenario?.id ?? null, createdAt: now, updatedAt: now, messages: [], feedback: {} };
    await persistSession(session, serialize(session), context);
    return serialize(session);
  } finally { unlock(); }
}

export async function requireSession(owner: string, id: unknown) {
  await hydrate(owner);
  const session = typeof id === "string" ? sessions.get(id) : undefined;
  if (!session || session.owner !== owner) throw new AppError("没有找到这段对话，请从历史记录选择或新建对话。", 404, "session_not_found");
  return session;
}

export async function commitTurn(session: StoredSession, user: Message, assistant: Message, context: DemoContext) {
  const next = serialize(session);
  next.messages.push(user, assistant);
  if (next.title === "新的对话") next.title = user.content.slice(0, 18) + (user.content.length > 18 ? "…" : "");
  next.updatedAt = new Date().toISOString();
  await persistSession(session, next, context);
}

export async function commitAssistantEvent(session: StoredSession, assistant: Message, context: DemoContext) {
  const next = serialize(session);
  next.messages.push(assistant);
  next.updatedAt = new Date().toISOString();
  await persistSession(session, next, context);
}

export async function saveFeedback(session: StoredSession, messageId: string, feedback: Feedback) {
  const unlock = lockWorkspace(session.owner);
  try {
    if (session.busy) throw new AppError("请等当前回复完成后再保存反馈。", 409);
    const context = await createDemoContext(session.owner, session.id);
    const next = serialize(session);
    next.feedback[messageId] = feedback;
    await persistSession(session, next, context);
  } finally { unlock(); }
}

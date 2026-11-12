import type { AgentId, DemoAttachment, TaskLedger } from "./demo-types.ts";

export type AgentTrace = {
  agent: "main" | AgentId;
  label: string;
  status: "running" | "done" | "error";
  tools?: string[];
  taskId?: string;
  context?: { level: number; reason: string; messageIds: string[]; estimatedTokens: number; truncated: boolean };
};
export type Rating = "good" | "adjust";
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  model?: string;
  truncated?: boolean;
  attachments?: DemoAttachment[];
  trace?: AgentTrace[];
  agentResponses?: { agent: AgentId; taskId: string; content: string }[];
};
export type Feedback = { rating: Rating; note: string; updatedAt: string };
export type Session = {
  id: string;
  title: string;
  scenarioId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  feedback: Record<string, Feedback>;
  ledger?: TaskLedger;
};
export type ModelStatus = {
  model: string;
  baseUrl: string;
  hasKey: boolean;
  configured: boolean;
  verified: boolean;
  checkedAt: string | null;
};
export type Scenario = {
  id: string;
  code: string;
  title: string;
  category: "陪伴" | "服务" | "支持";
  icon: string;
  description: string;
  starter: string;
  followups: string[];
  watch: string[];
};
export type ChatEvent =
  | { type: "start"; user: Message; assistantId: string }
  | { type: "delta"; text: string }
  | { type: "status"; agent: "main" | AgentId; label: string }
  | { type: "done"; session: Session }
  | { type: "error"; message: string };

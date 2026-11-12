import type { Session } from "./types.ts";

export type AgentId = "customer_service" | "counselor_matching" | "appointment" | "psychological_support";

export type ConsultationFormat = "线上咨询" | "线下咨询";

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type DemoProfile = {
  id: string; name: string; employeeId: string; company: string; department: string;
  eap: { annualSessions: number; usedSessions: number; remainingSessions: number; validUntil: string; coverage: string; privacy: string };
  isDemo: true;
};
export type DemoPayment = { id: string; amount: number; chargedAt: string; status: "paid" | "refunded" };
export type DemoOrder = {
  id: string; title: string; amount: number; status: "paid" | "refund_pending" | "refunded";
  chargedAt: string; payments: DemoPayment[];
  refund: { status: "processing" | "completed"; amount: number; reference: string; updatedAt: string } | null;
  note: string; isDemo: true;
};
export type DemoSlot = { id: string; startsAt: string; endsAt: string; format: ConsultationFormat };
export type DemoExpert = {
  id: string; name: string; gender: "女" | "男"; price: number; topics: string[];
  style: string; bio: string; slots: DemoSlot[]; isDemo: true;
};
export type DemoBooking = {
  id: string; expertId: string; expertName: string; slotId: string; startsAt: string; endsAt: string;
  format: ConsultationFormat; status: "confirmed" | "cancelled"; price: number; isDemo: true;
};
export type DemoResource = {
  id: string; title: string; kind: "meditation" | "audio" | "exercise"; durationSeconds: number;
  audioUrl?: string; description: string; tags: string[]; isDemo: true;
};
export type DemoExerciseState = {
  id: string; title: string; status: "active" | "completed" | "stopped";
  stepIndex: number; totalSteps: number; prompt: string; isDemo: true;
};
export type MatchingCriteria = {
  topic: string; date: string; timeStart: string; timeEnd: string; format: ConsultationFormat;
  gender?: "女" | "男"; maxPrice?: number;
};
export type AvailabilityCriteria = Partial<MatchingCriteria> & { dateEnd?: string };
export type AvailabilityOption = Pick<DemoSlot, "startsAt" | "endsAt" | "format">;
export type TaskStatus = "active" | "waiting_input" | "waiting_confirmation" | "paused" | "completed" | "cancelled";
export type TaskLocalState = {
  matching?: { criteria: AvailabilityCriteria; batch: number; status: "collecting" | "presented" | "selected" | "closed"; expertIds: string[]; selectedExpertId?: string; attachmentId?: string };
  appointment?: { expertId?: string; slotId?: string; bookingId?: string; status: "selecting" | "waiting_confirmation" | "completed" };
  customerService?: { orderId?: string; waitingConfirmation?: boolean };
};
export type AgentTask = {
  id: string; agent: AgentId; instruction: string; status: TaskStatus;
  createdAt: string; updatedAt: string; messageIds: string[]; localState: TaskLocalState;
};
export type TaskLedger = { schemaVersion: 1; tasks: AgentTask[]; lastAgents: AgentId[]; lastTurnId?: string };
export type AttachmentScope = { turnId: string; taskId: string; agent: AgentId; purpose: string; status: "current" | "superseded" };
export type DemoAttachment = (
  | { id: string; kind: "availability"; criteria: AvailabilityCriteria; options: AvailabilityOption[] }
  | { id: string; kind: "orders"; orders: DemoOrder[] }
  | { id: string; kind: "experts"; experts: DemoExpert[]; criteria?: MatchingCriteria; batch?: number; hasMore?: boolean }
  | { id: string; kind: "bookings"; bookings: DemoBooking[] }
  | { id: string; kind: "resource"; resource: DemoResource }
  | { id: string; kind: "exercise"; exercise: DemoExerciseState }
) & { scope?: AttachmentScope };

export type DemoAccount = {
  sessions: Session[];
  schemaVersion: 1; version: number; profile: DemoProfile; orders: DemoOrder[]; bookings: DemoBooking[];
  exercises: Record<string, DemoExerciseState>; mutationIds: string[];
  pendingActions: Record<string, { action: "book" | "move" | "cancel" | "refund"; targetId: string; slotId?: string }>;
};
export type DemoContext = {
  owner: string; sessionId: string; latestUserContent: string; turnId?: string;
  account: DemoAccount; exerciseStates: Record<string, DemoExerciseState>;
  baseVersion: number; dirty: boolean; storageRoot: string;
  initialPendingAction?: { action: "book" | "move" | "cancel" | "refund"; targetId: string; slotId?: string };
  approvedAction?: { action: "book" | "move" | "cancel" | "refund"; targetId: string; slotId?: string };
  currentExperts?: Extract<DemoAttachment, { kind: "experts" }>;
  ledger?: TaskLedger;
  taskId?: string;
  matchingCriteria?: AvailabilityCriteria;
  selectedExpertId?: string;
};

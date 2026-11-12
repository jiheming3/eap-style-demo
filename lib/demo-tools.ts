import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors.ts";
import { demoExperts, demoResources, demoSampleQueries, exerciseSteps, sanitizeAccountPresentation, seedDemoAccount } from "./demo-data.ts";
import type { AgentId, AvailabilityCriteria, ConsultationFormat, DemoAccount, DemoAttachment, DemoBooking, DemoContext, DemoExerciseState, DemoSlot, ToolDefinition } from "./demo-types.ts";

export type { DemoContext } from "./demo-types.ts";

const state = globalThis as typeof globalThis & { eapDemoDataLocks?: Map<string, Promise<unknown>> };
const locks = state.eapDemoDataLocks ??= new Map<string, Promise<unknown>>();

async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}

function accountPath(owner: string, root: string) {
  if (!owner || owner.length > 200) throw new AppError("账户标识无效。");
  return join(root, `${createHash("sha256").update(owner).digest("hex")}.json`);
}

async function readAccount(path: string): Promise<DemoAccount | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DemoAccount;
    if (parsed.schemaVersion !== 1 || !Number.isInteger(parsed.version) || !parsed.profile || !Array.isArray(parsed.orders) || !Array.isArray(parsed.bookings)) throw new AppError("本地服务数据格式异常，请检查数据文件。", 500);
    for (const booking of parsed.bookings) {
      const legacyFormat = booking.format as string;
      if (legacyFormat === "视频" || legacyFormat === "语音") booking.format = "线上咨询";
    }
    parsed.pendingActions ??= {};
    parsed.exercises ??= {};
    parsed.sessions ??= [];
    if (!Array.isArray(parsed.sessions)) throw new AppError("本地聊天记录格式异常，请检查数据文件。", 500);
    return sanitizeAccountPresentation(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, account: DemoAccount) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(account, null, 2), { flag: "wx" }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

export async function createDemoContext(owner: string, sessionId: string, options: { storageRoot?: string } = {}): Promise<DemoContext> {
  const storageRoot = options.storageRoot ?? process.env.EAP_DEMO_DATA_DIR ?? join(process.cwd(), ".demo-data");
  const path = accountPath(owner, storageRoot);
  const account = await locked(path, async () => {
    await mkdir(storageRoot, { recursive: true });
    const stored = await readAccount(path);
    if (stored) return stored;
    const seeded = seedDemoAccount();
    await atomicWrite(path, seeded);
    return seeded;
  });
  return { owner, sessionId, latestUserContent: "", account, exerciseStates: account.exercises, baseVersion: account.version, dirty: false, storageRoot, initialPendingAction: account.pendingActions[sessionId] ? structuredClone(account.pendingActions[sessionId]) : undefined };
}

export async function commitDemoContext(context: DemoContext) {
  if (!context.dirty) return;
  const path = accountPath(context.owner, context.storageRoot);
  await locked(path, async () => {
    const stored = await readAccount(path);
    if (!stored || stored.version !== context.baseVersion) throw new AppError("账户刚被另一轮对话更新，请重试本轮操作。", 409, "demo_conflict");
    const next = structuredClone(context.account);
    next.version = context.baseVersion + 1;
    await atomicWrite(path, next);
    context.account.version = next.version;
    context.baseVersion = next.version;
    context.dirty = false;
  });
}

function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDefinition {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
const str = (description: string) => ({ type: "string", description });
const toolSets: Record<AgentId, ToolDefinition[]> = {
  customer_service: [
    tool("get_my_profile", "查询当前用户资料与EAP权益。用户身份由服务端确定，不接受其他用户ID。"),
    tool("query_my_orders", "查询当前用户订单、支付流水及退款进度；不传订单号时列出全部。", { orderId: str("可选，例如 ORD-1002") }),
    tool("request_duplicate_refund", "为重复扣款提交退款申请，先返回具体金额并要求用户确认，确认后再次调用。", { orderId: str("订单ID") }, ["orderId"]),
  ],
  counselor_matching: [
    tool("check_consultation_availability", "每轮匹配需求有更新时，按目前已知条件检查可约资源。未知条件省略，不猜测；date与dateEnd可表示周末范围。不展示咨询师卡片。没有资源时停止当前方案的追问，建议调整日期或条件；有资源时让用户从实际日期或时段中选择。", {
      topic: str("已知咨询主题"), date: str("已知日期或日期范围起点，YYYY-MM-DD"), dateEnd: str("日期范围终点，例如周日，YYYY-MM-DD"),
      timeStart: str("用户已明确的时段起点，HH:mm"), timeEnd: str("用户已明确的时段终点，HH:mm"),
      format: { type: "string", enum: ["线上咨询", "线下咨询"] }, gender: { type: "string", enum: ["女", "男"] }, maxPrice: { type: "number", minimum: 0 },
    }),
    tool("search_experts", "仅在咨询类型、日期、当天时段和咨询方式均已确认后匹配咨询师。只返回完全符合时间范围的时段；每批最多3位，batch从0开始。", {
      topic: str("咨询类型或困扰主题，例如情绪、家庭、工作、关系、睡眠"),
      date: str("用户希望咨询的日期，YYYY-MM-DD"),
      timeStart: str("用户确认的起始时间，HH:mm，例如晚上为18:00"),
      timeEnd: str("用户确认的结束时间，HH:mm，例如晚上为23:59"),
      format: { type: "string", enum: ["线上咨询", "线下咨询"] },
      batch: { type: "integer", minimum: 0, description: "批次序号，首次为0，换一批时递增" },
      gender: { type: "string", enum: ["女", "男"] },
      maxPrice: { type: "number", minimum: 0 },
    }, ["topic", "date", "timeStart", "timeEnd", "format"]),
  ],
  appointment: [
    tool("get_expert_slots", "只查询目标咨询师的可约时间。沿用当前候选卡片的日期、时段和方式；用户明确更改时，可传新的date、timeStart、timeEnd、format四项。", {
      expertId: str("目标咨询师ID"), date: str("YYYY-MM-DD"), timeStart: str("HH:mm"), timeEnd: str("HH:mm"),
      format: { type: "string", enum: ["线上咨询", "线下咨询"] },
    }, ["expertId"]),
    tool("list_my_bookings", "查询当前用户的预约。默认只返回有效预约；仅在用户明确查询历史或取消记录时设置includeCancelled。", { includeCancelled: { type: "boolean", description: "是否包含已取消预约，默认false" } }),
    tool("book_appointment", "创建预约。必须提供咨询师和已查询过的具体时间ID，工具先要求用户确认。", { expertId: str("咨询师ID"), slotId: str("具体可约时间ID") }, ["expertId", "slotId"]),
    tool("move_appointment", "将已有预约改到同一咨询师的另一个可约时间，需用户明确确认。", { bookingId: str("当前预约ID"), slotId: str("新的具体时间ID") }, ["bookingId", "slotId"]),
    tool("cancel_appointment", "取消一个预约并释放EAP次数，需用户明确确认。", { bookingId: str("预约ID") }, ["bookingId"]),
  ],
  psychological_support: [
    tool("find_support_resources", "查找冥想、音频和对话练习。只在用户适合并愿意时推荐，不宣称疗效。", { topic: str("可选需求关键词，例如焦虑、紧张、休息、睡眠、情绪"), kind: { type: "string", enum: ["meditation", "audio", "exercise"] } }),
    tool("show_support_resource", "展示一个可播放的音频或练习介绍；展示练习不等于开始。", { resourceId: str("资源ID") }, ["resourceId"]),
    tool("start_support_exercise", "用户同意后开始三步对话练习，每次只呈现一步。已有进行中的练习会继续当前步骤。", { resourceId: { type: "string", enum: ["RES-103", "RES-104"] } }, ["resourceId"]),
    tool("advance_support_exercise", "用户回应当前步骤后推进一步，不得在同一轮连续调用跳过步骤。可选action继续或停止。", { action: { type: "string", enum: ["next", "stop"] } }, ["action"]),
  ],
};
export function toolsForAgent(agent: AgentId): ToolDefinition[] { return structuredClone(toolSets[agent]); }

function stringArg(args: Record<string, unknown>, key: string, optional = false): string {
  const value = args[key];
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new AppError(`工具参数 ${key} 无效。`);
  return value.trim();
}
function attach<K extends DemoAttachment["kind"]>(kind: K, data: Omit<Extract<DemoAttachment, { kind: K }>, "id" | "kind">): DemoAttachment {
  return { id: randomUUID(), kind, ...data } as unknown as DemoAttachment;
}
function publicResult(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => key === "isDemo" ? undefined : item));
}
const matches = (values: string[], query: string) => !query || values.some((value) => value.includes(query) || query.includes(value));

function readAvailabilityCriteria(args: Record<string, unknown>): AvailabilityCriteria {
  const criteria: AvailabilityCriteria = {};
  for (const key of ["topic", "date", "dateEnd", "timeStart", "timeEnd", "format", "gender"] as const) {
    const value = stringArg(args, key, true);
    if (value) Object.assign(criteria, { [key]: value });
  }
  for (const date of [criteria.date, criteria.dateEnd]) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new AppError("请提供有效的YYYY-MM-DD日期。");
  }
  if (criteria.dateEnd && (!criteria.date || criteria.dateEnd < criteria.date)) throw new AppError("日期范围无效。");
  if (criteria.timeStart || criteria.timeEnd) {
    if (!criteria.timeStart || !criteria.timeEnd || !validTime(criteria.timeStart) || !validTime(criteria.timeEnd) || criteria.timeStart >= criteria.timeEnd) throw new AppError("请提供有效的起止时段。");
  }
  if (criteria.format && !["线上咨询", "线下咨询"].includes(criteria.format)) throw new AppError("咨询方式参数无效。");
  if (criteria.gender && !["女", "男"].includes(criteria.gender)) throw new AppError("性别筛选参数无效。");
  if (args.maxPrice !== undefined) {
    if (typeof args.maxPrice !== "number" || !Number.isFinite(args.maxPrice) || args.maxPrice < 0) throw new AppError("预算参数无效。");
    criteria.maxPrice = args.maxPrice;
  }
  return criteria;
}

function matchingExperts(context: DemoContext, criteria: AvailabilityCriteria) {
  return availableExperts(context).filter((expert) => matches(expert.topics, criteria.topic ?? "") && (!criteria.gender || expert.gender === criteria.gender) && (criteria.maxPrice === undefined || expert.price <= criteria.maxPrice)).map((expert) => ({ ...expert, slots: expert.slots.filter((slot) => {
    const date = slot.startsAt.slice(0, 10);
    return (!criteria.date || date >= criteria.date && date <= (criteria.dateEnd ?? criteria.date))
      && (!criteria.format || slot.format === criteria.format)
      && (!criteria.timeStart || slot.startsAt.slice(11, 16) >= criteria.timeStart)
      && (!criteria.timeEnd || slot.endsAt.slice(11, 16) <= criteria.timeEnd);
  }) })).filter((expert) => expert.slots.length > 0);
}

function validTime(value: string) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function slotInRange(slot: DemoSlot, date: string, timeStart: string, timeEnd: string, format: ConsultationFormat) {
  return slot.startsAt.startsWith(date) && slot.format === format && slot.startsAt.slice(11, 16) >= timeStart && slot.endsAt.slice(11, 16) <= timeEnd;
}

function availableExperts(context: DemoContext) {
  const bookings = context.account.bookings.filter((item) => item.status === "confirmed");
  return demoExperts().map((expert) => ({ ...expert, slots: expert.slots.filter((slot) => Date.parse(slot.startsAt) > Date.now() && !bookings.some((item) => Date.parse(item.startsAt) < Date.parse(slot.endsAt) && Date.parse(item.endsAt) > Date.parse(slot.startsAt))) }));
}

function requestedSlot(context: DemoContext, expertId: string, slotId: string): DemoSlot {
  const expert = demoExperts().find((item) => item.id === expertId);
  if (!expert) throw new AppError("没有这位咨询师，请先查询咨询师列表。");
  const slot = expert.slots.find((item) => item.id === slotId);
  if (!slot || Date.parse(slot.startsAt) <= Date.now()) throw new AppError("该时段已过期或不存在，请重新查询可约时间。");
  return slot;
}
function ensureNoOverlap(context: DemoContext, slot: DemoSlot, exceptId?: string) {
  if (context.account.bookings.some((booking) => booking.status === "confirmed" && booking.id !== exceptId && Date.parse(booking.startsAt) < Date.parse(slot.endsAt) && Date.parse(booking.endsAt) > Date.parse(slot.startsAt))) throw new AppError("这个时段与你已有的预约冲突，请换一个时间。", 409);
}

function confirmation(context: DemoContext, action: "book" | "move" | "cancel" | "refund", targetId: string, slotId?: string): boolean {
  const approved = context.approvedAction;
  if (approved?.action === action && approved.targetId === targetId && approved.slotId === slotId) return true;
  const text = context.latestUserContent.trim();
  const prior = context.initialPendingAction;
  const refusal = /不要|不想|暂不|别|不确认|不预约|不取消|不退款|算了|先不|不改|不能|可以吗|能不能|是否|如果|怎么|如何|流程|\?|？/.test(text);
  const inquiry = /查询|查一下|帮我查|查查|看看|了解|为什么|进度|状态|明细|想知道|能否/.test(text);
  const explicit = /确认|确定|同意|就按|就[约订]/.test(text);
  const actionText = action === "book" ? /预约|预订|确认|确定|同意|就约/ : action === "move" ? /改约|改到|改期|确认|确定|同意/ : action === "cancel" ? /取消|确认|确定|同意/ : /退款|退回|确认|确定|同意/;
  const samePending = prior?.action === action && prior.targetId === targetId && prior.slotId === slotId;
  const identifiers = text.includes(targetId) && (!slotId || text.includes(slotId));
  const mentionedIds = text.match(/(?:EXP|APT|ORD)-[\w-]+/g) ?? [];
  const mentionsDifferentTarget = mentionedIds.some((id) => id !== targetId && id !== slotId);
  const directCommand = identifiers && /确认|确定|同意|帮我预约|请预约|取消|改约|改到|改期|退款|退回/.test(text);
  if (!refusal && !inquiry && !mentionsDifferentTarget && actionText.test(text) && ((explicit && samePending) || directCommand)) {
    delete context.account.pendingActions[context.sessionId];
    context.dirty = true;
    return true;
  }
  context.account.pendingActions[context.sessionId] = { action, targetId, ...(slotId ? { slotId } : {}) };
  context.dirty = true;
  return false;
}

function bookingById(context: DemoContext, id: string) {
  const booking = context.account.bookings.find((item) => item.id === id);
  if (!booking) throw new AppError("当前账户没有这条预约。", 404);
  return booking;
}

export async function executeDemoTool(context: DemoContext, agent: AgentId, name: string, args: Record<string, unknown>): Promise<{ result: unknown; attachments: DemoAttachment[] }> {
  const schema = toolSets[agent].find((item) => item.function.name === name);
  if (!schema) throw new AppError("这个智能体不能调用该工具。", 403);
  const allowed = Object.keys((schema.function.parameters.properties ?? {}) as Record<string, unknown>);
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new AppError("工具包含不受支持的参数。");
  if (agent === "counselor_matching" && ["check_consultation_availability", "search_experts"].includes(name) && context.matchingCriteria) {
    const prior = { ...context.matchingCriteria };
    if (args.date && args.dateEnd === undefined) delete prior.dateEnd;
    args = { ...Object.fromEntries(Object.entries(prior).filter(([key]) => allowed.includes(key))), ...args };
  }
  const response = (result: unknown, attachments: DemoAttachment[] = []) => ({ result: publicResult(result), attachments });
  switch (name) {
    case "check_consultation_availability": {
      const criteria = readAvailabilityCriteria(args);
      const experts = matchingExperts(context, criteria);
      const options = [...new Map(experts.flatMap((expert) => expert.slots).map(({ startsAt, endsAt, format }) => [`${startsAt}:${format}`, { startsAt, endsAt, format }])).values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.format.localeCompare(b.format));
      const available = options.length > 0;
      const attachments = available && criteria.date && criteria.topic && (!criteria.timeStart || !criteria.format || criteria.dateEnd && criteria.dateEnd !== criteria.date) ? [attach("availability", { criteria, options })] : [];
      return response({ available, criteria, options, foundExperts: experts.length, timezone: "Asia/Shanghai", message: available ? "只提供实际可约日期或时段供用户选择；未知条件不要猜测。" : "当前已知条件下没有可约资源，停止追问当前方案，建议换日期或调整一个条件。" }, attachments);
    }
    case "get_my_profile": return response(structuredClone(context.account.profile));
    case "query_my_orders": {
      const id = stringArg(args, "orderId", true);
      const orders = context.account.orders.filter((item) => !id || item.id === id);
      return response({ orders, found: orders.length, isDemo: true }, [attach("orders", { orders: structuredClone(orders) })]);
    }
    case "request_duplicate_refund": {
      const id = stringArg(args, "orderId");
      const order = context.account.orders.find((item) => item.id === id);
      if (!order) throw new AppError("当前账户没有这笔订单。", 404);
      if (order.refund) return response({ order, alreadyRequested: true, message: "已有退款记录，不重复提交。" }, [attach("orders", { orders: [structuredClone(order)] })]);
      const paid = order.payments.filter((item) => item.status === "paid").reduce((sum, item) => sum + item.amount, 0);
      const amount = paid - order.amount;
      if (amount <= 0) return response({ order, eligible: false, message: "这笔订单没有可退的重复扣款。" });
      if (!confirmation(context, "refund", id)) return response({ confirmationRequired: true, orderId: id, amount, currency: "CNY", message: `请让用户确认：为${id}的重复扣款${amount}元提交退款申请。` }, [attach("orders", { orders: [structuredClone(order)] })]);
      order.status = "refund_pending";
      order.refund = { status: "processing", amount, reference: `REF-${id}`, updatedAt: new Date().toISOString() };
      context.dirty = true;
      return response({ order, message: "退款申请已提交，状态为处理中。" }, [attach("orders", { orders: [structuredClone(order)] })]);
    }
    case "search_experts": {
      const topic = stringArg(args, "topic"), gender = stringArg(args, "gender", true), date = stringArg(args, "date"), timeStart = stringArg(args, "timeStart"), timeEnd = stringArg(args, "timeEnd"), format = stringArg(args, "format") as ConsultationFormat;
      if (gender && gender !== "女" && gender !== "男") throw new AppError("性别筛选参数无效。");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("请使用YYYY-MM-DD查询日期。");
      if (!validTime(timeStart) || !validTime(timeEnd) || timeStart >= timeEnd) throw new AppError("查询时段无效，请使用HH:mm格式并确保结束时间晚于开始时间。");
      if (format !== "线上咨询" && format !== "线下咨询") throw new AppError("咨询方式参数无效。");
      if (args.maxPrice !== undefined && (typeof args.maxPrice !== "number" || !Number.isFinite(args.maxPrice) || args.maxPrice < 0)) throw new AppError("预算参数无效。");
      if (args.batch !== undefined && (!Number.isInteger(args.batch) || (args.batch as number) < 0)) throw new AppError("批次参数无效。");
      const requestedBatch = (args.batch as number | undefined) ?? 0;
      const candidates = matchingExperts(context, { topic, date, timeStart, timeEnd, format, ...(gender ? { gender: gender as "女" | "男" } : {}), ...(args.maxPrice !== undefined ? { maxPrice: args.maxPrice as number } : {}) });
      const batch = candidates.length && requestedBatch * 3 >= candidates.length ? 0 : requestedBatch;
      const experts = candidates.slice(batch * 3, batch * 3 + 3);
      const hasMore = candidates.length > 3;
      const criteria = { topic, date, timeStart, timeEnd, format, ...(gender ? { gender: gender as "女" | "男" } : {}), ...(args.maxPrice !== undefined ? { maxPrice: args.maxPrice as number } : {}) };
      return response({ experts, found: candidates.length, batch, hasMore, criteria, timezone: "Asia/Shanghai", isDemo: true }, [attach("experts", { experts, criteria, batch, hasMore })]);
    }
    case "get_expert_slots": {
      const id = stringArg(args, "expertId");
      if (context.selectedExpertId && context.selectedExpertId !== id) throw new AppError("请只查询用户当前选中的咨询师。");
      const current = context.currentExperts;
      let criteria = current?.experts.some((expert) => expert.id === id) ? current.criteria : undefined;
      // Older cards stored date and mode without a time window; retain their offered slot IDs.
      if (criteria && (!validTime(criteria.timeStart) || !validTime(criteria.timeEnd))) criteria = undefined;
      if (["date", "timeStart", "timeEnd", "format"].some((key) => args[key] !== undefined)) {
        const date = stringArg(args, "date"), timeStart = stringArg(args, "timeStart"), timeEnd = stringArg(args, "timeEnd"), format = stringArg(args, "format") as ConsultationFormat;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validTime(timeStart) || !validTime(timeEnd) || timeStart >= timeEnd || !["线上咨询", "线下咨询"].includes(format)) throw new AppError("请完整提供有效的预约日期、时段和咨询方式。");
        criteria = { topic: criteria?.topic ?? "指定咨询师", date, timeStart, timeEnd, format };
      }
      const experts = availableExperts(context).filter((item) => item.id === id).map((expert) => ({ ...expert, slots: expert.slots.filter((slot) => !criteria || slotInRange(slot, criteria.date, criteria.timeStart, criteria.timeEnd, criteria.format)) }));
      if (!experts.length) throw new AppError("没有找到这位咨询师。", 404);
      if (current && !criteria && current.experts.some((expert) => expert.id === id)) {
        const offered = new Set(current.experts.find((expert) => expert.id === id)!.slots.map((slot) => slot.id));
        experts[0].slots = experts[0].slots.filter((slot) => offered.has(slot.id));
      }
      return response({ experts, criteria, timezone: "Asia/Shanghai" }, [attach("experts", { experts: experts.filter((expert) => expert.slots.length > 0), ...(criteria ? { criteria } : {}) })]);
    }
    case "list_my_bookings": {
      if (args.includeCancelled !== undefined && typeof args.includeCancelled !== "boolean") throw new AppError("预约查询范围无效。");
      const includeCancelled = args.includeCancelled === true && /历史|以前|过去|取消.*(?:预约|记录)|(?:预约|记录).*取消|包括取消/.test(context.latestUserContent);
      const bookings = structuredClone(context.account.bookings.filter((booking) => includeCancelled || booking.status === "confirmed"));
      return response({ bookings, timezone: "Asia/Shanghai", isDemo: true }, [attach("bookings", { bookings })]);
    }
    case "book_appointment": {
      const expertId = stringArg(args, "expertId"), slotId = stringArg(args, "slotId");
      const existing = context.account.bookings.find((item) => item.status === "confirmed" && item.expertId === expertId && item.slotId === slotId);
      if (existing) return response({ booking: existing, alreadyBooked: true }, [attach("bookings", { bookings: [structuredClone(existing)] })]);
      const slot = requestedSlot(context, expertId, slotId);
      const expert = demoExperts().find((item) => item.id === expertId)!;
      ensureNoOverlap(context, slot);
      if (context.account.profile.eap.remainingSessions <= 0) throw new AppError("EAP剩余次数不足，暂时无法使用权益预约。");
      if (!confirmation(context, "book", expertId, slotId)) return response({ confirmationRequired: true, expert: { ...expert, slots: [slot] }, slot, useEapSessions: 1, message: "请让用户确认咨询师、具体时间与占用1次EAP权益，再调用预约工具。" }, [attach("experts", { experts: [{ ...expert, slots: [slot] }] })]);
      const booking: DemoBooking = { id: `APT-${randomUUID().slice(0, 8).toUpperCase()}`, expertId, expertName: expert.name, slotId, startsAt: slot.startsAt, endsAt: slot.endsAt, format: slot.format, status: "confirmed", price: expert.price, isDemo: true };
      context.account.bookings.push(booking);
      context.account.profile.eap.remainingSessions--;
      context.account.profile.eap.usedSessions++;
      context.dirty = true;
      return response({ booking, message: "预约已确认，占用1次EAP权益。" }, [attach("bookings", { bookings: [structuredClone(booking)] })]);
    }
    case "move_appointment": {
      const booking = bookingById(context, stringArg(args, "bookingId")), slotId = stringArg(args, "slotId");
      if (booking.status !== "confirmed") throw new AppError("这条预约已经取消，不能改约。");
      if (booking.slotId === slotId) return response({ booking, unchanged: true }, [attach("bookings", { bookings: [structuredClone(booking)] })]);
      const slot = requestedSlot(context, booking.expertId, slotId);
      ensureNoOverlap(context, slot, booking.id);
      if (!confirmation(context, "move", booking.id, slotId)) return response({ confirmationRequired: true, booking, newSlot: slot, message: "请让用户确认新的具体时间，再进行改约。" }, [attach("bookings", { bookings: [structuredClone(booking)] })]);
      Object.assign(booking, { slotId, startsAt: slot.startsAt, endsAt: slot.endsAt, format: slot.format });
      context.dirty = true;
      return response({ booking, message: "改约完成，EAP次数不变。" }, [attach("bookings", { bookings: [structuredClone(booking)] })]);
    }
    case "cancel_appointment": {
      const booking = bookingById(context, stringArg(args, "bookingId"));
      if (booking.status === "cancelled") return response({ booking, alreadyCancelled: true }, [attach("bookings", { bookings: [structuredClone(booking)] })]);
      if (!confirmation(context, "cancel", booking.id)) return response({ confirmationRequired: true, booking, message: "请让用户确认取消这条预约；取消后释放1次EAP权益。" }, [attach("bookings", { bookings: [structuredClone(booking)] })]);
      booking.status = "cancelled";
      context.account.profile.eap.remainingSessions++;
      context.account.profile.eap.usedSessions = Math.max(0, context.account.profile.eap.usedSessions - 1);
      context.dirty = true;
      return response({ booking, message: "预约已取消，已释放1次EAP权益。" }, [attach("bookings", { bookings: [structuredClone(booking)] })]);
    }
    case "find_support_resources": {
      const topic = stringArg(args, "topic", true), kind = stringArg(args, "kind", true);
      if (kind && !["meditation", "audio", "exercise"].includes(kind)) throw new AppError("资源类型无效。");
      const resources = demoResources.filter((item) => matches([...item.tags, item.title, item.description], topic) && (!kind || item.kind === kind));
      return response({ resources, isDemo: true });
    }
    case "show_support_resource": {
      const resource = demoResources.find((item) => item.id === stringArg(args, "resourceId"));
      if (!resource) throw new AppError("没有找到这个资源。", 404);
      return response({ resource }, [attach("resource", { resource: structuredClone(resource) })]);
    }
    case "start_support_exercise": {
      const id = stringArg(args, "resourceId");
      const steps = exerciseSteps[id], resource = demoResources.find((item) => item.id === id);
      if (!steps || !resource) throw new AppError("这个资源不是对话练习。");
      const active = context.account.exercises[context.sessionId];
      if (active?.status === "active") return response({ exercise: active, message: "已有进行中的练习，先回应当前步骤或停止。" }, [attach("exercise", { exercise: structuredClone(active) })]);
      if (/不要|不想|不做|先不|算了|停止|结束/.test(context.latestUserContent) || !/愿意|可以|开始|试试|练习|好的|好啊|来吧|同意/.test(context.latestUserContent)) return response({ consentRequired: true, resource, message: "先询问用户是否愿意开始，得到同意后调用。" });
      const exercise: DemoExerciseState = { id, title: resource.title, status: "active", stepIndex: 0, totalSteps: steps.length, prompt: steps[0], isDemo: true };
      context.account.exercises[context.sessionId] = exercise;
      context.account.mutationIds.push(exerciseTurnKey(context, exercise.id));
      context.dirty = true;
      return response({ exercise }, [attach("exercise", { exercise: structuredClone(exercise) })]);
    }
    case "advance_support_exercise": {
      const action = stringArg(args, "action"), exercise = context.account.exercises[context.sessionId];
      if (action !== "next" && action !== "stop") throw new AppError("练习操作无效。");
      if (!exercise) return response({ active: false, message: "当前对话没有进行中的练习。" });
      if (exercise.status !== "active") return response({ exercise }, [attach("exercise", { exercise: structuredClone(exercise) })]);
      const key = exerciseTurnKey(context, exercise.id);
      if (context.account.mutationIds.includes(key)) return response({ exercise, message: "这一轮已经推进过练习，等待用户下一次回应。" }, [attach("exercise", { exercise: structuredClone(exercise) })]);
      if (action === "stop" || /停下|停止|不做|不想做|不想继续|结束练习|先不/.test(context.latestUserContent)) { exercise.status = "stopped"; exercise.prompt = "练习已停止。你可以按照自己的节奏休息，或继续聊聊。"; }
      else {
        exercise.stepIndex++;
        if (exercise.stepIndex >= exercise.totalSteps) { exercise.status = "completed"; exercise.stepIndex = exercise.totalSteps; exercise.prompt = "这次练习到这里结束。你现在感觉如何？没有变化也没有关系。"; }
        else exercise.prompt = exerciseSteps[exercise.id][exercise.stepIndex];
      }
      context.account.mutationIds.push(key);
      context.account.mutationIds = context.account.mutationIds.slice(-200);
      context.dirty = true;
      return response({ exercise }, [attach("exercise", { exercise: structuredClone(exercise) })]);
    }
    default: throw new AppError("未知工具。");
  }
}

export function demoOverview(context: DemoContext) {
  return structuredClone({ profile: context.account.profile, orders: context.account.orders, bookings: context.account.bookings, experts: availableExperts(context), resources: demoResources, sampleQueries: demoSampleQueries, timezone: "Asia/Shanghai", isDemo: true });
}

function exerciseTurnKey(context: DemoContext, exerciseId: string) {
  return `${context.sessionId}:${createHash("sha256").update(context.turnId ?? context.latestUserContent).digest("hex").slice(0, 24)}:${exerciseId}`;
}

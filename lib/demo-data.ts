import type { ConsultationFormat, DemoAccount, DemoExpert, DemoResource } from "./demo-types.ts";

export function shanghaiDate(offsetDays = 0, now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600_000);
  local.setUTCDate(local.getUTCDate() + offsetDays);
  return local.toISOString().slice(0, 10);
}

function slot(expertId: string, day: number, hour: number, format: ConsultationFormat, now: Date) {
  const date = shanghaiDate(day, now);
  const startsAt = `${date}T${String(hour).padStart(2, "0")}:00:00+08:00`;
  const endsAt = `${date}T${String(hour).padStart(2, "0")}:50:00+08:00`;
  const mode = format === "线上咨询" ? "online" : "offline";
  return { id: `${expertId}-${date}-${hour}-${mode}`, startsAt, endsAt, format };
}

export function demoExperts(now = new Date()): DemoExpert[] {
  const items = [
    { id: "EXP-101", name: "陈知宁", gender: "女" as const, price: 180, topics: ["工作压力", "焦虑", "睡眠"], style: "温和、耐心，侧重一起梳理当下困扰", bio: "擅长职场适应与情绪梳理。" },
    { id: "EXP-102", name: "周予安", gender: "男" as const, price: 260, topics: ["职场关系", "沟通", "工作压力"], style: "平实、具体，重视可执行的小步骤", bio: "擅长职场沟通与压力管理。" },
    { id: "EXP-103", name: "许听澜", gender: "女" as const, price: 300, topics: ["亲密关系", "家庭", "自我探索"], style: "细致、尊重节奏，重视关系与感受", bio: "擅长关系困扰与自我探索。" },
    { id: "EXP-104", name: "沈嘉言", gender: "男" as const, price: 420, topics: ["焦虑", "情绪低落", "睡眠"], style: "稳定、结构清晰，兼顾理解与练习", bio: "擅长情绪与睡眠困扰。" },
    { id: "EXP-105", name: "林若川", gender: "女" as const, price: 220, topics: ["家庭", "亲子关系", "情绪"], style: "温和、清晰，重视家庭互动中的真实需要", bio: "擅长家庭关系与情绪调节。" },
    { id: "EXP-106", name: "顾南乔", gender: "女" as const, price: 320, topics: ["情绪", "焦虑", "自我探索"], style: "沉稳、包容，陪伴来访者理解内在感受", bio: "擅长情绪困扰与个人成长。" },
    { id: "EXP-107", name: "陆行舟", gender: "男" as const, price: 280, topics: ["工作压力", "职业发展", "人际关系"], style: "务实、有条理，关注现实处境与可行选择", bio: "擅长工作压力与职业适应。" },
    { id: "EXP-108", name: "苏明澈", gender: "男" as const, price: 360, topics: ["家庭", "亲密关系", "情绪"], style: "耐心、稳定，帮助看见关系中的互动模式", bio: "擅长家庭及亲密关系困扰。" },
  ];
  return items.map((item, index) => ({ ...item, slots: [
    slot(item.id, 1, 18 + index % 2, "线上咨询", now),
    slot(item.id, 1, 14 + index % 3, "线下咨询", now),
    slot(item.id, 2, 14 + index % 4, "线上咨询", now),
    slot(item.id, 2, 10 + index % 3, "线下咨询", now),
    slot(item.id, 3, 19, "线上咨询", now),
    slot(item.id, 5, 10 + index % 5, "线下咨询", now),
  ], isDemo: true }));
}

export const demoResources: DemoResource[] = [
  { id: "RES-101", title: "一分钟缓缓呼吸", kind: "meditation", durationSeconds: 60, audioUrl: "/audio/breathing-demo.wav", description: "合成节奏提示音（无语音）：保持自然呼吸，舒适时稍放慢；不需要屏息，感到不适可随时停止。", tags: ["紧张", "工作压力", "放松"], isDemo: true },
  { id: "RES-102", title: "雨声休息片刻", kind: "audio", durationSeconds: 60, audioUrl: "/audio/rain-demo.wav", description: "一段舒缓的雨声音频，可以用作短暂休息的背景声。", tags: ["休息", "睡眠", "陪伴"], isDemo: true },
  { id: "RES-103", title: "把注意力带回此刻", kind: "exercise", durationSeconds: 180, description: "自愿参加的三步感官练习，每次只进行一步，可以随时停止。", tags: ["焦虑", "紧张", "注意力"], isDemo: true },
  { id: "RES-104", title: "给当下的感受一个名字", kind: "exercise", durationSeconds: 180, description: "用三个小问题整理情绪、需要和一个可行的小行动，不评判自己的回答。", tags: ["情绪", "工作压力", "自我关怀"], isDemo: true },
];

export const exerciseSteps: Record<string, string[]> = {
  "RES-103": ["如果现在方便，看看身边，选出三样你能看见的东西。愿意的话告诉我它们是什么。", "让脚掌轻轻接触地面，留意一个能感觉到的触感，例如椅子的支撑。此刻你注意到了什么？", "听听周围，找一个你能听见的声音。接下来你希望继续聊聊，还是先休息一下？"],
  "RES-104": ["如果用一两个词描述现在的感受，会是什么？不用找最准确的答案。", "这种感受背后，你现在最需要的是什么，例如休息、被理解，或一点空间？", "照顾这个需要，你愿意给自己安排一个什么样的小行动？也可以暂时什么都不做。"],
};

export function seedDemoAccount(now = new Date()): DemoAccount {
  const first = demoExperts(now)[0];
  const booked = first.slots[4];
  const chargedAt = `${shanghaiDate(-3, now)}T20:05:00+08:00`;
  const duplicateAt = `${shanghaiDate(-2, now)}T09:12:00+08:00`;
  return {
    schemaVersion: 1, version: 0, sessions: [],
    profile: { id: "DEMO-USER-001", name: "林晓", employeeId: "TEST-E042", company: "星河科技", department: "产品部", eap: { annualSessions: 6, usedSessions: 2, remainingSessions: 4, validUntil: `${shanghaiDate(0, now).slice(0, 4)}-12-31`, coverage: "每年6次企业支付的50分钟线上或线下咨询，预约成功后占用1次，取消后释放。", privacy: "具体可见范围以企业与平台的隐私政策为准；对话会发送至当前配置的AI模型服务。" }, isDemo: true },
    orders: [
      { id: "ORD-1001", title: "50分钟视频心理咨询", amount: 260, status: "paid", chargedAt, payments: [{ id: "PAY-1001-A", amount: 260, chargedAt, status: "paid" }], refund: null, note: "正常支付订单，无重复扣款。", isDemo: true },
      { id: "ORD-1002", title: "50分钟视频心理咨询", amount: 300, status: "paid", chargedAt: duplicateAt, payments: [{ id: "PAY-1002-A", amount: 300, chargedAt: duplicateAt, status: "paid" }, { id: "PAY-1002-B", amount: 300, chargedAt: `${shanghaiDate(-2, now)}T09:13:00+08:00`, status: "paid" }], refund: null, note: "应付300元，实际两笔各300元，共600元；第二笔为重复扣款，尚未申请退款。", isDemo: true },
      { id: "ORD-1003", title: "已取消咨询的退款订单", amount: 180, status: "refunded", chargedAt: `${shanghaiDate(-8, now)}T16:00:00+08:00`, payments: [{ id: "PAY-1003-A", amount: 180, chargedAt: `${shanghaiDate(-8, now)}T16:00:00+08:00`, status: "refunded" }], refund: { status: "completed", amount: 180, reference: "REF-1003", updatedAt: `${shanghaiDate(-5, now)}T10:30:00+08:00` }, note: "退款已完成。", isDemo: true },
    ],
    bookings: [{ id: "APT-2001", expertId: first.id, expertName: first.name, slotId: booked.id, startsAt: booked.startsAt, endsAt: booked.endsAt, format: booked.format, status: "confirmed", price: first.price, isDemo: true }],
    exercises: {}, mutationIds: [], pendingActions: {},
  };
}

export function sanitizeAccountPresentation(account: DemoAccount) {
  account.profile.company = account.profile.company.replace("（测试企业）", "");
  account.profile.department = account.profile.department.replace("（测试）", "");
  account.profile.eap.coverage = account.profile.eap.coverage.replace("可用次数以remainingSessions为准，仅为演示权益。", "").trim();
  if (account.profile.eap.privacy === "测试数据仅供本机演示，不代表真实企业隐私政策或数据共享承诺。") account.profile.eap.privacy = "具体可见范围以企业与平台的隐私政策为准；对话会发送至当前配置的AI模型服务。";
  for (const order of account.orders) {
    order.title = order.title.replace("（测试重复扣款）", "").replace("（测试）", "");
    order.note = order.note.replace(/^测试异常：/, "").replace(/测试退款/g, "退款");
  }
  return account;
}

export const demoSampleQueries = [
  "我的EAP还有几次？帮我查一下重复扣款的订单。",
  "查一下ORD-1002具体扣了几笔钱，退款到哪一步了？",
  "我想找一位合适的咨询师。",
  "我现在有哪些预约？",
  "我有点紧张，想听一小段放松音频。",
  "陪我做一个把注意力带回此刻的练习吧。",
  "我最近压力很大，想有人陪我聊聊，也查下我的权益，再找位300元以内的咨询师。",
];

import type { DemoSlot } from "./demo-types.ts";

export function appointmentTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function slotTime(slot: Pick<DemoSlot, "startsAt" | "endsAt">) {
  const end = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(slot.endsAt));
  return `${appointmentTime(slot.startsAt)}-${end}`;
}

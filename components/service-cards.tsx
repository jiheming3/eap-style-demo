"use client";

import { useMemo, useState } from "react";
import type { AvailabilityCriteria, ConsultationFormat, DemoAttachment, DemoExpert } from "@/lib/demo-types";
import type { AgentTrace } from "@/lib/types";
import { slotTime } from "@/lib/appointment-time";
import { Icon } from "./icons";

const labels: Record<string, string> = { paid: "已支付", duplicate_charge: "重复扣款待处理", refunded: "已退款", refund_pending: "退款处理中", pending: "处理中", processing: "处理中", completed: "已完成", confirmed: "已确认", booked: "已预约", cancelled: "已取消", canceled: "已取消", none: "无退款", succeeded: "已完成", active: "进行中", stopped: "已停止" };
function label(value: string) { return labels[value] ?? value; }

function availabilitySelection(criteria: AvailabilityCriteria, date: string, selection?: { startsAt: string; endsAt: string; format: ConsultationFormat }) {
  return `我选择${date}${selection ? ` ${selection.startsAt.slice(11, 16)}-${selection.endsAt.slice(11, 16)}，${selection.format}` : ""}。沿用咨询主题“${criteria.topic}”${criteria.gender ? `，${criteria.gender}咨询师` : ""}${criteria.maxPrice !== undefined ? `，预算${criteria.maxPrice}元以内` : ""}${!selection && criteria.timeStart ? `，时段${criteria.timeStart}-${criteria.timeEnd}` : ""}${!selection && criteria.format ? `，${criteria.format}` : ""}。请按这些条件匹配咨询师。`;
}

function AudioPlayer({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);
  return <><audio aria-label={title} controls preload="metadata" src={src} onError={() => setFailed(true)} />{failed && <p role="alert">音频暂时无法加载，请刷新后重试。</p>}</>;
}

export function AgentActivity({ trace }: { trace?: AgentTrace[] }) {
  if (!trace?.length) return null;
  const count = new Set(trace.filter((r) => r.agent !== "main").map((r) => r.agent)).size;
  return <details className="agent-trace"><summary><Icon name="layers" size={13} />{count ? `本轮协作 · ${count} 位子 Agent` : "服务说明"}</summary><ol>{trace.map((r, index) => <li key={index}><Icon name="check" size={12} /><span>{r.label}</span>{!!r.tools?.length && <code>{r.tools.join(" · ")}</code>}</li>)}</ol></details>;
}

function ExpertCard({ expert, preferredFormat, disabled, onBook }: { expert: DemoExpert; preferredFormat?: ConsultationFormat; disabled: boolean; onBook: (expertId: string, slotId: string) => void }) {
  const formats = useMemo(() => [...new Set(expert.slots.map((slot) => slot.format))], [expert.slots]);
  const initialFormat = preferredFormat && formats.includes(preferredFormat) ? preferredFormat : formats[0];
  const [format, setFormat] = useState<ConsultationFormat>(initialFormat);
  const slots = expert.slots.filter((slot) => slot.format === format);
  const [slotId, setSlotId] = useState(slots[0]?.id ?? "");
  const selectedSlot = slots.some((slot) => slot.id === slotId) ? slotId : (slots[0]?.id ?? "");

  return <section className="service-item expert-item"><div className="service-item-head"><strong>{expert.name} <small>{expert.gender}</small></strong><span className="service-price">¥{expert.price}<small> / 次</small></span></div><p className="expert-style">{expert.style}</p><p>{expert.topics.join(" · ")}</p><p>{expert.bio}</p><div className="appointment-fields"><label><span>咨询方式</span><select disabled={disabled} value={format} onChange={(event) => { const next = event.target.value as ConsultationFormat; setFormat(next); setSlotId(expert.slots.find((slot) => slot.format === next)?.id ?? ""); }}>{formats.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>可约时间</span><select disabled={disabled} value={selectedSlot} onChange={(event) => setSlotId(event.target.value)}>{slots.map((slot) => <option key={slot.id} value={slot.id}>{slotTime(slot)}</option>)}</select></label></div><button className="appointment-submit" disabled={disabled || !selectedSlot} onClick={() => onBook(expert.id, selectedSlot)}><Icon name="calendar" size={14} />确认预约</button><small className="test-label">使用 1 次 EAP 权益</small></section>;
}

export default function ServiceCards({ attachments, onChoose, onBook, disabled }: { attachments?: DemoAttachment[]; onChoose: (text: string) => void; onBook: (expertId: string, slotId: string) => void; disabled: boolean }) {
  if (!attachments?.length) return null;
  return <div className="service-results">{attachments.map((attachment) => {
    if (attachment.kind === "availability") {
      const dates = [...new Set(attachment.options.map((option) => option.startsAt.slice(0, 10)))];
      const chooseDate = dates.length > 1;
      return <label className="availability-choice" key={attachment.id}><span>{chooseDate ? "可约日期" : "可约时段"}</span><select aria-label={chooseDate ? "选择可约日期" : "选择可约时段"} disabled={disabled} value="" onChange={(event) => { if (!event.target.value) return; if (chooseDate) onChoose(availabilitySelection(attachment.criteria, event.target.value)); else { const option = attachment.options[Number(event.target.value)]; onChoose(availabilitySelection(attachment.criteria, option.startsAt.slice(0, 10), option)); } }}><option value="" disabled>{chooseDate ? "选择方便的日期" : "选择方便的时间和咨询方式"}</option>{chooseDate ? dates.map((date) => <option key={date} value={date}>{date}</option>) : attachment.options.map((option, index) => <option key={`${option.startsAt}-${option.format}`} value={index}>{slotTime(option)} · {option.format}</option>)}</select></label>;
    }
    if (attachment.kind === "experts") return <div className="expert-results" key={attachment.id}>{attachment.experts.length === 0 && <p className="service-empty">暂无符合条件的咨询师或时段</p>}{attachment.experts.map((expert) => <ExpertCard key={expert.id} expert={expert} preferredFormat={attachment.criteria?.format} disabled={disabled} onBook={onBook} />)}{attachment.hasMore && attachment.criteria && <button className="replace-experts" disabled={disabled} onClick={() => { const criteria = attachment.criteria!; onChoose(`换一批咨询师。沿用咨询类型“${criteria.topic}”、日期${criteria.date}、时段${criteria.timeStart}-${criteria.timeEnd}、${criteria.format}${criteria.gender ? `、${criteria.gender}咨询师` : ""}${criteria.maxPrice !== undefined ? `、预算${criteria.maxPrice}元以内` : ""}，请展示下一批。上一批次为${attachment.batch ?? 0}。`); }}><Icon name="refresh" size={14} />换一批</button>}</div>;
    if (attachment.kind === "orders") return <div key={attachment.id}>{attachment.orders.length === 0 && <p className="service-empty">没有找到对应订单</p>}{attachment.orders.map((order) => <section className="service-item" key={order.id}><div className="service-item-head"><strong>{order.title}</strong><span>¥{order.amount}</span></div><div className="service-meta"><span>{order.id}</span><span>{label(order.status)}</span></div><p>支付记录：{order.payments.map((payment) => `¥${payment.amount}（${label(payment.status)}）`).join("、")}</p>{order.refund && <p>退款：{label(order.refund.status)} · ¥{order.refund.amount} · {order.refund.reference}</p>}</section>)}</div>;
    if (attachment.kind === "bookings") return <div key={attachment.id}>{attachment.bookings.length === 0 && <p className="service-empty">没有符合查询条件的预约</p>}{attachment.bookings.map((booking) => <section className="service-item" key={booking.id}><div className="service-item-head"><strong>{booking.expertName}</strong><span>{label(booking.status)}</span></div><p>{slotTime(booking)} · {booking.format} · ¥{booking.price}</p><div className="service-meta"><span>{booking.id}</span><span>咨询预约</span></div>{!["cancelled", "canceled", "completed"].includes(booking.status) && <div className="service-actions"><button disabled={disabled} onClick={() => onChoose(`我想改约 ${booking.id}，先帮我查一下可改的时段。`)}><Icon name="calendar" size={13} />改约</button><button disabled={disabled} onClick={() => onChoose(`确认取消预约 ${booking.id}（${booking.expertName}，${slotTime(booking)}）。`)}><Icon name="close" size={13} />取消预约</button></div>}</section>)}</div>;
    if (attachment.kind === "resource") {
      const resource = attachment.resource;
      return <section className="service-item resource-item" key={attachment.id}><div className="service-item-head"><strong><Icon name={resource.kind === "exercise" ? "leaf" : "headphones"} size={16} />{resource.title}</strong><span>{Math.ceil(resource.durationSeconds / 60)} 分钟</span></div><p>{resource.description}</p>{resource.audioUrl && <AudioPlayer src={resource.audioUrl} title={resource.title} />}{resource.kind === "exercise" && <button className="resource-start" disabled={disabled} onClick={() => onChoose(`带我做“${resource.title}”这个对话式练习。`)}><Icon name="arrow" size={13} />开始练习</button>}<small className="test-label">自助支持 · 可随时停止</small></section>;
    }
    if (attachment.kind === "exercise") {
      const exercise = attachment.exercise;
      return <section className="service-item exercise-item" key={attachment.id}><div className="service-item-head"><strong>{exercise.title}</strong><span>{Math.min(exercise.stepIndex + 1, exercise.totalSteps)} / {exercise.totalSteps}</span></div><p>{exercise.prompt}</p><small className="test-label">{label(exercise.status)} · 可随时停止</small>{exercise.status === "active" && <div className="service-actions"><button disabled={disabled} onClick={() => onChoose("这一步我做完了，继续练习。请接着刚才的进度。")}><Icon name="check" size={13} />继续</button><button disabled={disabled} onClick={() => onChoose("先停止练习，我想继续聊聊。")}><Icon name="stop" size={13} />停止练习</button></div>}</section>;
    }
    return null;
  })}</div>;
}

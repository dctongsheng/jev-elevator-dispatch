import { FLOORS } from "../hospital";
import type { Locale } from "./locale";

// Presentation-only translations. Simulation inputs and recorded evidence keep
// their original text, regardless of the selected interface language.
const FLOOR_LABELS_ZH = [
  "B · 太平间/物资",
  "1 · 大厅/急诊",
  "2 · 影像/检验",
  "3 · 手术室",
  "4 · 重症监护",
  "5 · 心内科",
  "6 · 内外科病房",
  "7 · 肿瘤科",
  "8 · 产科",
  "9 · 儿科/食堂",
] as const;

export function floorLabel(floor: number, locale: Locale): string {
  if (locale === "zh") return FLOOR_LABELS_ZH[floor] ?? `${floor} 层`;
  return FLOORS[floor]?.short ?? `Floor ${floor}`;
}

const REQUEST_NOTES_ZH = new Map<string, string>([
  ["Bed transport ER to ICU, pt intubated, need to go NOW", "患者已插管，需立即用病床从急诊转送重症监护室"],
  ["trauma pt on stretcher, straight to OR", "创伤患者乘担架，直接送往手术室"],
  ["STEMI pt headed to cath lab, bed + RN", "ST 段抬高型心梗患者前往导管室，病床及护士随行"],
  ["stroke alert pt to CT, on gurney", "卒中预警患者乘转运床前往 CT 室"],
  ["code blue team heading up", "心肺复苏急救小组正在上楼"],
  ["rapid response team responding", "快速反应小组正在赶往现场"],
  ["code team en route w/ crash cart", "急救小组携抢救车赶往现场"],
  ["pt transfer to med-surg, bed", "患者乘病床转往内外科病房"],
  ["moving post-op pt to ICU bed", "术后患者乘病床转往重症监护室"],
  ["bed transfer from ICU step-down", "患者乘病床从重症过渡病区转出"],
  ["wheelchair pt for scheduled CT, on contact precautions", "需接触隔离的患者乘轮椅前往预约的 CT 检查"],
  ["pt w/ C diff going to radiology in wheelchair", "艰难梭菌感染患者乘轮椅前往影像科"],
  ["droplet precautions pt to imaging, w/c", "需飞沫隔离的患者乘轮椅前往影像检查"],
  ["stat troponin sample to lab", "急送肌钙蛋白样本至检验科"],
  ["blood cultures to lab asap", "血培养样本需尽快送至检验科"],
  ["ABG sample running to lab", "急送动脉血气样本至检验科"],
  ["pt in wheelchair to dialysis appt", "患者乘轮椅前往预约的透析治疗"],
  ["wheelchair pt going down for x-ray", "患者乘轮椅下楼做 X 光检查"],
  ["discharge pt to lobby, w/c", "出院患者乘轮椅前往大厅"],
  ["sterile instrument trays for OR restock", "为手术室补充无菌器械盘"],
  ["clean supply cart to floor", "清洁物资车送往楼层"],
  ["central supply delivery, sterile packs", "中央供应室配送无菌包"],
  ["dirty linen cart to laundry", "脏布草车送往洗衣房"],
  ["biohazard waste bins going down", "医疗废物桶运送下楼"],
  ["soiled utility cart to basement", "污物车送往地下层"],
  ["morgue transport, pt expired 0300", "转运至太平间，患者于 03:00 去世"],
  ["decedent to morgue", "遗体送往太平间"],
  ["taking deceased pt downstairs", "将已故患者送往楼下"],
  ["nurse going to cafeteria", "护士前往食堂"],
  ["staff heading to break room", "工作人员前往休息室"],
  ["resident going to pharmacy", "住院医师前往药房"],
  ["tech going back to unit", "技师返回科室"],
  ["meal cart delivery", "送餐车配送"],
  ["food service cart", "餐饮服务推车"],
  ["lunch trays going up", "午餐餐盘运送上楼"],
  ["family of 4 going to the cafeteria", "一家四口前往食堂"],
  ["visitors going to maternity", "访客前往产科"],
  ["couple visiting a patient", "两位访客前往探望患者"],
  ["visitor to oncology", "访客前往肿瘤科"],
  ["dad with stroller going to peds", "父亲推婴儿车前往儿科"],
  ["night shift nurse heading to unit", "夜班护士前往科室"],
  ["staff arriving for shift change", "工作人员到院交接班"],
  ["group of visitors", "一组访客"],
  ["visitor looking for a patient room", "访客正在寻找病房"],
  ["family heading upstairs", "家属前往楼上"],
  ["trauma pt arrived, bed to OR with team, go now", "创伤患者已到达，团队随病床立即前往手术室"],
]);

export function requestNote(note: string, locale: Locale): string {
  return locale === "zh" ? REQUEST_NOTES_ZH.get(note) ?? note : note;
}

// Trace messages are stored in Chinese by the existing engine. Translate these
// exact observed events for English readers, without changing the trace itself.
const TRACE_MESSAGES_EN = new Map<string, string>([
  ["模型更新后的容量或优先级约束与原分配不兼容，等待重新派梯", "Updated capacity or priority constraints no longer fit the original assignment; waiting for reassignment."],
  ["收到故障报告，尚未上梯的紧急或专梯请求重新分配", "A fault was reported; urgent or dedicated-car requests not yet on board are reassigned."],
  ["急救请求需要空梯，尚未上梯的原请求重新分配", "An emergency needs an empty car; existing requests not yet on board are reassigned."],
  ["已到达目的楼层", "Arrived at the destination floor."],
  ["电梯到达后实际空间不足，保留请求并重新派梯", "The arriving car had insufficient space; the request is retained for reassignment."],
  ["已上梯，后续模型结果仅作记录", "Picked up; any later model result is recorded without changing the trip."],
]);

export function traceMessage(message: string, locale: Locale): string {
  return locale === "en" ? TRACE_MESSAGES_EN.get(message) ?? message : message;
}

export function eventAction(message: string, locale: Locale): string {
  if (locale === "en") return message;

  // Preserve quoted user/request text verbatim. Only the dispatcher-authored
  // action is translated, using values from the recorded message.
  let match = message.match(/^Re-routed "([\s\S]*)" off Car ([A-D]) after a fault report$/);
  if (match) return `收到故障报告，已将“${match[1]}”从 ${match[2]} 梯重新分配`;

  match = message.match(/^"([\s\S]*)" → Car ([A-D]) limited to routine traffic$/);
  if (match) return `“${match[1]}” → ${match[2]} 梯仅用于常规运输`;

  match = message.match(/^"([\s\S]*)" → hold Car ([A-D]) empty at floor (\d+)$/);
  if (match) return `“${match[1]}” → 在 ${match[3]} 层预留空载的 ${match[2]} 梯`;

  match = message.match(/^"([\s\S]*)" → pre-position (Car [A-D](?:, Car [A-D])*) at floor (\d+)$/);
  if (match) {
    const cars = match[2].split(", ").map((car) => `${car.slice(4)} 梯`).join("、");
    return `“${match[1]}” → 将 ${cars} 提前调至 ${match[3]} 层`;
  }

  return message;
}

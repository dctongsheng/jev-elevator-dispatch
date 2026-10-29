import type { Load, Priority } from "../../src/lib/jev/interpretRequest";

// Evaluation-only wording, separate from the simulation traffic templates.
// These labels describe this toy hospital transport task, not clinical triage.
export interface HarnessCase {
  id: string;
  note: string;
  from: number;
  to: number;
  priority: Priority[];
  load: Load;
  exclusive?: boolean;
}

export const HARNESS_CASES: HarnessCase[] = [
  { id: "staff-icu", note: "One employee walking from the ICU to lunch; no patient or equipment.", from: 4, to: 9, priority: ["routine"], load: "walking", exclusive: false },
  { id: "doctor-pharmacy", note: "A doctor is walking to collect their own prescription after work.", from: 3, to: 1, priority: ["routine"], load: "walking", exclusive: false },
  { id: "no-bed", note: "Visitor walking alone; no bed, no wheelchair, and no medical emergency.", from: 1, to: 4, priority: ["visitor"], load: "walking", exclusive: false },
  { id: "negated-code", note: "Code blue drill is over. One instructor walks back to the office.", from: 5, to: 1, priority: ["routine"], load: "walking", exclusive: false },
  { id: "linen-trolley", note: "Housekeeping moving a trolley full of clean towels to the ward.", from: 0, to: 6, priority: ["routine"], load: "cart", exclusive: false },
  { id: "food-cart", note: "Kitchen attendant delivering a large cart of evening meals.", from: 9, to: 8, priority: ["routine"], load: "cart", exclusive: false },
  { id: "scheduled-chair", note: "Patient seated in a wheelchair going to a booked dialysis appointment.", from: 6, to: 2, priority: ["urgent"], load: "wheelchair", exclusive: false },
  { id: "stable-bed", note: "Stable patient on a hospital bed transferring to the recovery ward; no emergency.", from: 3, to: 6, priority: ["urgent"], load: "bed", exclusive: true },
  { id: "resuscitation", note: "Resuscitation team responding to an active cardiac arrest upstairs, on foot.", from: 1, to: 7, priority: ["stat"], load: "walking", exclusive: true },
  { id: "critical-stretcher", note: "Critical trauma patient on a stretcher needs immediate transport to emergency surgery.", from: 1, to: 3, priority: ["stat"], load: "bed", exclusive: true },
  { id: "specimen", note: "Courier walking with one urgent blood specimen for the lab; no patient is travelling.", from: 6, to: 2, priority: ["urgent"], load: "walking", exclusive: false },
  { id: "family", note: "Three relatives are walking together to visit a patient in maternity.", from: 1, to: 8, priority: ["visitor"], load: "walking", exclusive: false },
  { id: "deceased", note: "Porter transferring a deceased patient to the mortuary on a stretcher.", from: 7, to: 0, priority: ["routine"], load: "bed", exclusive: true },
  { id: "empty-bed", note: "Facilities staff returning an empty hospital bed to storage. No patient aboard.", from: 6, to: 0, priority: ["routine"], load: "bed", exclusive: true },
  { id: "cancelled-trauma", note: "The trauma transfer was cancelled; a receptionist is walking back to the lobby.", from: 4, to: 1, priority: ["routine"], load: "walking", exclusive: false },
  { id: "equipment-negation", note: "Technician walking to repair a wheelchair upstairs, carrying only a small screwdriver.", from: 1, to: 6, priority: ["routine"], load: "walking", exclusive: false },
];

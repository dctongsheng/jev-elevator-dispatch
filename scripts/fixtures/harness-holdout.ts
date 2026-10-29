import type { HarnessCase } from "./harness-cases";

// Final wording set authored after the development fixture had exposed guard
// bugs. Keep this set out of implementation tuning; report failures unchanged.
export const HOLDOUT_CASES: HarnessCase[] = [
  { id: "holdout-meeting", note: "A cardiologist is taking the lift alone to a scheduled staff meeting.", from: 5, to: 3, priority: ["routine"], load: "walking", exclusive: false },
  { id: "holdout-guests", note: "Four guests are on their way to see a new baby.", from: 1, to: 8, priority: ["visitor"], load: "walking", exclusive: false },
  { id: "holdout-chair", note: "Transporter pushing a patient in a wheeled chair for a planned scan.", from: 7, to: 2, priority: ["urgent"], load: "wheelchair", exclusive: false },
  { id: "holdout-code", note: "Crash response clinicians urgently attending an active code blue; travelling without equipment.", from: 1, to: 9, priority: ["stat"], load: "walking", exclusive: true },
  { id: "holdout-empty-stretcher", note: "Unoccupied stretcher being wheeled back to equipment storage.", from: 4, to: 0, priority: ["routine"], load: "bed", exclusive: true },
  { id: "holdout-morgue", note: "The porter is taking someone who has died to the morgue.", from: 6, to: 0, priority: ["routine"], load: "bed", exclusive: true },
  { id: "holdout-laundry", note: "A trolley carrying sealed bags of used laundry is going to the basement.", from: 8, to: 0, priority: ["routine"], load: "cart", exclusive: false },
  { id: "holdout-stroke", note: "Stroke-alert patient lying on a gurney, immediate transfer for treatment.", from: 1, to: 2, priority: ["stat"], load: "bed", exclusive: true },
  { id: "holdout-training", note: "Returning from stroke simulation training, instructor on foot.", from: 5, to: 1, priority: ["routine"], load: "walking", exclusive: false },
  { id: "holdout-pathology", note: "Messenger bringing time-sensitive pathology samples by hand.", from: 4, to: 2, priority: ["urgent"], load: "walking", exclusive: false },
  { id: "holdout-parent", note: "A parent is walking to the children's ward carrying a toy.", from: 1, to: 9, priority: ["visitor"], load: "walking", exclusive: false },
  { id: "holdout-cancelled-chair", note: "Wheelchair appointment cancelled. The ward clerk will walk to reception alone.", from: 6, to: 1, priority: ["routine"], load: "walking", exclusive: false },
  { id: "holdout-old-emergency", note: "Hospital employee carrying paperwork for an emergency surgery that finished yesterday.", from: 3, to: 4, priority: ["routine"], load: "walking", exclusive: false },
  { id: "holdout-planned-bed", note: "Patient transport on a bed for scheduled MRI, stable and comfortable.", from: 8, to: 2, priority: ["urgent"], load: "bed", exclusive: true },
];

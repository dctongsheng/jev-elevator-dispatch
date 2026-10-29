import type { Load, Priority } from "./interpretRequest";

export interface RequestEvidence {
  priority?: Priority;
  load?: Load;
  exclusive?: boolean;
  exclusiveReason?: "load" | "emergency" | "explicit";
  people?: number;
}

// A small, shared set of operational constraints, not a catalog of simulation
// requests. It reads the note only; floor names and hidden scoring labels must
// never establish that a passenger is a patient, needs a bed, or is critical.
export function requestEvidence(note: string): RequestEvidence {
  const text = note.toLowerCase().replace(/[’]/g, "'").replace(/\bw\/c\b/g, "wheelchair");
  const active = text
    .replace(/\b(?:no(?: longer)?|without|not(?: using| requiring)?|does not need|doesn't need)\s+(?:a |an |any )?(?:patient|pt|bed|stretcher|gurney|wheelchair|cart|emergency|trauma|code blue|stroke alert|critical|urgent)\b/g, "")
    .replace(/\b(?:stroke(?: alert)?|trauma|code blue|emergency)(?: transfer| transport| response)?\s+(?:(?:was|is|has been)\s+)?(?:ruled out|excluded|cancelled|canceled)\b/g, "")
    .replace(/\b(?:code blue|trauma|cardiac arrest|emergency)\s+(?:drill|training|simulation)\b/g, "training");
  const equipment = active
    .replace(/\b(?:linen|sheets|blankets)\s+(?:for|on)\s+(?:a |the )?(?:patient )?bed\b/g, "linen")
    .replace(/\b(?:wheelchair|bed|stretcher|gurney)\s+(?:training|demonstration|paperwork)\b/g, "training")
    .replace(/\b(?:repair|fix|clean|inspect)\s+(?:a |the |an )?(?:wheelchair|bed|stretcher|gurney)\b/g, "maintenance");
  const e: RequestEvidence = {};
  const deceased = /\b(?:decedent|deceased|morgue|expired)\b/.test(active);
  const emergency = !deceased && /\b(?:code blue|code team|rapid response|resuscitat\w*|cardiac arrest|respiratory arrest|stroke alert|heart attack|stemi|trauma|crash c[ -]?section)\b/.test(active);
  const urgentPatient = /\b(?:patient|pt)\b/.test(active) && /\b(?:intubated|unstable|critical|emergency|stat|now|asap)\b/.test(active);
  const visitor = /\b(?:visitor\w*|visiting|family|families|parents|relatives|couple|guests?)\b/.test(active);
  const visitingOnly = visitor && !/\b(?:transporting|transferring|accompanying|escorting)\b/.test(active);
  const operational = /\b(?:restock\w*|linen|laundry|meal\w*|trash|waste|soiled|sterile instrument|suppl\w*|training|empty (?:hospital )?bed)\b/.test(active);
  const staffTrip = /\b(?:staff|nurse|resident|doctor|tech(?:nician)?|employee|receptionist)\b/.test(active)
    && /\b(?:going|heading|break|cafeteria|back|commut\w*)\b/.test(active);
  const patientTrip = /\b(?:patient|pt)\b/.test(active);
  const specimens = /\b(?:specimen\w*|sample\w*|blood|medication\w*|meds)\b/.test(active)
    && /\b(?:stat|urgent|asap|time.sensitive|lab|delivery)\b/.test(active);

  if (emergency || urgentPatient) e.priority = "stat";
  else if (deceased) e.priority = "routine";
  else if (specimens) e.priority = "urgent";
  else if (visitingOnly) e.priority = "visitor";
  else if (operational || staffTrip) e.priority = "routine";
  else if (patientTrip) e.priority = "urgent";
  else if (visitor) e.priority = "visitor";
  else if (/\b(?:not (?:an? )?emergency|non[ -]?urgent|routine trip)\b/.test(text)) e.priority = "routine";

  if (visitingOnly) e.load = "walking";
  else if (/\b(?:bed(?!\s*(?:sheet|linen))|stretcher|gurney)\b/.test(equipment) || deceased) e.load = "bed";
  else if (/\bwheelchair\b/.test(equipment)) e.load = "wheelchair";
  else if (/\b(?:cart|trolley|large equipment)\b/.test(equipment)) e.load = "cart";
  else if (/\b(?:walking|on foot|ambulatory)\b/.test(active) || staffTrip || visitor || specimens || /\b(?:code blue|rapid response) team\b/.test(active)) e.load = "walking";

  // A generic probability near 0.5 must not turn every cart or staff trip into
  // a dedicated car. Beds, emergencies, or an explicit isolation request can.
  if (/\b(?:isolation|no other passengers|dedicated (?:car|elevator)|empty (?:car|elevator)|own (?:car|elevator))\b/.test(active)) {
    e.exclusive = true;
    e.exclusiveReason = "explicit";
  } else if (e.load === "bed" || e.priority === "stat") {
    e.exclusive = true;
    e.exclusiveReason = e.load === "bed" ? "load" : "emergency";
  }
  else if (e.load !== undefined) e.exclusive = false;

  const count = text.match(/\b(?:group|family|party|team) of (\d+)\b|\b(\d+) (?:people|visitors|passengers|staff|nurses)\b/);
  if (count) e.people = Math.max(1, Math.min(10, Number(count[1] ?? count[2])));
  else if (/\b(?:group|family|families|visitors|parents|relatives)\b/.test(active)) e.people = 3;
  else if (e.load === "walking") e.people = 1;
  return e;
}

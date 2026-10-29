import type { Load, Priority, RequestInterpretation } from "../jev/interpretRequest";
import { requestEvidence } from "../jev/requestEvidence";
import type { Profile } from "./types";

// Code owns policy: Jev supplies typed judgments, these rules turn them into
// dispatch constraints.
const YES = 0.85;

const LOAD_UNITS: Record<Load, number> = { bed: 10, cart: 5, wheelchair: 3, walking: 1 };
export const PRIORITY_LABEL: Record<Priority, string> = {
  stat: "STAT",
  urgent: "Urgent",
  routine: "Routine",
  visitor: "Visitor",
};

// What the baseline assumes about every request: a normal passenger.
export const BASELINE_PROFILE: Profile = {
  priority: "routine",
  units: 1,
  exclusive: false,
  tags: [],
};

// Direct, visible request facts can move a car immediately. Model latency must
// not stop the control loop. Unspecified facts retain ordinary service.
export function provisionalProfile(note: string): Profile {
  const evidence = requestEvidence(note);
  const priority = evidence.priority ?? "routine";
  const load = evidence.load ?? "walking";
  const exclusive = priority === "stat" || load === "bed" || evidence.exclusive === true;
  const tags = [PRIORITY_LABEL[priority], load, "provisional"];
  if (exclusive) tags.push("own car");
  return {
    priority,
    units: load === "walking" ? Math.min(10, Math.max(1, evidence.people ?? 1)) : LOAD_UNITS[load],
    exclusive,
    tags,
  };
}

export function profileFrom(i: RequestInterpretation, note = ""): Profile {
  const evidence = requestEvidence(note);
  const exclusive = i.priority === "stat" || i.load === "bed" || evidence.exclusiveReason === "explicit" || i.exclusiveCar > YES;
  const tags = [PRIORITY_LABEL[i.priority], i.load];
  if (exclusive) tags.push("own car");
  return {
    priority: i.priority,
    units: i.load === "walking" ? Math.min(10, Math.max(1, evidence.people ?? 1)) : LOAD_UNITS[i.load],
    exclusive,
    tags,
  };
}

import type { EventInterpretation } from "../jev/interpretEvent";
import type { Priority, RequestInterpretation } from "../jev/interpretRequest";
import type { Truth } from "./corpus";

export type Mode = "baseline" | "jev" | "llm";

export const CAR_CAPACITY = 10;
export const CAR_SPEED = 0.5; // floors per sim second
export const DOOR_DWELL = 6; // sim seconds per stop
export const FAULT_DWELL = 20; // extra seconds per stop for a faulty car

// How much a second of waiting costs, by true priority. Scoring only.
export const PRIORITY_WEIGHT: Record<Priority, number> = {
  stat: 10,
  urgent: 3,
  routine: 1,
  visitor: 1,
};

export interface Arrival {
  id: number;
  at: number; // sim seconds
  from: number;
  to: number;
  note: string;
  truth: Truth;
}

// What a dispatcher believes about a request. The baseline believes nothing
// beyond origin and destination.
export interface Profile {
  priority: Priority;
  units: number;
  exclusive: boolean;
  tags: string[]; // human-readable, built from typed answers
}

export type PassengerStatus = "interpreting" | "waiting" | "riding" | "done";

export type DispatchRejection =
  | "recent_capacity_failure"
  | "exclusive_car"
  | "faulty_for_priority"
  | "reserved_for_emergency"
  | "exclusive_trip_conflict"
  | "insufficient_capacity";

export interface DispatchScore {
  eta: number;
  disruption: number;
  faultPenalty: number;
  reassignmentPenalty: number;
  reservationBonus: number;
  total: number;
}

export interface DispatchCandidateTrace {
  car: number;
  position: number;
  eligible: boolean;
  selected: boolean;
  rejection?: DispatchRejection;
  score?: DispatchScore;
  displacedPassengerIds: number[];
}

export interface AssignmentTrace {
  at: number;
  car: number | null;
  basis: "provisional" | "model" | "fallback" | "rules";
  profile: Profile;
  candidates: DispatchCandidateTrace[];
}

export interface TraceEvent {
  at: number;
  kind: "reroute" | "capacity-failure" | "pickup" | "dropoff";
  car?: number;
  message: string;
}

// Observation-only snapshots: each profile and candidate list is copied at the
// actual decision point. These values are never inputs to scoring or routing.
export interface PassengerTrace {
  initialProfile: Profile;
  modelStatus: "not-requested" | "pending" | "success" | "fallback";
  modelCompletedAt?: number;
  modelAppliedBeforePickup?: boolean;
  profileBeforeModel?: Profile;
  modelProfile?: Profile;
  profileAfterModel?: Profile;
  assignments: AssignmentTrace[];
  events: TraceEvent[];
}

export interface Passenger extends Arrival {
  status: PassengerStatus;
  profile?: Profile;
  interp?: RequestInterpretation;
  trace?: PassengerTrace;
  car?: number;
  pickedAt?: number;
  droppedAt?: number;
  wastedTrips: number;
  // After a car arrives too full, don't send that same car straight back.
  blockedCar?: number;
  blockedUntil?: number;
}

export interface Car {
  id: number;
  pos: number;
  dir: -1 | 0 | 1;
  doorTimer: number;
  riders: number[];
  assigned: number[];
  faulty: boolean; // physical: slow doors
  avoided: boolean; // policy: dispatcher knows it's faulty
  exclusiveFor?: number;
  reservedFloor?: number; // held empty for an incoming priority transport
  reservedUntil?: number; // reservations expire if the predicted request never arrives
  parkAt?: number;
}

export interface Decision {
  at: number;
  kind: "assign" | "interpret" | "bump" | "wasted" | "event";
  latencyMs?: number; // Jev latency for the request behind this decision
  text: string;
  tags?: string[];
}

export interface WorldEvent {
  text: string;
  at: number;
  interp: EventInterpretation;
}

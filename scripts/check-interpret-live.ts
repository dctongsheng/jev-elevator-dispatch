import { interpretRequest } from "../src/lib/jev/interpretRequest";

const notes = [
  "resident going to pharmacy",
  "meal cart delivery",
  "patient transfer to ward, not an emergency",
  "Bed transport ER to ICU, patient intubated, need to go NOW",
  "family of 4 going to the cafeteria",
  "code blue team heading up to OR 2",
  "stat troponin sample to lab",
  "wheelchair patient for scheduled CT, on contact precautions",
];

async function main() {
  for (const note of notes) {
    const r = await interpretRequest({ note, from: 1, to: 4 });
    console.log(JSON.stringify({ note, priority: r.priority, load: r.load, exclusiveCar: r.exclusiveCar, raw: r.raw, adjustments: r.adjustments, latencyMs: Math.round(r.latencyMs), model: r.model }));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

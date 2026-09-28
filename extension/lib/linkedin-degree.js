/**
 * Connection degree, out of whatever shape Voyager is serving this month.
 *
 * The degree is the one fact EarthOS cannot infer, guess, or fetch from
 * anywhere else: it is the difference between "you know this person" and "you
 * have never met them", and it is most of what a mutual is for. So it gets its
 * own module — small, pure, and under test — rather than living inline in the
 * graph engine where a silent shape change can rot it unnoticed. That is
 * exactly what happened: the field moved and every capture quietly recorded a
 * null degree while everything else about the profile kept working.
 *
 * Three spellings are accepted, because LinkedIn has shipped all three:
 *
 *   · Today — a union whose ARM is the answer. `connection` means first degree
 *     and carries no distance string at all; everyone else arrives as
 *     `noConnection.memberDistance`, a plain string.
 *   · Previously — `memberRelationshipUnion.memberDistance.value`, an object.
 *   · Older still — a flat `distanceData.value`.
 *
 * Nothing here ever guesses. A shape this does not recognise returns null,
 * which the writers treat as "no evidence" and leave alone — a person whose
 * degree we cannot establish keeps whatever a real capture proved earlier,
 * rather than being downgraded by a parser that failed to read a field.
 */

/** "1st" | "2nd" | "3rd", or null when nothing here is evidence of a degree. */
export function degreeFromRelationship(relationship) {
  const union = relationship?.memberRelationshipUnion || relationship;
  if (!union || typeof union !== "object") return null;
  // The arm itself is the evidence: a `connection` arm IS first degree, and it
  // carries no distance string to read.
  if (union.connection) return "1st";
  // You are not a degree away from yourself. Returning null keeps the viewer's
  // own row from being stamped with a relationship to themselves.
  if (union.self) return null;
  const distance =
    (typeof union.noConnection?.memberDistance === "string" ? union.noConnection.memberDistance : null)
    || union.noConnection?.memberDistance?.value
    || (typeof union.memberDistance === "string" ? union.memberDistance : null)
    || union.memberDistance?.value
    || "";
  if (distance === "DISTANCE_1") return "1st";
  if (distance === "DISTANCE_2") return "2nd";
  // OUT_OF_NETWORK is spelled "3rd" to match the search parser's entityDegree,
  // so one degree means one thing everywhere in the extension.
  if (distance === "DISTANCE_3" || distance === "OUT_OF_NETWORK") return "3rd";
  return null;
}

/**
 * The degree carried anywhere in a profile response, or null.
 *
 * Scans the whole response rather than one element: the relationship and the
 * identity do not reliably arrive on the same object, and reading only the
 * element that happened to carry the name is how this came back null.
 */
export function readProfileDegree(data) {
  const combined = [...(data?.elements || []), ...(data?.included || [])];
  for (const item of combined) {
    const degree = degreeFromRelationship(item?.memberRelationship)
      || degreeFromRelationship(item?.memberRelationshipData)
      || legacyDistance(item?.distanceData?.value);
    if (degree) return degree;
  }
  return null;
}

function legacyDistance(value) {
  if (value === "DISTANCE_1") return "1st";
  if (value === "DISTANCE_2") return "2nd";
  if (value === "DISTANCE_3") return "3rd";
  return null;
}

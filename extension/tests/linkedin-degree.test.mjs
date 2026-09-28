/**
 * Degree parsing, against the shapes LinkedIn actually returns.
 *
 * Every fixture here was copied from a live Voyager response, not invented:
 * the union arms below are what
 * `/voyager/api/identity/dash/profiles?decorationId=…WebTopCardCore-13` served
 * for a first-degree connection, a second-degree stranger, and the viewer
 * themselves. The old flat shapes are kept too, because a decoration that
 * still serves them must keep working.
 *
 * This file exists because the field moved and nothing noticed. Every capture
 * recorded a null degree — no error, no failed request, no missing person,
 * just the one fact the product is built on quietly absent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { degreeFromRelationship, readProfileDegree } from "../lib/linkedin-degree.js";

test("a connection arm is first degree, and carries no distance to read", () => {
  // Live shape: the arm IS the answer. There is no DISTANCE_1 string anywhere.
  const relationship = {
    memberRelationshipUnion: {
      connection: { connectedMemberResolutionResult: { lastName: "Melas-Kyriazi" } },
    },
  };
  assert.equal(degreeFromRelationship(relationship), "1st");
});

test("a noConnection arm carries the distance as a plain string", () => {
  const second = { memberRelationshipUnion: { noConnection: { memberDistance: "DISTANCE_2" } } };
  const third = { memberRelationshipUnion: { noConnection: { memberDistance: "DISTANCE_3" } } };
  const out = { memberRelationshipUnion: { noConnection: { memberDistance: "OUT_OF_NETWORK" } } };
  assert.equal(degreeFromRelationship(second), "2nd");
  assert.equal(degreeFromRelationship(third), "3rd");
  // Spelled the same way the search parser spells it, so one degree means one
  // thing across the extension.
  assert.equal(degreeFromRelationship(out), "3rd");
});

test("you are not a degree away from yourself", () => {
  assert.equal(degreeFromRelationship({ memberRelationshipUnion: { self: {} } }), null);
});

test("the shapes LinkedIn served before this one still parse", () => {
  // Object-wrapped distance, one level up from the union.
  assert.equal(
    degreeFromRelationship({ memberRelationshipUnion: { memberDistance: { value: "DISTANCE_1" } } }),
    "1st",
  );
  // A bare union, passed without its wrapper.
  assert.equal(degreeFromRelationship({ noConnection: { memberDistance: "DISTANCE_2" } }), "2nd");
});

test("an unrecognised shape is null, never a guess", () => {
  // A parser that cannot read the field must say so. Returning a default here
  // would overwrite a degree a real capture had already proved.
  assert.equal(degreeFromRelationship(null), null);
  assert.equal(degreeFromRelationship(undefined), null);
  assert.equal(degreeFromRelationship({}), null);
  assert.equal(degreeFromRelationship("DISTANCE_1"), null);
  assert.equal(degreeFromRelationship({ memberRelationshipUnion: { somethingNew: {} } }), null);
});

test("the degree is found wherever in the response it sits", () => {
  // The relationship and the identity do not arrive on the same element;
  // reading only the one carrying the name is how this came back null.
  const response = {
    elements: [{ entityUrn: "urn:li:fsd_profile:ABC", firstName: "Aaron", lastName: "Levie" }],
    included: [{ memberRelationship: { memberRelationshipUnion: { noConnection: { memberDistance: "DISTANCE_2" } } } }],
  };
  assert.equal(readProfileDegree(response), "2nd");
});

test("a response with no relationship at all is null", () => {
  // FullProfileWithEntities returns every section of a profile and no
  // relationship — which is exactly why the graph engine asks the top card
  // for the degree separately instead of assuming one.
  const fullProfile = {
    elements: [{ entityUrn: "urn:li:fsd_profile:ABC", firstName: "Aaron", headline: "CEO at Box" }],
  };
  assert.equal(readProfileDegree(fullProfile), null);
  assert.equal(readProfileDegree({}), null);
  assert.equal(readProfileDegree(null), null);
});

test("the legacy flat distanceData is still read", () => {
  assert.equal(readProfileDegree({ elements: [{ distanceData: { value: "DISTANCE_3" } }] }), "3rd");
});

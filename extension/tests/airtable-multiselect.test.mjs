import test from "node:test";
import assert from "node:assert/strict";
const H = "./helpers/image-harness.mjs";
const { PEOPLE, person, setup, sink } = await import(H);

const SKILLS = "fldSkills00000001";
const addSkills = (tables) => {
  tables.find((t) => t.id === PEOPLE).fields.push({ id: SKILLS, name: "Skills", type: "multipleSelects",
    options: { choices: [{ id: "selPy", name: "Python" }] } });
  return tables;
};

test("multi-select with one existing and one new choice lands both", async () => {
  const { base } = setup({}, { tables: addSkills, mapping: { skills: SKILLS } });
  const t = await sink.writePeople([person("ada", { skills: ["Python", "Rust"] })]);
  assert.equal(t.failed, 0, t.errors[0]);
  const [row] = base.rows(PEOPLE);
  assert.deepEqual(row.fields[SKILLS], ["Python", "Rust"], "new choice silently dropped");
});

test("a multi-select that did land partially is repaired by the next sync", async () => {
  const { base } = setup({}, { tables: addSkills, mapping: { skills: SKILLS } });
  await sink.writePeople([person("ada", { skills: ["Python", "Rust"] })]);
  await sink.writePeople([person("ada", { skills: ["Python", "Rust"] })]);
  const [row] = base.rows(PEOPLE);
  assert.deepEqual(row.fields[SKILLS], ["Python", "Rust"]);
});

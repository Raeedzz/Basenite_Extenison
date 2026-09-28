/**
 * Terminal result handling for the LinkedIn graph flows (mutuals, company):
 * write the people into Airtable and settle the progress record the side
 * panel reads.
 */

import { captureCompanyPeople, captureMutualConnections, getToken } from "../lib/api-client.js";
import { setCompanyProgress, setMutualProgress } from "./capture-state.js";

const LOG = (...args) => console.log("[EarthOS:Heart:BG]", ...args);
const ERR = (...args) => console.error("[EarthOS:Heart:BG]", ...args);

export async function saveBridgeResults(results) {
  if (!Array.isArray(results)) {
    ERR("Invalid bridge results:", typeof results);
    return { error: "Invalid results" };
  }

  LOG(`Received ${results.length} bridge result(s), uploading...`);

  const token = await getToken();
  if (!token) {
    await setMutualProgress({ status: "error", message: "Connect Airtable in the side panel first." });
    return { error: "Not authenticated" };
  }

  await setMutualProgress({
    status: "uploading",
    current: results.length,
    total: results.length,
    message: `Saving ${results.length} result(s) to Airtable…`,
  });

  try {
    const response = await captureMutualConnections(results);
    const totalBridges = results.reduce((sum, r) => sum + (r.bridges?.length || 0), 0);

    await setMutualProgress({
      status: "complete",
      current: results.length,
      total: results.length,
      updated: response?.updated || 0,
      unresolved: response?.unresolved || 0,
      totalBridges,
      people: Array.isArray(response?.mutualPeople) ? response.mutualPeople : [],
      message: `Found ${totalBridges} mutual connection${totalBridges === 1 ? "" : "s"} across ${results.length} contact${results.length === 1 ? "" : "s"}`,
    });

    LOG(`Mutuals capture complete: ${totalBridges} bridges across ${results.length} contacts`);
    return {
      success: true,
      totalBridges,
      targets: results.length,
      people: Array.isArray(response?.mutualPeople) ? response.mutualPeople : [],
    };
  } catch (err) {
    ERR("Mutuals upload failed:", err.message);
    await setMutualProgress({ status: "error", message: err.message });
    return { error: err.message };
  }
}

/**
 * Persist the enriched company list locally, upsert it into Airtable (matched
 * on LinkedIn URL, so repeated captures are idempotent), and flip
 * company_progress to complete.
 */
export async function saveCompanyResults(message) {
  const name = (message.company || "").trim();
  const companyId = message.companyId || null;
  const people = Array.isArray(message.people) ? message.people : [];
  const requestId = message.requestId ?? null;

  const token = await getToken();
  if (!token) {
    await setCompanyProgress({ status: "error", message: "Connect Airtable in the side panel first.", requestId });
    return { error: "Not authenticated" };
  }

  // The people go to Airtable only; no copy of their profiles is kept here.
  LOG(`Company capture complete: ${people.length} people for "${name}"`);

  let linked = 0;
  if (people.length > 0) {
    await setCompanyProgress({
      status: "in_progress",
      current: people.length,
      total: people.length,
      message: `Saving ${people.length} ${people.length === 1 ? "person" : "people"} to Airtable…`,
      requestId,
    });
    try {
      const json = await captureCompanyPeople({ company: name, companyId, people });
      linked = json?.accepted ?? json?.linked ?? people.length;
      LOG(`Company capture uploaded: ${linked} saved for "${name}"`);
    } catch (err) {
      ERR("Company capture upload error:", err.message);
      await setCompanyProgress({
        status: "error",
        current: 0,
        total: people.length,
        company: name,
        message: err.message || "Company capture upload failed",
        requestId,
      });
      return { error: err.message || "Company capture upload failed", count: people.length };
    }
  }

  await setCompanyProgress({
    status: "complete",
    current: people.length,
    total: people.length,
    count: people.length,
    linked,
    company: name,
    message: (people.length
      ? `Captured ${people.length} ${people.length === 1 ? "person" : "people"} at ${name}`
      : `No matching people found at ${name}`)
      + (message.partial ? ` (search stopped early: ${message.partial})` : ""),
    requestId,
  });

  return { success: true, count: people.length, linked };
}


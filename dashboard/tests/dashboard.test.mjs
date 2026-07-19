import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard source includes the experiment narrative and profile", async () => {
  const source = await readFile(new URL("../src/ExperimentDashboard.tsx", import.meta.url), "utf8");

  assert.match(source, /This study explores whether offering students a/);
  assert.match(source, /Personalized quizzes increased/);
  assert.match(source, /What the experiment found/);
  assert.match(source, /Technical Product Manager for Data Platforms at Wood Mackenzie/);
  assert.match(source, /Columbia University/);
  assert.match(source, /linkedin\.com\/in\/ain1/);
  assert.match(source, /x\.com\/ain__siddiqui/);
});

test("production build contains dashboard metadata", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");

  assert.match(html, /Personalized Quiz A\/B Test/);
  assert.match(html, /59\.8% quiz attempt rate in control vs\. 62\.9% with personalization/);
  assert.match(html, /social-preview\.png/);
  assert.match(html, /id="root"/);
});

test("exported data matches the notebook and preserves aggregate particles", async () => {
  const payload = JSON.parse(
    await readFile(new URL("../src/data/experiment-summary.json", import.meta.url), "utf8"),
  );

  assert.equal(payload.experiment.rawRows, 64_928);
  assert.equal(payload.experiment.cleanUsers, 64_888);
  assert.equal(payload.experiment.removedImpossible, 3);
  assert.equal(payload.experiment.removedDuplicates, 37);
  assert.equal(payload.arms.control.users, 32_166);
  assert.equal(payload.arms.personalized_quiz.users, 32_722);
  assert.ok(Math.abs(payload.metrics.attempt.difference - 0.031002) < 1e-6);
  assert.ok(Math.abs(payload.metrics.completion.difference + 0.020201) < 1e-6);
  assert.ok(Math.abs(payload.metrics.retention.pValue - 0.6226) < 1e-4);
  assert.equal(payload.particleBins.reduce((sum, bin) => sum + bin.particles, 0), 6_489);
  assert.equal(payload.particleBins.reduce((sum, bin) => sum + bin.users, 0), 64_888);
});

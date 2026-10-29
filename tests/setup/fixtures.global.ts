import { ensureFixtures } from '../../scripts/fixtures/generate.js';

/** Generates synthetic fixtures once (skipped when the stamp matches the generator version). */
export default async function setup(): Promise<void> {
  await ensureFixtures();
}

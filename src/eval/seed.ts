import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLiveApps } from '../adapters/live/index.js';
import { loadLiveConfig } from '../config.js';
import { COMPANIES, INCIDENTS } from './scenarios.js';

export const DATASET_PATH = 'eval/dataset.json';

export interface Dataset {
  companies: Record<string, { id: string; name: string }>;
  incidents: Record<string, { id: string; identifier: string }>;
}

export function loadDataset(): Dataset {
  if (!existsSync(DATASET_PATH)) throw new Error('Run npm run seed first');
  return JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Dataset;
}

/** Creates or updates the fixed HubSpot companies and Linear incidents. Safe to run twice. */
async function main(): Promise<void> {
  const config = loadLiveConfig();
  const apps = createLiveApps(config);
  await apps.crm.ensureProperties();

  const dataset: Dataset = { companies: {}, incidents: {} };
  for (const company of COMPANIES) {
    const stripeCustomerId = await apps.billing.createTestCustomer(company.name, { twiceshy_seed: company.key });
    const id = await apps.crm.upsertCompany({ ...company, stripeCustomerId });
    dataset.companies[company.key] = { id, name: company.name };
    process.stdout.write(`HubSpot company ${company.name} -> ${id}\n`);
  }
  for (const incident of INCIDENTS) {
    const id = await apps.tracker.upsertIncident({
      title: incident.title,
      summary: incident.summary,
      severity: incident.severity,
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt,
      affectedCompanyIds: incident.affected.map((key) => dataset.companies[key]!.id),
    });
    const loaded = await apps.tracker.getIncident(id);
    dataset.incidents[incident.key] = { id, identifier: loaded?.identifier ?? '' };
    process.stdout.write(`Linear incident ${incident.title} -> ${loaded?.identifier} (${loaded?.affectedCompanyIds.length} accounts)\n`);
  }
  mkdirSync('eval', { recursive: true });
  writeFileSync(DATASET_PATH, `${JSON.stringify(dataset, null, 2)}\n`);
  process.stdout.write(`Wrote ${DATASET_PATH}\n`);
}

if (process.argv[1]?.endsWith('seed.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

import { createWriteStream } from "node:fs";
import { Command } from "commander";
import {
  backfillFolders,
  backlogSorterIsTrickle,
  connectorForAccount,
  createDrafter,
  createSorter,
  distillRules,
  ensureConfigFiles,
  exportJsonl,
  formatModelRef,
  listEvalRuns,
  listProjects,
  loadConfig,
  loadPipelineInputs,
  MODEL_ENV_VARS,
  MODEL_ROLES,
  openDb,
  parseModelRef,
  proposeProjects,
  providerForRole,
  readRules,
  renderSortEvalReport,
  renderUsageReport,
  runPipeline,
  runSortEval,
  saveProjects,
  seedCategoriesIfEmpty,
  sortEvalReport,
  usageSummary,
  windowStartFor,
  schema,
} from "@messaging-agent/core";

const program = new Command().name("celeste").description("Celeste reads mail, sorts it, drafts replies you approve.");

async function setup() {
  const cfg = loadConfig();
  await ensureConfigFiles(cfg);
  const db = openDb(cfg.dbPath);
  // The sorter needs sub-categories; a fresh install gets the starter list.
  seedCategoriesIfEmpty(db);
  // Mail stored before folders existed still needs one (spec 10a).
  backfillFolders(db);
  return { cfg, db };
}

program
  .command("run")
  .description("Sync every account, sort new mail, apply labels, draft replies.")
  .option("--no-draft", "sync, sort, and label only")
  .option("--backfill-days <n>", "first-run backfill window", "7")
  .action(async (opts: { draft: boolean; backfillDays: string }) => {
    const { cfg, db } = await setup();
    const accountCount = db.select().from(schema.accounts).all().length;
    if (accountCount === 0) {
      console.log("No inboxes connected. Open the app and add one: pnpm web");
      return;
    }
    const { criteria, voice, blocklist } = await loadPipelineInputs(cfg);

    const result = await runPipeline(db, {
      connectorFor: (account) => connectorForAccount(cfg, db, account),
      sorter: createSorter(cfg, db),
      drafter: opts.draft ? createDrafter(cfg, db) : null,
      backfillDays: Number(opts.backfillDays),
      blocklist,
      criteria,
      voice,
    });

    for (const a of result.accounts) {
      if (a.sync) {
        console.log(`[${a.email}] sync ${a.sync.mode}: fetched ${a.sync.fetched}, stored ${a.sync.stored}, blocked ${a.sync.blocked}, failed ${a.sync.failed}`);
      } else if (a.syncError) {
        console.error(`[${a.email}] sync failed: ${a.syncError}`);
      }
    }

    console.log(`sorted ${result.sorted}, failed ${result.sortFailed}`);

    for (const a of result.accounts) {
      if (a.labelError) {
        console.error(`[${a.email}] label failed: ${a.labelError}`);
      } else if (a.labeled !== undefined) {
        console.log(`[${a.email}] labeled ${a.labeled}, failed ${a.labelFailed}`);
      }
    }

    if (opts.draft) {
      console.log(`drafted ${result.drafted}, failed ${result.draftFailed}`);
    }

    console.log(`${result.pending} draft(s) waiting. Open the queue: pnpm web`);
  });

program
  .command("export")
  .argument("<file>", "output .jsonl path")
  .description("Dump messages, threads, sorts, drafts, and actions as JSONL.")
  .action(async (file: string) => {
    const { db } = await setup();
    const out = createWriteStream(file);
    const r = await exportJsonl(db, (line) => {
      out.write(line + "\n");
    });
    await new Promise<void>((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
      out.end();
    });
    console.log(`wrote ${r.lines} lines to ${file}`);
  });

program
  .command("models")
  .description("Which model answers for each role, and how to change it.")
  .action(() => {
    const cfg = loadConfig();
    for (const role of MODEL_ROLES) {
      // The backlog sorter is the trickle one until the operator names it,
      // so saying the model twice would hide that nothing was chosen (spec 7a).
      const fellBack = role === "sorter_backlog" && backlogSorterIsTrickle();
      const model = fellBack ? `${formatModelRef(cfg.models[role])} (same as sorter)` : formatModelRef(cfg.models[role]);
      console.log(`${role.padEnd(14)} ${model.padEnd(40)} ${MODEL_ENV_VARS[role]}`);
    }
    console.log("\nSet those in .env to move a role onto another model, e.g. ollama:qwen3:8b.");
  });

const projectsCmd = program.command("projects").description("The projects this inbox's mail is filed under.");

/**
 * Which inbox a projects command is about. Ids are UUIDs, so an operator with
 * one inbox should not have to go and find it; two or more and the choice is
 * theirs to make.
 */
function accountFor(db: ReturnType<typeof openDb>, id: string | undefined): string {
  const accounts = db.select().from(schema.accounts).all();
  if (accounts.length === 0) throw new Error("No inboxes connected. Open the app and add one: pnpm web");
  if (id) {
    if (!accounts.some((a) => a.id === id)) throw new Error(`No inbox with id ${id}.`);
    return id;
  }
  if (accounts.length === 1) return accounts[0]!.id;
  const list = accounts.map((a) => `  ${a.id}  ${a.email}`).join("\n");
  throw new Error(`This install has more than one inbox. Name one with --account:\n${list}`);
}

function printProjects(rows: { name: string; description: string }[]): void {
  for (const p of rows) console.log(`- **${p.name}**: ${p.description}`);
}

projectsCmd
  .command("list")
  .description("Print one inbox's project list, in the operator's order.")
  .option("--account <id>", "which inbox")
  .action(async (opts: { account?: string }) => {
    const { db } = await setup();
    const accountId = accountFor(db, opts.account);
    const rows = listProjects(db, accountId);
    if (rows.length === 0) {
      console.log("No projects yet. Propose some: celeste projects propose");
      return;
    }
    printProjects(rows);
  });

projectsCmd
  .command("propose")
  .description("Ask the drafter's model what projects this inbox's mail is about. Writes nothing without --adopt.")
  .option("--account <id>", "which inbox")
  .option("--limit <n>", "how many messages to read, newest first")
  .option("--adopt", "append the proposals to the list")
  .action(async (opts: { account?: string; limit?: string; adopt?: boolean }) => {
    const { cfg, db } = await setup();
    const accountId = accountFor(db, opts.account);
    const { proposals, usage, latencyMs } = await proposeProjects(db, providerForRole("drafter", cfg, db, { role: "propose", accountId }), {
      accountId,
      ...(opts.limit ? { limit: Number(opts.limit) } : {}),
    });
    if (proposals.length === 0) {
      console.log("Nothing to propose. Either this inbox has no stored mail, or the model named only projects it already has.");
      return;
    }
    printProjects(proposals);
    console.log(`\n${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens, ${latencyMs} ms`);
    if (!opts.adopt) {
      console.log("Nothing was written. Run again with --adopt to append them, or edit them in the app's project editor.");
      return;
    }
    const existing = listProjects(db, accountId);
    saveProjects(db, accountId, [
      ...existing.map((p) => ({ id: p.id, name: p.name, description: p.description })),
      ...proposals,
    ]);
    console.log(`appended ${proposals.length}; this inbox now has ${existing.length + proposals.length} project(s)`);
  });

const rulesCmd = program.command("rules").description("What the backlog model's verdicts taught the trickle model.");

rulesCmd
  .command("distill")
  .description("Rewrite rules.md from every trusted verdict. One call on the drafter's model.")
  .option("--account <id>", "only this inbox")
  .action(async (opts: { account?: string }) => {
    const { cfg, db } = await setup();
    const result = await distillRules(db, cfg, providerForRole("drafter", cfg, db, { role: "rules" }), {
      trickleModel: formatModelRef(cfg.models.sorter),
      ...(opts.account ? { accountId: opts.account } : {}),
    });
    if (!result) {
      console.log("No trusted verdicts to learn from yet. Sort some mail with the backlog model first.");
      return;
    }
    console.log(`wrote ${result.words} words to ${cfg.rulesPath}`);
    console.log(`${result.inputTokens} input tokens, ${result.outputTokens} output tokens`);
  });

rulesCmd
  .command("show")
  .description("Print the rules the trickle model is reading.")
  .action(async () => {
    const cfg = loadConfig();
    const rules = await readRules(cfg);
    console.log(rules ?? "No rules yet. Run: celeste rules distill");
  });

const USAGE_WINDOWS = ["today", "7d", "30d", "all"] as const;

program
  .command("usage")
  .description("What every model call has cost: tokens, models and money.")
  .option("--since <window>", "today, 7d, 30d or all", "7d")
  .action(async (opts: { since: string }) => {
    const window = USAGE_WINDOWS.find((w) => w === opts.since);
    if (!window) throw new Error(`--since takes ${USAGE_WINDOWS.join(", ")}`);
    const { db } = await setup();
    const since = windowStartFor(window);
    // Days are grouped on this machine's clock, which is the operator's.
    const summary = usageSummary(db, {
      ...(since === null ? {} : { since }),
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });
    console.log(renderUsageReport(summary, { window }));
  });

const evalCmd = program.command("eval").description("Compare models on mail that is already sorted.");

evalCmd
  .command("sort")
  .description("Replay sorted inbox mail through two or more models and report where they differ.")
  .requiredOption("--models <refs>", "comma-separated, e.g. anthropic:claude-haiku-4-5,ollama:qwen3:8b")
  .option("--sample <n>", "how many messages to replay", "40")
  .option("--account <id>", "only this inbox")
  .option("--seed <n>", "draw the same sample again")
  .option("--examples", "show every model the nearest trusted verdicts as worked examples")
  .option("--rules", "show every model the distilled rules file")
  .action(async (opts: { models: string; sample: string; account?: string; seed?: string; examples?: boolean; rules?: boolean }) => {
    const { cfg, db } = await setup();
    const models = opts.models
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseModelRef);
    if (models.length === 0) throw new Error("--models needs at least one model ref");

    const { criteria } = await loadPipelineInputs(cfg);
    const run = await runSortEval(db, cfg, {
      models,
      sample: Number(opts.sample),
      criteria,
      ...(opts.account ? { accountId: opts.account } : {}),
      ...(opts.seed ? { seed: Number(opts.seed) } : {}),
      ...(opts.examples ? { examples: true } : {}),
      ...(opts.rules ? { rules: true } : {}),
    });
    console.log(`ran ${models.length} model(s) over ${run.sampled} message(s): ${run.answered} answered, ${run.failed} failed\n`);
    console.log(renderSortEvalReport(sortEvalReport(db, run.runId)));
  });

evalCmd
  .command("report")
  .description("Print a finished eval run. Defaults to the most recent one.")
  .argument("[runId]", "the run to print")
  .action(async (runId: string | undefined) => {
    const { db } = await setup();
    const id = runId ?? listEvalRuns(db, 1)[0]?.id;
    if (!id) throw new Error("No eval runs yet. Run: celeste eval sort --models <a>,<b>");
    console.log(renderSortEvalReport(sortEvalReport(db, id)));
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

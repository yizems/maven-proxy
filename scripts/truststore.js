import { config } from "../src/config/config.js";
import {
  getTrustStoreCommands,
  initTrustStore,
  mergeTrustStores,
} from "../src/cert/truststore-utils.js";

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/truststore.js print");
  console.log("  node scripts/truststore.js init");
  console.log(
    "  node scripts/truststore.js merge --source <path> --target <path> [--source-pass <pwd>] [--target-pass <pwd>] [--source-type <JKS|PKCS12>] [--target-type <JKS|PKCS12>] [--on-conflict <fail|overwrite>] [--dry-run]",
  );
}

function parseCliOptions(args) {
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "dry-run") {
      options[key] = true;
      continue;
    }

    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for option: --${key}`);
    }

    options[key] = value;
    i += 1;
  }

  return options;
}

const action = process.argv[2] || "print";

try {
  if (action === "init") {
    initTrustStore(config);
    process.exit(0);
  }

  if (action === "merge") {
    if (process.argv.slice(3).includes("--help")) {
      printUsage();
      process.exit(0);
    }

    const opts = parseCliOptions(process.argv.slice(3));
    if (!opts.source || !opts.target) {
      throw new Error("merge requires --source and --target");
    }

    const mergeResult = mergeTrustStores({
      sourcePath: opts.source,
      targetPath: opts.target,
      sourcePassword: opts["source-pass"] || config.trustStorePassword,
      targetPassword: opts["target-pass"] || config.trustStorePassword,
      sourceType: (opts["source-type"] || "JKS").toUpperCase(),
      targetType: (opts["target-type"] || "JKS").toUpperCase(),
      onConflict: (opts["on-conflict"] || "fail").toLowerCase(),
      dryRun: Boolean(opts["dry-run"]),
    });

    if (mergeResult?.dryRun) {
      console.log("Dry run passed: merge validation completed, no changes were made.");
    } else {
      console.log("Trust stores merged successfully.");
    }
    process.exit(0);
  }

  if (action !== "print") {
    printUsage();
    throw new Error(`Unknown action: ${action}`);
  }

  const commands = getTrustStoreCommands(config);
  console.log("Trust store commands:");
  console.log(commands.copyCmd);
  console.log(commands.importCmd);
  console.log(commands.listCmd);
} catch (error) {
  console.error(`[truststore] ${error.message}`);
  process.exit(1);
}

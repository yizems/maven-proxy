import { config } from "../src/config/config.js";
import { getTrustStoreCommands, initTrustStore } from "../src/cert/truststore-utils.js";

const action = process.argv[2] || "print";

if (action === "init") {
  initTrustStore(config);
  process.exit(0);
}

const commands = getTrustStoreCommands(config);
console.log("Trust store commands:");
console.log(commands.copyCmd);
console.log(commands.importCmd);
console.log(commands.listCmd);

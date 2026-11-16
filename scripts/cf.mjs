// Runs wrangler, using the Worker name from WORKER_NAME in your .env file if
// you set one. This keeps a personal name (like "alex-and-sam") out of git.
//   npm run deploy
//   npm run cf -- secret put ADMIN_PASSWORD
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

let name = process.env.WORKER_NAME || "";
try {
  const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).find((l) => /^\s*WORKER_NAME\s*=/.test(l));
  if (line && !name) name = line.split("=")[1].trim().replace(/^["']|["']$/g, "");
} catch {}

const args = process.argv.slice(2);
const named = ["deploy", "secret", "tail", "versions", "deployments", "rollback", "delete"];
if (name && named.includes(args[0]) && !args.includes("--name")) args.push("--name", name);

const run = spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", shell: true });
process.exit(run.status ?? 1);

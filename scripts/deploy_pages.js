const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  REPO_ROOT,
  REQUIRED_DEPLOY_ENV_VARS,
  getEnvWithDotEnv,
  validateDeployEnv,
} = require("./_deploy_env");

const env = getEnvWithDotEnv();
const publicUrl = env.EWS_PUBLIC_URL || "https://ews.kylemcdonald.net/";
const projectName = env.CLOUDFLARE_PAGES_PROJECT || "apocalypse-ews";

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function getCommitHash() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout.trim();
}

async function restoreCurrentRss() {
  const rssUrl = env.EWS_RSS_URL || new URL("/rss.xml", publicUrl).toString();
  const response = await fetch(rssUrl);
  if (!response.ok) {
    throw new Error(`Unable to restore current RSS feed from ${rssUrl}: ${response.status}`);
  }

  const rssXml = await response.text();
  const rssPath = path.join(REPO_ROOT, "client", "dist", "rss.xml");
  fs.mkdirSync(path.dirname(rssPath), { recursive: true });
  fs.writeFileSync(rssPath, rssXml);
  console.log(`Restored current RSS feed from ${rssUrl}.`);
}

async function main() {
  const errors = validateDeployEnv(env);
  for (const name of REQUIRED_DEPLOY_ENV_VARS) {
    console.log(`${name}=${env[name] ? "set" : "missing"}`);
  }

  if (errors.length) {
    console.error("Refusing to deploy because required deployment environment is incomplete:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  run("npm", ["run", "build"]);
  await restoreCurrentRss();
  run("npm", ["run", "verify:dashboard-urls"]);

  const deployArgs = [
    "pages",
    "deploy",
    "client/dist",
    "--project-name",
    projectName,
    "--branch",
    "main",
  ];
  const commitHash = getCommitHash();
  if (commitHash) {
    deployArgs.push("--commit-hash", commitHash);
  }

  run("wrangler", deployArgs);
  run("npm", ["run", "smoke:live", "--", publicUrl]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

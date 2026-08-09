const fs = require("fs");
const { execSync } = require("child_process");

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const autoConfirm = process.argv.includes("--yes") || process.argv.includes("-y");
const releaseBranch = "main";

function run(command) {
  console.log(`\n> ${command}\n`);
  execSync(command, { stdio: "inherit" });
}

function git(command) {
  return execSync(command, { encoding: "utf8" }).trim();
}

function getNextVersion(current) {
  const [major, minor, patch] = current.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function ensureCleanWorkingTree() {
  const status = git("git status --porcelain");
  if (status) {
    throw new Error(
      "Working tree is not clean. Commit or stash your changes before releasing."
    );
  }
}

function ensureOnReleaseBranch() {
  const branch = git("git rev-parse --abbrev-ref HEAD");
  if (branch !== releaseBranch) {
    throw new Error(
      `Releases must be from '${releaseBranch}', current branch is '${branch}'.`
    );
  }
}

function ensureUpToDateWithRemote() {
  run("git fetch origin");

  let remoteRef;
  try {
    remoteRef = git("git rev-parse @{u}");
  } catch {
    throw new Error(
      "No upstream configured. Set upstream and try again."
    );
  }

  const localRef = git("git rev-parse HEAD");
  if (localRef !== remoteRef) {
    const aheadBehind = git("git rev-list --left-right --count HEAD...@{u}");
    const [ahead, behind] = aheadBehind.split("\t").map(Number);

    if (behind > 0) {
      throw new Error(
        `Local branch is ${behind} commit(s) behind. Pull before releasing.`
      );
    }

    if (ahead > 0) {
      console.log(`Local branch is ${ahead} commit(s) ahead.`);
    }
  }
}

async function prompt(question) {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  try {
    ensureCleanWorkingTree();
    ensureOnReleaseBranch();
    ensureUpToDateWithRemote();

    const currentVersion = pkg.version;
    const nextVersion = getNextVersion(currentVersion);

    console.log(`\nCurrent version: ${currentVersion}`);
    console.log(`Next version:    ${nextVersion}\n`);

    if (!autoConfirm) {
      const response = await prompt(`Release v${nextVersion}? (y/N) `);
      if (response.toLowerCase() !== "y") {
        console.log("Release cancelled.");
        process.exit(0);
      }
    }

    pkg.version = nextVersion;
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");

    run("git add package.json");
    run(`git commit -m "chore: release v${nextVersion}"`);
    run(`git tag v${nextVersion}`);
    run(`git push origin ${releaseBranch}`);
    run(`git push origin v${nextVersion}`);

    console.log(
      `\n✓ Released v${nextVersion}. GitHub Actions will build and publish.`
    );
  } catch (error) {
    console.error(`\n✗ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
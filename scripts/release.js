const fs = require("fs");
const { execSync } = require("child_process");

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const args = process.argv.slice(2);
const autoConfirm = args.includes("--yes") || args.includes("-y");
const releaseBranch = "main";

function run(command) {
  console.log(`\n> ${command}\n`);
  execSync(command, {
    stdio: "inherit",
  });
}

function git(command) {
  return execSync(command, {
    encoding: "utf8",
  }).trim();
}

function getNextVersion(currentVersion) {
  const [major, minor, patch] = currentVersion.split(".").map(Number);
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
      `Releases must be created from '${releaseBranch}', but current branch is '${branch}'.`
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
      "No upstream configured for the current branch. Set the upstream and run again."
    );
  }

  const localRef = git("git rev-parse HEAD");
  if (localRef !== remoteRef) {
    const aheadBehind = git("git rev-list --left-right --count HEAD...@{u}");
    const [ahead, behind] = aheadBehind.split("\t").map(Number);

    if (behind > 0) {
      throw new Error(
        `Local branch is behind origin/${releaseBranch} by ${behind} commit(s). Pull before releasing.`
      );
    }

    if (ahead > 0) {
      console.log(`Local branch is ahead by ${ahead} commit(s).`);
    }
  }
}

const currentVersion = pkg.version;
const nextVersion = getNextVersion(currentVersion);

console.log(`current version: ${currentVersion}`);
console.log(`next version:    ${nextVersion}`);

function finalizeRelease() {
  pkg.version = nextVersion;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");

  run("git add package.json");
  run(`git commit -m "chore: release v${nextVersion}"`);
  run(`git tag v${nextVersion}`);
  run(`git push origin ${releaseBranch}`);
  run(`git push origin v${nextVersion}`);

  console.log(`\nRelease v${nextVersion} created and pushed. GitHub Actions should now build and publish the release.`);
}

try {
  ensureCleanWorkingTree();
  ensureOnReleaseBranch();
  ensureUpToDateWithRemote();

  const confirm = autoConfirm
    ? Promise.resolve("y")
    : new Promise((resolve) => {
        const rl = require("readline").createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(`\nRelease beatsync v${nextVersion}? (y/N) `, (answer) => {
          rl.close();
          resolve(answer);
        });
      });

  confirm.then((response) => {
    if (response.toLowerCase() !== "y") {
      console.log("Release cancelled.");
      process.exit(0);
    }

    finalizeRelease();
  });
} catch (error) {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
}

const { execSync } = require("child_process");
const path = require("path");

function run(command) {
  console.log(`> ${command}\n`);
  execSync(command, { stdio: "inherit" });
}

const apps = {
  x64: path.join("dist", "mac", "beatsync.app"),
  arm64: path.join("dist", "mac-arm64", "beatsync.app"),
};

run("electron-builder --mac dir --arm64 --x64 --publish never");

for (const arch of ["x64", "arm64"]) {
  run(`codesign --force --deep --sign - "${apps[arch]}"`);
}

run(`electron-builder --mac dmg --x64 --prepackaged "${apps.x64}"`);
run(`electron-builder --mac dmg --arm64 --prepackaged "${apps.arm64}"`);

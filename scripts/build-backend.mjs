import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const backendDir = path.join(process.cwd(), "backend");
const candidates =
  process.platform === "win32"
    ? [
        path.join(backendDir, ".venv", "Scripts", "pyinstaller.exe"),
        path.join(backendDir, ".venv", "Scripts", "pyinstaller"),
      ]
    : [path.join(backendDir, ".venv", "bin", "pyinstaller")];

const pyinstallerPath = candidates.find((candidate) => existsSync(candidate));

if (!pyinstallerPath) {
  console.error(
    `PyInstaller not found in backend virtualenv. Checked: ${candidates.join(", ")}`
  );
  process.exit(1);
}

const result = spawnSync(
  pyinstallerPath,
  ["backend.spec", "--noconfirm", "--clean"],
  {
    cwd: backendDir,
    stdio: "inherit",
  }
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);

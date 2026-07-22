import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PICKER_TIMEOUT_MS = 10 * 60 * 1_000;
const WINDOWS_INITIAL_PATH_ENV = "GRAPHWARD_PICKER_INITIAL_PATH";
const WINDOWS_PICKER = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder to index with Graphward'
$dialog.ShowNewFolderButton = $false
$initialPath = [Environment]::GetEnvironmentVariable('GRAPHWARD_PICKER_INITIAL_PATH', 'Process')
if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) {
  $dialog.SelectedPath = $initialPath
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

async function run(executable, args, options = {}) {
  return execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: PICKER_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 16_384,
    ...options,
  });
}

function selectedPath(result) {
  const value = String(result?.stdout ?? "").trim();
  return value || null;
}

function wasCancelled(error) {
  return Number(error?.code) === 1
    || Number(error?.code) === -128
    || /cancel(?:led|ed)|user canceled/i.test(String(error?.stderr ?? error?.message ?? ""));
}

export function windowsPickerInvocation(initialPath, {
  systemRoot = process.env.SystemRoot || "C:\\Windows",
  environment = process.env,
} = {}) {
  const pickerEnvironment = { ...environment };
  if (initialPath) {
    pickerEnvironment[WINDOWS_INITIAL_PATH_ENV] = path.resolve(initialPath);
  } else {
    delete pickerEnvironment[WINDOWS_INITIAL_PATH_ENV];
  }

  return {
    executable: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_PICKER],
    options: { env: pickerEnvironment },
  };
}

async function chooseOnWindows(initialPath) {
  const { executable, args, options } = windowsPickerInvocation(initialPath);
  return selectedPath(await run(executable, args, options));
}

async function chooseOnMac() {
  try {
    return selectedPath(await run("osascript", [
      "-e",
      "POSIX path of (choose folder with prompt \"Choose a folder to index with Graphward\")",
    ]));
  } catch (error) {
    if (wasCancelled(error)) return null;
    throw error;
  }
}

async function chooseOnLinux(initialPath) {
  const attempts = [
    ["zenity", ["--file-selection", "--directory", "--title=Choose a folder to index with Graphward", ...(initialPath ? [`--filename=${path.resolve(initialPath)}${path.sep}`] : [])]],
    ["kdialog", ["--getexistingdirectory", initialPath ? path.resolve(initialPath) : process.cwd(), "--title", "Choose a folder to index with Graphward"]],
  ];
  let unavailable = null;
  for (const [executable, args] of attempts) {
    try {
      return selectedPath(await run(executable, args));
    } catch (error) {
      if (wasCancelled(error)) return null;
      if (error?.code === "ENOENT") {
        unavailable = error;
        continue;
      }
      throw error;
    }
  }
  const error = new Error("No supported native folder picker is installed (tried zenity and kdialog)");
  error.cause = unavailable;
  throw error;
}

export async function chooseDirectory({ initialPath = null } = {}) {
  if (process.platform === "win32") return chooseOnWindows(initialPath);
  if (process.platform === "darwin") return chooseOnMac();
  return chooseOnLinux(initialPath);
}

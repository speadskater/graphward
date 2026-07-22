import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { windowsPickerInvocation } from "../src/folder-picker.mjs";

test("Windows folder picker passes the initial folder outside the PowerShell command", () => {
  const initialPath = "C:\\Users\\Example Person\\Bob's Project";
  const invocation = windowsPickerInvocation(initialPath, {
    systemRoot: "C:\\Windows",
    environment: { PATH: "example" },
  });

  assert.equal(invocation.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(invocation.args.includes(initialPath), false);
  assert.match(invocation.args.at(-1), /GRAPHWARD_PICKER_INITIAL_PATH/);
  assert.equal(invocation.options.env.GRAPHWARD_PICKER_INITIAL_PATH, path.win32.resolve(initialPath));
  assert.equal(invocation.options.env.PATH, "example");
});

test("Windows folder picker clears a stale initial-folder environment value", () => {
  const invocation = windowsPickerInvocation(null, {
    environment: {
      GRAPHWARD_PICKER_INITIAL_PATH: "C:\\stale",
    },
  });

  assert.equal("GRAPHWARD_PICKER_INITIAL_PATH" in invocation.options.env, false);
});

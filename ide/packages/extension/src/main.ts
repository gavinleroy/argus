import { CallArgus } from "@argus/common";
import vscode from "vscode";

import { showErrorDialog } from "./errors";
import { log } from "./logging";
import { setup } from "./setup";
import { launchArgus, onChange as webviewOnChange } from "./view";

export let globals: {
  backend: CallArgus;
  diagnosticCollection: vscode.DiagnosticCollection;
};

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {
  log("Activating Argus ...");

  // TODO: this needs to be a little more robust.
  try {
    globals = {
      backend: () => {
        throw Error("Unreachable");
      },
      diagnosticCollection:
        vscode.languages.createDiagnosticCollection("argus"),
    };

    context.subscriptions.push(globals.diagnosticCollection);

    let b = await setup(context);

    if (b == null) {
      showErrorDialog("Failed to setup Argus");
      return;
    }

    // Compile the workspace with the Argus version of rustc.
    await b(["preload"], true);

    globals.backend = b;

    // Note, list must match commands listed in package.json.
    let commands: [string, () => Promise<void>][] = [
      ["launchArgus", async () => launchArgus(context.extensionUri)],
    ];

    commands.forEach(([name, func]) => {
      let disposable = vscode.commands.registerCommand(`argus.${name}`, func);
      context.subscriptions.push(disposable);
    });
  } catch (e: any) {
    showErrorDialog(e);
  }
}

export function onChange() {
  webviewOnChange();
}

// This method is called when your extension is deactivated
export function deactivate() {
  // TODO cleanup resources
}

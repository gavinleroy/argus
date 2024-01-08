import {
  ExtensionToWebViewMsg,
  Filename,
  WebViewToExtensionMsg,
} from "@argus/common";
// FIXME: some build thingy is wrong. The 'dist/' should not be necessary?
// Elsewhere I can just use '@argus/common/types', but TS can't find the type decls.
import {
  CharRange,
  Obligation,
  ObligationOutput,
  SerializedTree,
  TraitError,
  TreeOutput,
} from "@argus/common/dist/types";
import { MessageHandlerData } from "@estruyf/vscode";
import _ from "lodash";
import vscode from "vscode";

import { rangeHighlight, traitErrorDecorate } from "./decorate";
import { showErrorDialog } from "./errors";
import { log } from "./logging";
import { globals } from "./main";
import { RustEditor, isRustEditor, rustRangeToVscodeRange } from "./utils";

const outDir = "dist";
const packageName = "panoptes";

// ------------------------------------
// Endpoints for the extension to call.

export const launchArgus = async (extensionPath: vscode.Uri) => {
  ViewLoader.createOrShow(extensionPath);
};

export const onChange = () => {
  // TODO: invalidate the webview information
};

// ----------------------
// Internal functionality

function rootUri(extensionUri: vscode.Uri) {
  return vscode.Uri.joinPath(extensionUri, "..");
}

// Wraps around the MessageHandler data types from @estruyf/vscode.
type BlessedMessage = {
  command: string;
  requestId: string;
  payload: WebViewToExtensionMsg;
};

// Class wrapping the state around the webview panel.

class ViewLoader {
  public static currentPanel: ViewLoader | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionPath: vscode.Uri;

  private disposables: vscode.Disposable[] = [];
  private highlightRanges: CharRange[] = [];

  public static createOrShow(extensionPath: vscode.Uri) {
    if (ViewLoader.currentPanel) {
      ViewLoader.currentPanel.panel.reveal();
    } else {
      ViewLoader.currentPanel = new ViewLoader(
        extensionPath,
        vscode.ViewColumn.Beside
      );
    }
  }

  private constructor(extensionPath: vscode.Uri, column: vscode.ViewColumn) {
    this.extensionPath = extensionPath;
    const root = rootUri(this.extensionPath);

    this.panel = vscode.window.createWebviewPanel("argus", "Argus", column, {
      enableScripts: true,
      localResourceRoots: [root],
    });

    // Set the webview's initial html content
    this.panel.webview.html = this.getHtmlForWebview();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programatically
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      async message => await this.handleMessage(message),
      null,
      this.disposables
    );
  }

  public dispose() {
    ViewLoader.currentPanel = undefined;
    // Clean up our resources
    this.panel.dispose();
    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  // ---------------------------------------------------

  private async handleMessage(message: BlessedMessage) {
    const { command, requestId, payload } = message;

    if (command !== payload.command) {
      log(
        `
        Command mismatch 
          expected: ${payload.command} 
          but got: ${command}
        `
      );
      return;
    }

    switch (payload.command) {
      case "obligations": {
        this.getObligations(requestId, payload.file);
        return;
      }
      case "tree": {
        this.getTree(requestId, payload.file, payload.predicate, payload.range);
        return;
      }

      // These messages don't require a response.

      case "add-highlight": {
        this.addHighlightRange(payload.file, payload.range);
        return;
      }
      case "remove-highlight": {
        this.removeHighlightRange(payload.file, payload.range);
        return;
      }
      default: {
        log(`Message not understood ${message}`);
        return;
      }
    }
  }

  private async getObligations(requestId: string, host: Filename) {
    log("Fetching obligations for file", host);

    const res = await globals.backend<ObligationOutput[]>([
      "obligations",
      host,
    ]);

    log("Result", res);

    if (res.type !== "output") {
      vscode.window.showErrorMessage(res.error);
      return;
    }
    const obligations = res.value;
    log("Returning obligations", obligations);

    // TODO: for each obligations in body set the trait errors.
    const traitErrors = _.flatMap(obligations, oib => oib.traitErrors);
    this.setTraitErrors(host, traitErrors);

    this.messageWebview<ObligationOutput[]>(requestId, {
      type: "FROM_EXTENSION",
      file: host,
      command: "obligations",
      obligations: obligations,
    });
  }

  private async getTree(
    requestId: string,
    host: Filename,
    obl: Obligation,
    range: CharRange
  ) {
    log("Fetching tree for file", host, obl.hash, obl);

    const res = await globals.backend<TreeOutput[]>([
      "tree",
      host,
      obl.hash,
      range.start.line,
      range.start.column,
      range.end.line,
      range.end.column,
    ]);

    if (res.type !== "output") {
      vscode.window.showErrorMessage(res.error);
      return;
    }

    // NOTE: the returned value should be an array of a single tree, however,
    // it is possible that no tree is returned. (Yes, but I'm working on it.)
    const tree = _.filter(res.value, t => t !== undefined) as Array<
      SerializedTree | undefined
    >;
    const tree0 = tree[0];

    this.messageWebview<SerializedTree>(requestId, {
      type: "FROM_EXTENSION",
      file: host,
      command: "tree",
      tree: tree0,
    });
  }

  // ----------------------
  // Decorations

  private setTraitErrors(host: Filename, errors: TraitError[]) {
    const editor = this.getEditorByName(host);
    if (editor === undefined) {
      showErrorDialog(`No editor for file ${host}`);
      return;
    }

    editor.setDecorations(
      traitErrorDecorate,
      _.map(errors, e => {
        return {
          range: rustRangeToVscodeRange(e.range),
          hoverMessage: `This is a trait error!`,
        };
      })
    );
  }

  private async addHighlightRange(host: Filename, range: CharRange) {
    log("Adding highlight range", host, range);

    const editor = this.getEditorByName(host);
    if (editor === undefined) {
      showErrorDialog(`No editor for file ${host}`);
      return;
    }

    this.highlightRanges.push(range);
    await this.refreshHighlights(editor);
  }

  private async removeHighlightRange(host: Filename, range: CharRange) {
    log("Removing highlight range", host, range);

    const editor = this.getEditorByName(host);
    if (editor === undefined) {
      showErrorDialog(`No editor for file ${host}`);
      return;
    }

    this.highlightRanges = _.filter(
      this.highlightRanges,
      r => !_.isEqual(r, range)
    );
    await this.refreshHighlights(editor);
  }

  private async refreshHighlights(editor: vscode.TextEditor) {
    editor.setDecorations(
      rangeHighlight,
      _.map(this.highlightRanges, r => rustRangeToVscodeRange(r))
    );
  }

  // --------------------------------
  // Utilities

  // FIXME: the type T here is wrong, it should be a response message similar to
  // how the webview encodes the return value.
  private messageWebview<T>(requestId: string, msg: ExtensionToWebViewMsg) {
    this.panel.webview.postMessage({
      command: msg.command,
      requestId: requestId,
      payload: msg,
    } as MessageHandlerData<T>);
  }

  private getEditorByName(name: Filename): vscode.TextEditor | undefined {
    return _.find(this.visibleEditors(), e => e.document.fileName === name);
  }

  private visibleEditors(): RustEditor[] {
    let editors = [];
    for (let editor of vscode.window.visibleTextEditors) {
      if (isRustEditor(editor)) {
        editors.push(editor);
      }
    }
    return editors;
  }

  private getHtmlForWebview() {
    const panoptesDir = vscode.Uri.joinPath(
      this.extensionPath,
      "node_modules",
      "@argus",
      "panoptes"
    );

    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(panoptesDir, "dist", "panoptes.iife.js")
    );

    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(panoptesDir, "dist", "style.css")
    );

    const codiconsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(
        panoptesDir,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css"
      )
    );

    let initialFiles: Filename[] = _.map(
      this.visibleEditors(),
      e => e.document.fileName
    );

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Config View</title>
          <link rel="stylesheet" type="text/css" href=${styleUri}>
          <link rel="stylesheet" type="text/css" href=${codiconsUri}>
          <script>window.initialData = ${JSON.stringify(initialFiles)};</script>
      </head>
      <body>
          <div id="root"></div>
          <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}

import { CharRange } from "@argus/common/dist/types";
import vscode from "vscode";

export type RustDocument = vscode.TextDocument & { languageId: "rust" };
export type RustEditor = vscode.TextEditor & { document: RustDocument };

export function isRustDocument(
  document: vscode.TextDocument
): document is RustDocument {
  // Prevent corrupted text (particularly via inlay hints) in diff views
  // by allowing only `file` schemes
  // unfortunately extensions that use diff views not always set this
  // to something different than 'file' (see ongoing bug: #4608)
  return document.languageId === "rust" && document.uri.scheme === "file";
}

export function isRustEditor(editor: vscode.TextEditor): editor is RustEditor {
  return isRustDocument(editor.document);
}

export function rustRangeToVscodeRange(range: CharRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.column),
    new vscode.Position(range.end.line, range.end.column)
  );
}

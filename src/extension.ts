import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";

// --- Data Structures (TreeNode, FileNode, DirectoryNode, ReferenceLeaf) ---
interface ReferenceLeaf {
    type: "leaf";
    uri: string;
    fileName: string;
    fullPath: string;
    line: number;
    character: number;
    previewText: string;
    originalLocation: vscode.Location;
}
interface FileNode {
    type: "file";
    fileName: string;
    fullPath: string;
    references: ReferenceLeaf[];
}
interface DirectoryNode {
    type: "directory";
    dirName: string;
    fullPath: string;
    children: (DirectoryNode | FileNode)[];
}
type TreeNode = DirectoryNode | FileNode;

const CONTEXT_LINES_AROUND = 3; // For scrolling logic, not for hiding lines in Monaco
let referencesViewProvider: ReferencesViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    referencesViewProvider = new ReferencesViewProvider(context.extensionUri);
    // The disposable from registerWebviewViewProvider is added to context.subscriptions
    // This will dispose the provider itself when the extension deactivates.
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ReferencesViewProvider.viewType,
            referencesViewProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "references-with-context.showReferencesInPanel",
            async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor || !referencesViewProvider) {
                    vscode.window.showInformationMessage(
                        "No active editor or view provider not ready."
                    );
                    return;
                }
                const position = editor.selection.active;
                const documentUri = editor.document.uri;
                const codeLanguage = editor.document.languageId;

                await vscode.window.withProgress(
                    {
                        location: { viewId: ReferencesViewProvider.viewType }, // Show progress in our view's container
                        title: "Finding References...",
                        cancellable: false,
                    },
                    async (progress) => {
                        try {
                            progress.report({
                                increment: 0,
                                message: "Executing reference provider...",
                            });
                            const locations: vscode.Location[] | undefined =
                                await vscode.commands.executeCommand<
                                    vscode.Location[]
                                >(
                                    "vscode.executeReferenceProvider",
                                    documentUri,
                                    position
                                );
                            progress.report({
                                increment: 30,
                                message: "Grouping references...",
                            });

                            if (!locations || locations.length === 0) {
                                vscode.window.showInformationMessage(
                                    "No references found."
                                );
                                referencesViewProvider?.updateViewData(
                                    [],
                                    codeLanguage,
                                    true
                                ); // true to clear monaco
                                return;
                            }
                            const groupedReferences =
                                await groupReferencesByDirectoryAndFile(
                                    locations
                                );
                            progress.report({
                                increment: 70,
                                message: "Updating view...",
                            });
                            referencesViewProvider?.updateViewData(
                                groupedReferences,
                                codeLanguage,
                                true
                            ); // Initially clear/set Monaco with first ref

                            if (groupedReferences.length > 0) {
                                // Attempt to reveal/focus the view container.
                                // VS Code will show the panel if a view inside it becomes active/gets content.
                                await vscode.commands.executeCommand(
                                    `workbench.view.extension.referencesContextViewContainer`
                                );
                            }
                        } catch (error) {
                            console.error(
                                "Error in 'showReferencesInPanel':",
                                error
                            );
                            vscode.window.showErrorMessage(
                                "Failed to process references."
                            );
                            referencesViewProvider?.updateViewData(
                                [],
                                codeLanguage,
                                true
                            );
                        }
                    }
                );
            }
        )
    );
}

class ReferencesViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "referencesContextView.mainView"; // Matches package.json
    private _view?: vscode.WebviewView;
    private _currentReferences: TreeNode[] = [];
    private _currentLanguage: string = "plaintext";
    private _currentMonacoContent: string =
        "// Select a reference on the left to see its context here.\n// Double-click a reference to navigate in the main editor.";
    private _currentMonacoRevealLine: number = 1;
    private _currentMonacoTheme: string = "vs"; // Default, will be updated
    private _themeChangeListener?: vscode.Disposable;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, "media"),
                vscode.Uri.joinPath(this._extensionUri, "media", "monaco-vs"), // For Monaco editor files
            ],
        };

        // Set initial HTML content. Data will be sent via postMessage.
        this._updateHtmlForView();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "getContextMonaco":
                    const refUri = vscode.Uri.parse(message.payload.uri);
                    const refLine0Indexed = message.payload.line;
                    const fileLanguage =
                        message.payload.language || this._currentLanguage; // Use language from clicked item
                    this._currentMonacoTheme =
                        vscode.window.activeColorTheme.kind ===
                        vscode.ColorThemeKind.Dark
                            ? "vs-dark"
                            : "vs";
                    try {
                        const fullFileContent = await getFullFileContent(
                            refUri
                        );
                        this._currentMonacoContent = fullFileContent;
                        this._currentMonacoRevealLine = refLine0Indexed + 1; // Monaco is 1-indexed

                        this._view?.webview.postMessage({
                            command: "updateMonacoContent",
                            payload: {
                                content: this._currentMonacoContent,
                                language: fileLanguage,
                                revealLine: this._currentMonacoRevealLine,
                                theme: this._currentMonacoTheme,
                            },
                        });
                    } catch (e) {
                        this._currentMonacoContent = `// Error loading content for ${path.basename(
                            refUri.fsPath
                        )}\n// ${e instanceof Error ? e.message : String(e)}`;
                        this._currentMonacoRevealLine = 1;
                        this._view?.webview.postMessage({
                            command: "updateMonacoContent",
                            payload: {
                                content: this._currentMonacoContent,
                                language: "plaintext", // Fallback language
                                revealLine: this._currentMonacoRevealLine,
                                theme: this._currentMonacoTheme,
                            },
                        });
                    }
                    return;
                case "explicitNavigateTo":
                    const navUri = vscode.Uri.parse(message.payload.uri);
                    const navRange = new vscode.Range(
                        new vscode.Position(
                            message.payload.line,
                            message.payload.character
                        ),
                        new vscode.Position(
                            message.payload.line,
                            message.payload.character
                        )
                    );
                    try {
                        const doc = await vscode.workspace.openTextDocument(
                            navUri
                        );
                        await vscode.window.showTextDocument(doc, {
                            selection: navRange,
                            viewColumn: vscode.ViewColumn.Active, // Show in the currently active editor group
                            preserveFocus: false, // Allow focus to move to the editor
                        });
                    } catch (e) {
                        vscode.window.showErrorMessage(
                            `Could not open file: ${navUri.fsPath}`
                        );
                    }
                    return;
                case "webviewReady":
                    // Webview is ready, send current data if any
                    this.sendCurrentDataToWebview();
                    return;
            }
        });

        // Dispose previous theme listener if this view is being re-resolved
        if (this._themeChangeListener) {
            this._themeChangeListener.dispose();
        }
        // Listen for theme changes
        this._themeChangeListener = vscode.window.onDidChangeActiveColorTheme(
            (theme) => {
                if (this._view && this._view.visible) {
                    // Only update if our view is current and visible
                    const newTheme =
                        theme.kind === vscode.ColorThemeKind.Dark
                            ? "vs-dark"
                            : "vs";
                    // Only post if the Monaco theme needs to change
                    if (this._currentMonacoTheme !== newTheme) {
                        this._currentMonacoTheme = newTheme;
                        this._view.webview.postMessage({
                            command: "updateMonacoTheme",
                            payload: { theme: this._currentMonacoTheme },
                        });
                    }
                }
            }
        );

        webviewView.onDidDispose(() => {
            // When this specific webviewView is disposed, clean up its theme listener
            if (this._themeChangeListener) {
                this._themeChangeListener.dispose();
                this._themeChangeListener = undefined;
            }
            // If this was the current view, clear the reference
            if (this._view === webviewView) {
                this._view = undefined;
            }
        });

        // Set initial theme
        this._currentMonacoTheme =
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
                ? "vs-dark"
                : "vs";
    }

    public updateViewData(
        references: TreeNode[],
        language: string,
        shouldUpdateMonacoWithFirstRef: boolean = false
    ) {
        this._currentReferences = references;
        this._currentLanguage = language; // Language of the file where "find references" was triggered

        if (shouldUpdateMonacoWithFirstRef) {
            if (references.length > 0) {
                // Find the first actual reference leaf to pre-load its context
                let firstLeaf: ReferenceLeaf | undefined;
                for (const node of references) {
                    if (node.type === "file" && node.references.length > 0) {
                        firstLeaf = node.references[0];
                        break;
                    } else if (node.type === "directory") {
                        for (const child of node.children) {
                            if (
                                child.type === "file" &&
                                child.references.length > 0
                            ) {
                                firstLeaf = child.references[0];
                                break;
                            }
                        }
                    }
                    if (firstLeaf) break;
                }

                if (firstLeaf) {
                    // Asynchronously load its content for Monaco
                    // The actual posting will happen after 'webviewReady' or if already ready
                    getFullFileContent(vscode.Uri.parse(firstLeaf.uri))
                        .then((content) => {
                            this._currentMonacoContent = content;
                            this._currentMonacoRevealLine = firstLeaf!.line + 1;
                            this._currentLanguage =
                                firstLeaf!.originalLocation.uri.fsPath
                                    .split(".")
                                    .pop() || this._currentLanguage; // Language of the specific reference file
                            this.sendCurrentDataToWebview(); // This will now include the preloaded Monaco content
                        })
                        .catch((e) => {
                            this._currentMonacoContent = `// Error pre-loading: ${e}`;
                            this._currentMonacoRevealLine = 1;
                            this.sendCurrentDataToWebview();
                        });
                } else {
                    this._currentMonacoContent =
                        "// No specific reference to show context for.";
                    this._currentMonacoRevealLine = 1;
                }
            } else {
                // No references found
                this._currentMonacoContent = "// No references found.";
                this._currentMonacoRevealLine = 1;
            }
        }
        this.sendCurrentDataToWebview();
    }

    private sendCurrentDataToWebview() {
        if (this._view && this._view.visible) {
            // Only send if view is ready and visible
            this._view.webview.postMessage({
                command: "updateTreeData",
                payload: {
                    references: this._currentReferences,
                    // language: this._currentLanguage // language for tree items, if needed
                },
            });
            this._view.webview.postMessage({
                command: "updateMonacoContent",
                payload: {
                    content: this._currentMonacoContent,
                    language: this._currentLanguage, // Or a more specific language if available for the content
                    revealLine: this._currentMonacoRevealLine,
                    theme: this._currentMonacoTheme,
                },
            });
        }
    }

    private _updateHtmlForView() {
        if (this._view) {
            // If the view is not visible, VS Code might dispose and re-create the webview when it becomes visible.
            // Calling show() might not be necessary here if retainContextWhenHidden is true,
            // but it doesn't hurt to ensure it's active before setting HTML.
            this._view.show(true);
            this._view.webview.html = this._getHtmlForWebview(
                this._view.webview
            );
            // Data will be sent via postMessage, often in response to 'webviewReady' or by updateViewData
        }
    }

        private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));
        const monacoLoaderUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'monaco-vs', 'loader.js'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicon.css'));

        let monacoBasePathForScripts = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'monaco-vs')).toString(true);
        if (monacoBasePathForScripts.endsWith('/')) {
            monacoBasePathForScripts = monacoBasePathForScripts.slice(0, -1);
        }
        monacoBasePathForScripts = monacoBasePathForScripts.replace(/%22/g, '');

        // JavaScript comment explaining the CSP choice:
        // We are using webview.cspSource and 'self' for script-src and worker-src.
        // This is generally recommended. If Monaco's dynamically loaded scripts
        // are not covered, further refinement of CSP might be needed, potentially
        // by constructing a more specific source for the monaco-vs directory if possible,
        // or ensuring all monaco assets are loaded in a way that 'self' covers them.

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy"
                  content="default-src 'none';
                           style-src ${webview.cspSource} 'unsafe-inline';
                           font-src ${webview.cspSource} data:;
                           script-src 'nonce-${nonce}' ${webview.cspSource} 'self' blob:;
                           worker-src ${webview.cspSource} 'self' blob:;">
            <link href="${codiconsUri}" rel="stylesheet" />
            <link href="${styleUri}" rel="stylesheet">
            <title>References Context</title>
        </head>
        <body>
            <div class="container">
                <div class="references-list-section">
                    <h3>References</h3>
                    <div id="reference-tree-container">
                       <p class='initial-message'>Run 'Find References in Panel View' (Ctrl+Shift+Alt+F12) on a symbol.</p>
                       <ul id="reference-tree-list"></ul>
                    </div>
                </div>
                <div class="context-view-section">
                    <h3>Context Preview</h3>
                    <div id="monaco-editor-container"></div>
                </div>
            </div>
            <script nonce="${nonce}">
                window.MONACO_BASE_PATH = "${monacoBasePathForScripts}";
            </script>
            <script nonce="${nonce}" src="${monacoLoaderUri}"></script>
            <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
    }
}

async function getFullFileContent(fileUri: vscode.Uri): Promise<string> {
    try {
        const buffer = await vscode.workspace.fs.readFile(fileUri);
        return new TextDecoder().decode(buffer);
    } catch (e) {
        console.error(`Error reading file content for ${fileUri.fsPath}:`, e);
        const message = e instanceof Error ? e.message : String(e);
        return `// Error loading content for ${path.basename(
            fileUri.fsPath
        )}\n// ${message}`;
    }
}

function getNonce(): string {
    return crypto.randomBytes(16).toString("base64");
}

function escapeHtml(unsafe: string): string {
    if (typeof unsafe !== "string") return "";
    return unsafe
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, '"')
        .replace(/'/g, "'");
}

async function groupReferencesByDirectoryAndFile(
    locations: vscode.Location[]
): Promise<TreeNode[]> {
    // (This should be the robust version of groupReferencesByDirectoryAndFile from previous examples)
    const filesMap: Map<string, FileNode> = new Map();
    for (const loc of locations) {
        const fullPath = loc.uri.fsPath;
        const fileName = path.basename(fullPath);
        let previewText = "";
        try {
            const doc = await vscode.workspace.openTextDocument(loc.uri);
            previewText = doc.lineAt(loc.range.start.line).text.trim();
        } catch (e) {
            previewText = "[Error loading preview]";
        }
        const referenceLeaf: ReferenceLeaf = {
            type: "leaf",
            uri: loc.uri.toString(),
            fileName: fileName,
            fullPath: fullPath,
            line: loc.range.start.line,
            character: loc.range.start.character,
            previewText: previewText,
            originalLocation: loc,
        };
        if (!filesMap.has(fullPath)) {
            filesMap.set(fullPath, {
                type: "file",
                fileName: fileName,
                fullPath: fullPath,
                references: [],
            });
        }
        filesMap.get(fullPath)!.references.push(referenceLeaf);
    }

    const dirData: {
        [dirPathKey: string]: { node: DirectoryNode; files: FileNode[] };
    } = {};
    const rootFiles: FileNode[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    // Normalize paths for comparison
    const workspaceRootPaths = workspaceFolders
        ? workspaceFolders.map((wf) => wf.uri.fsPath.replace(/\\/g, "/"))
        : [];

    for (const fileNode of filesMap.values()) {
        if (fileNode.references.length === 0) continue;
        let dirPath = path.dirname(fileNode.fullPath).replace(/\\/g, "/");
        let dirPathKey = dirPath;

        // Check if the file is directly in a workspace root or if there are no workspace folders (e.g. single file open)
        let isRootFile = workspaceRootPaths.some((root) => dirPath === root);
        if (workspaceRootPaths.length === 0 && !dirPath.includes("/")) {
            // Single file, no real "directory"
            isRootFile = true;
        }
        if (dirPath === ".") {
            // Relative path for files in the current directory if no workspace
            isRootFile = true;
        }

        if (isRootFile) {
            rootFiles.push(fileNode);
        } else {
            if (!dirData[dirPathKey]) {
                dirData[dirPathKey] = {
                    node: {
                        type: "directory",
                        dirName: path.basename(dirPath),
                        fullPath: dirPath,
                        children: [],
                    },
                    files: [],
                };
            }
            dirData[dirPathKey].files.push(fileNode);
        }
    }

    const finalTree: TreeNode[] = [
        ...rootFiles.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    ];
    const sortedDirPaths = Object.keys(dirData).sort((a, b) =>
        a.localeCompare(b)
    );

    for (const dirPathKey of sortedDirPaths) {
        const { node, files } = dirData[dirPathKey];
        files.sort((a, b) => a.fileName.localeCompare(b.fileName));
        node.children = files;
        finalTree.push(node);
    }

    // Final sort: directories first, then files, then alphabetically
    finalTree.sort((a, b) => {
        if (a.type === "directory" && b.type === "file") return -1;
        if (a.type === "file" && b.type === "directory") return 1;
        const nameA = a.type === "directory" ? a.dirName : a.fileName;
        const nameB = b.type === "directory" ? b.dirName : b.fileName;
        return nameA.localeCompare(nameB);
    });

    return finalTree.filter(
        (n) =>
            (n.type === "file" && n.references.length > 0) ||
            (n.type === "directory" && n.children.length > 0)
    );
}

export function deactivate() {
    // The provider's disposables (like theme listener) should be cleaned up
    // when its associated webviewView is disposed.
    // Additional global disposables would be cleaned here if `context.subscriptions` was used for them in `activate`.
}

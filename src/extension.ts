import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";

// --- Data Structures ---
interface ReferenceLeaf {
    type: "leaf";
    uri: string;
    fileName: string; // Kept for context, but might be redundant if parent FileNode always exists
    fullPath: string;
    line: number; // 0-indexed
    character: number; // 0-indexed
    previewText: string;
    enclosingSymbol?: string;
    originalLocation: vscode.Location;
}

interface FunctionGroupNode {
    type: "function";
    functionName: string;
    references: ReferenceLeaf[];
}

interface FileNode {
    type: "file";
    fileName: string;
    fullPath: string;
    children: (FunctionGroupNode | ReferenceLeaf)[]; // Can contain functions or loose references
}

interface DirectoryNode {
    type: "directory";
    dirName: string;
    fullPath: string;
    children: (DirectoryNode | FileNode)[];
}

type TreeNode = DirectoryNode | FileNode; // Top-level can be dirs or files
type FileChildNode = FunctionGroupNode | ReferenceLeaf; // Children of a FileNode

let referencesViewProvider: ReferencesViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    referencesViewProvider = new ReferencesViewProvider(context.extensionUri);
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
                let codeLanguage = editor.document.languageId; // Default language

                await vscode.window.withProgress(
                    {
                        location: { viewId: ReferencesViewProvider.viewType },
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
                                message: "Grouping references and finding symbols...",
                            });

                            if (!locations || locations.length === 0) {
                                vscode.window.showInformationMessage(
                                    "No references found."
                                );
                                referencesViewProvider?.updateViewData(
                                    [],
                                    codeLanguage,
                                    true
                                );
                                return;
                            }
                            // If locations are found, try to use the language of the first reference target
                            // as it might be more accurate for Monaco syntax highlighting if refs are cross-file.
                            if (locations[0]) {
                                try {
                                    const firstRefDoc = await vscode.workspace.openTextDocument(locations[0].uri);
                                    codeLanguage = firstRefDoc.languageId;
                                } catch (e) {
                                    console.warn("Could not determine language from first reference, using active editor's language.", e);
                                }
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
                                codeLanguage, // Use potentially updated language
                                true
                            );

                            if (groupedReferences.length > 0) {
                                await vscode.commands.executeCommand(
                                    `workbench.view.extension.referencesContextViewContainer`
                                );
                                await vscode.commands.executeCommand('workbench.action.focusPanel');
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
    public static readonly viewType = "referencesContextView.mainView";
    private _view?: vscode.WebviewView;
    private _currentReferences: TreeNode[] = [];
    private _currentLanguage: string = "plaintext"; // Language for Monaco editor
    private _currentMonacoContent: string =
        "// Select a reference on the left to see its context here.\n// Double-click a reference to navigate in the main editor.";
    private _currentMonacoRevealLine: number = 1;
    private _currentMonacoFileUri: string = "";
    private _currentMonacoTheme: string = "vs";
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
                vscode.Uri.joinPath(this._extensionUri, "media", "monaco-vs"),
            ],
        };

        this._updateHtmlForView();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "getContextMonaco":
                    const refUriStr = message.payload.uri;
                    const refUri = vscode.Uri.parse(refUriStr);
                    const refLine0Indexed = message.payload.line;
                    // The language for Monaco should ideally be determined from the file itself,
                    // not just the language of the file where "find references" was initiated.
                    let monacoLanguage = this._currentLanguage; // Fallback
                    try {
                        const doc = await vscode.workspace.openTextDocument(refUri);
                        monacoLanguage = doc.languageId;
                    } catch (e) {
                        console.warn(`Could not determine language for ${refUriStr}, falling back to ${this._currentLanguage}`);
                    }
                    
                    this._currentMonacoTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? "vs-dark" : "vs";
                    this._currentMonacoFileUri = refUriStr; 

                    try {
                        const fullFileContent = await getFullFileContent(refUri);
                        this._currentMonacoContent = fullFileContent;
                        this._currentMonacoRevealLine = refLine0Indexed + 1; 

                        this._view?.webview.postMessage({
                            command: "updateMonacoContent",
                            payload: {
                                content: this._currentMonacoContent,
                                language: monacoLanguage, // Use determined language
                                revealLine: this._currentMonacoRevealLine,
                                theme: this._currentMonacoTheme,
                                fileUri: this._currentMonacoFileUri, 
                            },
                        });
                    } catch (e) {
                        this._currentMonacoContent = `// Error loading content for ${path.basename(refUri.fsPath)}\n// ${e instanceof Error ? e.message : String(e)}`;
                        this._currentMonacoRevealLine = 1;
                        this._view?.webview.postMessage({
                            command: "updateMonacoContent",
                            payload: {
                                content: this._currentMonacoContent,
                                language: "plaintext", // Fallback on error
                                revealLine: this._currentMonacoRevealLine,
                                theme: this._currentMonacoTheme,
                                fileUri: this._currentMonacoFileUri, 
                            },
                        });
                    }
                    return;

                case "explicitNavigateTo": 
                    const navUri = vscode.Uri.parse(message.payload.uri);
                    const navRange = new vscode.Range(
                        new vscode.Position(message.payload.line, message.payload.character),
                        new vscode.Position(message.payload.line, message.payload.character)
                    );
                    this.navigateToLocation(navUri, navRange);
                    return;

                case "monacoAction": 
                    const { actionType, uri: monacoFileUriStr, position: monacoPosition } = message.payload;
                    const monacoFileUriFromAction = vscode.Uri.parse(monacoFileUriStr); // Renamed to avoid conflict
                    const vscPosition = new vscode.Position(monacoPosition.lineNumber -1, monacoPosition.column -1); 

                    if (actionType === "goToDefinition") {
                        const definitions: vscode.LocationLink[] | vscode.Location[] | undefined =
                            await vscode.commands.executeCommand<vscode.LocationLink[] | vscode.Location[]>(
                                "vscode.executeDefinitionProvider",
                                monacoFileUriFromAction,
                                vscPosition
                            );
                        if (definitions && definitions.length > 0) {
                            const firstDef = definitions[0]; 
                            
                            let targetUriToNavigate: vscode.Uri;
                            let targetRangeToNavigate: vscode.Range;

                            if ('targetUri' in firstDef) { 
                                targetUriToNavigate = firstDef.targetUri;
                                targetRangeToNavigate = firstDef.targetSelectionRange || firstDef.targetRange;
                            } else { 
                                targetUriToNavigate = firstDef.uri;
                                targetRangeToNavigate = firstDef.range;
                            }
                            this.navigateToLocation(targetUriToNavigate, targetRangeToNavigate);
                        } else {
                            vscode.window.showInformationMessage("No definition found.");
                        }
                    } else if (actionType === "peekDefinition") {
                         vscode.commands.executeCommand(
                            "editor.action.peekDefinition",
                            monacoFileUriFromAction,
                            vscPosition
                        );
                    }
                    return;

                case "webviewReady":
                    this.sendCurrentDataToWebview();
                    return;
            }
        });

        if (this._themeChangeListener) {
            this._themeChangeListener.dispose();
        }
        this._themeChangeListener = vscode.window.onDidChangeActiveColorTheme(
            (theme) => {
                if (this._view && this._view.visible) {
                    const newTheme = theme.kind === vscode.ColorThemeKind.Dark ? "vs-dark" : "vs";
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
            if (this._themeChangeListener) {
                this._themeChangeListener.dispose();
                this._themeChangeListener = undefined;
            }
            if (this._view === webviewView) {
                this._view = undefined;
            }
        });
        this._currentMonacoTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? "vs-dark" : "vs";
    }

    private async navigateToLocation(uri: vscode.Uri, range: vscode.Range) {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                selection: range,
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: false,
            });
        } catch (e) {
            vscode.window.showErrorMessage(`Could not open file: ${uri.fsPath}. ${e}`);
        }
    }

    public updateViewData(
        references: TreeNode[],
        languageForMonaco: string, // Explicitly pass language for Monaco
        shouldUpdateMonacoWithFirstRef: boolean = false
    ) {
        this._currentReferences = references;
        this._currentLanguage = languageForMonaco; // This is the primary language for Monaco context

        if (shouldUpdateMonacoWithFirstRef) {
            let firstLeaf: ReferenceLeaf | undefined;
            
            function findFirstLeafRecursive(nodes: (TreeNode | FileChildNode)[]): ReferenceLeaf | undefined {
                for (const node of nodes) {
                    if (node.type === "leaf") return node;
                    if (node.type === "file") {
                        const leaf = findFirstLeafRecursive(node.children);
                        if (leaf) return leaf;
                    } else if (node.type === "directory") {
                        const leaf = findFirstLeafRecursive(node.children);
                        if (leaf) return leaf;
                    } else if (node.type === "function") {
                        const leaf = findFirstLeafRecursive(node.references);
                        if (leaf) return leaf;
                    }
                }
                return undefined;
            }
            firstLeaf = findFirstLeafRecursive(references);


            if (firstLeaf) {
                this._currentMonacoFileUri = firstLeaf.uri; 
                getFullFileContent(vscode.Uri.parse(firstLeaf.uri))
                    .then(async (content) => {
                        this._currentMonacoContent = content;
                        this._currentMonacoRevealLine = firstLeaf!.line + 1;
                        // Determine specific language of the file being shown in Monaco
                        let specificFileLanguage = this._currentLanguage; // Default to overall language
                        try {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(firstLeaf!.uri));
                            specificFileLanguage = doc.languageId;
                        } catch(e) { /* ignore, use default */ }
                        this._currentLanguage = specificFileLanguage; // Update if more specific found

                        this.sendCurrentDataToWebview();
                    })
                    .catch((e) => {
                        this._currentMonacoContent = `// Error pre-loading: ${e}`;
                        this._currentMonacoRevealLine = 1;
                        this.sendCurrentDataToWebview();
                    });
            } else {
                this._currentMonacoContent = "// No specific reference to show context for.";
                this._currentMonacoRevealLine = 1;
                this._currentMonacoFileUri = "";
                this.sendCurrentDataToWebview(); 
            }
        } else {
             this.sendCurrentDataToWebview(); 
        }
    }

    private sendCurrentDataToWebview() {
        if (this._view && this._view.visible) {
            this._view.webview.postMessage({
                command: "updateTreeData",
                payload: {
                    references: this._currentReferences,
                },
            });
            // Only send monaco update if content is not the default placeholder OR if we intend to clear it
            if (this._currentMonacoContent !== "// Select a reference on the left to see its context here.\n// Double-click a reference to navigate in the main editor." || 
                this._currentReferences.length === 0) {
                 this._view.webview.postMessage({
                    command: "updateMonacoContent",
                    payload: {
                        content: this._currentMonacoContent,
                        language: this._currentLanguage, 
                        revealLine: this._currentMonacoRevealLine,
                        theme: this._currentMonacoTheme,
                        fileUri: this._currentMonacoFileUri, 
                    },
                });
            }
        }
    }

    private _updateHtmlForView() {
        if (this._view) {
            this._view.show(true);
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
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
        return `// Error loading content for ${path.basename(fileUri.fsPath)}\n// ${message}`;
    }
}

function getNonce(): string {
    return crypto.randomBytes(16).toString("base64");
}

function findEnclosingSymbol(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position
): vscode.DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (symbol.range.contains(position)) {
            const childMatch = findEnclosingSymbol(symbol.children, position);
            if (childMatch) {
                return childMatch;
            }
            // We are interested in functions, methods, classes mostly for grouping
            if (
                symbol.kind === vscode.SymbolKind.Function ||
                symbol.kind === vscode.SymbolKind.Method ||
                symbol.kind === vscode.SymbolKind.Class || // Class can be a grouping level too
                symbol.kind === vscode.SymbolKind.Constructor
                // Consider if other kinds like Interface or Namespace make sense for grouping
            ) {
                return symbol;
            }
        }
    }
    return undefined;
}

async function groupReferencesByDirectoryAndFile(
    locations: vscode.Location[]
): Promise<TreeNode[]> {
    // Step 1: Collect all ReferenceLeaf objects with enriched data
    const allReferenceLeaves: ReferenceLeaf[] = [];
    for (const loc of locations) {
        const fullPath = loc.uri.fsPath;
        const fileName = path.basename(fullPath);
        let previewText = "";
        let enclosingSymbolName: string | undefined;

        try {
            const doc = await vscode.workspace.openTextDocument(loc.uri);
            previewText = doc.lineAt(loc.range.start.line).text.trim();

            const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                doc.uri
            );
            if (documentSymbols && documentSymbols.length > 0) {
                const symbol = findEnclosingSymbol(documentSymbols, loc.range.start);
                if (symbol) {
                    enclosingSymbolName = symbol.name;
                }
            }
        } catch (e) {
            console.warn(`Error processing reference in ${fullPath}: ${e}`);
            previewText = "[Error loading preview]";
        }

        allReferenceLeaves.push({
            type: "leaf",
            uri: loc.uri.toString(),
            fileName: fileName, // For leaf itself
            fullPath: fullPath,
            line: loc.range.start.line,
            character: loc.range.start.character,
            previewText: previewText,
            enclosingSymbol: enclosingSymbolName,
            originalLocation: loc,
        });
    }

    // Step 2: Group ReferenceLeaf objects by file path
    const referencesByFile: Map<string, ReferenceLeaf[]> = new Map();
    for (const leaf of allReferenceLeaves) {
        if (!referencesByFile.has(leaf.fullPath)) {
            referencesByFile.set(leaf.fullPath, []);
        }
        referencesByFile.get(leaf.fullPath)!.push(leaf);
    }

    // Step 3: Create FileNode objects, with internal grouping by function
    const fileNodes: FileNode[] = [];
    for (const [fullPath, leaves] of referencesByFile) {
        const fileName = path.basename(fullPath);
        const fileChildren: FileChildNode[] = [];
        const referencesByFunction: Map<string, ReferenceLeaf[]> = new Map();
        const looseReferences: ReferenceLeaf[] = [];

        for (const leaf of leaves) {
            if (leaf.enclosingSymbol) {
                if (!referencesByFunction.has(leaf.enclosingSymbol)) {
                    referencesByFunction.set(leaf.enclosingSymbol, []);
                }
                referencesByFunction.get(leaf.enclosingSymbol)!.push(leaf);
            } else {
                looseReferences.push(leaf);
            }
        }

        // Add function groups, sorted by function name
        const sortedFunctionNames = Array.from(referencesByFunction.keys()).sort((a, b) => a.localeCompare(b));
        for (const funcName of sortedFunctionNames) {
            const funcReferences = referencesByFunction.get(funcName)!;
            // Sort references within a function by line number
            funcReferences.sort((a, b) => a.line - b.line);
            fileChildren.push({
                type: "function",
                functionName: funcName,
                references: funcReferences,
            });
        }
        
        // Add loose references (not in any function), sorted by line number
        looseReferences.sort((a,b) => a.line - b.line);
        fileChildren.push(...looseReferences);

        if (fileChildren.length > 0) {
            fileNodes.push({
                type: "file",
                fileName: fileName,
                fullPath: fullPath,
                children: fileChildren,
            });
        }
    }

    // Step 4: Group FileNode objects by directory (similar to previous logic)
    const dirData: { [dirPathKey: string]: { node: DirectoryNode; files: FileNode[] } } = {};
    const rootFileNodes: FileNode[] = []; // Files directly in workspace root or if no workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRootPaths = workspaceFolders
        ? workspaceFolders.map((wf) => wf.uri.fsPath.replace(/\\/g, "/"))
        : [];

    for (const fileNode of fileNodes) {
        let dirPath = path.dirname(fileNode.fullPath).replace(/\\/g, "/");
        let isRootFile = workspaceRootPaths.some((root) => dirPath === root);

        if (workspaceRootPaths.length === 0) { // No workspace folder open
            // Treat files as root if they are not in a subdirectory relative to where VS Code might be "seeing" them
            // This heuristic might need refinement if dealing with single files opened from deep paths.
             if (!dirPath.includes(path.sep) && dirPath !== '.') isRootFile = true;
             else if (dirPath === '.' || dirPath === path.basename(fileNode.fullPath)) isRootFile = true; // file in "root"
        }


        if (isRootFile) {
            rootFileNodes.push(fileNode);
        } else {
            if (!dirData[dirPath]) {
                dirData[dirPath] = {
                    node: {
                        type: "directory",
                        dirName: path.basename(dirPath),
                        fullPath: dirPath,
                        children: [],
                    },
                    files: [],
                };
            }
            dirData[dirPath].files.push(fileNode);
        }
    }

    const finalTree: TreeNode[] = [
        ...rootFileNodes.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    ];
    const sortedDirPaths = Object.keys(dirData).sort((a, b) => a.localeCompare(b));

    for (const dirPathKey of sortedDirPaths) {
        const { node, files } = dirData[dirPathKey];
        files.sort((a, b) => a.fileName.localeCompare(b.fileName));
        node.children = files; // Directory children are FileNodes
        finalTree.push(node);
    }

    finalTree.sort((a, b) => {
        if (a.type === "directory" && b.type === "file") return -1;
        if (a.type === "file" && b.type === "directory") return 1;
        const nameA = a.type === "directory" ? a.dirName : a.fileName;
        const nameB = b.type === "directory" ? b.dirName : b.fileName;
        return nameA.localeCompare(nameB);
    });

    return finalTree.filter(
        (n) =>
            (n.type === "file" && n.children.length > 0) ||
            (n.type === "directory" && n.children.length > 0)
    );
}

export function deactivate() {}
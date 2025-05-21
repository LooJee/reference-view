// media/main.js
(function () {
    const vscode = acquireVsCodeApi();
    const referenceTreeList = document.getElementById("reference-tree-list");
    const monacoEditorContainer = document.getElementById(
        "monaco-editor-container"
    );
    const initialMessageElement = document.querySelector(".initial-message");
    let monacoEditor;
    let lastClickedLeafTime = 0;
    const DOUBLE_CLICK_THRESHOLD = 300; // ms
    let currentMonacoFileUri = "";
    let currentLineHighlightDecorationIds = [];

    if (typeof require === "function" && typeof require.config === "function") {
        const monacoAmdPath = window.MONACO_BASE_PATH.endsWith("/")
            ? window.MONACO_BASE_PATH.slice(0, -1)
            : window.MONACO_BASE_PATH;
        require.config({ paths: { vs: monacoAmdPath } });

        require(["vs/editor/editor.main"], function () {
            monacoEditor = monaco.editor.create(monacoEditorContainer, {
                value: "// Select a reference to see its context.",
                language: "plaintext",
                theme: "vs",
                readOnly: true,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                wordWrap: "off",
                lineNumbers: "on",
                glyphMargin: true,
                folding: true,
                renderLineHighlight: "none",
                occurrencesHighlight: false,
                selectionHighlight: false,
                matchBrackets: "near",
                fontFamily: "var(--vscode-editor-font-family)",
                fontSize:
                    parseFloat(
                        getComputedStyle(
                            document.documentElement
                        ).getPropertyValue("--vscode-font-size")
                    ) || 13,
                lineHeight:
                    (parseFloat(
                        getComputedStyle(
                            document.documentElement
                        ).getPropertyValue("--vscode-editor-line-height")
                    ) || 1.35) *
                    (parseFloat(
                        getComputedStyle(
                            document.documentElement
                        ).getPropertyValue("--vscode-font-size")
                    ) || 13),
            });

            monacoEditor.addAction({
                id: "vscode-ext-go-to-definition",
                label: "Go to Definition",
                keybindings: [monaco.KeyCode.F12],
                contextMenuGroupId: "navigation",
                contextMenuOrder: 1.5,
                run: function (editor) {
                    const position = editor.getPosition();
                    if (position && currentMonacoFileUri) {
                        vscode.postMessage({
                            command: "monacoAction",
                            payload: {
                                actionType: "goToDefinition",
                                uri: currentMonacoFileUri,
                                position: {
                                    lineNumber: position.lineNumber,
                                    column: position.column,
                                },
                            },
                        });
                    }
                },
            });
            monacoEditor.addAction({
                id: "vscode-ext-peek-definition",
                label: "Peek Definition",
                keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F12],
                contextMenuGroupId: "navigation",
                contextMenuOrder: 1.6,
                run: function (editor) {
                    const position = editor.getPosition();
                    if (position && currentMonacoFileUri) {
                        vscode.postMessage({
                            command: "monacoAction",
                            payload: {
                                actionType: "peekDefinition",
                                uri: currentMonacoFileUri,
                                position: {
                                    lineNumber: position.lineNumber,
                                    column: position.column,
                                },
                            },
                        });
                    }
                },
            });
            vscode.postMessage({ command: "webviewReady" });
        });
    } else {
        monacoEditorContainer.textContent =
            "Error: Monaco Editor loader not found.";
        console.error("Monaco loader (require or require.config) not found.");
    }

    function escapeHtml(unsafe) {
        if (typeof unsafe !== "string") return "";
        return unsafe
            .replace(/&/g, "&")
            .replace(/</g, "<")
            .replace(/>/g, ">")
            .replace(/"/g, '"')
            .replace(/'/g, "'");
    }

    function renderReferenceLeafHTML(ref) {
        const escapedUri = escapeHtml(ref.uri);
        const escapedFullPath = escapeHtml(ref.fullPath);
        let escapedPreviewText = escapeHtml(ref.previewText);
        // Language for this specific leaf, if available from originalLocation
        let fileExtension = "plaintext";
        if (
            ref.originalLocation &&
            ref.originalLocation.uri &&
            ref.originalLocation.uri.fsPath
        ) {
            fileExtension =
                ref.originalLocation.uri.fsPath.split(".").pop() || "plaintext";
        } else if (ref.uri) {
            // Fallback to uri if originalLocation is missing parts
            fileExtension = ref.uri.split(".").pop() || "plaintext";
        }

        // No enclosing symbol prefix here, as it's handled by the function group or directly
        return `<li class="reference-leaf" data-uri="${escapedUri}" data-line="${
            ref.line
        }" data-character="${
            ref.character
        }" data-language="${fileExtension}" title="${escapedFullPath} (Line ${
            ref.line + 1
        })">
                    <span class="line-number">L${ref.line + 1}</span>
                    <span class="preview-text-content">${escapedPreviewText}</span>
                </li>`;
    }

    function renderFileChildNodesHTML(childNodes) {
        let html = "";
        childNodes.forEach((childNode) => {
            if (childNode.type === "function") {
                const escapedFunctionName = escapeHtml(childNode.functionName);
                html += `<li class="tree-node function-group-node collapsible">
                            <span class="node-label">
                                <span class="icon codicon codicon-chevron-right"></span>
                                <span class="fx-icon codicon codicon-symbol-method"></span> <!-- 'fx' or method icon -->
                                ${escapedFunctionName}
                            </span>
                            <ul class="nested-list function-references">
                                ${childNode.references
                                    .map((ref) => renderReferenceLeafHTML(ref))
                                    .join("")}
                            </ul>
                         </li>`;
            } else if (childNode.type === "leaf") {
                // Loose reference directly under file
                html += renderReferenceLeafHTML(childNode);
            }
        });
        return html;
    }

    function renderTreeNodesHTML(nodes) {
        let html = "";
        nodes.forEach((node) => {
            if (node.type === "directory") {
                const escapedDirName = escapeHtml(node.dirName);
                html += `<li class="tree-node directory-node collapsible">
                            <span class="node-label"><span class="icon codicon codicon-chevron-right"></span> ${escapedDirName}</span>
                            <ul class="nested-list">${renderTreeNodesHTML(
                                node.children
                            )}</ul>
                         </li>`;
            } else if (node.type === "file") {
                const escapedFileName = escapeHtml(node.fileName);
                html += `<li class="tree-node file-node collapsible">
                            <span class="node-label"><span class="icon codicon codicon-chevron-right"></span> ${escapedFileName}</span>
                            <ul class="nested-list file-children">
                                ${renderFileChildNodesHTML(node.children)}
                            </ul>
                         </li>`;
            }
        });
        return html;
    }

    function clearAllSelections() {
        const selected = referenceTreeList.querySelector(
            ".reference-leaf.selected"
        );
        if (selected) {
            selected.classList.remove("selected");
        }
    }

    if (referenceTreeList) {
        referenceTreeList.addEventListener("click", (event) => {
            let target = event.target;

            // Handle expand/collapse of tree nodes (directory, file, function group)
            let labelElement = target.closest(".node-label");
            if (labelElement) {
                const parentLi = labelElement.closest(".collapsible");
                if (parentLi) {
                    parentLi.classList.toggle("expanded");
                    const icon = labelElement.querySelector(
                        ".icon.codicon-chevron-right, .icon.codicon-chevron-down"
                    );
                    if (icon) {
                        icon.classList.toggle(
                            "codicon-chevron-down",
                            parentLi.classList.contains("expanded")
                        );
                        icon.classList.toggle(
                            "codicon-chevron-right",
                            !parentLi.classList.contains("expanded")
                        );
                    }
                }
                // If the click was on a label, don't process as leaf click.
                // Check if the click was specifically on a reference leaf if labelElement is also part of a leaf.
                if (!target.closest(".reference-leaf")) {
                    return;
                }
            }

            // Handle reference leaf click
            let leafElement = target.closest(".reference-leaf");
            if (leafElement) {
                const currentTime = new Date().getTime();
                clearAllSelections();
                leafElement.classList.add("selected");

                const uri = leafElement.dataset.uri;
                const line = parseInt(leafElement.dataset.line);
                const lang = leafElement.dataset.language;

                vscode.postMessage({
                    command: "getContextMonaco",
                    payload: { uri, line, language: lang },
                });

                const isDoubleClick =
                    currentTime - lastClickedLeafTime <
                        DOUBLE_CLICK_THRESHOLD &&
                    leafElement.dataset.lastClickTarget === "true";
                if (isDoubleClick) {
                    const character = parseInt(leafElement.dataset.character);
                    vscode.postMessage({
                        command: "explicitNavigateTo",
                        payload: { uri, line, character },
                    });
                }
                lastClickedLeafTime = currentTime;
                const allLeaves =
                    referenceTreeList.querySelectorAll(".reference-leaf");
                allLeaves.forEach(
                    (el) => (el.dataset.lastClickTarget = "false")
                );
                leafElement.dataset.lastClickTarget = "true";
            }
        });
    }

    window.addEventListener("message", (event) => {
        const message = event.data;
        switch (message.command) {
            case "updateTreeData":
                if (referenceTreeList) {
                    referenceTreeList.innerHTML = renderTreeNodesHTML(
                        message.payload.references
                    );
                    // Auto-expand first level (directories and files) and function groups
                    referenceTreeList
                        .querySelectorAll(
                            ".directory-node, .file-node, .function-group-node"
                        )
                        .forEach((node) => {
                            // Check if it's a direct child of the main list or a function group
                            if (
                                node.parentElement === referenceTreeList ||
                                (node.parentElement.classList.contains(
                                    "file-children"
                                ) &&
                                    node.classList.contains(
                                        "function-group-node"
                                    )) ||
                                (node.parentElement.classList.contains(
                                    "nested-list"
                                ) &&
                                    node.classList.contains("file-node") &&
                                    node.parentElement.parentElement
                                        .parentElement === referenceTreeList) // Expand files under root dirs
                            ) {
                                node.classList.add("expanded");
                                const icon = node.querySelector(
                                    ".node-label > .icon.codicon-chevron-right"
                                );
                                if (icon) {
                                    // Ensure icon exists
                                    icon.classList.remove(
                                        "codicon-chevron-right"
                                    );
                                    icon.classList.add("codicon-chevron-down");
                                }
                            }
                        });
                }
                if (initialMessageElement) {
                    initialMessageElement.style.display =
                        message.payload.references.length === 0
                            ? "block"
                            : "none";
                }
                if (message.payload.references.length > 0) {
                    const firstLeaf =
                        referenceTreeList.querySelector(".reference-leaf");
                    if (firstLeaf) {
                        setTimeout(() => {
                            // Simulate click to load context, ensures leafElement is valid for the click handler
                            let clickTarget =
                                firstLeaf.querySelector(
                                    ".preview-text-content"
                                ) ||
                                firstLeaf.querySelector(".line-number") ||
                                firstLeaf;
                            const clickEvent = new MouseEvent("click", {
                                bubbles: true,
                                cancelable: true,
                            });
                            clickTarget.dispatchEvent(clickEvent);

                            firstLeaf.scrollIntoView({
                                behavior: "auto",
                                block: "nearest",
                            });
                        }, 100); // Increased delay slightly for complex DOM updates
                    }
                } else if (monacoEditor) {
                    monacoEditor.setValue(
                        "// No references found or selected."
                    );
                    if (monacoEditor.getModel()) {
                        monaco.editor.setModelLanguage(
                            monacoEditor.getModel(),
                            "plaintext"
                        );
                    }
                    currentMonacoFileUri = "";
                    currentLineHighlightDecorationIds =
                        monacoEditor.deltaDecorations(
                            currentLineHighlightDecorationIds,
                            []
                        );
                }
                break;

            case "updateMonacoContent":
                if (monacoEditor) {
                    const { content, language, revealLine, theme, fileUri } =
                        message.payload;
                    currentMonacoFileUri = fileUri;

                    monaco.editor.setTheme(theme);
                    let model = monacoEditor.getModel();
                    if (
                        model &&
                        model.getLanguageId() === language &&
                        !model.isDisposed() &&
                        model.uri.toString() === fileUri
                    ) {
                        // Only set value if content is different or model is the same but needs update
                        if (model.getValue() !== content) {
                            model.setValue(content);
                        }
                    } else {
                        if (model && !model.isDisposed()) model.dispose();
                        model = monaco.editor.createModel(
                            content,
                            language,
                            monaco.Uri.parse(
                                fileUri ||
                                    `inmemory://model/${Date.now()}.${language}`
                            )
                        );
                        monacoEditor.setModel(model);
                    }

                    monacoEditor.revealLineInCenterIfOutsideViewport(
                        revealLine,
                        monaco.editor.ScrollType.Smooth
                    );
                    monacoEditor.setPosition({
                        lineNumber: revealLine,
                        column: 1,
                    });

                    currentLineHighlightDecorationIds =
                        monacoEditor.deltaDecorations(
                            currentLineHighlightDecorationIds,
                            [
                                {
                                    range: new monaco.Range(
                                        revealLine,
                                        1,
                                        revealLine,
                                        model.getLineMaxColumn(revealLine)
                                    ),
                                    options: {
                                        isWholeLine: true,
                                        className:
                                            "current-reference-line-highlight",
                                    },
                                },
                            ]
                        );
                }
                break;

            case "updateMonacoTheme":
                if (monacoEditor && message.payload.theme) {
                    monaco.editor.setTheme(message.payload.theme);
                }
                break;
        }
    });
})();

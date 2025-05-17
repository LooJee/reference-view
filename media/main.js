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
    const DOUBLE_CLICK_THRESHOLD = 300;

    // --- Monaco Editor Setup ---
    if (typeof require === "function" && typeof require.config === "function") {
        const monacoAmdPath = window.MONACO_BASE_PATH.endsWith("/")
            ? window.MONACO_BASE_PATH.slice(0, -1)
            : window.MONACO_BASE_PATH;
        require.config({ paths: { vs: window.MONACO_BASE_PATH } });

        require(["vs/editor/editor.main"], function () {
            monacoEditor = monaco.editor.create(monacoEditorContainer, {
                value: "// Select a reference to see its context.",
                language: "plaintext",
                theme: "vs", // Will be updated by messages
                readOnly: true,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                wordWrap: "off",
                lineNumbers: "on",
                glyphMargin: true, // For potential future breakpoint/error markers
                folding: true,
                renderLineHighlight: "gutter", // Highlights current line in gutter
                occurrencesHighlight: false,
                selectionHighlight: false,
                matchBrackets: "near",
                fontFamily: "var(--vscode-editor-font-family)", // Attempt to use CSS var
                fontSize:
                    parseFloat(
                        getComputedStyle(
                            document.documentElement
                        ).getPropertyValue("--vscode-font-size")
                    ) || 13,
                lineHeight:
                    parseFloat(
                        getComputedStyle(
                            document.documentElement
                        ).getPropertyValue("--vscode-editor-line-height")
                    ) *
                        (parseFloat(
                            getComputedStyle(
                                document.documentElement
                            ).getPropertyValue("--vscode-font-size")
                        ) || 13) || 19,
            });
            vscode.postMessage({ command: "webviewReady" });
        });
    } else {
        monacoEditorContainer.textContent =
            "Error: Monaco Editor loader not found.";
        console.error("Monaco loader (require or require.config) not found.");
    }

    function escapeHtml(unsafe) {
        // Simple escape for HTML in JS
        if (typeof unsafe !== "string") return "";
        return unsafe
            .replace(/&/g, "&")
            .replace(/</g, "<")
            .replace(/>/g, ">")
            .replace(/"/g, '"')
            .replace(/'/g, "'");
    }

    function renderTreeNodesHTML(nodes) {
        let html = "";
        nodes.forEach((node) => {
            const escapedDirName = escapeHtml(node.dirName);
            const escapedFileName = escapeHtml(node.fileName);

            if (node.type === "directory") {
                html += `<li class="tree-node directory-node collapsible">
                            <span class="node-label"><span class="icon codicon codicon-chevron-right"></span> ${escapedDirName}</span>
                            <ul class="nested-list">${renderTreeNodesHTML(
                                node.children
                            )}</ul>
                         </li>`;
            } else if (node.type === "file") {
                html += `<li class="tree-node file-node collapsible">
                            <span class="node-label"><span class="icon codicon codicon-chevron-right"></span> ${escapedFileName}</span>
                            <ul class="nested-list">
                                ${node.references
                                    .map((ref) => {
                                        const escapedUri = escapeHtml(ref.uri);
                                        const escapedFullPath = escapeHtml(
                                            ref.fullPath
                                        );
                                        const escapedPreviewText = escapeHtml(
                                            ref.previewText
                                        );
                                        const fileExtension =
                                            ref.originalLocation.uri.fsPath
                                                .split(".")
                                                .pop() || "plaintext";
                                        return `<li class="reference-leaf" data-uri="${escapedUri}" data-line="${
                                            ref.line
                                        }" data-character="${
                                            ref.character
                                        }" data-language="${fileExtension}" title="${escapedFullPath} (Line ${
                                            ref.line + 1
                                        })">
                                                <span class="line-number">L${
                                                    ref.line + 1
                                                }</span>
                                                <span class="preview-text-content">${escapedPreviewText}</span>
                                            </li>`;
                                    })
                                    .join("")}
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
            if (
                target.matches(".node-label") ||
                target.parentElement?.matches(".node-label")
            ) {
                const labelElement = target.matches(".node-label")
                    ? target
                    : target.parentElement;
                const parentLi = labelElement.closest(".collapsible");
                if (parentLi) {
                    parentLi.classList.toggle("expanded");
                    const icon = labelElement.querySelector(".icon.codicon");
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
                return;
            }
            let leafElement = target;
            while (
                leafElement &&
                !leafElement.classList.contains("reference-leaf")
            ) {
                leafElement = leafElement.parentElement;
            }
            if (
                leafElement &&
                leafElement.classList.contains("reference-leaf")
            ) {
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
                }
                if (initialMessageElement) {
                    initialMessageElement.style.display =
                        message.payload.references.length === 0
                            ? "block"
                            : "none";
                }
                // Auto-select and load first reference if available
                if (message.payload.references.length > 0) {
                    const firstLeaf =
                        referenceTreeList.querySelector(".reference-leaf");
                    if (firstLeaf) {
                        // Simulate a click to load its context
                        // This needs to happen after a very short delay for DOM to be fully ready with new list
                        setTimeout(() => {
                            firstLeaf.click();
                            // And also ensure it's scrolled into view if the list itself is scrollable
                            firstLeaf.scrollIntoView({
                                behavior: "smooth",
                                block: "nearest",
                            });
                        }, 50);
                    }
                } else if (monacoEditor) {
                    // Clear Monaco if no references
                    monacoEditor.setValue(
                        "// No references found or selected."
                    );
                    monaco.editor.setModelLanguage(
                        monacoEditor.getModel(),
                        "plaintext"
                    );
                }
                break;
            case "updateMonacoContent":
                if (monacoEditor) {
                    const { content, language, revealLine, theme } =
                        message.payload;
                    monaco.editor.setTheme(theme);
                    let model = monacoEditor.getModel();
                    if (
                        model &&
                        model.getLanguageId() === language &&
                        !model.isDisposed()
                    ) {
                        model.setValue(content);
                    } else {
                        if (model && !model.isDisposed()) model.dispose(); // Dispose old model
                        model = monaco.editor.createModel(content, language);
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
                    // monacoEditor.focus(); // Optionally focus
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

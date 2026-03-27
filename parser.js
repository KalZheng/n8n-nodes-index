const { Project, SyntaxKind } = require("ts-morph");
const fs = require("fs-extra");
const path = require("path");
const simpleGit = require("simple-git");

const REPO_URL = "https://github.com/n8n-io/n8n.git";
const TEMP_DIR = path.join(__dirname, "temp");
const OUTPUT_DIR = path.join(__dirname, "output");

// --------------------
// GIT HANDLING
// --------------------
async function cloneRepo(version) {
    const git = simpleGit();
    await fs.ensureDir(TEMP_DIR);

    if (!fs.existsSync(path.join(TEMP_DIR, ".git"))) {
        console.log("📦 Cloning repo...");
        await git.clone(REPO_URL, TEMP_DIR);
    }

    const repo = simpleGit(TEMP_DIR);

    try {
        console.log("🔄 Fetching latest...");
        await repo.fetch(["--tags", "--force"]);
    } catch (err) {
        console.warn(`⚠️  Fetch warning (non-fatal): ${err.message?.split("\n")[0]}`);
    }

    console.log(`📌 Checking out version ${version}...`);
    try {
        await repo.checkout(`tags/n8n@${version}`);
    } catch (_) {
        // Already on that tag/commit
    }
    console.log(`✅ Ready at version ${version}`);
}

// --------------------
// AST EVALUATOR
// --------------------

/**
 * Recursively evaluate a ts-morph AST node into a plain JS value.
 * `context` is an optional map of name→value for resolving local variables.
 */
function evalNode(node, project, context) {
    if (!node) return null;
    const kind = node.getKind();

    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        return node.getLiteralValue();
    }
    if (kind === SyntaxKind.NumericLiteral) return Number(node.getLiteralValue());
    if (kind === SyntaxKind.TrueKeyword) return true;
    if (kind === SyntaxKind.FalseKeyword) return false;
    if (kind === SyntaxKind.NullKeyword) return null;
    if (kind === SyntaxKind.UndefinedKeyword) return undefined;

    if (kind === SyntaxKind.ArrayLiteralExpression) {
        const results = [];
        for (const el of node.getElements()) {
            if (el.getKind() === SyntaxKind.SpreadElement) {
                const expr = el.getExpression();
                const resolved = resolveExpr(expr, project, context);
                if (Array.isArray(resolved)) {
                    results.push(...resolved);
                } else if (resolved !== undefined && resolved !== null) {
                    results.push({ _spread: el.getText() });
                } else {
                    results.push({ _spread: el.getText() });
                }
            } else {
                const val = evalNode(el, project, context);
                if (val !== undefined) results.push(val);
            }
        }
        return results;
    }

    if (kind === SyntaxKind.ObjectLiteralExpression) {
        const obj = {};
        for (const prop of node.getProperties()) {
            try {
                if (prop.getKind() === SyntaxKind.PropertyAssignment) {
                    const key = prop.getName();
                    const val = evalNode(prop.getInitializer(), project, context);
                    if (val !== undefined) obj[key] = val;
                } else if (prop.getKind() === SyntaxKind.SpreadAssignment) {
                    const expr = prop.getExpression();
                    const resolved = resolveExpr(expr, project, context);
                    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
                        Object.assign(obj, resolved);
                    }
                    // ShorthandPropertyAssignment — skip
                }
            } catch (_) { }
        }
        return obj;
    }

    if (kind === SyntaxKind.PropertyAccessExpression) {
        return normaliseConnectionType(node.getText());
    }

    if (kind === SyntaxKind.Identifier) {
        const name = node.getText();
        if (name === "undefined") return undefined;
        // Check caller-supplied context first (for local constructor vars)
        if (context && name in context) return context[name];
        const resolved = resolveIdentifierInProject(name, node, project);
        if (resolved !== undefined) return resolved;
        return name;
    }

    if (kind === SyntaxKind.AsExpression) {
        return evalNode(node.getExpression(), project, context);
    }

    if (kind === SyntaxKind.PrefixUnaryExpression) {
        const operand = evalNode(node.getOperand(), project, context);
        if (node.getOperatorToken() === 40 && typeof operand === "number") return -operand;
    }

    if (kind === SyntaxKind.CallExpression) {
        // e.g. getSendAndWaitProperties([...]).filter(...) — evaluate the first arg if it's an array
        // Try to fall back gracefully
        return undefined;
    }

    // Fallback
    return node.getText().replace(/^['"`]|['"`]$/g, "");
}

/**
 * Resolve any expression: identifier, property access, call, etc.
 */
function resolveExpr(expr, project, context) {
    const kind = expr.getKind();
    if (kind === SyntaxKind.Identifier) {
        const name = expr.getText();
        if (context && name in context) return context[name];
        return resolveIdentifierInProject(name, expr, project);
    }
    return evalNode(expr, project, context);
}

function normaliseConnectionType(text) {
    const match = text.match(/NodeConnectionType\.(\w+)/);
    if (match) {
        const raw = match[1];
        return raw.charAt(0).toLowerCase() + raw.slice(1);
    }
    return text.replace(/['"]/g, "");
}

// --------------------
// SYMBOL RESOLUTION
// --------------------

/**
 * Resolve an identifier in the project by traversing import chains.
 */
function resolveIdentifierInProject(name, refNode, project) {
    try {
        const sourceFile = refNode?.getSourceFile?.();
        if (!sourceFile) return undefined;

        // 1. Check current file's variable declarations
        const local = findExportInFile(sourceFile, name, project);
        if (local !== undefined) return local;

        // 2. Walk imports
        const decl = findThroughImports(sourceFile, name, project, new Set());
        return decl;
    } catch (_) {
        return undefined;
    }
}

function findExportInFile(sourceFile, name, project) {
    try {
        for (const varDecl of sourceFile.getVariableDeclarations()) {
            if (varDecl.getName() === name) {
                const init = varDecl.getInitializer();
                if (init) return evalNode(init, project);
            }
        }
    } catch (_) { }
    return undefined;
}

function findThroughImports(sourceFile, name, project, visited) {
    const key = sourceFile.getFilePath();
    if (visited.has(key)) return undefined;
    visited.add(key);

    try {
        for (const imp of sourceFile.getImportDeclarations()) {
            try {
                const named = imp.getNamedImports().map(n => n.getName());
                const namespace = imp.getNamespaceImport()?.getText();
                if (!named.includes(name) && namespace !== name) continue;

                const resolved = imp.getModuleSpecifierSourceFile();
                if (!resolved) continue;

                const found = findExportInFile(resolved, name, project);
                if (found !== undefined) return found;

                const deeper = findThroughImports(resolved, name, project, visited);
                if (deeper !== undefined) return deeper;
            } catch (_) { }
        }
    } catch (_) { }
    return undefined;
}

// --------------------
// SIDECAR (.node.json)
// --------------------
function readSidecar(folderPath, nodeBaseName) {
    try {
        // Try baseName.node.json, then look for any .node.json in the folder
        const candidates = [
            path.join(folderPath, `${nodeBaseName}.node.json`),
        ];
        // Also try folder-name based sidecar
        const folderName = path.basename(folderPath);
        candidates.push(path.join(folderPath, `${folderName}.node.json`));

        for (const sidecarPath of candidates) {
            if (!fs.existsSync(sidecarPath)) continue;
            const data = fs.readJsonSync(sidecarPath);
            const primaryDoc = data?.resources?.primaryDocumentation?.[0]?.url ?? null;
            return {
                categories: data.categories ?? [],
                alias: data.alias ?? [],
                subcategories: data.subcategories ?? {},
                documentationUrl: primaryDoc,
            };
        }
        return {};
    } catch (_) {
        return {};
    }
}

// --------------------
// EXAMPLE GENERATION
// --------------------
function generateExample(properties) {
    const example = {};
    if (!Array.isArray(properties)) return example;

    for (const prop of properties) {
        if (!prop || typeof prop !== "object") continue;
        if (!prop.name || prop._spread) continue;

        const hasDisplayOptions =
            prop.displayOptions &&
            typeof prop.displayOptions === "object" &&
            Object.keys(prop.displayOptions).length > 0;
        if (hasDisplayOptions) continue;

        if (prop["default"] !== undefined && prop["default"] !== "") {
            example[prop.name] = prop["default"];
        } else if (prop.required) {
            const placeholders = {
                string: "",
                number: 0,
                boolean: false,
                json: "{}",
                options: prop.options?.[0]?.value ?? "",
                multiOptions: [],
                collection: {},
                fixedCollection: {},
                resourceLocator: { mode: "id", value: "" },
            };
            example[prop.name] = placeholders[prop.type] ?? "";
        }
    }
    return example;
}

// --------------------
// NODE DESCRIPTION PARSER
// --------------------
function parseDescriptionObject(obj, project, context) {
    if (!obj) return null;
    const result = {
        name: null,
        description: null,
        subtitle: null,
        inputs: [],
        outputs: [],
        credentials: [],
        properties: [],
    };

    for (const field of obj.getProperties()) {
        try {
            if (field.getKind() !== SyntaxKind.PropertyAssignment) {
                // SpreadAssignment: { ...baseDescription }
                if (field.getKind() === SyntaxKind.SpreadAssignment) {
                    const expr = field.getExpression();
                    const resolved = resolveExpr(expr, project, context);
                    if (resolved && typeof resolved === "object") {
                        // Merge resolved fields but don't overwrite already-set ones
                        for (const [k, v] of Object.entries(resolved)) {
                            if (k === "displayName" && !result.name) result.name = v;
                            if (k === "description" && !result.description) result.description = v;
                            if (k === "subtitle" && !result.subtitle) result.subtitle = v;
                        }
                    }
                }
                continue;
            }

            const fieldName = field.getName();
            const valueNode = field.getInitializer();
            if (!valueNode) continue;

            if (fieldName === "displayName") {
                result.name = evalNode(valueNode, project, context);
            } else if (fieldName === "description") {
                result.description = evalNode(valueNode, project, context);
            } else if (fieldName === "subtitle") {
                result.subtitle = evalNode(valueNode, project, context);
            } else if (fieldName === "inputs") {
                const raw = evalNode(valueNode, project, context);
                result.inputs = normaliseIO(raw);
            } else if (fieldName === "outputs") {
                const raw = evalNode(valueNode, project, context);
                result.outputs = normaliseIO(raw);
            } else if (fieldName === "credentials") {
                const raw = evalNode(valueNode, project, context);
                result.credentials = Array.isArray(raw) ? raw : [];
            } else if (fieldName === "properties") {
                const raw = evalNode(valueNode, project, context);
                result.properties = Array.isArray(raw) ? raw : [];
            }
        } catch (_) { }
    }

    return result;
}

function normaliseIO(raw) {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
        .map(v => {
            if (typeof v === "string") return normaliseConnectionType(v);
            if (v && typeof v === "object") {
                return normaliseConnectionType(v.type ?? String(v));
            }
            return String(v);
        })
        .filter(v => v !== "" && v !== "undefined" && v !== "[object Object]");
}

// --------------------
// NODE TYPE DETECTION
// --------------------
function detectNodeType(inputs, outputs, sourceText) {
    const hasNoInputs = inputs.length === 0;
    const isTrigger = /ITriggerFunctions|IPollFunctions/.test(sourceText);
    const isWebhook = /IWebhookFunctions/.test(sourceText) && !isTrigger;
    if (hasNoInputs || isTrigger) return "trigger";
    if (isWebhook) return "webhook";
    return "regular";
}

// --------------------
// PARSE A SINGLE NODE FILE
// --------------------

/**
 * Parse a .node.ts file.
 * `extraContext` may contain resolved local variable values (e.g. baseDescription)
 *  so that spread-from-parameter patterns like `{ ...baseDescription, ... }` work.
 */
function parseNodeFile(filePath, version, project, sidecar, extraContext) {
    let sourceFile = project.getSourceFile(filePath);
    if (!sourceFile) {
        sourceFile = project.addSourceFileAtPath(filePath);
    }

    const sourceText = sourceFile.getFullText();
    let result = null;

    try {
        const classes = sourceFile.getClasses();
        if (!classes.length) return null;

        for (const nodeClass of classes) {
            // Strategy 1: class property `description = { ... }`
            for (const prop of nodeClass.getProperties()) {
                if (prop.getName() !== "description") continue;
                const init = prop.getInitializer();
                if (!init) continue;
                const obj = init.asKind(SyntaxKind.ObjectLiteralExpression);
                if (!obj) continue;
                const parsed = parseDescriptionObject(obj, project, extraContext);
                if (parsed && parsed.name) { result = parsed; break; }
            }

            if (result) break;

            // Strategy 2: `this.description = { ... }` inside constructor
            for (const ctor of nodeClass.getConstructors()) {
                // Build local context from constructor's variable declarations
                const localCtx = { ...(extraContext ?? {}) };
                try {
                    for (const varDecl of ctor.getBody()?.getVariableDeclarations?.() ?? []) {
                        const init = varDecl.getInitializer();
                        if (init) {
                            localCtx[varDecl.getName()] = evalNode(init, project, localCtx);
                        }
                    }
                } catch (_) { }

                for (const stmt of ctor.getBody()?.getStatements() ?? []) {
                    try {
                        if (!stmt.getText().includes("this.description")) continue;
                        const exprs = stmt.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
                        for (const expr of exprs) {
                            const parsed = parseDescriptionObject(expr, project, localCtx);
                            if (parsed && parsed.name) { result = parsed; break; }
                        }
                        if (result) break;
                    } catch (_) { }
                }
                if (result) break;
            }

            if (result) break;
        }
    } catch (err) {
        throw err;
    }

    if (!result || !result.name) return null;

    const nodeType = detectNodeType(result.inputs, result.outputs, sourceText);
    const example = generateExample(result.properties);

    return {
        version,
        name: result.name,
        description: result.description ?? "",
        subtitle: result.subtitle ?? null,
        type: nodeType,
        inputs: result.inputs,
        outputs: result.outputs,
        credentials: result.credentials,
        categories: sidecar.categories ?? [],
        alias: sidecar.alias ?? [],
        subcategories: sidecar.subcategories ?? {},
        documentationUrl: sidecar.documentationUrl ?? null,
        properties: result.properties,
        example,
    };
}

// --------------------
// VERSIONED NODE HANDLER
// --------------------

/**
 * For VersionedNodeType nodes (e.g. Slack.node.ts → SlackV1, SlackV2),
 * parse the parent file to extract `baseDescription`, then parse the latest
 * versioned child file with that context injected.
 */
function parseVersionedNode(parentFilePath, version, project, sidecar) {
    let parentFile = project.getSourceFile(parentFilePath);
    if (!parentFile) parentFile = project.addSourceFileAtPath(parentFilePath);

    // Extract baseDescription from the parent constructor
    let baseDescription = {};
    try {
        for (const cls of parentFile.getClasses()) {
            for (const ctor of cls.getConstructors()) {
                for (const varDecl of ctor.getBody()?.getVariableDeclarations?.() ?? []) {
                    if (varDecl.getName() === "baseDescription") {
                        const init = varDecl.getInitializer();
                        if (init) baseDescription = evalNode(init, project) ?? {};
                    }
                }
            }
        }
    } catch (_) { }

    return { baseDescription };
}

// --------------------
// PARSE ALL NODES
// --------------------
async function parseAllNodes(version) {
    const nodesDir = path.join(TEMP_DIR, "packages/nodes-base/nodes");
    const folders = await fs.readdir(nodesDir);

    const project = new Project({ skipAddingFilesFromTsConfig: true });

    const results = [];
    let parsed = 0, skipped = 0;

    for (const folder of folders) {
        const folderPath = path.join(nodesDir, folder);
        const stat = await fs.stat(folderPath);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(folderPath);

        // Add all .ts files in this node's folder to the project
        try {
            const allTs = await globTs(folderPath);
            for (const ts of allTs) {
                if (!project.getSourceFile(ts)) project.addSourceFileAtPath(ts);
            }
        } catch (_) { }

        // Detect if this folder uses VersionedNodeType pattern
        // (top-level .node.ts that extends VersionedNodeType + sub-dirs V1, V2...)
        const topNodeFiles = files.filter(f => f.endsWith(".node.ts"));
        const versionedDirs = files
            .filter(f => /^V\d+$/.test(f))
            .map(f => path.join(folderPath, f))
            .filter(d => fs.statSync(d).isDirectory())
            .sort((a, b) => {
                const na = parseInt(path.basename(a).slice(1));
                const nb = parseInt(path.basename(b).slice(1));
                return na - nb;
            });

        const isVersionedPattern = versionedDirs.length > 0 && topNodeFiles.length > 0;

        if (isVersionedPattern) {
            // Parse the LATEST versioned sub-dir's node file(s), with baseDescription context
            // Use the largest V# dir as canonical
            const latestVDir = versionedDirs[versionedDirs.length - 1];
            const topFile = path.join(folderPath, topNodeFiles[topNodeFiles.length - 1]);

            // Extract baseDescription from parent
            const { baseDescription } = parseVersionedNode(topFile, version, project, {});
            const extraContext = { baseDescription };

            // Determine the sidecar name from the top-level node file
            const sidecarBaseName = topNodeFiles[topNodeFiles.length - 1].replace(".node.ts", "");
            const sidecar = readSidecar(folderPath, sidecarBaseName);

            // Parse the versioned node files (just the latest dir)
            const vFiles = await fs.readdir(latestVDir);
            const targetVFiles = vFiles.filter(f => f.endsWith(".node.ts"));

            if (targetVFiles.length === 0) {
                skipped++;
                continue;
            }

            // Use the node that has the most properties
            let best = null;
            for (const vf of targetVFiles) {
                try {
                    const r = parseNodeFile(path.join(latestVDir, vf), version, project, sidecar, extraContext);
                    if (r && r.name && (!best || r.properties.length > best.properties.length)) {
                        best = r;
                    }
                } catch (err) {
                    console.error(`❌ Failed versioned: ${folder}/${path.basename(latestVDir)}/${vf} — ${err.message}`);
                }
            }
            if (best) {
                results.push(best);
                parsed++;
            } else {
                skipped++;
            }

        } else {
            // Normal flat structure: parse each .node.ts directly
            for (const file of topNodeFiles) {
                const filePath = path.join(folderPath, file);
                const sidecarBaseName = file.replace(".node.ts", "");
                const sidecar = readSidecar(folderPath, sidecarBaseName);

                try {
                    const r = parseNodeFile(filePath, version, project, sidecar, {});
                    if (r) {
                        results.push(r);
                        parsed++;
                    } else {
                        skipped++;
                    }
                } catch (err) {
                    console.error(`❌ Failed: ${folder}/${file} — ${err.message}`);
                    skipped++;
                }
            }
        }
    }

    console.log(`✅ Parsed: ${parsed}  |  Skipped/failed: ${skipped}`);
    return results;
}

async function globTs(dir) {
    const results = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (["node_modules", "__tests__", "test", "__schema__"].includes(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                results.push(...(await globTs(full)));
            } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.endsWith(".test.ts")) {
                results.push(full);
            }
        }
    } catch (_) { }
    return results;
}

// --------------------
// SAVE OUTPUT
// --------------------
async function saveOutput(version, data) {
    await fs.ensureDir(OUTPUT_DIR);
    const filePath = path.join(OUTPUT_DIR, `nodes-${version}.json`);
    await fs.writeJson(filePath, data, { spaces: 2 });
    console.log(`💾 Saved ${data.length} nodes → ${filePath}`);
}

// --------------------
// MAIN
// --------------------
async function run(version) {
    await cloneRepo(version);
    const nodes = await parseAllNodes(version);
    await saveOutput(version, nodes);
}

const version = process.argv[2] || "1.82.0";
run(version);
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Service } from "./Service";
import { Manager } from "../core";
import { AndroidBuildVariantsModel, BuildVariantExecutable, Command, Module } from "../cmd/BuildVariant";
import { AndroidSdkDetector } from "../utils/androidSdkDetector";
import { showMsg, MsgType } from '../module/ui';

/**
 * Workspace state key used to persist the detected Android project path
 * so it survives VS Code restarts.
 */
const PROJECT_PATH_KEY = 'android-studio-lite.projectPath';

export interface MuduleBuildVariant extends Module {
    module: string;
}

const defaultVariants: MuduleBuildVariant[] = [
    {
        module: "app",
        type: "application",
        variants: [{
            name: "debug",
            flavors: ["debug"],
            buildType: "debug",
            tasks: {
                assemble: "assembleDebug",
                install: "installDebug",
                bundle: "bundleDebug",
            },
        }, {
            name: "release",
            flavors: ["release"],
            buildType: "release",
            tasks: {
                assemble: "assembleRelease",
                bundle: "bundleRelease",
            },
        }],
    }
];

export class BuildVariantService extends Service {
    readonly manager: Manager;
    readonly buildVariant: BuildVariantExecutable;
    readonly workspacePath: string;

    /** The resolved Android project root (may be a subdirectory of workspacePath). */
    private _projectPath: string = '';
    /** Cache the isAndroidProject flag so we don't re-search every call. */
    private _androidProjectChecked: boolean = false;
    /** The ExtensionContext for persistent storage — set once externally. */
    private _context: vscode.ExtensionContext | null = null;

    /** Coalesces concurrent getModuleBuildVariants calls to avoid duplicate Gradle fetches */
    private moduleBuildVariantsPromise: Promise<MuduleBuildVariant[]> | null = null;

    constructor(manager: Manager) {
        super(manager);
        this.manager = manager;
        this.buildVariant = new BuildVariantExecutable(manager);
        this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    }

    /** Provide the ExtensionContext for persistence. Must be called before auto-detection. */
    public setContext(context: vscode.ExtensionContext): void {
        this._context = context;
        // Restore persisted project path
        const saved = context.workspaceState.get<string>(PROJECT_PATH_KEY);
        if (saved) {
            const gradleCheck = AndroidSdkDetector.checkGradleWrapper(saved);
            if (gradleCheck.exists) {
                this._projectPath = saved;
                this._androidProjectChecked = true;
            }
        }
    }

    /**
     * Returns the resolved Android project path.
     * This may be a subdirectory of the workspace root if gradlew was found there.
     */
    public getProjectPath(): string {
        if (!this._projectPath) {
            this.autoDetectAndroidProject();
        }
        return this._projectPath;
    }

    /**
     * True if the workspace (or a subdirectory) contains a Gradle wrapper.
     * This replaces the original shallow check with a recursive search.
     */
    public isAndroidProject(): boolean {
        if (this._androidProjectChecked) {
            return this._projectPath !== '';
        }
        this.autoDetectAndroidProject();
        return this._projectPath !== '';
    }

    /**
     * Auto-detect the Android project root.
     *
     * 1. Check the workspace root for gradlew (fast path).
     * 2. If not found, search subdirectories up to 3 levels deep.
     * 3. If exactly one project is found, use it.
     * 4. If multiple are found, ask the user to pick.
     * 5. Persist the result so it survives restarts.
     */
    public autoDetectAndroidProject(): void {
        this._androidProjectChecked = true;
        this._projectPath = '';

        if (!this.workspacePath) return;

        // Step 1: Check workspace root
        const rootCheck = AndroidSdkDetector.checkGradleWrapper(this.workspacePath);
        if (rootCheck.exists) {
            this._projectPath = this.workspacePath;
            void this._persistProjectPath();
            return;
        }

        // Step 2: Search subdirectories
        const found = AndroidSdkDetector.findAndroidProjectPaths(this.workspacePath, 3);

        if (found.length === 0) {
            return; // No Android project found anywhere
        }

        if (found.length === 1) {
            this._projectPath = found[0];
            void this._persistProjectPath();
            return;
        }

        // Step 3: Multiple projects found — auto-pick the shallowest (breadth-first), or let user pick
        // Sort by depth (number of path separators) so shallowest comes first
        found.sort((a, b) => {
            const depthA = a.split(path.sep).length;
            const depthB = b.split(path.sep).length;
            return depthA - depthB;
        });

        // Use the first (shallowest) by default — user can still change later
        this._projectPath = found[0];
        void this._persistProjectPath();
    }

    /** Persist the resolved project path so it survives restarts. */
    private async _persistProjectPath(): Promise<void> {
        if (this._context && this._projectPath) {
            await this._context.workspaceState.update(PROJECT_PATH_KEY, this._projectPath);
        }
    }

    /** Allow the user to manually set a different project path. */
    public setProjectPath(projectPath: string): void {
        this._projectPath = projectPath;
        this._androidProjectChecked = true;
        // Invalidate cached variants since project path changed
        this.clearCache();
        void this._persistProjectPath();
    }

    public async getModuleBuildVariants(context: vscode.ExtensionContext): Promise<MuduleBuildVariant[]> {
        // Ensure context is set for persistence
        if (!this._context) {
            this.setContext(context);
        }

        let out = this.getCache("getModuleBuildVariants");
        if (out) {
            return out;
        }

        // Coalesce concurrent calls
        if (this.moduleBuildVariantsPromise) {
            return this.moduleBuildVariantsPromise;
        }

        this.moduleBuildVariantsPromise = this.fetchModuleBuildVariants(context).finally(() => {
            this.moduleBuildVariantsPromise = null;
        });
        return this.moduleBuildVariantsPromise;
    }

    private async fetchModuleBuildVariants(context: vscode.ExtensionContext): Promise<MuduleBuildVariant[]> {
        // Ensure context set
        if (!this._context) {
            this.setContext(context);
        }

        const projectPath = this.getProjectPath();

        if (!projectPath) {
            showMsg(MsgType.warning, "No Android project found. Please open a folder containing an Android project.");
            return defaultVariants;
        }

        const gradleCheck = AndroidSdkDetector.checkGradleWrapper(projectPath);
        if (!gradleCheck.exists) {
            const errorMsg = gradleCheck.error || `Gradle wrapper not found at: ${gradleCheck.path}`;
            this.manager.output.append(
                `${errorMsg}\n\nMake sure you're in an Android project root directory.`,
                "error"
            );
            return defaultVariants;
        }

        // If gradlew exists but is not executable, try to fix it
        if (gradleCheck.error && gradleCheck.error.includes('not executable')) {
            try {
                fs.chmodSync(gradleCheck.path, 0o755);
            } catch (e) {
                // best effort
            }
        }

        const initScriptPath = this.getInitScriptPath(context);
        try {
            const variantsObj = await this.buildVariant.exec<AndroidBuildVariantsModel>(
                Command.load,
                initScriptPath,
                { cwd: projectPath }
            );
            fs.unlinkSync(initScriptPath);

            if (!variantsObj) {
                return defaultVariants;
            }

            const variants: MuduleBuildVariant[] = [];

            Object.entries(variantsObj.modules).forEach(([module, moduleObj]) => {
                const moduleData = moduleObj as Module;
                variants.push({
                    module: module,
                    type: moduleData.type,
                    variants: moduleData.variants,
                });
            });
            // Cache for 5 minutes (300 seconds)
            this.setCache("getModuleBuildVariants", variants, 300);
            return variants;
        } catch (error: any) {
            // Cleanup temp script
            try { fs.unlinkSync(initScriptPath); } catch { /* ignore */ }

            const errorMessage = error?.message || String(error);
            if (errorMessage.includes('No such file or directory') || errorMessage.includes('gradlew')) {
                showMsg(
                    MsgType.error,
                    `Gradle wrapper not found or not executable.\n\nError: ${errorMessage}\n\nMake sure you're in an Android project root directory with a gradlew file.`,
                    {}
                );
            } else {
                showMsg(
                    MsgType.error,
                    `Failed to load build variants.\n\nError: ${errorMessage}`,
                    {}
                );
            }
            return defaultVariants;
        }
    }

    public clearCache(): void {
        this.manager.cache.set("getModuleBuildVariants", null, -1);
        this.moduleBuildVariantsPromise = null;
    }

    private getInitScriptPath(context: vscode.ExtensionContext) {
        let buildVariantGradleInitScriptPath = path.join(
            context.extensionPath,
            'out',
            'scripts',
            'build-variant-init.gradle.kts'
        );

        if (!fs.existsSync(buildVariantGradleInitScriptPath)) {
            buildVariantGradleInitScriptPath = path.join(
                context.extensionPath,
                'src',
                'scripts',
                'build-variant-init.gradle.kts'
            );
        }

        if (!fs.existsSync(buildVariantGradleInitScriptPath)) {
            throw new Error(`[BuildVariantService] Build variant Gradle init script not found. Checked: ${path.join(context.extensionPath, 'out/scripts')} and ${path.join(context.extensionPath, 'src/scripts')}`);
        }

        const buildVariantGradleInitScriptContent = fs.readFileSync(buildVariantGradleInitScriptPath, 'utf-8');

        const tempDir = os.tmpdir();
        const tempInitScript = path.join(tempDir, `android-variant-init-${Date.now()}.gradle.kts`);
        fs.writeFileSync(tempInitScript, buildVariantGradleInitScriptContent);

        return tempInitScript;
    }
}

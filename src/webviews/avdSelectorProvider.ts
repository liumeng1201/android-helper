import type { Disposable, ExtensionContext } from 'vscode';
import { Disposable as VSCodeDisposable, window, commands, workspace, ProgressLocation, CancellationTokenSource } from 'vscode';
import type { WebviewProvider, WebviewHost } from './webviewProvider.js';
import type { WebviewState } from './protocol.js';
import { Manager } from '../core';
import type { MuduleBuildVariant } from '../service/BuildVariantService';
import type { DeviceInfo } from '../device/DeviceManager';
import { EmulatorBootService } from '../device/EmulatorBootService.js';
import { LogcatService } from '../service/LogcatService.js';

export interface AVDSelectorWebviewState extends WebviewState {
    devices?: DeviceInfo[];
    selectedDeviceSerial?: string;
    modules?: MuduleBuildVariant[];
    selectedModule?: string;
    /** The resolved Android project path (may be a subdirectory). */
    projectPath?: string;
    /** When false, show "Open an Android project" placeholder. */
    isAndroidProject?: boolean;
    /** When false, logcat modules are not available; hide Logcat toggle. */
    logcatAvailable?: boolean;
}

export class AVDSelectorProvider implements WebviewProvider<AVDSelectorWebviewState> {
    private readonly disposables: Disposable[] = [];
    private readonly manager: Manager;
    private buildCancellationTokens = new Map<string, CancellationTokenSource>();
    private logcatActive: boolean = false;

    constructor(
        private readonly host: WebviewHost,
        private readonly context: ExtensionContext,
        private readonly logcatAvailable: boolean = false,
    ) {
        this.manager = Manager.getInstance();
        this.disposables.push(
            workspace.onDidChangeWorkspaceFolders(async () => {
                const isAndroidProject = this.manager.buildVariant.isAndroidProject();
                await this.host.notify('update-android-project-state', {
                    isAndroidProject,
                    projectPath: isAndroidProject
                        ? this.manager.buildVariant.getProjectPath()
                        : undefined,
                });
                if (isAndroidProject) {
                    await this.sendModules();
                }
            }),
            // Listen for device list changes from DeviceManager
            this.manager.deviceManager.onDeviceListChanged(async (devices) => {
                await this.host.notify('update-devices', { devices });
            }),
        );
    }

    getTelemetryContext(): Record<string, string | number | boolean | undefined> {
        return {
            'webview.id': this.host.id,
            'webview.instanceId': this.host.instanceId,
        };
    }

    async includeBootstrap(): Promise<AVDSelectorWebviewState> {
        const isAndroidProject = this.manager.buildVariant.isAndroidProject();

        // Get modules and filter for application type (only when Android project)
        let modules: MuduleBuildVariant[] = [];
        if (isAndroidProject) {
            try {
                const allModules = await this.manager.buildVariant.getModuleBuildVariants(this.context);
                modules = allModules.filter(m => m.type === 'application');
            } catch (error) {
                console.error('[AVDSelectorProvider] Error loading modules:', error);
            }
        }
        const selectedModule = modules.length > 0 ? modules[0].module : undefined;

        // Check current logcat state
        try {
            this.logcatActive = false;
        } catch (error) {
            console.error('[AVDSelectorProvider] Error checking logcat state:', error);
        }

        // Get current device list from DeviceManager
        const devices = this.manager.deviceManager.getDevices();

        // Auto-select first connected device
        const connectedDevice = devices.find(d => d.state === 'device');

        // Get resolved project path
        const projectPath = this.manager.buildVariant.isAndroidProject()
            ? this.manager.buildVariant.getProjectPath()
            : undefined;

        return {
            ...this.host.baseWebviewState,
            devices,
            selectedDeviceSerial: connectedDevice?.serial,
            projectPath,
            modules,
            selectedModule,
            isAndroidProject,
            logcatAvailable: this.logcatAvailable,
        };
    }

    async onReady(): Promise<void> {
        console.log('[AVDSelector] Ready');
        // Send initial modules and device list
        await this.sendModules();
        await this.sendDeviceList();
        // Send initial logcat state
        await this.host.notify('logcat-state-changed', { active: this.logcatActive });
    }

    onMessageReceived?(e: any): void {
        if (e.type === 'open-folder') {
            void commands.executeCommand('workbench.action.files.openFolder');
            return;
        }
        if (e.type === 'refresh-modules') {
            void this.sendModules();
        } else if (e.type === 'refresh-devices') {
            void this.manager.deviceManager.refreshDevices().then(() => this.sendDeviceList());
        } else if (e.type === 'select-device') {
            const { deviceSerial, avdName } = e.params || {};
            if (deviceSerial) {
                void this.host.notify('device-selected', { deviceSerial, avdName });
            }
        } else if (e.type === 'select-module') {
            const { moduleName } = e.params || {};
            if (moduleName) {
                void this.host.notify('module-selected', { moduleName });
            }
        } else if (e.type === 'run-app') {
            void this.handleRunApp(e.params);
        } else if (e.type === 'cancel-build') {
            void this.handleCancelBuild(e.params);
        } else if (e.type === 'toggle-logcat') {
            void this.handleToggleLogcat(e.params);
        } else if (e.type === 'select-project-path') {
            const { projectPath } = e.params || {};
            if (projectPath && typeof projectPath === 'string') {
                this.manager.buildVariant.setProjectPath(projectPath);
                // Re-send modules since the project changed
                void this.sendModules();
            }
        }
    }

    private async handleRunApp(params: any): Promise<void> {
        const { deviceSerial, avdName, moduleName, cancellationToken } = params || {};
        if (!deviceSerial || !moduleName) {
            await this.host.notify('build-failed', { error: 'Device and Module must be selected' });
            return;
        }

        // Create cancellation token
        const cancelToken = new CancellationTokenSource();
        if (cancellationToken) {
            this.buildCancellationTokens.set(cancellationToken, cancelToken);
        }

        try {
            await this.host.notify('build-started', { cancellationToken });

            const adbPath = this.manager.deviceManager.getAdbPath();
            const emulatorPath = this.manager.android.getEmulator();
            if (!adbPath || !emulatorPath) {
                await this.host.notify('build-failed', { error: 'SDK path or emulator not configured. Run Setup Wizard.' });
                return;
            }

            // Get selected build variant for the module
            const modules = await this.manager.buildVariant.getModuleBuildVariants(this.context);
            const module = modules.find(m => m.module === moduleName && m.type === 'application');
            if (!module || !module.variants || module.variants.length === 0) {
                await this.host.notify('build-failed', { error: 'No build variants found for module' });
                return;
            }

            // Get selected variant (use first one as default)
            const selectedVariants = this.context.workspaceState.get<Record<string, string>>(
                'android-helper.selectedBuildVariants',
                {}
            );
            const variantName = selectedVariants[moduleName] || module.variants[0].name;
            const variant = module.variants.find(v => v.name === variantName) || module.variants[0];

            // Get install task (e.g., installDebug, installProductionDebug)
            if (!variant.tasks.install) {
                await this.host.notify('build-failed', { error: `No install task found for variant ${variantName}` });
                return;
            }

            const installTask = variant.tasks.install;

            // Build and install using GradleService
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Building and installing ${variantName}`,
                    cancellable: true,
                },
                async (progress, token) => {
                    // Link cancellation tokens
                    token.onCancellationRequested(() => {
                        cancelToken.cancel();
                        this.manager.gradle.cancelBuild();
                    });

                    try {
                        // Resolve the target device serial
                        const serial = deviceSerial;

                        // If this is an emulator (has avdName), ensure it's running and fully booted
                        if (avdName) {
                            const bootService = new EmulatorBootService(
                                this.manager.deviceManager,
                                emulatorPath,
                                { appendLine: (line) => this.manager.output.append(line) },
                            );
                            await bootService.launchAndWait(
                                avdName,
                                progress,
                                cancelToken.token,
                            );
                        }

                        if (cancelToken.token.isCancellationRequested) {
                            throw new Error('Build was cancelled');
                        }

                        progress.report({ increment: 0, message: `Installing ${installTask}...` });
                        console.log(`[AVDSelectorProvider] Starting gradle install task: ${installTask}`);

                        // Install variant (this will build and install)
                        await this.manager.gradle.installVariant(
                            installTask,
                            (output) => {
                                // Show progress from Gradle output
                                const lines = output.split('\n').filter(l => l.trim());
                                const lastLine = lines[lines.length - 1];
                                if (lastLine && lastLine.length < 100) {
                                    progress.report({ message: lastLine });
                                }
                            },
                            cancelToken.token
                        );

                        console.log(`[AVDSelectorProvider] Gradle install task completed successfully: ${installTask}`);

                        progress.report({ increment: 90, message: 'Installation completed! Launching app...' });

                        // Launch the app after installation
                        try {
                            const applicationId = variant.applicationId;
                            if (!applicationId) {
                                throw new Error(`No applicationId found for variant ${variantName}. Please ensure the gradle script includes applicationId for application modules.`);
                            }
                            await this.launchApp(applicationId, serial);
                            LogcatService.setLastRun(this.context, applicationId, serial);
                            progress.report({ increment: 100, message: 'App launched successfully!' });
                            window.showInformationMessage(`App installed and launched on ${deviceSerial}`);
                        } catch (launchError: any) {
                            console.error('[AVDSelectorProvider] Error launching app:', launchError);
                            // Don't fail the whole process if launch fails
                            progress.report({ increment: 100, message: 'Installation completed (launch failed)' });
                            window.showWarningMessage(`App installed but failed to launch: ${launchError.message || String(launchError)}`);
                        }

                        await this.host.notify('build-completed', {});
                    } catch (error: any) {
                        if (cancelToken.token.isCancellationRequested || token.isCancellationRequested) {
                            throw new Error('Build was cancelled');
                        }
                        throw error;
                    }
                }
            );
        } catch (error: any) {
            console.error('[AVDSelectorProvider] Error in handleRunApp:', error);
            if (error.name === 'CancellationError' || cancelToken.token.isCancellationRequested || error.message === 'Build was cancelled') {
                await this.host.notify('build-cancelled', {});
                window.showInformationMessage('Build was cancelled');
            } else {
                // Extract error message more reliably
                let errorMessage = this.extractBuildErrorMessage(error);

                console.error('[AVDSelectorProvider] Build failed with error:', errorMessage);
                console.error('[AVDSelectorProvider] Full error object:', error);
                await this.host.notify('build-failed', { error: errorMessage });
                window.showErrorMessage(`Build failed: ${errorMessage}`);
            }
        } finally {
            if (cancellationToken) {
                this.buildCancellationTokens.delete(cancellationToken);
            }
            cancelToken.dispose();
        }
    }

    private async handleCancelBuild(params: any): Promise<void> {
        const { cancellationToken } = params || {};
        if (cancellationToken) {
            const cancelToken = this.buildCancellationTokens.get(cancellationToken);
            if (cancelToken) {
                cancelToken.cancel();
                this.manager.gradle.cancelBuild();
                this.buildCancellationTokens.delete(cancellationToken);
                await this.host.notify('build-cancelled', {});
            }
        }
    }

    private async handleToggleLogcat(params: any): Promise<void> {
        const { active } = params || {};
        this.logcatActive = active;

        try {
            if (active) {
                // Start logcat and show logcat output channel
                await commands.executeCommand('android-helper.startLogcat');
                // Hide Android Helper output channel
                this.manager.output.hide();
            } else {
                // Stop logcat and show Android Helper output channel
                await commands.executeCommand('android-helper.stopLogcat');
                // Show Android Helper output channel
                this.manager.output.show();
            }
            // Notify webview of state change
            await this.host.notify('logcat-state-changed', { active: this.logcatActive });
        } catch (error: any) {
            console.error('[AVDSelectorProvider] Error toggling logcat:', error);
            // Revert state on error
            this.logcatActive = !active;
            await this.host.notify('logcat-state-changed', { active: this.logcatActive });
            window.showErrorMessage(`Failed to ${active ? 'start' : 'stop'} logcat: ${error.message || String(error)}`);
        }
    }

    private async ensureAVDRunning(avdName: string, cancellationToken: any): Promise<void> {
        // Check if AVD is already running via DeviceManager
        const existing = this.manager.deviceManager.findDeviceByAvdName(avdName);
        if (existing) {
            console.log(`[AVDSelectorProvider] AVD ${avdName} is already running as ${existing.serial}, skipping launch`);
            return;
        }

        console.log(`[AVDSelectorProvider] AVD ${avdName} is not running, launching emulator...`);

        // Launch the emulator with progress notification
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: `Booting emulator: ${avdName}`,
                cancellable: true,
            },
            async (progress, token) => {
                progress.report({ increment: 0, message: 'Starting emulator...' });
                // Launch emulator (this spawns and returns immediately)
                await this.manager.avd.launchEmulator(avdName);

                // Wait for device to be ready via DeviceManager (event-driven)
                progress.report({ increment: 30, message: 'Waiting for device...' });

                const timeoutMs = 120000; // 2 minutes

                try {
                    await this.manager.deviceManager.waitForDevice(avdName, timeoutMs);
                    progress.report({ increment: 100, message: 'Device ready!' });
                } catch (error: any) {
                    if (error.message?.includes('was cancelled') || token.isCancellationRequested) {
                        throw new Error('Build was cancelled');
                    }
                    throw new Error(`Emulator started but device not detected. ${error.message}`);
                }
            },
        );
    }

    private async launchApp(applicationId: string, serial?: string): Promise<void> {
        const adbPath = this.manager.deviceManager.getAdbPath();
        if (!adbPath) {
            throw new Error('SDK path not configured');
        }

        console.log(`[AVDSelectorProvider] Launching app with applicationId: ${applicationId}`);

        const serialArg = serial ? `-s ${serial} ` : '';
        const launchCommand = `"${adbPath}" ${serialArg}shell monkey -p ${applicationId} -c android.intent.category.LAUNCHER 1`;
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            const result = await execAsync(launchCommand);
            console.log(`[AVDSelectorProvider] App launch command output: ${result.stdout}`);
        } catch (error: any) {
            // Check if it's just a warning about monkey
            if (error.stdout && !error.stdout.includes('Error')) {
                console.log(`[AVDSelectorProvider] App launched (monkey output): ${error.stdout}`);
                return;
            }
            throw new Error(`Failed to launch app: ${error.message || String(error)}`);
        }
    }

    private extractBuildErrorMessage(error: any): string {
        // Extract error message more reliably
        let errorMessage = 'Unknown error';
        if (error?.message) {
            errorMessage = error.message;
        } else if (error?.toString && typeof error.toString === 'function') {
            errorMessage = error.toString();
        } else if (typeof error === 'string') {
            errorMessage = error;
        } else {
            errorMessage = JSON.stringify(error);
        }

        // Try to extract the most relevant error from Gradle output
        // Common patterns:
        // 1. "What went wrong:" followed by error description
        // 2. "FAILURE: Build failed with an exception."
        // 3. Task-specific errors like "Execution failed for task"

        const lines = errorMessage.split('\n');
        const relevantLines: string[] = [];

        // Look for key error indicators
        let captureNext = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Capture "What went wrong:" section
            if (line.includes('What went wrong:') || line.includes('FAILURE:')) {
                captureNext = true;
                if (line.includes('FAILURE:')) {
                    relevantLines.push(line);
                }
                continue;
            }

            // Capture "Execution failed for task" lines
            if (line.includes('Execution failed for task')) {
                relevantLines.push(line);
                captureNext = true;
                continue;
            }

            // Capture lines after "What went wrong:" (usually the actual error)
            if (captureNext && line && !line.startsWith('*') && !line.startsWith('>') && !line.includes('Try:') && !line.includes('Run with')) {
                if (line.length > 0 && !line.match(/^\s*$/)) {
                    relevantLines.push(line);
                    // Stop capturing after we get a meaningful error line
                    if (line.length > 20 && !line.includes('Get more help')) {
                        captureNext = false;
                    }
                }
            }

            // Stop capturing on certain markers
            if (line.includes('Try:') || line.includes('Run with') || line.includes('Get more help')) {
                captureNext = false;
            }
        }

        // If we found relevant lines, use them; otherwise use the original message
        if (relevantLines.length > 0) {
            // Join relevant lines, but limit to first 3-4 most important ones
            const extracted = relevantLines.slice(0, 4).join(' ').trim();
            if (extracted.length > 0) {
                return extracted;
            }
        }

        // Fallback: try to find the first meaningful error line
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed &&
                trimmed.length > 20 &&
                !trimmed.includes('BUILD FAILED') &&
                !trimmed.includes('FAILURE:') &&
                !trimmed.includes('Try:') &&
                !trimmed.includes('Run with') &&
                (trimmed.includes('failed') || trimmed.includes('error') || trimmed.includes('Error'))) {
                return trimmed;
            }
        }

        return errorMessage;
    }

    private async sendDeviceList(): Promise<void> {
        const devices = this.manager.deviceManager.getDevices();
        await this.host.notify('update-devices', { devices });
    }

    async onRefresh?(force?: boolean): Promise<void> {
        if (force) {
            await this.manager.avd.getAVDList(true);
            this.manager.buildVariant.clearCache();
        }
        await this.sendModules();
        await this.sendDeviceList();
    }

    private async sendModules(): Promise<void> {
        if (!this.manager.buildVariant.isAndroidProject()) {
            await this.host.notify('update-modules', { modules: [] });
            return;
        }
        try {
            const allModules = await this.manager.buildVariant.getModuleBuildVariants(this.context);
            const modules = allModules.filter(m => m.type === 'application');
            await this.host.notify('update-modules', { modules });
        } catch (error) {
            console.error('[AVDSelectorProvider] Error sending modules:', error);
            await this.host.notify('update-modules', { modules: [] });
        }
    }

    registerCommands(): Disposable[] {
        return [];
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

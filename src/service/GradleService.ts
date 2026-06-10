import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { Service } from "./Service";
import { Manager } from "../core";
import { GradleExecutable, Command } from "../cmd/Gradle";
import { showMsg, MsgType } from '../module/ui';

export class GradleService extends Service {
    readonly manager: Manager;
    readonly gradle: GradleExecutable;

    /** Returns the effective project root (auto-detected subdirectory or workspace root). */
    private get projectPath(): string {
        return this.manager.buildVariant.getProjectPath();
    }

    private buildProcess: child_process.ChildProcess | null = null;

    constructor(manager: Manager) {
        super(manager);
        this.manager = manager;
        this.gradle = new GradleExecutable(manager);
    }

    public async installVariant(
        variantTask: string,
        onOutput?: (output: string) => void,
        cancellationToken?: vscode.CancellationToken
    ): Promise<void> {
        if (!this.projectPath) {
            throw new Error("No Android project found. Please open a folder containing an Android project.");
        }

        // Get command from executable
        const commandProp = this.gradle.getCommand(Command.install);
        const cmd = this.gradle.getCmd(commandProp, variantTask);

        return new Promise<void>((resolve, reject) => {
            // Check cancellation before starting
            if (cancellationToken?.isCancellationRequested) {
                reject(new Error("Build was cancelled"));
                return;
            }

            const spawnOptions: child_process.SpawnOptions = {
                shell: true,
                cwd: this.projectPath,
            };

            this.buildProcess = child_process.spawn(cmd, [], spawnOptions);

            let stdout = '';
            let stderr = '';

            if (this.buildProcess.stdout) {
                this.buildProcess.stdout.on('data', (data) => {
                    const output = Buffer.from(data).toString();
                    stdout += output;
                    if (onOutput) {
                        onOutput(output);
                    }
                    this.manager.output.append(output);
                });
            }

            if (this.buildProcess.stderr) {
                this.buildProcess.stderr.on('data', (data) => {
                    const output = Buffer.from(data).toString();
                    stderr += output;
                    if (onOutput) {
                        onOutput(output);
                    }
                    this.manager.output.append(output, "error");
                });
            }

            // Handle cancellation
            if (cancellationToken) {
                const cancellationListener = cancellationToken.onCancellationRequested(() => {
                    if (this.buildProcess) {
                        this.buildProcess.kill('SIGTERM');
                        this.buildProcess = null;
                    }
                    reject(new Error("Build was cancelled"));
                });
                this.buildProcess.on('close', () => {
                    cancellationListener.dispose();
                });
            }

            this.buildProcess.on('error', (error) => {
                this.buildProcess = null;
                this.manager.output.append(stderr, "error");
                showMsg(MsgType.error, `Failed to install ${variantTask}: ${error.message}`);
                reject(error);
            });

            this.buildProcess.on('close', (code) => {
                this.buildProcess = null;
                if (code === 0) {
                    showMsg(MsgType.info, `${variantTask} installed successfully.`);
                    resolve();
                } else {
                    this.manager.output.append(stderr, "error");
                    const errorMsg = stderr || stdout || `Gradle build failed with exit code ${code}`;
                    console.error(`[GradleService] Build failed. Exit code: ${code}, stderr: ${stderr}, stdout: ${stdout}`);
                    showMsg(MsgType.error, `Failed to install ${variantTask}. Exit code: ${code}`);
                    reject(new Error(errorMsg));
                }
            });
        });
    }

    public async assembleVariant(
        variantTask: string,
        onOutput?: (output: string) => void,
        cancellationToken?: vscode.CancellationToken
    ): Promise<void> {
        if (!this.projectPath) {
            throw new Error("No Android project found. Please open a folder containing an Android project.");
        }

        // Get command from executable
        const commandProp = this.gradle.getCommand(Command.assemble);
        const cmd = this.gradle.getCmd(commandProp, variantTask);

        return new Promise<void>((resolve, reject) => {
            // Check cancellation before starting
            if (cancellationToken?.isCancellationRequested) {
                reject(new Error("Build was cancelled"));
                return;
            }

            const spawnOptions: child_process.SpawnOptions = {
                shell: true,
                cwd: this.projectPath,
            };

            this.buildProcess = child_process.spawn(cmd, [], spawnOptions);

            let stdout = '';
            let stderr = '';

            if (this.buildProcess.stdout) {
                this.buildProcess.stdout.on('data', (data) => {
                    const output = Buffer.from(data).toString();
                    stdout += output;
                    if (onOutput) {
                        onOutput(output);
                    }
                    this.manager.output.append(output);
                });
            }

            if (this.buildProcess.stderr) {
                this.buildProcess.stderr.on('data', (data) => {
                    const output = Buffer.from(data).toString();
                    stderr += output;
                    if (onOutput) {
                        onOutput(output);
                    }
                    this.manager.output.append(output, "error");
                });
            }

            // Handle cancellation
            if (cancellationToken) {
                const cancellationListener = cancellationToken.onCancellationRequested(() => {
                    if (this.buildProcess) {
                        this.buildProcess.kill('SIGTERM');
                        this.buildProcess = null;
                    }
                    reject(new Error("Build was cancelled"));
                });
                this.buildProcess.on('close', () => {
                    cancellationListener.dispose();
                });
            }

            this.buildProcess.on('error', (error) => {
                this.buildProcess = null;
                this.manager.output.append(stderr, "error");
                showMsg(MsgType.error, `Failed to assemble ${variantTask}: ${error.message}`);
                reject(error);
            });

            this.buildProcess.on('close', (code) => {
                this.buildProcess = null;
                if (code === 0) {
                    showMsg(MsgType.info, `${variantTask} assembled successfully.`);
                    resolve();
                } else {
                    this.manager.output.append(stderr, "error");
                    showMsg(MsgType.error, `Failed to assemble ${variantTask}. Exit code: ${code}`);
                    reject(new Error(`Gradle build failed with exit code ${code}`));
                }
            });
        });
    }

    public isBuildInProgress(): boolean {
        return this.buildProcess !== null;
    }

    public cancelBuild(): void {
        if (this.buildProcess) {
            try {
                this.buildProcess.kill('SIGTERM');
            } catch (error) {
                console.error('[GradleService] Error cancelling build:', error);
            }
            this.buildProcess = null;
        }
    }
}

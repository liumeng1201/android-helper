import * as cp from 'child_process';
import * as vscode from 'vscode';
import { DeviceManager } from './DeviceManager';

const BOOT_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 2000;
const SETTLE_DELAY_MS = 2000;

export type OutputChannelLike = { appendLine(line: string): void };
export type ProgressLike = vscode.Progress<{ message?: string }>;

/**
 * EmulatorBootService — manages emulator launch + boot wait.
 *
 * Uses DeviceManager to resolve the ADB serial for a given AVD name (event‑driven,
 * no polling). Still polls `getprop` for boot completion since that's the only
 * reliable way to know when the emulator is fully booted.
 */
export class EmulatorBootService {
    constructor(
        private readonly deviceManager: DeviceManager,
        private readonly emulatorPath: string,
        private readonly outputChannel: OutputChannelLike,
    ) {}

    /**
     * Launch emulator (if not already running) and wait until
     * ADB reports it fully booted. Returns the resolved ADB serial.
     */
    async launchAndWait(
        avdName: string,
        progress: ProgressLike,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<string> {
        // Step 1: Check if already running via DeviceManager
        const existing = this.deviceManager.findDeviceByAvdName(avdName);
        if (existing) {
            this._log(`${avdName} already running as ${existing.serial}`);
            const booted = await this._isBooted(existing.serial);
            if (booted) {
                this._log(`${existing.serial} already fully booted`);
                return existing.serial;
            }
            this._log(`${existing.serial} found but not fully booted yet — waiting...`);
            return this._waitForBoot(existing.serial, avdName, progress, cancellationToken);
        }

        // Step 2: Fire-and-forget spawn — DO NOT await; process runs until emulator is closed
        this._spawnEmulator(avdName);

        // Step 3: Wait for device to appear (event-driven via DeviceManager)
        return this._waitForBoot(null, avdName, progress, cancellationToken);
    }

    /**
     * Spawns the emulator detached — never awaited.
     */
    private _spawnEmulator(avdName: string): void {
        this._log(`Spawning: ${this.emulatorPath} @${avdName}`);

        const proc = cp.spawn(this.emulatorPath, [`@${avdName}`], {
            detached: true,
            stdio: 'ignore',
        });

        proc.unref();

        proc.on('error', (err) => {
            this._log(`Emulator spawn error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to start emulator: ${err.message}`);
        });
    }

    /**
     * Phase 1 — wait for the device to appear (via DeviceManager event).
     * Phase 2 — poll boot_completed + bootanim on that serial.
     */
    private async _waitForBoot(
        knownSerial: string | null,
        avdName: string,
        progress: ProgressLike,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<string> {
        const start = Date.now();

        let serial = knownSerial;

        if (!serial) {
            progress.report({ message: `Starting ${avdName}...` });
            serial = await this._waitForSerial(avdName, start, progress, cancellationToken);
        }

        await this._pollForBootCompleted(serial, start, progress, cancellationToken);

        progress.report({ message: 'Almost ready...' });
        await this._delay(SETTLE_DELAY_MS);

        this._log(`${serial} fully booted and ready`);
        return serial;
    }

    /**
     * Wait for the AVD to appear in DeviceManager (event-driven).
     * Falls back to a safety polling loop only if DeviceManager isn't tracking.
     */
    private async _waitForSerial(
        avdName: string,
        start: number,
        progress: ProgressLike,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<string> {
        // Primary: event-driven wait via DeviceManager
        try {
            const serial = await this._waitForDeviceManager(avdName, start, progress, cancellationToken);
            this._log(`Resolved ADB serial via DeviceManager: ${serial}`);
            return serial;
        } catch (err: any) {
            if (err.message?.includes('was cancelled')) throw err;
            // DeviceManager wait timed out — fall through to polling fallback
            this._log(`DeviceManager wait failed (${err.message}), falling back to polling...`);
        }

        // Fallback: traditional polling
        return this._pollForSerial(avdName, start, progress, cancellationToken);
    }

    private async _waitForDeviceManager(
        avdName: string,
        start: number,
        _progress: ProgressLike,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<string> {
        const remaining = BOOT_TIMEOUT_MS - (Date.now() - start);
        if (remaining <= 0) {
            throw new Error(`Timed out waiting for ${avdName} to appear in adb devices`);
        }

        // Use DeviceManager.waitForDevice with a cancellation-aware wrapper
        const devicePromise = this.deviceManager.waitForDevice(avdName, remaining);

        if (!cancellationToken) {
            return devicePromise;
        }

        return new Promise<string>((resolve, reject) => {
            const cancelListener = cancellationToken.onCancellationRequested(() => {
                reject(new Error('Build was cancelled'));
            });

            devicePromise
                .then((serial) => {
                    cancelListener.dispose();
                    resolve(serial);
                })
                .catch((err) => {
                    cancelListener.dispose();
                    reject(err);
                });
        });
    }

    /** Polling fallback — same logic as the original implementation. */
    private _pollForSerial(
        avdName: string,
        start: number,
        progress: ProgressLike,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setInterval(async () => {
                const elapsed = Math.round((Date.now() - start) / 1000);

                if (cancellationToken?.isCancellationRequested) {
                    clearInterval(timer);
                    reject(new Error('Build was cancelled'));
                    return;
                }
                if (Date.now() - start > BOOT_TIMEOUT_MS) {
                    clearInterval(timer);
                    reject(
                        new Error(
                            `Timed out waiting for ${avdName} to appear in adb devices (${elapsed}s)`,
                        ),
                    );
                    return;
                }

                progress.report({ message: `Waiting for emulator to connect... (${elapsed}s)` });

                try {
                    const serial = await this._findSerialForAvdPolling(avdName);
                    if (serial) {
                        clearInterval(timer);
                        this._log(`Resolved ADB serial (polling fallback): ${serial}`);
                        resolve(serial);
                    }
                } catch {
                    /* adb not ready */
                }
            }, POLL_INTERVAL_MS);
        });
    }

    private async _pollForBootCompleted(
        serial: string,
        start: number,
        progress: ProgressLike,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setInterval(async () => {
                const elapsed = Math.round((Date.now() - start) / 1000);

                if (cancellationToken?.isCancellationRequested) {
                    clearInterval(timer);
                    reject(new Error('Build was cancelled'));
                    return;
                }
                if (Date.now() - start > BOOT_TIMEOUT_MS) {
                    clearInterval(timer);
                    reject(
                        new Error(
                            `Emulator ${serial} did not finish booting (${elapsed}s)`,
                        ),
                    );
                    return;
                }

                progress.report({ message: `Emulator booting... (${elapsed}s)` });

                try {
                    const booted = await this._isBooted(serial);
                    if (booted) {
                        clearInterval(timer);
                        resolve();
                    }
                } catch {
                    /* shell not ready yet */
                }
            }, POLL_INTERVAL_MS);
        });
    }

    private async _isBooted(serial: string): Promise<boolean> {
        const adbPath = this.deviceManager.getAdbPath();
        const [bootCompleted, bootAnim] = await Promise.all([
            this._getProp(adbPath, serial, 'sys.boot_completed'),
            this._getProp(adbPath, serial, 'init.svc.bootanim'),
        ]);
        this._log(`${serial} — boot_completed=${bootCompleted} bootanim=${bootAnim}`);
        return bootCompleted === '1' && bootAnim === 'stopped';
    }

    /** Polling fallback: find serial for AVD by running adb devices -l. */
    private async _findSerialForAvdPolling(avdName: string): Promise<string | null> {
        const adbPath = this.deviceManager.getAdbPath();
        const output = await this._exec(`"${adbPath}" devices -l`);
        const lines = output.split('\n').filter((l) => /^emulator-\d+/.test(l.trim()));

        for (const line of lines) {
            if (line.includes(`avd_name:${avdName}`)) {
                return line.trim().split(/\s+/)[0];
            }
        }

        for (const line of lines) {
            const serial = line.trim().split(/\s+/)[0];
            if (!serial) continue;
            try {
                const name = await this._exec(`"${adbPath}" -s ${serial} emu avd name`);
                if (name.split('\n')[0].trim() === avdName) {
                    return serial;
                }
            } catch {
                /* this emulator not responding yet */
            }
        }

        return null;
    }

    private _getProp(adbPath: string, serial: string, prop: string): Promise<string> {
        return this._exec(`"${adbPath}" -s ${serial} shell getprop ${prop}`)
            .then((s) => s.trim())
            .catch(() => '');
    }

    private _exec(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(cmd, { timeout: 5000 }, (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(stdout ?? '');
            });
        });
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }

    private _log(msg: string): void {
        this.outputChannel.appendLine(`[EmulatorBoot] ${msg}`);
    }
}

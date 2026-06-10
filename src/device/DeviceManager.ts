import * as cp from 'child_process';
import { EventEmitter, Disposable } from 'vscode';

export interface DeviceInfo {
    serial: string;
    state: 'device' | 'offline' | 'connecting' | 'unknown';
    avdName?: string;
    product?: string;
    model?: string;
    device?: string;
    transportId?: string;
    isEmulator: boolean;
}

/**
 * DeviceManager — globally shared singleton.
 *
 * Uses `adb track-devices` (long-lived streaming process) to react instantly
 * when devices are added / removed / change state, then runs `adb devices -l`
 * to enrich with product/model details and resolves AVD names for emulators.
 *
 * Events:
 *   onDeviceAdded(device)       – a new device appeared
 *   onDeviceRemoved(device)     – a device was disconnected
 *   onDeviceChanged(serial, oldState, newState) – state transition
 *   onDeviceListChanged(DeviceInfo[]) – full list after any change
 */
export class DeviceManager implements Disposable {
    private trackProcess: cp.ChildProcess | null = null;
    private devices: Map<string, DeviceInfo> = new Map();
    private _disposed = false;
    private restartTimer: NodeJS.Timeout | null = null;
    private resolveInitialRefresh: (() => void) | null = null;
    private initialRefreshDone = false;

    // ── Events ──────────────────────────────────────────────────────────────
    private _onDeviceAdded = new EventEmitter<DeviceInfo>();
    readonly onDeviceAdded = this._onDeviceAdded.event;

    private _onDeviceRemoved = new EventEmitter<DeviceInfo>();
    readonly onDeviceRemoved = this._onDeviceRemoved.event;

    private _onDeviceChanged = new EventEmitter<{
        serial: string;
        oldState: string;
        newState: string;
    }>();
    readonly onDeviceChanged = this._onDeviceChanged.event;

    private _onDeviceListChanged = new EventEmitter<DeviceInfo[]>();
    readonly onDeviceListChanged = this._onDeviceListChanged.event;

    constructor(private adbPath: string) {}

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /** Update the ADB path when SDK config changes. */
    setAdbPath(adbPath: string): void {
        this.adbPath = adbPath;
    }

    getAdbPath(): string {
        return this.adbPath;
    }

    /** Start tracking ADB devices. Safe to call multiple times. */
    start(): void {
        if (this.trackProcess || this._disposed) return;
        this.startTracking();
    }

    /** Stop tracking and release all resources. */
    stop(): void {
        this._disposed = true;
        this.clearRestartTimer();
        if (this.trackProcess) {
            try {
                this.trackProcess.kill('SIGTERM');
            } catch {
                // process may already be dead
            }
            this.trackProcess = null;
        }
    }

    dispose(): void {
        this.stop();
        this._onDeviceAdded.dispose();
        this._onDeviceRemoved.dispose();
        this._onDeviceChanged.dispose();
        this._onDeviceListChanged.dispose();
    }

    /** Returns a promise that resolves once the first `adb devices -l` refresh is complete. */
    waitForInitialRefresh(): Promise<void> {
        if (this.initialRefreshDone) return Promise.resolve();
        return new Promise((resolve) => {
            this.resolveInitialRefresh = resolve;
        });
    }

    // ── Query helpers ───────────────────────────────────────────────────────

    getDevices(): DeviceInfo[] {
        return Array.from(this.devices.values());
    }

    getDevice(serial: string): DeviceInfo | undefined {
        return this.devices.get(serial);
    }

    /** Find a device that matches the given AVD name (emulator only). */
    findDeviceByAvdName(avdName: string): DeviceInfo | undefined {
        for (const device of this.devices.values()) {
            if (device.avdName === avdName) return device;
        }
        return undefined;
    }

    /**
     * Wait for a device matching `avdName` to appear with state === 'device'.
     * Resolves immediately if the device is already tracked.
     * Rejects after `timeoutMs` milliseconds.
     */
    waitForDevice(avdName: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            // Already available?
            const existing = this.findDeviceByAvdName(avdName);
            if (existing && existing.state === 'device') {
                resolve(existing.serial);
                return;
            }

            const timer = setTimeout(() => {
                changeListener.dispose();
                addListener.dispose();
                reject(
                    new Error(
                        `Timed out waiting for ${avdName} to appear in adb devices (${timeoutMs / 1000}s)`,
                    ),
                );
            }, timeoutMs);

            const addListener = this._onDeviceAdded.event((device) => {
                if (device.avdName === avdName && device.state === 'device') {
                    clearTimeout(timer);
                    addListener.dispose();
                    changeListener.dispose();
                    resolve(device.serial);
                }
            });

            const changeListener = this._onDeviceChanged.event(({ serial, newState }) => {
                const device = this.devices.get(serial);
                if (device && device.avdName === avdName && newState === 'device') {
                    clearTimeout(timer);
                    addListener.dispose();
                    changeListener.dispose();
                    resolve(serial);
                }
            });
        });
    }

    // ── Internal: adb track-devices ─────────────────────────────────────────

    private startTracking(): void {
        if (this._disposed) return;

        console.log(`[DeviceManager] Starting adb track-devices...`);

        const proc = cp.spawn(this.adbPath, ['track-devices'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        this.trackProcess = proc;

        let buffer = '';

        proc.stdout?.on('data', (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split(/\r?\n/);
            // Keep the last (possibly incomplete) line in the buffer
            buffer = lines.pop() || '';

            // A blank line signals the end of a batch in track-devices
            const batchEndIndex = lines.indexOf('');
            if (batchEndIndex >= 0) {
                const deviceLines = lines.slice(0, batchEndIndex).filter((l) => {
                    const trimmed = l.trim();
                    return trimmed && !trimmed.startsWith('*') && !trimmed.startsWith('List');
                });
                if (deviceLines.length > 0) {
                    this.processTrackDeviceChanges(deviceLines);
                }
                // Keep everything after the blank line in buffer for next batch
                buffer = lines.slice(batchEndIndex + 1).join('\n') + buffer;
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                console.error(`[DeviceManager] stderr: ${msg}`);
            }
        });

        proc.on('error', (err) => {
            console.error(`[DeviceManager] Process error: ${err.message}`);
            this.trackProcess = null;
            this.scheduleRestart();
        });

        proc.on('exit', (code, signal) => {
            console.log(`[DeviceManager] Process exited: code=${code} signal=${signal}`);
            this.trackProcess = null;
            if (!this._disposed) {
                this.scheduleRestart();
            }
        });

        // Initial full refresh to populate the device list
        this.refreshDeviceDetails().then(() => {
            this.initialRefreshDone = true;
            if (this.resolveInitialRefresh) {
                this.resolveInitialRefresh();
                this.resolveInitialRefresh = null;
            }
        });
    }

    /** Process a batch of device state lines from track-devices. */
    private processTrackDeviceChanges(lines: string[]): void {
        const batchSerials = new Set<string>();
        const previousSerials = new Set(this.devices.keys());

        for (const line of lines) {
            const parts = line.split('\t');
            const serial = parts[0].trim();
            const state = parts[1]?.trim() || 'unknown';
            batchSerials.add(serial);

            const existing = this.devices.get(serial);
            if (!existing) {
                // New device — trigger a full detail refresh
                this.refreshDeviceDetails().then(() => {
                    const device = this.devices.get(serial);
                    if (device) {
                        this._onDeviceAdded.fire(device);
                        this._onDeviceListChanged.fire(this.getDevices());
                    }
                });
            } else if (existing.state !== state) {
                const oldState = existing.state;
                existing.state = state as DeviceInfo['state'];
                this.devices.set(serial, existing);
                this._onDeviceChanged.fire({ serial, oldState, newState: state });
                this._onDeviceListChanged.fire(this.getDevices());
            }
        }

        // Removed devices
        for (const serial of previousSerials) {
            if (!batchSerials.has(serial)) {
                const device = this.devices.get(serial)!;
                this.devices.delete(serial);
                this._onDeviceRemoved.fire(device);
                this._onDeviceListChanged.fire(this.getDevices());
            }
        }
    }

    // ── Internal: adb devices -l (full detail) ─────────────────────────────

    private async refreshDeviceDetails(): Promise<void> {
        try {
            const output = await this.exec(`"${this.adbPath}" devices -l`);
            const lines = output.split(/\r?\n/);

            const seenSerials = new Set<string>();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('List') || trimmed.startsWith('*')) continue;

                const parts = trimmed.split(/\s+/);
                if (parts.length < 2) continue;

                const serial = parts[0];
                const state = parts[1];
                seenSerials.add(serial);

                // Parse -l extra fields
                let product: string | undefined;
                let model: string | undefined;
                let deviceModel: string | undefined;
                let transportId: string | undefined;

                for (const part of parts.slice(2)) {
                    if (part.startsWith('product:')) product = part.split(':')[1];
                    else if (part.startsWith('model:'))
                        model = (part.split(':')[1] || '').replace(/_/g, ' ');
                    else if (part.startsWith('device:')) deviceModel = part.split(':')[1];
                    else if (part.startsWith('transport_id:')) transportId = part.split(':')[1];
                }

                const isEmulator = serial.startsWith('emulator-');
                const existing = this.devices.get(serial);

                const info: DeviceInfo = {
                    serial,
                    state: state as DeviceInfo['state'],
                    product,
                    model: model || existing?.model,
                    device: deviceModel,
                    transportId,
                    isEmulator,
                    avdName: existing?.avdName, // preserve previously resolved AVD name
                };

                this.devices.set(serial, info);
            }

            // Resolve AVD names for emulators (async, doesn't block)
            this.resolveAVDNames();
        } catch (err) {
            console.error('[DeviceManager] Failed to refresh device details:', err);
        }
    }

    /** For each emulator device without an avdName, query it via `emu avd name`. */
    private async resolveAVDNames(): Promise<void> {
        for (const [serial, device] of this.devices.entries()) {
            if (device.isEmulator && !device.avdName) {
                try {
                    const output = await this.exec(
                        `"${this.adbPath}" -s ${serial} emu avd name`,
                    );
                    const name = output.split('\n')[0].trim();
                    if (name && !name.includes('error') && !name.includes('KO')) {
                        device.avdName = name;
                        this.devices.set(serial, device);
                        this._onDeviceChanged.fire({
                            serial,
                            oldState: device.state,
                            newState: device.state,
                        });
                        this._onDeviceListChanged.fire(this.getDevices());
                    }
                } catch {
                    // emulator not ready yet — will retry on next refresh
                }
            }
        }
    }

    // ── Internal: helpers ───────────────────────────────────────────────────

    private scheduleRestart(): void {
        if (this._disposed) return;
        this.clearRestartTimer();
        this.restartTimer = setTimeout(() => {
            if (!this._disposed) {
                console.log('[DeviceManager] Restarting track-devices...');
                this.startTracking();
            }
        }, 3000);
    }

    private clearRestartTimer(): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }

    private exec(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(cmd, { timeout: 10000 }, (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(stdout ?? '');
            });
        });
    }
}

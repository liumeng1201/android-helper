import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ASlElement } from '../shared/components/element.js';
import { elementBase } from '../shared/components/styles/base.css.js';
import '../shared/components/dropdown.js';
import '../shared/components/button.js';
import '../shared/components/toggle-button.js';
import type { DropdownOption } from '../shared/components/dropdown.js';

const playIcon = `<svg width="11" height="13" viewBox="0 0 11 13" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M0 11.2354V1.06934C0 0.703125 0.090332 0.43457 0.270996 0.263672C0.45166 0.0878906 0.666504 0 0.915527 0C1.13525 0 1.35986 0.0634766 1.58936 0.19043L10.1221 5.17822C10.4248 5.354 10.6348 5.5127 10.752 5.6543C10.874 5.79102 10.9351 5.95703 10.9351 6.15234C10.9351 6.34277 10.874 6.50879 10.752 6.65039C10.6348 6.79199 10.4248 6.95068 10.1221 7.12646L1.58936 12.1143C1.35986 12.2412 1.13525 12.3047 0.915527 12.3047C0.666504 12.3047 0.45166 12.2168 0.270996 12.041C0.090332 11.8652 0 11.5967 0 11.2354Z" fill="white"/>
</svg>`;

const progressSpinnerIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" class="spinner-icon">
<rect x="7" width="2" height="5" rx="1" fill="white" fill-opacity="0.8"/>
<rect x="12.9497" y="1.63604" width="2" height="5" rx="1" transform="rotate(45 12.9497 1.63604)" fill="white" fill-opacity="0.1"/>
<rect x="16" y="7" width="2" height="5" rx="1" transform="rotate(90 16 7)" fill="white" fill-opacity="0.2"/>
<rect x="14.364" y="12.9497" width="2" height="5" rx="1" transform="rotate(135 14.364 12.9497)" fill="white" fill-opacity="0.3"/>
<rect x="9" y="16" width="2" height="5" rx="1" transform="rotate(180 9 16)" fill="white" fill-opacity="0.4"/>
<rect x="3.05029" y="14.364" width="2" height="5" rx="1" transform="rotate(-135 3.05029 14.364)" fill="white" fill-opacity="0.5"/>
<rect y="9" width="2" height="5" rx="1" transform="rotate(-90 0 9)" fill="white" fill-opacity="0.6"/>
<rect x="1.63599" y="3.05025" width="2" height="5" rx="1" transform="rotate(-45 1.63599 3.05025)" fill="white" fill-opacity="0.7"/>
</svg>`;

interface DeviceInfo {
    serial: string;
    state: 'device' | 'offline' | 'connecting' | 'unknown';
    avdName?: string;
    product?: string;
    model?: string;
    device?: string;
    transportId?: string;
    isEmulator: boolean;
}

interface Module {
    module: string;
    type: string;
    variants?: any[];
}

@customElement('asl-avd-selector-app')
export class ASlAVDSelectorApp extends ASlElement {
    static override styles = [
        elementBase,
        css`
			:host {
				display: block;
				width: 100%;
				padding: 0.75rem;
				font-family: var(--vscode-font-family);
				font-size: var(--vscode-font-size);
				color: var(--vscode-foreground);
				background-color: var(--vscode-sideBar-background);
			}

			.container {
				display: flex;
				flex-direction: column;
				gap: 0.75rem;
			}

			.section-title {
				font-size: 0.875rem;
				font-weight: 600;
				color: var(--vscode-foreground);
				margin: 0;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}

			.dropdown-container {
				width: 100%;
			}

			.dropdown-label {
				font-size: 0.75rem;
				font-weight: 500;
				color: var(--vscode-descriptionForeground);
				margin-bottom: 0.25rem;
			}

			.button-group {
				display: flex;
				gap: 0.5rem;
				width: 100%;
				margin-top: 0.5rem;
			}

			.button-group asl-button {
				flex: 1;
			}

			.button-group asl-toggle-button {
				flex: 0 0 auto;
			}

			.open-project-placeholder {
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				gap: 1rem;
				padding: 1.5rem;
				text-align: center;
				color: var(--vscode-descriptionForeground);
				min-height: 120px;
			}

			.open-project-placeholder .message {
				font-size: var(--vscode-font-size);
				margin: 0;
			}

			.open-project-placeholder asl-button {
				min-width: 180px;
			}

			.devices-section {
				width: 100%;
			}

			.devices-list {
				display: flex;
				flex-direction: column;
				gap: 0.25rem;
				margin-top: 0.25rem;
			}

			.device-item {
				display: flex;
				align-items: center;
				gap: 0.375rem;
				padding: 0.25rem 0.375rem;
				font-size: 0.75rem;
				border-radius: 3px;
				background-color: var(--vscode-list-hoverBackground, transparent);
			}

			.device-icon {
				flex-shrink: 0;
				width: 14px;
				height: 14px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 0.75rem;
			}

			.device-serial {
				font-family: var(--vscode-editor-font-family, monospace);
				color: var(--vscode-editor-foreground);
				flex: 1;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.device-name {
				color: var(--vscode-descriptionForeground);
				margin-left: 0.25rem;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				max-width: 120px;
			}

			.device-state {
				flex-shrink: 0;
				font-size: 0.6875rem;
				padding: 0.0625rem 0.375rem;
				border-radius: 3px;
				font-weight: 500;
			}

			.device-state.device {
				color: var(--vscode-testing-iconPassed, #4ec9b0);
				background-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #4ec9b0) 15%, transparent);
			}

			.device-state.offline,
			.device-state.connecting {
				color: var(--vscode-list-warningForeground, #cca700);
				background-color: color-mix(in srgb, var(--vscode-list-warningForeground, #cca700) 15%, transparent);
			}

			.device-state.unknown {
				color: var(--vscode-disabledForeground);
				background-color: color-mix(in srgb, var(--vscode-disabledForeground) 10%, transparent);
			}

			.no-devices {
				font-size: 0.75rem;
				color: var(--vscode-descriptionForeground);
				padding: 0.25rem 0.375rem;
				font-style: italic;
			}
		`,
    ];

    @state()
    private selectedDeviceSerial: string = '';

    @state()
    private modules: Module[] = [];

    @state()
    private selectedModule: string = '';

    @state()
    private isBuilding: boolean = false;

    @state()
    private buildCancellable: boolean = false;

    @state()
    private logcatActive: boolean = false;

    @state()
    private logcatAvailable: boolean = false;

    @state()
    private isAndroidProject: boolean = true;

    @state()
    private projectPath: string = '';

    @state()
    private devices: DeviceInfo[] = [];

    private vscode: any;
    private buildCancellationToken: string | null = null;

    private get deviceOptions(): DropdownOption[] {
        // Only show devices that are in 'device' state (ready to use)
        const connected = this.devices.filter(d => d.state === 'device');
        return connected.map(device => {
            const label = device.model
                ? `${device.model} (${device.serial})`
                : device.avdName
                    ? `${device.avdName} (${device.serial})`
                    : device.serial;
            return {
                value: device.serial,
                label,
                device,
            };
        });
    }

    private get moduleOptions(): DropdownOption[] {
        return this.modules.map(module => ({
            value: module.module,
            label: module.module,
            module,
        }));
    }

    private handleDeviceChange(e: CustomEvent) {
        const { value } = e.detail;
        if (value !== this.selectedDeviceSerial) {
            this.selectedDeviceSerial = value;
            const device = this.devices.find(d => d.serial === value);
            if (this.vscode) {
                this.vscode.postMessage({
                    type: 'select-device',
                    params: { deviceSerial: value, avdName: device?.avdName },
                });
            }
        }
    }

    private handleModuleChange(e: CustomEvent) {
        const { value } = e.detail;
        if (value !== this.selectedModule) {
            this.selectedModule = value;
            if (this.vscode) {
                this.vscode.postMessage({
                    type: 'select-module',
                    params: { moduleName: value },
                });
            }
        }
    }

    private handleRunClick() {
        if (!this.selectedDeviceSerial || !this.selectedModule || this.isBuilding) {
            return;
        }

        if (this.vscode) {
            this.isBuilding = true;
            this.buildCancellable = true;
            this.buildCancellationToken = `cancel-${Date.now()}`;

            const device = this.devices.find(d => d.serial === this.selectedDeviceSerial);

            this.vscode.postMessage({
                type: 'run-app',
                params: {
                    deviceSerial: this.selectedDeviceSerial,
                    avdName: device?.avdName,
                    moduleName: this.selectedModule,
                    cancellationToken: this.buildCancellationToken,
                },
            });
        }
    }

    private handleCancelClick() {
        if (!this.buildCancellable || !this.buildCancellationToken) {
            return;
        }

        if (this.vscode) {
            this.vscode.postMessage({
                type: 'cancel-build',
                params: {
                    cancellationToken: this.buildCancellationToken,
                },
            });
        }
    }

    private handleLogcatToggle(e: CustomEvent) {
        const { checked } = e.detail;
        this.logcatActive = checked;

        if (this.vscode) {
            this.vscode.postMessage({
                type: 'toggle-logcat',
                params: { active: checked },
            });
        }
    }

    private handleMessage = (event: MessageEvent) => {
        const message = event.data;
        switch (message.type) {
            case 'update-modules':
                const { modules } = message.params || {};
                if (modules) {
                    this.modules = modules;
                    // Select first module if none selected
                    if (!this.selectedModule && modules.length > 0) {
                        this.selectedModule = modules[0].module;
                    }
                }
                break;
            case 'webview/ready':
                // Handle bootstrap data from ready response
                if (message.params && message.params.state) {
                    const state = message.params.state;
                    if (state.devices) {
                        this.devices = state.devices;
                        this._autoSelectDevice();
                    }
                    if (state.modules) {
                        this.modules = state.modules;
                        if (state.selectedModule) {
                            this.selectedModule = state.selectedModule;
                        } else if (this.modules.length > 0) {
                            this.selectedModule = this.modules[0].module;
                        }
                    }
                    if (typeof state.logcatAvailable === 'boolean') {
                        this.logcatAvailable = state.logcatAvailable;
                    }
                    if (typeof state.projectPath === 'string') {
                        this.projectPath = state.projectPath;
                    }
                }
                break;
            case 'build-started':
                this.isBuilding = true;
                this.buildCancellable = true;
                if (message.params?.cancellationToken) {
                    this.buildCancellationToken = message.params.cancellationToken;
                }
                break;
            case 'build-completed':
            case 'build-failed':
            case 'build-cancelled':
                this.isBuilding = false;
                this.buildCancellable = false;
                this.buildCancellationToken = null;
                break;
            case 'logcat-state-changed':
                const { active } = message.params || {};
                if (typeof active === 'boolean') {
                    this.logcatActive = active;
                }
                break;
            case 'update-devices':
                const { devices } = message.params || {};
                if (devices) {
                    this.devices = devices;
                    this._autoSelectDevice();
                }
                break;
            case 'update-android-project-state':
                if (typeof message.params?.isAndroidProject === 'boolean') {
                    this.isAndroidProject = message.params.isAndroidProject;
                }
                if (typeof message.params?.projectPath === 'string') {
                    this.projectPath = message.params.projectPath;
                }
                break;
        }
    };

    /** Auto-select the first 'device' state device if none is currently selected. */
    private _autoSelectDevice(): void {
        if (this.selectedDeviceSerial) {
            // Keep existing selection if still connected
            const stillExists = this.devices.some(
                d => d.serial === this.selectedDeviceSerial && d.state === 'device',
            );
            if (stillExists) return;
        }
        // Select first connected device
        const connected = this.devices.filter(d => d.state === 'device');
        if (connected.length > 0) {
            this.selectedDeviceSerial = connected[0].serial;
        } else {
            this.selectedDeviceSerial = '';
        }
    }

    private handleOpenFolderClick() {
        if (this.vscode) {
            this.vscode.postMessage({ type: 'open-folder' });
        }
    }

    override connectedCallback() {
        super.connectedCallback();

        // Initialize VS Code API
        if (typeof (window as any).acquireVsCodeApi !== 'undefined') {
            this.vscode = (window as any).acquireVsCodeApi();
        }

        // Listen for messages from extension
        window.addEventListener('message', this.handleMessage);

        // Request initial device list and modules
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-devices' });
            this.vscode.postMessage({ type: 'refresh-modules' });
        }

        // Load bootstrap data if available
        if (typeof (window as any).bootstrap !== 'undefined') {
            try {
                // Bootstrap is a base64 encoded JSON string
                const bootstrapStr = (window as any).bootstrap;
                const bootstrap = typeof bootstrapStr === 'string'
                    ? JSON.parse(atob(bootstrapStr))
                    : bootstrapStr;
                if (bootstrap && bootstrap.devices) {
                    this.devices = bootstrap.devices;
                    this._autoSelectDevice();
                }
                if (bootstrap && bootstrap.modules) {
                    this.modules = bootstrap.modules;
                    if (bootstrap.selectedModule) {
                        this.selectedModule = bootstrap.selectedModule;
                    } else if (this.modules.length > 0) {
                        this.selectedModule = this.modules[0].module;
                    }
                }
                if (typeof bootstrap?.projectPath === 'string') {
                    this.projectPath = bootstrap.projectPath;
                }
                if (typeof bootstrap?.isAndroidProject === 'boolean') {
                    this.isAndroidProject = bootstrap.isAndroidProject;
                }
                if (typeof bootstrap?.logcatAvailable === 'boolean') {
                    this.logcatAvailable = bootstrap.logcatAvailable;
                }
            } catch (e) {
                console.error('Failed to parse bootstrap data:', e);
            }
        }

        // Send ready message to extension
        if (this.vscode) {
            this.vscode.postMessage({ type: 'webview/ready' });
        }
    }

    override disconnectedCallback() {
        super.disconnectedCallback();
        window.removeEventListener('message', this.handleMessage);
    }

    override render() {
        if (!this.isAndroidProject) {
            return html`
				<div class="container">
					<h2 class="section-title">Android Studio Lite</h2>
					<div class="open-project-placeholder">
						<p class="message">Open an Android project to run and debug apps.</p>
						<asl-button
							label="Open Folder"
							variant="primary"
							@button-click=${this.handleOpenFolderClick}
						></asl-button>
					</div>
				</div>
			`;
        }

        return html`
			<div class="container">
				<h2 class="section-title">Android Studio Lite</h2>

				<div class="dropdown-container">
					<div class="dropdown-label">Select Device</div>
					<asl-dropdown
						.options=${this.deviceOptions}
						.value=${this.selectedDeviceSerial}
						placeholder=${this.devices.length > 0 ? 'No connected devices' : 'No devices detected'}
						@change=${this.handleDeviceChange}
					></asl-dropdown>
				</div>

				<div class="dropdown-container">
					<div class="dropdown-label">Select Module</div>
					<asl-dropdown
						.options=${this.moduleOptions}
						.value=${this.selectedModule}
						placeholder="No modules available"
						@change=${this.handleModuleChange}
					></asl-dropdown>
				</div>

				<div class="button-group">
					<asl-button
						icon=${this.isBuilding ? progressSpinnerIcon : playIcon}
						label=${this.isBuilding ? 'Building...' : 'Run'}
						?disabled=${!this.selectedDeviceSerial || !this.selectedModule || this.isBuilding}
						@button-click=${this.handleRunClick}
					></asl-button>
					<asl-button
						variant="secondary"
						icon="⏹"
						label="Cancel"
						?disabled=${!this.buildCancellable}
						@button-click=${this.handleCancelClick}
					></asl-button>
					${this.logcatAvailable
						? html`<asl-toggle-button
								label="Logcat"
								?checked=${this.logcatActive}
								@toggle-click=${this.handleLogcatToggle}
							></asl-toggle-button>`
						: ''}
				</div>
			</div>
		`;
    }
}

// Initialize the app when the module loads
if (typeof window !== 'undefined') {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            const app = document.createElement('asl-avd-selector-app');
            document.body.appendChild(app);
        });
    } else {
        const app = document.createElement('asl-avd-selector-app');
        document.body.appendChild(app);
    }
}

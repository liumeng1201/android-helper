import * as vscode from 'vscode';
import { AVDTreeView } from './ui/AVDTreeView';
import { BuildVariantTreeView } from './ui/BuildVariantTreeView';
import { Manager, ConfigItem } from './core';
import { subscribe } from './module/';
import { WebviewsController } from './webviews/webviewsController';
import { AVDSelectorProvider } from './webviews/avdSelectorProvider';
import { KotlinImportFoldingProvider } from './language/KotlinImportFoldingProvider';
import { LogcatService } from './service/LogcatService';

export async function activate(context: vscode.ExtensionContext) {
	console.log('Android Helper extension is now active!');

	// Initialize Manager (core singleton)
	const manager = Manager.getInstance();
	await manager.android.initCheck();

	// Provide ExtensionContext to BuildVariantService for project path persistence
	manager.buildVariant.setContext(context);

	// Start ADB device tracking (non-blocking)
	manager.startDeviceManager();

	// Dispose DeviceManager when extension deactivates
	context.subscriptions.push(manager.deviceManager);

	// Kotlin: provide import folding ranges so editor.foldingImportsByDefault works
	context.subscriptions.push(
		vscode.languages.registerFoldingRangeProvider(
			{ language: 'kotlin' },
			new KotlinImportFoldingProvider(),
		),
	);

	// Logcat: built-in service with its own output channel (logs for last-run app only)
	const logcatService = new LogcatService(manager, context);

	// Register AVD Selector webview view using new architecture
	const webviewsController = new WebviewsController(context);
	context.subscriptions.push(webviewsController);

	context.subscriptions.push(
		webviewsController.registerWebviewView(
			{
				id: 'android-helper-avd-dropdown',
				fileName: 'avdSelector.html',
				title: 'Android Helper',
			},
			async (host) => new AVDSelectorProvider(host, context, true),
		)
	);

	//avd manager
	const avdTreeView = new AVDTreeView(context, manager);
	console.log("avd loaded");

	//build variant manager
	new BuildVariantTreeView(context, manager);
	console.log("build variant loaded");

	// Register commands
	subscribe(context, [
		vscode.commands.registerCommand('android-helper.setup-wizard', async () => {
			await manager.android.initCheck();
		}),
		vscode.commands.registerCommand('android-helper.setup-sdkpath', async () => {
			await manager.android.updatePathDiag("dir", ConfigItem.sdkPath, "Please select the Android SDK Root Path", "Android SDK Root path updated!", "Android SDK path not specified!");
		}),
		vscode.commands.registerCommand('android-helper.setup-avdmanager', async () => {
			await manager.android.updatePathDiag("file", ConfigItem.executable, "Please select the AVDManager Path", "AVDManager updated!", "AVDManager path not specified!");
		}),
		vscode.commands.registerCommand('android-helper.setup-sdkmanager', async () => {
			await manager.android.updatePathDiag("file", ConfigItem.sdkManager, "Please select the SDKManager Path", "SDKManager updated!", "SDKManager path not specified!");
		}),
		vscode.commands.registerCommand('android-helper.setup-emulator', async () => {
			await manager.android.updatePathDiag("file", ConfigItem.emulator, "Please select the Emulator Path", "Emulator path updated!", "Emulator path not specified!");
		}),
		vscode.commands.registerCommand('android-helper.startLogcat', async () => {
			await logcatService.start();
		}),
		vscode.commands.registerCommand('android-helper.stopLogcat', () => {
			logcatService.stop();
		}),
		vscode.commands.registerCommand('android-helper.pauseLogcat', () => {
			// Pause = stop for this simple implementation
			logcatService.stop();
		}),
		vscode.commands.registerCommand('android-helper.resumeLogcat', async () => {
			await logcatService.start();
		}),
		vscode.commands.registerCommand('android-helper.clearLogcat', () => {
			logcatService.clear();
		}),
		vscode.commands.registerCommand('android-helper.setLogLevel', async () => {
			logcatService.show();
			vscode.window.showInformationMessage('Filter by log level is not available. Logcat shows all levels for the running app.');
		}),
	]);

}

// this method is called when your extension is deactivated
export function deactivate() {
}

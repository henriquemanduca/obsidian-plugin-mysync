import { App, Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import type { MySyncSettings } from "settings";
import type { PouchDbFileStore } from "sync/pouchdb-store";
import type { VaultFileRecord } from "sync/types";
import {
	collectFilesInFolder,
	createFileRecord,
	getSyncFolder,
	getSyncFolderState,
	isFileInsideSyncFolder
} from "sync/vault-files";
import { Logger } from "utils/logger";

interface LocalSyncResult {
	total: number;
	saved: number;
	skipped: number;
}

interface RestoreResult {
	total: number;
	restored: number;
	skipped: number;
	conflicts: number;
}

export type SyncStatus =
	| { state: "idle" }
	| { state: "queued"; pending: number }
	| { state: "syncing"; current: number; total: number; saved: number; skipped: number }
	| { state: "done"; total: number; saved: number; skipped: number }
	| { state: "pushing"; docsWritten: number }
	| { state: "pushed"; docsWritten: number }
	| { state: "pulling"; docsRead: number }
	| { state: "restoring"; current: number; total: number; restored: number; skipped: number; conflicts: number }
	| { state: "pulled"; docsRead: number; restored: number; skipped: number; conflicts: number }
	| { state: "testing" }
	| { state: "tested"; databaseName: string; documentCount?: number }
	| { state: "error"; message: string };

const logger = new Logger("SyncService");

export class SyncService {
	private syncInProgress = false;
	private pendingSyncPaths = new Set<string>();
	private syncQueueTimer: number | null = null;

	constructor(
		private app: App,
		private store: PouchDbFileStore,
		private getSettings: () => MySyncSettings,
		private onStatusChange: (status: SyncStatus) => void
	) {
		this.onStatusChange({ state: "idle" });
	}

	async syncNow() {
		logger.method("syncNow", { syncInProgress: this.syncInProgress });

		if (this.syncInProgress) {
			new Notice("MySync is already running.");
			return;
		}
		new Notice("MySync synchronization...");

		this.syncInProgress = true;
		let failed = false;

		try {
			const result = await this.syncLocalFiles();
			this.onStatusChange({
				state: "done",
				total: result.total,
				saved: result.saved,
				skipped: result.skipped
			});
			new Notice(`Saved ${result.saved} vault files to PouchDB. Skipped ${result.skipped} unchanged.`);
		} catch (error) {
			failed = true;
			logger.error("Synchronization failed", error);
			this.onStatusChange({
				state: "error",
				message: "synchronization failed"
			});
			new Notice(getErrorMessage(error, "synchronization failed. Check the console for details."));
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	async pushToCouchDb() {
		logger.method("pushToCouchDb", { syncInProgress: this.syncInProgress });

		if (this.syncInProgress) {
			new Notice("MySync is already running.");
			return;
		}
		new Notice("MySync start pushing...");

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings);

		if (validationMessage) {
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;
		let failed = false;

		try {
			const result = await this.syncLocalFiles();

			this.onStatusChange({
				state: "done",
				total: result.total,
				saved: result.saved,
				skipped: result.skipped
			});

			this.onStatusChange({
				state: "pushing",
				docsWritten: 0
			});

			const pushResult = await this.store.pushToCouchDb(
				{
					url: settings.couchDbUrl,
					database: settings.couchDbDatabase,
					username: settings.couchDbUsername,
					password: settings.couchDbPassword
				},
				(docsWritten) => {
					this.onStatusChange({
						state: "pushing",
						docsWritten
					});
				}
			);

			this.onStatusChange({
				state: "pushed",
				docsWritten: pushResult.docsWritten
			});
			new Notice(`Pushed ${pushResult.docsWritten} document changes to CouchDB.`);
		} catch (error) {
			failed = true;
			logger.error("CouchDB push failed", error);
			this.onStatusChange({
				state: "error",
				message: "CouchDB push failed"
			});
			new Notice(getErrorMessage(error, "CouchDB push failed. Check the console for details."));
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	async pullFromCouchDb() {
		// logger.method("pullFromCouchDb", { syncInProgress: this.syncInProgress });

		if (this.syncInProgress) {
			new Notice("MySync sync is already running.");
			return;
		}

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings, "pulling");

		if (validationMessage) {
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;

		try {
			this.onStatusChange({
				state: "pulling",
				docsRead: 0
			});

			const pullResult = await this.store.pullFromCouchDb(
				{
					url: settings.couchDbUrl,
					database: settings.couchDbDatabase,
					username: settings.couchDbUsername,
					password: settings.couchDbPassword
				},
				(docsRead) => {
					this.onStatusChange({
						state: "pulling",
						docsRead
					});
				}
			);

			const records = await this.store.listFileRecords();
			const restoreResult = await this.restoreVaultFiles(records);

			this.onStatusChange({
				state: "pulled",
				docsRead: pullResult.docsRead,
				restored: restoreResult.restored,
				skipped: restoreResult.skipped,
				conflicts: restoreResult.conflicts
			});
			new Notice(
				`Pulled ${pullResult.docsRead} documents. Restored ${restoreResult.restored}, skipped ${restoreResult.skipped}, conflicts ${restoreResult.conflicts}.`
			);
		} catch (error) {
			logger.error("CouchDB pull failed", error);
			this.onStatusChange({
				state: "error",
				message: "CouchDB pull failed"
			});
			new Notice(getErrorMessage(error, "CouchDB pull failed. Check the console for details."));
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();
		}
	}

	async testCouchDbConnection() {
		// logger.method("testCouchDbConnection", { syncInProgress: this.syncInProgress });

		if (this.syncInProgress) {
			new Notice("MySync is already running.");
			return;
		}

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings, "testing");

		if (validationMessage) {
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;

		let failed = false;

		try {
			this.onStatusChange({ state: "testing" });

			const result = await this.store.testCouchDbConnection({
				url: settings.couchDbUrl,
				database: settings.couchDbDatabase,
				username: settings.couchDbUsername,
				password: settings.couchDbPassword
			});

			this.onStatusChange({
				state: "tested",
				databaseName: result.databaseName,
				documentCount: result.documentCount
			});
			new Notice(`Connected to CouchDB database ${result.databaseName}.`);
		} catch (error) {
			failed = true;
			logger.error("CouchDB connection test failed", error);
			this.onStatusChange({
				state: "error",
				message: "CouchDB connection failed"
			});
			new Notice(getErrorMessage(error, "CouchDB connection failed. Check the console for details."));
		} finally {
			this.syncInProgress = false;

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	private async syncLocalFiles(): Promise<LocalSyncResult> {
		// logger.method("syncLocalFiles");

		const syncFolder = this.getCurrentSyncFolder();

		if (!syncFolder) {
			throw new Error("Set a folder before syncing.");
		}

		const syncFolderState = getSyncFolderState(this.app, syncFolder);

		if (!syncFolderState.valid) {
			throw new Error(syncFolderState.message);
		}

		const files = collectFilesInFolder(syncFolderState.folder);
		let savedCount = 0;
		let skippedCount = 0;

		for (const [index, file] of files.entries()) {
			const saved = await this.syncFileIfChanged(file);

			if (saved) {
				savedCount += 1;
			} else {
				skippedCount += 1;
			}

			this.onStatusChange({
				state: "syncing",
				current: index + 1,
				total: files.length,
				saved: savedCount,
				skipped: skippedCount
			});
		}

		return {
			total: files.length,
			saved: savedCount,
			skipped: skippedCount
		};
	}

	private async restoreVaultFiles(records: VaultFileRecord[]): Promise<RestoreResult> {
		// logger.method("restoreVaultFiles", { total: records.length });

		let restored = 0;
		let skipped = 0;
		let conflicts = 0;

		for (const [index, record] of records.entries()) {
			let restoreStatus: "restored" | "skipped" | "conflict";

			try {
				restoreStatus = await this.restoreVaultFile(record);
			} catch (error) {
				logger.warn("Skipped remote file during restore", error, { path: record.path });
				restoreStatus = "skipped";
			}

			if (restoreStatus === "restored") {
				restored += 1;
			} else if (restoreStatus === "conflict") {
				conflicts += 1;
			} else {
				skipped += 1;
			}

			this.onStatusChange({
				state: "restoring",
				current: index + 1,
				total: records.length,
				restored,
				skipped,
				conflicts
			});
		}

		return {
			total: records.length,
			restored,
			skipped,
			conflicts
		};
	}

	private async restoreVaultFile(record: VaultFileRecord): Promise<"restored" | "skipped" | "conflict"> {
		// logger.method("restoreVaultFile", { path: record.path, fileType: record.fileType });

		const path = normalizeRestoredPath(record.path);

		if (!path || record.type !== "vault-file") {
			return "skipped";
		}

		const existingFile = this.app.vault.getAbstractFileByPath(path);

		if (existingFile) {
			await this.createConflictFile(record, path);
			return "conflict";
		}

		const folderStatus = await this.ensureParentFolders(path);

		if (folderStatus === "conflict") {
			await this.createConflictFile(record, path);
			return "conflict";
		}

		if (record.fileType === "markdown") {
			if (typeof record.content !== "string") {
				return "skipped";
			}

			await this.app.vault.create(path, record.content);
			return "restored";
		}

		if (record.fileType === "image" || record.fileType === "binary") {
			const data = await getAttachmentArrayBuffer(record);

			if (!data) {
				return "skipped";
			}

			await this.app.vault.createBinary(path, data);
			return "restored";
		}

		return "skipped";
	}

	private async createConflictFile(record: VaultFileRecord, originalPath: string) {
		const conflictPath = getConflictPath(originalPath);

		const folderStatus = await this.ensureParentFolders(conflictPath);
		if (folderStatus === "conflict") {
			return;
		}

		const existingConflict = this.app.vault.getAbstractFileByPath(conflictPath);
		if (existingConflict) {
			await this.app.vault.delete(existingConflict);
		}

		if (record.fileType === "markdown" && typeof record.content === "string") {
			await this.app.vault.create(conflictPath, record.content);
		} else if (record.fileType === "image" || record.fileType === "binary") {
			const data = await getAttachmentArrayBuffer(record);
			if (data) {
				await this.app.vault.createBinary(conflictPath, data);
			}
		}
	}

	private async ensureParentFolders(path: string): Promise<"ok" | "conflict"> {
		// logger.method("ensureParentFolders", { path });

		const parts = path.split("/");
		parts.pop();

		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existingFile = this.app.vault.getAbstractFileByPath(currentPath);

			if (existingFile instanceof TFile) {
				return "conflict";
			}

			if (!existingFile) {
				await this.app.vault.createFolder(currentPath);
			} else if (!(existingFile instanceof TFolder)) {
				return "conflict";
			}
		}

		return "ok";
	}

	queueFileSync(abstractFile: TAbstractFile) {
		if (!(abstractFile instanceof TFile)) {
			return;
		}

		if (!this.isFileInsideCurrentSyncFolder(abstractFile)) {
			return;
		}

		this.pendingSyncPaths.add(abstractFile.path);

		if (!this.syncInProgress) {
			this.onStatusChange({
				state: "queued",
				pending: this.pendingSyncPaths.size
			});
		}

		this.scheduleQueuedSync();
	}

	async handleRenamedFile(abstractFile: TAbstractFile, oldPath: string) {
		// logger.method("handleRenamedFile", { path: abstractFile.path, oldPath });

		await this.store.deleteFileRecordByPath(oldPath);
		this.queueFileSync(abstractFile);
	}

	async handleDeletedFile(abstractFile: TAbstractFile) {
		// logger.method("handleDeletedFile", { path: abstractFile.path });

		if (abstractFile instanceof TFile) {
			await this.store.deleteFileRecordByPath(abstractFile.path);
		}
	}

	close() {
		// logger.method("close");

		if (this.syncQueueTimer !== null) {
			window.clearTimeout(this.syncQueueTimer);
		}

		void this.store.close();
	}

	private scheduleQueuedSync() {
		logger.method("scheduleQueuedSync", {
			pending: this.pendingSyncPaths.size,
			syncInProgress: this.syncInProgress,
			hasTimer: this.syncQueueTimer !== null
		});

		if (this.pendingSyncPaths.size === 0 || this.syncInProgress || this.syncQueueTimer !== null) {
			return;
		}

		this.syncQueueTimer = window.setTimeout(() => {
			this.syncQueueTimer = null;
			void this.syncQueuedFiles();
		}, 1000);
	}

	private async syncQueuedFiles() {
		logger.method("syncQueuedFiles", {
			pending: this.pendingSyncPaths.size,
			syncInProgress: this.syncInProgress
		});

		if (this.syncInProgress || this.pendingSyncPaths.size === 0) {
			return;
		}

		this.syncInProgress = true;

		let failed = false;

		try {
			const paths = Array.from(this.pendingSyncPaths);
			this.pendingSyncPaths.clear();
			let savedCount = 0;
			let skippedCount = 0;

			for (const [index, path] of paths.entries()) {
				const abstractFile = this.app.vault.getAbstractFileByPath(path);

				if (abstractFile instanceof TFile && this.isFileInsideCurrentSyncFolder(abstractFile)) {
					const saved = await this.syncFileIfChanged(abstractFile);

					if (saved) {
						savedCount += 1;
					} else {
						skippedCount += 1;
					}
				}

				this.onStatusChange({
					state: "syncing",
					current: index + 1,
					total: paths.length,
					saved: savedCount,
					skipped: skippedCount
				});
			}

			this.onStatusChange({
				state: "done",
				total: paths.length,
				saved: savedCount,
				skipped: skippedCount
			});
		} catch (error) {
			failed = true;
			logger.error("Incremental sync failed", error);
			this.onStatusChange({
				state: "error",
				message: "Incremental sync failed"
			});
			new Notice("MySync incremental sync failed. Check the console for details.");
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	private refreshQueuedStatus() {
		// logger.method("refreshQueuedStatus", {
		// 	pending: this.pendingSyncPaths.size,
		// 	syncInProgress: this.syncInProgress
		// });

		if (this.syncInProgress) {
			return;
		}

		if (this.pendingSyncPaths.size > 0) {
			this.onStatusChange({
				state: "queued",
				pending: this.pendingSyncPaths.size
			});
		}
	}

	private isFileInsideCurrentSyncFolder(file: TFile) {
		// logger.method("isFileInsideCurrentSyncFolder", { path: file.path });

		return isFileInsideSyncFolder(file, this.getCurrentSyncFolder());
	}

	private getCurrentSyncFolder() {
		// logger.method("getCurrentSyncFolder");

		const settings = this.getSettings();
		return getSyncFolder(this.app, settings.syncFolderMode, settings.customSyncFolder);
	}

	private async syncFileIfChanged(file: TFile) {
		// logger.method("syncFileIfChanged", { path: file.path });

		if (!(await this.store.hasFileChanged(file))) {
			return false;
		}

		const record = await createFileRecord(this.app, file);
		await this.store.saveFileRecord(record);
		return true;
	}
}

function validateCouchDbSettings(settings: MySyncSettings, operation = "pushing") {
	if (!settings.couchDbUrl) {
		return `Set a CouchDB URL before ${operation}.`;
	}

	if (!isHttpUrl(settings.couchDbUrl)) {
		return `Set a valid CouchDB URL before ${operation}.`;
	}

	if (!settings.couchDbDatabase) {
		return `Set a CouchDB database before ${operation}.`;
	}

	return null;
}

function isHttpUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function getErrorMessage(error: unknown, fallback: string) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	return fallback;
}

function getConflictPath(path: string) {
	const lastDotIndex = path.lastIndexOf(".");

	if (lastDotIndex > 0) {
		return path.slice(0, lastDotIndex) + ".conflict" + path.slice(lastDotIndex);
	}

	return path + ".conflict";
}

function normalizeRestoredPath(path: string) {
	if (path.startsWith("/")) {
		return null;
	}

	const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
	const pathParts = normalizedPath.split("/");

	if (!normalizedPath || pathParts.includes("..") || pathParts.includes("")) {
		return null;
	}

	return normalizedPath;
}

async function getAttachmentArrayBuffer(record: VaultFileRecord) {
	const attachment = record._attachments?.file;

	if (!attachment || !("data" in attachment)) {
		return null;
	}

	const data = attachment.data;

	if (data instanceof Blob) {
		return data.arrayBuffer();
	}

	return null;
}

/*
 * Copyright 2010-2020 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global browser, singlefile, URL, fetch */

import * as config from "./config.js";
import * as bookmarks from "./bookmarks.js";
import * as business from "./business.js";
import * as editor from "./editor.js";
import { launchWebAuthFlow, extractAuthCode } from "./tabs-util.js";
import * as ui from "./../../ui/bg/index.js";
import { GDrive } from "./../../lib/gdrive/gdrive.js";
import { WebDAV } from "./../../lib/webdav/webdav.js";
import { GitHub } from "./../../lib/github/github.js";
import { download } from "./download-util.js";
import * as yabson from "./../../lib/yabson/yabson.js";

const parsers = new Map();
const GDRIVE_CLIENT_ID = "7544745492-oe3q2jjvdluks2st2smslmrofcdederh.apps.googleusercontent.com";
const GDRIVE_CLIENT_KEY = "VQJ8Gq8Vxx72QyxPyeLtWvUt";
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const CONFLICT_ACTION_SKIP = "skip";
const CONFLICT_ACTION_UNIQUIFY = "uniquify";
const REGEXP_ESCAPE = /([{}()^$&.*?/+|[\\\\]|\]|-)/g;

const gDrive = new GDrive(GDRIVE_CLIENT_ID, GDRIVE_CLIENT_KEY, SCOPES);
export {
	onMessage,
	downloadPage,
	testSkipSave,
	saveToGDrive,
	saveToGitHub,
	saveWithWebDAV,
	encodeSharpCharacter
};

async function onMessage(message, sender) {
	if (message.method.endsWith(".download")) {
		return downloadTabPage(message, sender.tab);
	}
	if (message.method.endsWith(".disableGDrive")) {
		const authInfo = await config.getAuthInfo();
		config.removeAuthInfo();
		await gDrive.revokeAuthToken(authInfo && (authInfo.accessToken || authInfo.revokableAccessToken));
		return {};
	}
	if (message.method.endsWith(".end")) {
		business.onSaveEnd(message.taskId);
		return {};
	}
	if (message.method.endsWith(".getInfo")) {
		return business.getTasksInfo();
	}
	if (message.method.endsWith(".cancel")) {
		business.cancelTask(message.taskId);
		return {};
	}
	if (message.method.endsWith(".cancelAll")) {
		business.cancelAllTasks();
		return {};
	}
	if (message.method.endsWith(".saveUrls")) {
		business.saveUrls(message.urls);
		return {};
	}
}

async function downloadTabPage(message, tab) {
	const tabId = tab.id;
	if (message.blobURL) {
		try {
			message.pageData = await yabson.parse(new Uint8Array(await (await fetch(message.blobURL)).arrayBuffer()));
			await download(message);
		} catch (error) {
			return { error: true };
		}
	} else {
		let parser = parsers.get(tabId);
		if (!parser) {
			parser = yabson.getParser();
			parsers.set(tabId, parser);
		}
		let result = await parser.next(message.data);
		if (result.done) {
			const message = result.value;
			parsers.delete(tabId);
			await download(message);
		}
	}
	return {};

	async function download(message) {
		let skipped;
		if (message.backgroundSave && !message.saveToGDrive && !message.saveWithWebDAV && !message.saveToGitHub) {
			const testSkip = await testSkipSave(message.filename, message);
			message.filenameConflictAction = testSkip.filenameConflictAction;
			skipped = testSkip.skipped;
		}
		if (skipped) {
			ui.onEnd(tabId);
		} else {
			const pageData = message.pageData;
			const blob = await singlefile.processors.compression.process(pageData, {
				insertTextBody: message.insertTextBody,
				url: pageData.url || tab.url,
				createRootDirectory: message.createRootDirectory,
				tabId,
				selfExtractingArchive: message.selfExtractingArchive,
				extractDataFromPage: message.extractDataFromPage,
				insertCanonicalLink: message.insertCanonicalLink,
				insertMetaNoIndex: message.insertMetaNoIndex,
				password: message.password
			});
			if (message.openEditor) {
				ui.onEdit(tab.id);
				await editor.open({ tabIndex: tab.index + 1, filename: message.filename, content: Array.from(new Uint8Array(await blob.arrayBuffer())) });
			} else {
				await downloadBlob(blob, tab, tab.incognito, message);
			}
		}
	}
}

async function downloadBlob(blob, tab, incognito, message) {
	const tabId = tab.id;
	try {
		const prompt = filename => promptFilename(tabId, filename);
		let response;
		if (message.saveWithWebDAV) {
			response = await saveWithWebDAV(message.taskId, encodeSharpCharacter(message.filename), blob, message.webDAVURL, message.webDAVUser, message.webDAVPassword, { filenameConflictAction: message.filenameConflictAction, prompt });
		} else if (message.saveToGDrive) {
			await saveToGDrive(message.taskId, encodeSharpCharacter(message.filename), blob, {
				forceWebAuthFlow: message.forceWebAuthFlow
			}, {
				onProgress: (offset, size) => ui.onUploadProgress(tabId, offset, size),
				filenameConflictAction: message.filenameConflictAction,
				prompt
			});
		} else if (message.saveToGitHub) {
			response = await saveToGitHub(message.taskId, encodeSharpCharacter(message.filename), blob, message.githubToken, message.githubUser, message.githubRepository, message.githubBranch, {
				filenameConflictAction: message.filenameConflictAction,
				prompt
			});
			await response.pushPromise;
		} else {
			if (message.backgroundSave) {
				message.url = URL.createObjectURL(blob);
				response = await downloadPage(message, {
					confirmFilename: message.confirmFilename,
					incognito,
					filenameConflictAction: message.filenameConflictAction,
					filenameReplacementCharacter: message.filenameReplacementCharacter,
					bookmarkId: message.bookmarkId,
					replaceBookmarkURL: message.replaceBookmarkURL
				});
			} else {
				await downloadPageForeground(message.taskId, message.filename, blob, tabId);
			}
		}
		if (message.replaceBookmarkURL && response && response.url) {
			await bookmarks.update(message.bookmarkId, { url: response.url });
		}
		ui.onEnd(tabId);
	} catch (error) {
		if (!error.message || error.message != "upload_cancelled") {
			console.error(error); // eslint-disable-line no-console
			ui.onError(tabId, error.message);
		}
	} finally {
		if (message.url) {
			URL.revokeObjectURL(message.url);
		}
	}
}

function encodeSharpCharacter(path) {
	return path.replace(/#/g, "%23");
}

function getRegExp(string) {
	return string.replace(REGEXP_ESCAPE, "\\$1");
}

async function getAuthInfo(authOptions, force) {
	let authInfo = await config.getAuthInfo();
	const options = {
		interactive: true,
		forceWebAuthFlow: authOptions.forceWebAuthFlow,
		launchWebAuthFlow: options => launchWebAuthFlow(options),
		extractAuthCode: authURL => extractAuthCode(authURL)
	};
	gDrive.setAuthInfo(authInfo, options);
	if (!authInfo || !authInfo.accessToken || force) {
		authInfo = await gDrive.auth(options);
		if (authInfo) {
			await config.setAuthInfo(authInfo);
		} else {
			await config.removeAuthInfo();
		}
	}
	return authInfo;
}

async function saveToGitHub(taskId, filename, blob, githubToken, githubUser, githubRepository, githubBranch, { filenameConflictAction, prompt }) {
	try {
		const taskInfo = business.getTaskInfo(taskId);
		if (!taskInfo || !taskInfo.cancelled) {
			const client = new GitHub(githubToken, githubUser, githubRepository, githubBranch);
			business.setCancelCallback(taskId, () => client.abort());
			return await client.upload(filename, blob, { filenameConflictAction, prompt });
		}
	} catch (error) {
		throw new Error(error.message + " (GitHub)");
	}
}

async function saveWithWebDAV(taskId, filename, blob, url, username, password, { filenameConflictAction, prompt }) {
	try {
		const taskInfo = business.getTaskInfo(taskId);
		if (!taskInfo || !taskInfo.cancelled) {
			const client = new WebDAV(url, username, password);
			business.setCancelCallback(taskId, () => client.abort());
			return await client.upload(filename, blob, { filenameConflictAction, prompt });
		}
	} catch (error) {
		throw new Error(error.message + " (WebDAV)");
	}
}

async function saveToGDrive(taskId, filename, blob, authOptions, uploadOptions) {
	try {
		await getAuthInfo(authOptions);
		const taskInfo = business.getTaskInfo(taskId);
		if (!taskInfo || !taskInfo.cancelled) {
			return await gDrive.upload(filename, blob, uploadOptions, callback => business.setCancelCallback(taskId, callback));
		}
	}
	catch (error) {
		if (error.message == "invalid_token") {
			let authInfo;
			try {
				authInfo = await gDrive.refreshAuthToken();
			} catch (error) {
				if (error.message == "unknown_token") {
					authInfo = await getAuthInfo(authOptions, true);
				} else {
					throw new Error(error.message + " (Google Drive)");
				}
			}
			if (authInfo) {
				await config.setAuthInfo(authInfo);
			} else {
				await config.removeAuthInfo();
			}
			return await saveToGDrive(taskId, filename, blob, authOptions, uploadOptions);
		} else {
			throw new Error(error.message + " (Google Drive)");
		}
	}
}

async function testSkipSave(filename, options) {
	let skipped, filenameConflictAction = options.filenameConflictAction;
	if (filenameConflictAction == CONFLICT_ACTION_SKIP) {
		const downloadItems = await browser.downloads.search({
			filenameRegex: "(\\\\|/)" + getRegExp(filename) + "$",
			exists: true
		});
		if (downloadItems.length) {
			skipped = true;
		} else {
			filenameConflictAction = CONFLICT_ACTION_UNIQUIFY;
		}
	}
	return { skipped, filenameConflictAction };
}

function promptFilename(tabId, filename) {
	return browser.tabs.sendMessage(tabId, { method: "content.prompt", message: "Filename conflict, please enter a new filename", value: filename });
}

async function downloadPage(pageData, options) {
	const downloadInfo = {
		url: pageData.url,
		saveAs: options.confirmFilename,
		filename: pageData.filename,
		conflictAction: options.filenameConflictAction
	};
	if (options.incognito) {
		downloadInfo.incognito = true;
	}
	const downloadData = await download(downloadInfo, options.filenameReplacementCharacter);
	if (downloadData.filename) {
		let url = downloadData.filename;
		if (!url.startsWith("file:")) {
			if (url.startsWith("/")) {
				url = url.substring(1);
			}
			url = "file:///" + encodeSharpCharacter(url);
		}
		return { url };
	}
}

async function downloadPageForeground(taskId, filename, content, tabId) {
	const serializer = yabson.getSerializer({ filename, taskId, content: await content.arrayBuffer() });
	for await (const data of serializer) {
		await browser.tabs.sendMessage(tabId, {
			method: "content.download",
			data: Array.from(data)
		});
	}
	await browser.tabs.sendMessage(tabId, { method: "content.download" });
}
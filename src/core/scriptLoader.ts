/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

namespace AMDLoader {

	export interface IModuleManager {
		getConfig(): Configuration;
		enqueueDefineAnonymousModule(dependencies: string[], callback: any): void;
		getRecorder(): ILoaderEventRecorder;
	}

	export interface IScriptLoader {
		load(moduleManager: IModuleManager, scriptPath: string, loadCallback: () => void, errorCallback: (err: any) => void): void;
	}

	// ------------------------------------------------------------------------
	// IScriptLoader(s)

	interface IScriptCallbacks {
		callback: () => void;
		errorback: (err: any) => void;
	}

	/**
	 * Load `scriptSrc` only once (avoid multiple <script> tags)
	 */
	class OnlyOnceScriptLoader implements IScriptLoader {

		private actualScriptLoader: IScriptLoader;
		private callbackMap: { [scriptSrc: string]: IScriptCallbacks[]; };

		constructor(actualScriptLoader: IScriptLoader) {
			this.actualScriptLoader = actualScriptLoader;
			this.callbackMap = {};
		}

		public load(moduleManager: IModuleManager, scriptSrc: string, callback: () => void, errorback: (err: any) => void): void {
			let scriptCallbacks: IScriptCallbacks = {
				callback: callback,
				errorback: errorback
			};
			if (this.callbackMap.hasOwnProperty(scriptSrc)) {
				this.callbackMap[scriptSrc].push(scriptCallbacks);
				return;
			}
			this.callbackMap[scriptSrc] = [scriptCallbacks];
			this.actualScriptLoader.load(moduleManager, scriptSrc, () => this.triggerCallback(scriptSrc), (err: any) => this.triggerErrorback(scriptSrc, err));
		}

		private triggerCallback(scriptSrc: string): void {
			let scriptCallbacks = this.callbackMap[scriptSrc];
			delete this.callbackMap[scriptSrc];

			for (let i = 0; i < scriptCallbacks.length; i++) {
				scriptCallbacks[i].callback();
			}
		}

		private triggerErrorback(scriptSrc: string, err: any): void {
			let scriptCallbacks = this.callbackMap[scriptSrc];
			delete this.callbackMap[scriptSrc];

			for (let i = 0; i < scriptCallbacks.length; i++) {
				scriptCallbacks[i].errorback(err);
			}
		}
	}

	class BrowserScriptLoader implements IScriptLoader {

		/**
		 * Attach load / error listeners to a script element and remove them when either one has fired.
		 * Implemented for browssers supporting HTML5 standard 'load' and 'error' events.
		 */
		private attachListeners(script: HTMLScriptElement, callback: () => void, errorback: (err: any) => void): void {
			let unbind = () => {
				script.removeEventListener('load', loadEventListener);
				script.removeEventListener('error', errorEventListener);
			};

			let loadEventListener = (e: any) => {
				unbind();
				callback();
			};

			let errorEventListener = (e: any) => {
				unbind();
				errorback(e);
			};

			script.addEventListener('load', loadEventListener);
			script.addEventListener('error', errorEventListener);
		}

		public load(moduleManager: IModuleManager, scriptSrc: string, callback: () => void, errorback: (err: any) => void): void {
			let script = document.createElement('script');
			script.setAttribute('async', 'async');
			script.setAttribute('type', 'text/javascript');

			this.attachListeners(script, callback, errorback);

			script.setAttribute('src', scriptSrc);

			document.getElementsByTagName('head')[0].appendChild(script);
		}
	}

	class WorkerScriptLoader implements IScriptLoader {

		public load(moduleManager: IModuleManager, scriptSrc: string, callback: () => void, errorback: (err: any) => void): void {
			try {
				importScripts(scriptSrc);
				callback();
			} catch (e) {
				errorback(e);
			}
		}
	}

	declare class Buffer {

	}

	interface INodeFS {
		readFile(filename: string, options: { encoding?: string; flag?: string }, callback: (err: any, data: any) => void): void;
		readFile(filename: string, callback: (err: any, data: Buffer) => void): void;
		writeFile(filename: string, data: Buffer, callback: (err: any) => void): void;
		unlink(path: string, callback: (err: any) => void): void;
	}

	interface INodeVMScriptOptions {
		filename: string;
		produceCachedData?: boolean;
		cachedData?: Buffer;
	}

	interface INodeVMScript {
		cachedData: Buffer;
		cachedDataProduced: boolean;
		cachedDataRejected: boolean;
		runInThisContext(options: INodeVMScriptOptions);
	}

	interface INodeVM {
		Script: { new (contents: string, options: INodeVMScriptOptions): INodeVMScript }
		runInThisContext(contents: string, { filename: string });
		runInThisContext(contents: string, filename: string);
	}

	interface INodePath {
		dirname(filename: string): string;
		normalize(filename: string): string;
		basename(filename: string): string;
		join(...parts: string[]): string;
	}

	interface INodeCryptoHash {
		update(str: string, encoding: string): INodeCryptoHash;
		digest(type: string): string;
	}
	interface INodeCrypto {
		createHash(type: string): INodeCryptoHash;
	}

	class NodeScriptLoader implements IScriptLoader {

		private static _BOM = 0xFEFF;

		private _initialized: boolean;
		private _fs: INodeFS;
		private _vm: INodeVM;
		private _path: INodePath;
		private _crypto: INodeCrypto;

		constructor() {
			this._initialized = false;
		}

		private _init(nodeRequire: INodeRequire): void {
			if (this._initialized) {
				return;
			}
			this._initialized = true;
			this._fs = nodeRequire('fs');
			this._vm = nodeRequire('vm');
			this._path = nodeRequire('path');
			this._crypto = nodeRequire('crypto');
		}

		public load(moduleManager: IModuleManager, scriptSrc: string, callback: () => void, errorback: (err: any) => void): void {
			const opts = moduleManager.getConfig().getOptionsLiteral();
			const nodeRequire = (opts.nodeRequire || global.nodeRequire);
			const nodeInstrumenter = (opts.nodeInstrumenter || function (c) { return c; });
			this._init(nodeRequire);
			let recorder = moduleManager.getRecorder();

			if (/^node\|/.test(scriptSrc)) {

				let pieces = scriptSrc.split('|');

				let moduleExports = null;
				try {
					moduleExports = nodeRequire(pieces[1]);
				} catch (err) {
					errorback(err);
					return;
				}

				moduleManager.enqueueDefineAnonymousModule([], () => moduleExports);
				callback();

			} else {

				scriptSrc = Utilities.fileUriToFilePath(scriptSrc);

				this._fs.readFile(scriptSrc, { encoding: 'utf8' }, (err, data: string) => {
					if (err) {
						errorback(err);
						return;
					}

					let normalizedScriptSrc = this._path.normalize(scriptSrc);
					let vmScriptSrc = normalizedScriptSrc;
					// Make the script src friendly towards electron
					if (isElectronRenderer) {
						let driveLetterMatch = vmScriptSrc.match(/^([a-z])\:(.*)/i);
						if (driveLetterMatch) {
							vmScriptSrc = driveLetterMatch[1].toUpperCase() + ':' + driveLetterMatch[2];
						}
						vmScriptSrc = 'file:///' + vmScriptSrc.replace(/\\/g, '/');
					}

					let contents: string,
						prefix = '(function (require, define, __filename, __dirname) { ',
						suffix = '\n});';

					if (data.charCodeAt(0) === NodeScriptLoader._BOM) {
						contents = prefix + data.substring(1) + suffix;
					} else {
						contents = prefix + data + suffix;
					}

					contents = nodeInstrumenter(contents, normalizedScriptSrc);

					if (!opts.nodeCachedDataDir) {

						this._loadAndEvalScript(scriptSrc, vmScriptSrc, contents, { filename: vmScriptSrc }, recorder);
						callback();

					} else {

						const cachedDataPath = this._getCachedDataPath(opts.nodeCachedDataDir, scriptSrc);

						this._fs.readFile(cachedDataPath, (err, data) => {

							// create script options
							const scriptOptions: INodeVMScriptOptions = {
								filename: vmScriptSrc,
								produceCachedData: typeof data === 'undefined',
								cachedData: data
							};

							const script = this._loadAndEvalScript(scriptSrc, vmScriptSrc, contents, scriptOptions, recorder);
							callback();

							// cached code after math
							if (script.cachedDataRejected) {
								// data rejected => delete cache file

								opts.onNodeCachedDataError({
									errorCode: 'cachedDataRejected',
									path: cachedDataPath
								});

								NodeScriptLoader._runSoon(() => this._fs.unlink(cachedDataPath, err => {
									if (err) {
										moduleManager.getConfig().getOptionsLiteral().onNodeCachedDataError({
											errorCode: 'unlink',
											path: cachedDataPath,
											detail: err
										});
									}
								}), opts.nodeCachedDataWriteDelay);

							} else if (script.cachedDataProduced) {
								// data produced => write cache file

								NodeScriptLoader._runSoon(() => this._fs.writeFile(cachedDataPath, script.cachedData, err => {
									if (err) {
										moduleManager.getConfig().getOptionsLiteral().onNodeCachedDataError({
											errorCode: 'writeFile',
											path: cachedDataPath,
											detail: err
										});
									}
								}), opts.nodeCachedDataWriteDelay);
							}
						});
					}
				});
			}
		}

		private _loadAndEvalScript(scriptSrc: string, vmScriptSrc: string, contents: string, options: INodeVMScriptOptions, recorder: ILoaderEventRecorder): INodeVMScript {

			// create script, run script
			recorder.record(LoaderEventType.NodeBeginEvaluatingScript, scriptSrc);

			const script = new this._vm.Script(contents, options);

			const r = script.runInThisContext(options);
			r.call(global, RequireFunc, DefineFunc, vmScriptSrc, this._path.dirname(scriptSrc));

			// signal done
			recorder.record(LoaderEventType.NodeEndEvaluatingScript, scriptSrc);

			return script;
		}

		private _getCachedDataPath(baseDir: string, filename: string): string {
			const hash = this._crypto.createHash('md5').update(filename, 'utf8').digest('hex');
			const basename = this._path.basename(filename).replace(/\.js$/, '');
			return this._path.join(baseDir, `${hash}-${basename}.code`);
		}

		private static _runSoon(callback: Function, minTimeout: number): void {
			const timeout = minTimeout + Math.ceil(Math.random() * minTimeout);
			setTimeout(callback, timeout);
		}
	}

	export const scriptLoader: IScriptLoader = new OnlyOnceScriptLoader(
		isWebWorker ?
			new WorkerScriptLoader()
			: isNode ?
				new NodeScriptLoader()
				: new BrowserScriptLoader()
	);
}

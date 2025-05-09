import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } from "@google/generative-ai";
import pMap from 'p-map';
import {
	SorensenDiceSimilarity,
	DefaultTextParser,
	Summarizer,
	AbsoluteSummarizerConfig,
	NullLogger // Or ConsoleLogger for debugging
} from 'ts-textrank';


interface GeminiTitleGeneratorSettings {
	apiKey: string;
	modelId: string;
	numberOfSentences: number;
	autoUpdateUntitledNotes: boolean;
}

const DEFAULT_PLUGIN_SETTINGS: GeminiTitleGeneratorSettings = {
	apiKey: '',
	modelId: 'gemini-2.5-flash-preview-04-17',
	numberOfSentences: 8,
	autoUpdateUntitledNotes: false,
}

export default class GeminiTitleGeneratorPlugin extends Plugin {
	settings: GeminiTitleGeneratorSettings;
	private lastActiveFile: TFile | null = null;
	private handleActiveLeafChangeBound = this.handleActiveLeafChange.bind(this);

	async onload() {
		await this.loadSettings();

		this.app.workspace.onLayoutReady(async () => {
			if (this.settings.autoUpdateUntitledNotes) {
				const markdownLeaves = this.app.workspace.getLeavesOfType('markdown');
				const untitledOpenFiles: TFile[] = [];

				for (const leaf of markdownLeaves) {
					if (leaf.view instanceof MarkdownView && leaf.view.file) {
						const file = leaf.view.file;
						if (file.basename.toLowerCase().startsWith("untitled")) {
							untitledOpenFiles.push(file);
						}
					}
				}

				if (untitledOpenFiles.length > 0) {
					let updatedTitlesCount = 0;
					const mapper = async (fileToUpdate: TFile) => {
						try {
							// Check again if it's still untitled, in case it was renamed
							const abstractFile = this.app.vault.getAbstractFileByPath(fileToUpdate.path);

							// Check if the file exists and is an instance of TFile
							if (!(abstractFile instanceof TFile)) {
								// If abstractFile is null or not a TFile (e.g., a TFolder or deleted), we can't proceed.
								// This implicitly handles the case where currentFileState would have been null.
								return;
							}

							// Now we know abstractFile is a TFile.
							const currentFileState: TFile = abstractFile;

							// Proceed with the original check for "untitled"
							if (!currentFileState.basename.toLowerCase().startsWith("untitled")) {
								return;
							}

							new Notice(`Auto-updating title for open note: "${currentFileState.basename}"...`);
							const noteContent = await this.app.vault.cachedRead(currentFileState);
							if (!noteContent.trim()) {
								new Notice(`Note "${currentFileState.basename}" is empty. Skipping auto-title on startup.`);
								return;
							}
							const generatedTitle = await this.generateTitle(noteContent);
							if (generatedTitle) {
								const wasUpdated = await this.updateNoteTitle(currentFileState, generatedTitle);
								if (wasUpdated) {
									updatedTitlesCount++;
								}
							}
						} catch (error) {
							new Notice(`Error auto-updating title for "${fileToUpdate.basename}" on startup. Check console.`);
						}
					};
					await pMap(untitledOpenFiles, mapper, { concurrency: 1 });
					if (updatedTitlesCount > 0) {
						new Notice(`Gemini: Updated titles for ${updatedTitlesCount} untitled note(s) on startup.`);
					}
				}
			}
		});

		this.app.workspace.on('active-leaf-change', this.handleActiveLeafChangeBound);

		// Add command to generate title for the current note
		this.addCommand({
			id: 'gemini-generate-title',
			name: 'Generate Title with Gemini AI',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				if (view.file) {
					const noteContent = editor.getValue();
					if (!noteContent.trim()) {
						new Notice('Current note is empty. Cannot generate title.');
						return;
					}
					new Notice('Generating title with Gemini...');
					const generatedTitle = await this.generateTitle(noteContent);
					if (generatedTitle && view.file) {
						await this.updateNoteTitle(view.file, generatedTitle);
					} else if (!generatedTitle) {
						// Notice for failure is handled within generateTitle or updateNoteTitle
					}
				} else {
					new Notice('No active file to generate title for.');
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GeminiTitleGeneratorSettingTab(this.app, this));

		// Add context menu item for generating title
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				// The 'file' argument is the TFile that was right-clicked.
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => {
						item
							.setTitle("Generate Title with Gemini AI")
							.setIcon("sparkles")
							.onClick(async () => {
								try {
									const noteContent = await this.app.vault.cachedRead(file);
									if (!noteContent.trim()) {
										new Notice(`Note "${file.basename}" is empty. Cannot generate title.`);
										return;
									}
									new Notice(`Generating title for "${file.basename}"...`);
									const generatedTitle = await this.generateTitle(noteContent);
									if (generatedTitle) {
										await this.updateNoteTitle(file, generatedTitle);
									}
								} catch (e) {
									new Notice(`Error processing file "${file.basename}". Check console.`);
								}
							});
					});
				}
			})
		);

		// Add context menu item for generating titles for multiple selected files
		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files: TFile[]) => {
				const markdownFiles = files.filter(
					(file): file is TFile => file instanceof TFile && file.extension === 'md'
				);

				if (markdownFiles.length > 0) {
					menu.addItem((item) => {
						item
							.setTitle(`Generate Titles using Gemini AI`)
							.setIcon("sparkles")
							.onClick(async () => {
								if (markdownFiles.length === 0) {
									new Notice("No markdown files selected."); // Should not happen if menu item is added
									return;
								}
								
								new Notice(`Generating titles for ${markdownFiles.length} note(s)...`);

								const mapper = async (mdFile: TFile) => {
									try {
										const noteContent = await this.app.vault.cachedRead(mdFile);
										if (!noteContent.trim()) {
											new Notice(`Note "${mdFile.basename}" is empty. Skipping.`);
											return; // Skip this file
										}
										const generatedTitle = await this.generateTitle(noteContent);
										if (generatedTitle) {
											await this.updateNoteTitle(mdFile, generatedTitle);
										}
									} catch (e) {
										new Notice(`Error processing file "${mdFile.basename}". Check console.`);
									}
								};

								// Process one by one to avoid overwhelming the API or notices
								await pMap(markdownFiles, mapper, { concurrency: 1 });
								new Notice("Finished generating titles for selected notes.");
							});
					});
				}
			})
		);
	}

	onunload() {
		this.app.workspace.off('active-leaf-change', this.handleActiveLeafChangeBound);
	}

	async handleActiveLeafChange(newLeaf: WorkspaceLeaf | null): Promise<void> {
		const previousFile = this.lastActiveFile;

		if (newLeaf && newLeaf.view instanceof MarkdownView && newLeaf.view.file) {
			this.lastActiveFile = newLeaf.view.file;
		} else {
			this.lastActiveFile = null;
		}

		if (!this.settings.autoUpdateUntitledNotes || !previousFile) {
			return;
		}

		// Check if the file still exists in the vault
		if (!this.app.vault.getAbstractFileByPath(previousFile.path)) {
			return;
		}
		
		if (previousFile.basename.toLowerCase().startsWith("untitled")) {
			try {
				new Notice(`Checking to auto-update title for "${previousFile.basename}"...`);
				const noteContent = await this.app.vault.cachedRead(previousFile);
				if (!noteContent.trim()) {
					new Notice(`Note "${previousFile.basename}" is empty. Skipping auto-title.`);
					return;
				}
				const generatedTitle = await this.generateTitle(noteContent);
				if (generatedTitle) {
					await this.updateNoteTitle(previousFile, generatedTitle);
				}
			} catch (error) {
				new Notice(`Error auto-updating title for "${previousFile.basename}". Check console.`);
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_PLUGIN_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async generateTitle(noteContent: string): Promise<string | null> {
		if (!this.settings.apiKey) {
			new Notice('Gemini API Key is not set. Please configure it in the plugin settings.');
			return null;
		}

		try {
			// 1. Extract sentences using ts-textrank
			let extractedSentences: string;
			// Preprocess noteContent to remove Obsidian image embedding lines
			const imageEmbeddingRegex = /^!\[\[.*]]$/;
			const lines = noteContent.split('\n');
			const filteredLines = lines.filter(line => !imageEmbeddingRegex.test(line.trim()));
			const processedNoteContent = filteredLines.join('\n');

			try {
				const similarityFunction = new SorensenDiceSimilarity();
				const parser = new DefaultTextParser();
				const logger = new NullLogger(); // Use NullLogger to avoid console spam
				// Damping factor (d) from TextRank paper, 0.85 is a common value.
				// Sorting by occurrence to maintain some original flow for the prompt.
				const config = new AbsoluteSummarizerConfig(
					this.settings.numberOfSentences,
					similarityFunction,
					parser,
					0.85,
					Summarizer.SORT_OCCURENCE
				);
				const summarizer = new Summarizer(config, logger);

				// "en" for English stopwords. The 'stopword' package should handle this.
				// Use the processedNoteContent for summarization
				const summarySentences: string[] = summarizer.summarize(processedNoteContent, "en");

				if (summarySentences && summarySentences.length > 0) {
					extractedSentences = summarySentences.join(' '); // Join the sentence strings directly
				} else {
					// Fallback: use the first 500 characters if ts-textrank returns no sentences
					new Notice('ts-textrank found no key sentences, using the first 500 characters of the note for context.');
					// Use processedNoteContent for fallback as well if original noteContent was mostly images
					// If processedNoteContent is empty (e.g. note only had images), use original noteContent for substring.
					extractedSentences = processedNoteContent.trim() ? processedNoteContent.substring(0, 500) : noteContent.substring(0, 500);
				}

			} catch (summarizationError) {
				new Notice('Error during sentence extraction with ts-textrank. Using fallback. Check console.');
				// Use processedNoteContent for fallback as well
				// If processedNoteContent is empty (e.g. note only had images), use original noteContent for substring.
				extractedSentences = processedNoteContent.trim() ? processedNoteContent.substring(0, 500) : noteContent.substring(0, 500); // Fallback on error
			}


			if (!extractedSentences || extractedSentences.trim().length === 0) {
				// Check the original noteContent for emptiness, not the processed one,
				// as a note with only images would be empty after processing.
				if (noteContent.trim().length === 0) {
					new Notice('Note is empty. Cannot generate title.');
					return null;
				}
				// This notice might be redundant if the fallback was already announced,
				// but good as a final check.
				new Notice('Could not extract any meaningful content from the note to generate a title.');
				return null;
			}

			// 2. Call Gemini API
			const genAI = new GoogleGenerativeAI(this.settings.apiKey);
			const model = genAI.getGenerativeModel({ model: this.settings.modelId });

			const prompt = `Based on the following key sentences, provide a single, concise title for a note. The title should be 10 words or less. Key sentences: "${extractedSentences}"`;
			

			const titleSchema = {
				type: SchemaType.OBJECT, // This should be correct if SchemaType.OBJECT is a valid member
				properties: {
					title: {
						type: SchemaType.STRING, // This should be correct if SchemaType.STRING is a valid member
						description: "A concise title for the note, 10 words or less."
					},
				},
				required: ["title"]
			} as const;

			const generationConfig = {
				temperature: 0.7,
				topK: 1,
				topP: 1,
				maxOutputTokens: 5000, // Reduced for a short title
				responseMimeType: "application/json",
				responseSchema: {
					...titleSchema, // Spread the properties from titleSchema
					required: [...titleSchema.required], // Create a new mutable array for 'required'
				},
			};

			const safetySettings = [
				{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
				{ category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
				{ category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
				{ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
			];
			
			const parts = [{ text: prompt }];

			const result = await model.generateContent({
				contents: [{ role: "user", parts }],
				generationConfig,
				safetySettings,
			});

			if (result.response) {
				const responseText = result.response.text();
				try {
					const jsonResponse = JSON.parse(responseText);
					if (jsonResponse && jsonResponse.title && typeof jsonResponse.title === 'string') {
						return jsonResponse.title.trim();
					} else {
						new Notice('Failed to get a valid title from Gemini JSON response.');
						return null;
					}
				} catch (e) {
					new Notice('Failed to parse Gemini JSON response for title.');
					return null;
				}
			} else {
				new Notice('Failed to generate title from Gemini API. No response.');
				return null;
			}

		} catch (error) {
			new Notice('Error generating title. Check console for details.');
			return null;
		}
	}

	async updateNoteTitle(file: TFile, newTitle: string): Promise<boolean> {
		if (!newTitle || newTitle.trim() === '') {
			new Notice('Generated title is empty. No changes made.');
			return false;
		}

		// Sanitize the new title to be a valid filename
		// Replace forbidden characters and trim whitespace
		const sanitizedTitle = newTitle
			.replace(/[\\/:*?"<>|]/g, '') // Remove characters forbidden in Windows filenames
			.replace(/[\n\r]/g, ' ')    // Replace newlines with spaces
			.trim();

		if (!sanitizedTitle) {
			new Notice('Sanitized title is empty. No changes made.');
			return false;
		}
		
		const currentPath = file.path;
		const parentPath = file.parent ? file.parent.path : '';
		const newPath = parentPath ? `${parentPath}/${sanitizedTitle}.${file.extension}` : `${sanitizedTitle}.${file.extension}`;

		if (currentPath === newPath) {
			new Notice(`Note title is already "${sanitizedTitle}". No changes made.`);
			return false;
		}

		try {
			await this.app.fileManager.renameFile(file, newPath);
			new Notice(`Note title updated to: "${sanitizedTitle}"`);
			return true;
		} catch (error) {
			new Notice('Error updating note title. Check console for details.');
			return false;
		}
	}
}

class GeminiTitleGeneratorSettingTab extends PluginSettingTab {
	plugin: GeminiTitleGeneratorPlugin;

	constructor(app: App, plugin: GeminiTitleGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Gemini API Key')
			.setDesc('Enter your Gemini API Key. Get this from https://aistudio.google.com/app/apikey')
			.addText(text => {
				text
					.setPlaceholder('Enter your API Key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password'; // To hide the API key
			});

		new Setting(containerEl)
			.setName('Gemini Model ID')
			.setDesc('Enter the Gemini Model ID to use for title generation. Example: gemini-2.5-flash-preview-04-17')
			.addText(text => text
				.setPlaceholder('gemini-2.5-flash-preview-04-17')
				.setValue(this.plugin.settings.modelId)
				.onChange(async (value) => {
					this.plugin.settings.modelId = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Number of Sentences for Summary')
			.setDesc('How many sentences to extract from the note to send to Gemini.')
			.addText(text => text
				.setPlaceholder('e.g., 5')
				.setValue(this.plugin.settings.numberOfSentences.toString())
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.numberOfSentences = num;
						await this.plugin.saveSettings();
					} else {
						new Notice('Please enter a valid positive number for sentences.');
						// Optionally, revert to old value or handle error display
						text.setValue(this.plugin.settings.numberOfSentences.toString());
					}
				}));
		
		new Setting(containerEl)
			.setName('Auto update title for untitled notes')
			.setDesc('When enabled, if you switch away from or close a note whose title starts with "Untitled", the plugin will attempt to generate and set a new title automatically.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoUpdateUntitledNotes)
				.onChange(async (value) => {
					this.plugin.settings.autoUpdateUntitledNotes = value;
					await this.plugin.saveSettings();
				}));
	}
}

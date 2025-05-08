import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } from "@google/generative-ai";
import pMap from 'p-map';

// Remember to rename these classes and interfaces!

interface GeminiTitleGeneratorSettings {
	apiKey: string;
	modelId: string;
	numberOfSentences: number;
}

const DEFAULT_PLUGIN_SETTINGS: GeminiTitleGeneratorSettings = {
	apiKey: '',
	modelId: 'gemini-2.5-flash-preview-04-17',
	numberOfSentences: 5
}

export default class GeminiTitleGeneratorPlugin extends Plugin {
	settings: GeminiTitleGeneratorSettings;

	async onload() {
		await this.loadSettings();

		// Add command to generate title for the current note
		this.addCommand({
			id: 'gemini-generate-title',
			name: 'Gemini Generate Title: Generate Title',
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
							.setTitle("Gemini: Generate title for this note")
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
									console.error(`Error in file-menu title generation for ${file.path}:`, e);
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
							.setTitle(`Gemini: Generate titles for ${markdownFiles.length} notes`)
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
										console.error(`Error in files-menu title generation for ${mdFile.path}:`, e);
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
			// 1. Extract sentences using built-in logic
			// Split by common sentence terminators. This regex tries to be a bit smart about not splitting on e.g. "Mr."
			// It looks for a period, question mark, or exclamation mark, possibly followed by quotes, and then whitespace or end of string.
			const sentenceEndRegex = /(?<!\b(?:Mr|Mrs|Ms|Dr|Sr|Jr|Inc|Ltd|Co|e\.g|i\.e|etc)\.)[.?!]['"]?(?=\s+|$)/g;
			let sentences = noteContent.split(sentenceEndRegex);

			// The split will include the delimiters themselves as separate array elements if they are captured,
			// or it might create empty strings. We need to clean this up.
			// A simpler split and then re-adding delimiter might be:
			// sentences = noteContent.replace(/([.?!])\s*(?=[A-Z0-9"'])/g, "$1|").split("|");
			// For now, let's try a simpler split and filter.
			
			sentences = noteContent.split(/[.?!]/g);


			const validSentences = sentences
				.map(s => s.trim()) // Trim whitespace
				.filter(s => s.length > 0) // Filter out empty strings
				.filter(s => s.split(/\s+/).length >= 3); // Filter out sentences with less than 3 words

			let extractedSentences: string;

			if (validSentences.length > 0) {
				const sentencesToUse = validSentences.slice(0, this.settings.numberOfSentences);
				extractedSentences = sentencesToUse.join('. ') + (sentencesToUse.length > 0 ? '.' : '');
			} else {
				// Fallback: use the first 500 characters if no valid sentences found
				if (noteContent.trim().length === 0) {
					new Notice('Note is empty. Cannot generate title.');
					return null;
				}
				new Notice('No distinct sentences found, using the first 500 characters of the note for context.');
				extractedSentences = noteContent.substring(0, 500);
			}
			
			if (!extractedSentences || extractedSentences.trim().length === 0) {
				// This case should ideally be caught by the noteContent.trim().length check earlier
				// or if the substring(0,500) results in an empty or whitespace-only string (highly unlikely for non-empty notes).
				new Notice('Could not extract any content from the note to generate a title.');
				return null;
			}

			// 2. Call Gemini API
			const genAI = new GoogleGenerativeAI(this.settings.apiKey);
			const model = genAI.getGenerativeModel({ model: this.settings.modelId });

			const prompt = `Based on the following key sentences, provide a single, concise title for a note. The title should be 10 words or less. Key sentences: "${extractedSentences}"`;
			
			console.log("Gemini API Prompt:", prompt); // Log the prompt for debugging

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
				console.log("Gemini API Result:", result); // Log the entire result object
				console.log("Gemini API Response:", result.response); // Log the entire response object
				const responseText = result.response.text();
				console.log("Gemini Raw Response:", responseText); // Log the raw response
				try {
					const jsonResponse = JSON.parse(responseText);
					if (jsonResponse && jsonResponse.title && typeof jsonResponse.title === 'string') {
						return jsonResponse.title.trim();
					} else {
						new Notice('Failed to get a valid title from Gemini JSON response.');
						console.error('Gemini API Error: Invalid JSON structure or missing title field.', jsonResponse);
						return null;
					}
				} catch (e) {
					new Notice('Failed to parse Gemini JSON response for title.');
					console.error('Gemini API Error: Could not parse JSON response.', responseText, e);
					return null;
				}
			} else {
				new Notice('Failed to generate title from Gemini API. No response.');
				console.error('Gemini API Error: No response object', result);
				return null;
			}

		} catch (error) {
			new Notice('Error generating title. Check console for details.');
			console.error('Gemini Title Generation Error:', error);
			return null;
		}
	}

	async updateNoteTitle(file: TFile, newTitle: string) {
		if (!newTitle || newTitle.trim() === '') {
			new Notice('Generated title is empty. No changes made.');
			return;
		}

		// Sanitize the new title to be a valid filename
		// Replace forbidden characters and trim whitespace
		const sanitizedTitle = newTitle
			.replace(/[\\/:*?"<>|]/g, '') // Remove characters forbidden in Windows filenames
			.replace(/[\n\r]/g, ' ')    // Replace newlines with spaces
			.trim();

		if (!sanitizedTitle) {
			new Notice('Sanitized title is empty. No changes made.');
			return;
		}
		
		const currentPath = file.path;
		const parentPath = file.parent ? file.parent.path : '';
		const newPath = parentPath ? `${parentPath}/${sanitizedTitle}.${file.extension}` : `${sanitizedTitle}.${file.extension}`;

		if (currentPath === newPath) {
			new Notice(`Note title is already "${sanitizedTitle}". No changes made.`);
			return;
		}

		try {
			await this.app.fileManager.renameFile(file, newPath);
			new Notice(`Note title updated to: "${sanitizedTitle}"`);
		} catch (error) {
			new Notice('Error updating note title. Check console for details.');
			console.error('Error renaming file:', error, { currentPath, newPath });
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
			.setDesc('Enter your Gemini API Key.')
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
			.setDesc('Enter the Gemini Model ID to use for title generation.')
			.addText(text => text
				.setPlaceholder('e.g., gemini-2.5-flash-preview-04-17')
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
	}
}

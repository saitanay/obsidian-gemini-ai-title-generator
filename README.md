# ✨ Gemini Title Generator for Obsidian ✨

**Author:** Tanay Sai (https://tanay.co.in)

An Obsidian plugin that leverages the Google Gemini API to automatically or manually generate titles for your notes based on their content. 📝 It helps streamline your note-taking workflow by ensuring your notes are always aptly named.

## 🔑 Key Features

*   **🤖 Automatic Title Generation:**
    *   Automatically generates and sets titles for notes starting with "Untitled" when you switch away from them.
    *   On startup, attempts to generate titles for any currently open "Untitled" notes.
*   **✍️ Manual Title Generation:**
    *   Generate a title for the currently active note using the command palette ("Gemini Title Generator : Generate Title").
*   **🖱️ Context Menu Integration:**
    *   Right-click on a markdown file in the Obsidian file explorer to generate a title for that specific note.
    *   Select multiple markdown files and right-click to generate titles for all selected notes in batch.
*   **⚙️ Configurable Settings:**
    *   **Gemini API Key:** (Required) Your personal API key for accessing the Google Gemini API.
    *   **Gemini Model ID:** Choose the specific Gemini model you wish to use (e.g., `gemini-1.5-flash-latest`).
    *   **Number of Sentences for Summary:** Define how many key sentences from your note should be extracted and sent to the Gemini API for context when generating a title. This helps in providing a concise summary for better title suggestions. 💡 **Token Saver!** This plugin uses NLP to identify the most important sentences, reducing the amount of text sent to Gemini and thus minimizing token usage. The number of sentences is configurable, giving you control over the context length.
    *   **Auto update title for untitled notes:** Toggle to enable or disable the automatic title generation feature for notes named "Untitled...".


## 🚀 Usage

1.  **Obtain a Gemini API Key:**
    *   Visit the [Google AI Studio](https://aistudio.google.com/app/apikey) (or your Google Cloud Console) to create and obtain an API key for the Gemini API.
2.  **Configure the Plugin:**
    *   Open Obsidian Settings.
    *   Navigate to "Gemini Title Generator" under the "Community Plugins" section.
    *   Enter your Gemini API Key in the designated field.
    *   Adjust other settings like Model ID and Number of Sentences as per your preference.
3.  **Generating Titles:**
    *   **Automatically:** If "Auto update title for untitled notes" is enabled, simply create a new note (it will likely be named "Untitled"). Add some content, and when you switch to another note or close it, the plugin will attempt to generate and set a title.
    *   **Manually (Command Palette):** While a note is active, open the command palette (usually `Cmd/Ctrl+P`) and search for "Gemini Title Generator : Generate Title". Select it to generate a title for the current note.
    *   **Manually (File Explorer):**
        *   Right-click on a single markdown file in the file explorer and select "Generate Title for this note".
        *   Select multiple markdown files, right-click, and select "Generate Titles for X notes" (where X is the number of notes).

## 🛠️ Troubleshooting

*   **"Gemini API Key is not set" Notice:** Ensure you have entered your API key correctly in the plugin settings.
*   **Title Generation Failures:**
    *   Check your internet connection.
    *   Ensure your Gemini API key is valid and has not exceeded its quota.
    *   The note content might be too short or ambiguous for the AI to generate a meaningful title. Try adding more content.
    *   Check the Obsidian developer console (View -> Toggle Developer Tools -> Console) for any error messages from the plugin.

## 🔒 Privacy Considerations

This plugin sends the extracted key sentences from your note content to the Google Gemini API to generate titles. Please be aware of Google's data usage policies for the Gemini API. No data is stored by the plugin itself, other than your API key locally within your Obsidian configuration.

## 📜 License

This plugin is released under the MIT License. See the [`LICENSE`](LICENSE) file for more details.

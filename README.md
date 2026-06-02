# LinkedIn AI Comment Assistant
 
A powerful Chrome extension that generates precise, ICP-targeted, voice-matched LinkedIn comments using multiple AI models (Claude, Gemini, Groq, etc.).

## Features

- **AI-Powered Comments**: Automatically generate thoughtful and engaging comments for LinkedIn posts.
- **Multiple AI Models**: Support for Anthropic Claude, Google Gemini, and Groq.
- **Customizable Voice**: Adjust the tone, length, and style to match your personal brand.
- **Seamless Integration**: Works directly within the LinkedIn feed and comment sections.

## Prerequisites

You need API keys for the AI services you wish to use:
- [Google Gemini API Key](https://aistudio.google.com/app/apikey)
- [Groq API Key](https://console.groq.com/keys)
- [Anthropic Claude API Key](https://console.anthropic.com/settings/keys)
- [Tavily API Key](https://tavily.com/)

## Installation

1. Clone or download this repository to your local machine.
2. Create a `config.env` file in the root directory by copying the example file:
   ```bash
   cp config.env.example config.env
   ```
3. Open `config.env` and add your API keys.
4. Open Google Chrome and navigate to `chrome://extensions/`.
5. Enable **Developer mode** in the top right corner.
6. Click **Load unpacked** and select the directory containing this project (the folder with `manifest.json`).

## Usage

1. Pin the extension to your Chrome toolbar for easy access.
2. Click the extension icon to open the options and configure your preferences (if any).
3. Navigate to LinkedIn. You will see an AI assist button within the comment boxes on posts.
4. Click the button to generate an AI-powered comment based on the post context.

## Permissions

The extension requires the following permissions to function:
- `storage`: To save your settings and preferences locally.
- `tabs`: To interact with your active LinkedIn tabs.
- `scripting`: To inject the comment generation buttons directly into LinkedIn pages.
- Access to LinkedIn domains and the respective AI model APIs.

## Disclaimer

This extension is for personal use and is not officially affiliated with or endorsed by LinkedIn. Use responsibly and ensure your comments remain authentic.

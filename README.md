## Gemini CodeAssist Proxy

This local server provides OpenAI (`/openai`) and Anthropic (`/anthropic`) compatible endpoints through Gemini CodeAssist (Gemini CLI).

* If you have used Gemini CLI before, it will utilize existing Gemini CLI credentials.
* If you have NOT used Gemini CLI before, you will be prompted to log in to Gemini CLI App through browser.

### Gemini 3.0 Pro + GitHub Copilot

Gemini 3.0 Pro paired with GitHub Copilot has proven to be an exceptionally capable combination for AI-assisted development. The model excels at code generation, understanding complex codebases, and providing contextually relevant suggestions.

For this reason, special care has been taken to ensure gemini-cli-proxy is fully compatible with GitHub Copilot, including:
- Proper handling of Gemini's thinking/reasoning tokens
- Server-side caching of thought signatures for multi-turn conversations
- Streaming optimizations for responsive UI feedback

### Why

Gemini 3 is cracked. So is GHCP now (I would not have said this in the past). Gemini Ultra is now worth the $ but Gemini 3 + Copilot is too good to give up for it.

Gemini CLI also offers a generous free tier. As of [2025-09-01](https://codeassist.google/), the free tier offers 60 requests/min and
1,000 requests/day.

## Quick Start

```npx gemini-cli-proxy```

The server will start on `http://localhost:3000`
* OpenAI compatible endpoint: `http://localhost:3000/openai`
* Anthropic compatible endpoint: `http://localhost:3000/anthropic`

### Usage

```bash
npx gemini-cli-proxy [options]
```

Options:
- `-p, --port <port>` - Server port (default: 3000)
- `-g, --google-cloud-project <project>` - Google Cloud project ID if you have paid/enterprise tier (default: GOOGLE_CLOUD_PROJECT env variable)
- `-l, --log-level <level>` - Log level: error, warn, info, debug (default: info)
- `--disable-browser-auth` - Disables browser auth flow and uses code based auth (default: false)
- `--disable-google-search` - Disables native Google Search tool (default: false)
- `--disable-auto-model-switch` - Disables auto model switching in case of rate limiting (default: false)

If you have NOT used Gemini CLI before, you will be prompted to log in to Gemini CLI App through browser. Credentials will be saved in the folder (`~/.gemini/oauth_creds.json`) used by Gemini CLI.

`gemini-3-pro-preview` is the default model when you request a model other than `gemini-3-pro-preview` or `gemini-2.5-flash`

## Use with GitHub Copilot

**Requirements:** VS Code Insiders is required to use custom OpenAI-compatible endpoints with GitHub Copilot.

### Setup Instructions

1. **Install VS Code Insiders**

   Download from [code.visualstudio.com/insiders](https://code.visualstudio.com/insiders/)

2. **Start the proxy server**
   ```bash
   npx gemini-cli-proxy -p 8084
   ```

3. **Configure GitHub Copilot in VS Code Insiders**

   Open VS Code Insiders settings (JSON) and add:
   ```json
   {
     "github.copilot.chat.models": [
       {
         "vendor": "copilot",
         "family": "gemini-3-pro",
         "id": "gemini-3-pro-preview",
         "name": "Gemini 3.0 Pro (via gemini-cli-proxy)",
         "version": "gemini-3-pro-preview",
         "capabilities": {
           "agents": true,
           "tokenCounting": false
         },
         "endpoint": {
           "url": "http://localhost:8084/openai/v1/chat/completions"
         }
       }
     ]
   }
   ```

**or just use the Copilot Chat settings UI**

4. **Select the model in Copilot Chat**

   Open GitHub Copilot Chat and select "Gemini 3.0 Pro (Preview) (via gemini-cli-proxy)" from the model dropdown under "Other Models."

### Tips for GitHub Copilot Usage

- The proxy handles Gemini's thinking tokens automatically, displaying them in Copilot's reasoning UI
- For verbose debugging, use `--log-level debug` when starting the proxy
- If you experience rate limiting, the proxy will automatically switch to fallback models (unless `--disable-auto-model-switch` is set)

## Use with Other Tools

### Environment Variables

Most agentic tools rely on environment variables, you can export the following variables

```
export OPENAI_API_BASE=http://localhost:3000/openai
export OPENAI_API_KEY=ItDoesNotMatter
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"
export ANTHROPIC_AUTH_TOKEN=ItDoesNotMatter
```

### Claude Code

Add the following env fields to `.claude/settings.json` file

```json
{
  "permissions": {
    ...
  },
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "NotImportant",
    "ANTHROPIC_MODEL": "gemini-3-pro-preview"
  }
}
```

### Zed

Add the following to the Zed config file
```json
{
  "language_models": {
    "openai": {
      "api_url": "http://localhost:3000/openai",
      "available_models": [
        {
          "name": "gemini-2.5",
          "display_name": "localhost:gemini-2.5",
          "max_tokens": 131072
        }
      ]
    }
  }
}
```

## Development

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run lint` - Run ESLint
- `npm test` - Run tests

### Project Structure

```
src/
├── auth/           # Google authentication logic
├── gemini/         # Gemini API client and mapping
├── routes/         # Express route handlers
├── types/          # TypeScript type definitions
└── utils/          # Utility functions
```

## License

Apache-2.0

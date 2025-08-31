# Nebula

A CLI tool to list your starred GitHub repositories using GitHub's API with support for both Personal Access Tokens and OAuth Device Flow.

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Authentication (Choose One Method)

#### 🚀 **Method 1: GitHub CLI (Easiest - If you have it)**

If you have GitHub CLI installed and authenticated:

```bash
gh auth login  # Follow the prompts to authenticate
bun run index.ts  # Nebula will automatically use your GitHub CLI authentication
```

#### 🔑 **Method 2: Personal Access Token (Recommended)**

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Give it a name like "Nebula CLI"
4. Select scopes: check `public_repo` and `read:user`
5. Click "Generate token"
6. Copy the token

Set the environment variable:

```bash
export GITHUB_TOKEN=your_token_here
```

#### 🔐 **Method 3: OAuth Device Flow (Alternative)**

1. Create OAuth app at https://github.com/settings/applications/new
2. Fill in:
   - **Application name**: Nebula
   - **Homepage URL**: http://localhost
   - **Authorization callback URL**: http://localhost
3. Copy the **Client ID**

Set the environment variable:

```bash
export GITHUB_CLIENT_ID=your_client_id
```

### 3. Environment Variables

You can set environment variables in your shell or create a `.env` file:

```bash
# For Personal Access Token (recommended)
export GITHUB_TOKEN=your_token_here

# For OAuth (alternative)
export GITHUB_CLIENT_ID=your_client_id_here
```

Or create a `.env` file:

```bash
echo "GITHUB_TOKEN=your_token_here" > .env
```

## Usage

```bash
# List your starred repositories with beautiful UI (shows READMEs for first 10 by default)
bun run index.tsx

# Process more repositories (shows READMEs for first 50)
NEBULA_MAX_REPOS=50 bun run index.tsx

# Process all repositories (be careful with rate limits!)
NEBULA_MAX_REPOS=999 bun run index.tsx

# Force login (even if you already have a token)
bun run index.tsx login

# Logout and remove saved token
bun run index.tsx logout
```

## Features

- **📖 README Preview**: Shows the first few lines of each repository's README
- **📊 Detailed Info**: Displays stars, creation date, size, topics, license, etc.
- **⚡ Smart Authentication**: Auto-detects GitHub CLI or uses personal access tokens
- **🐌 Rate Limiting**: Built-in delays to respect GitHub's API limits
- **📈 Progress Tracking**: Shows processing progress for multiple repositories
- **🛡️ Error Handling**: Graceful handling of missing READMEs, private repos, etc.

## How it Works

1. **First run**: If no token is saved, Nebula will start the GitHub OAuth Device Flow
2. **Follow the link**: Open the provided URL in your browser
3. **Enter the code**: Enter the provided device code on GitHub
4. **Authorize**: Grant permission for Nebula to access your starred repositories
5. **Token saved**: Your access token is saved securely to `~/.nebula.json`
6. **Future runs**: Nebula uses the saved token to list your starred repos

## Requirements

- Node.js or Bun runtime
- A GitHub account
- A GitHub OAuth App (for authentication)

---

Built with [Bun](https://bun.com) and [Effect](https://effect.website/).

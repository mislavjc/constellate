# 🌌 Constellator

```text
         .    *   .  .  *    .    *   .
     .     *      .    *      .     *    .
  *    .     *   .     *    .     *   .   *
   .     *       .     *    .     *      .  .
 *   .     *   .     *    .     *   .     * .
  .     *    .     *      .     *    .     *
    *    .     *   .     *    .     *   .
   .     *      .     *    .     *      .
     *    .     *   .     *    .     *
       .    *      .    *      .    *
```

**Turn your GitHub stars into a clean, categorized Awesome list.**

Constellator analyzes your starred repositories and generates an Awesome‑style markdown with clear categories, concise summaries, and sensible ordering.

## ✨ Features

- 🤖 **AI-Powered Categorization**: Uses Vercel AI Gateway with GPT-OSS models to intelligently categorize repositories
- 📊 **Multi-Pass Processing**: Advanced 4-pass AI pipeline for accurate classification
- 🎨 **Beautiful Output**: Generates clean, organized markdown files
- 🎯 **Customizable**: Flexible output filename and configuration options
- 🔄 **Incremental Updates**: Efficient processing with data persistence
- 📈 **Quality Metrics**: Includes star counts, activity indicators, and confidence scores
- 🎪 **Interactive CLI**: Beautiful terminal interface with real-time progress

## 🚀 Quick Start

### One‑liner

```bash
npx constellator
```

This authenticates with GitHub, fetches your stars, runs a multi‑pass AI pipeline, and writes `AWESOME.md`.

### Configure (recommended)

```bash
# Create/edit .constellator/config.json interactively
npx constellator config
```

Required:

- Vercel AI Gateway key (stored in `.env` as `AI_GATEWAY_API_KEY`)
- GitHub token (stored in `.env` as `GITHUB_TOKEN`, written automatically after `constellator login`)

### Usage

#### First-time setup

```bash
# Configure your settings interactively
npx constellator config
```

#### Run (creates AWESOME.md)

```bash
npx constellator
```

#### Custom output filename

```bash
npx constellator --name MY_STARS.md
```

#### Authentication (if needed)

```bash
npx constellator login
```

Check authentication status:

```bash
npx constellator whoami
```

#### Logout and clear stored token

```bash
npx constellator logout
```

## 🎯 How It Works

Constellator uses a sophisticated 4-pass AI processing pipeline:

### Pass 0 — Facts Extraction

- Analyzes repository README files
- Extracts key facts, capabilities, and tech stack
- Identifies repository purpose and features

### Pass 1 — Expansion & Summaries

- Generates concise repository summaries
- Creates key topic tags
- Proposes initial category candidates

### Pass 2 — Streamline & Primary Assignment

- Merges overlapping categories
- Assigns exactly one primary category per repository
- Ensures consistent categorization

### Pass 3 — Quality Assurance

- Validates category assignments
- Handles edge cases and misclassifications
- Optimizes category structure

## 📁 Output Structure

Constellator generates several files in your project directory:

```text
your-project/
├── AWESOME.md                    # Main categorized list (or custom name)
├── .constellator/
│   ├── config.json               # Your configuration settings
│   ├── constellator.json          # Processed repository data with categories
│   ├── repos.json                # Raw repository metadata (renamed from stars.json)
│   └── category-glossary.json    # AI-learned category definitions
└── .env                          # Environment variables (AI Gateway key only)
```

### Key Files Created

- **AWESOME.md**: The main output file with your organized repository list
- **.constellator/constellator.json**: Complete processed data with all repository metadata, categories, and AI analysis
- **.constellator/repos.json**: Raw repository data fetched from GitHub
- **.constellator/category-glossary.json**: AI-learned category definitions for consistency across runs

## ⚙️ Configuration

### Configuration Files

Constellator uses two configuration files:

#### 1. Environment Variables (.env)

Place your runtime secrets here. Bun auto-loads `.env`.

```bash
# .env file
# Vercel AI Gateway (required)
AI_GATEWAY_API_KEY=vck_your_vercel_ai_gateway_key_here

# GitHub token (recommended; set via `constellator login`)
GITHUB_TOKEN=ghp_your_token_here
```

#### 2. Application Settings (.constellator/config.json)

Non-secret app settings go here

```json
{
  "CONSTELLATE_MAX_REPOS": "100",
  "CONSTELLATE_MODEL": "openai/gpt-4o-mini",
  "CONSTELLATE_FALLBACK_MODELS": ["openai/gpt-3.5-turbo", "openai/gpt-4"]
}
```

### Configuration Options

| Variable                      | File                        | Default                | Description                      |
| ----------------------------- | --------------------------- | ---------------------- | -------------------------------- |
| `AI_GATEWAY_API_KEY`          | `.env`                      | Required               | Vercel AI Gateway API key        |
| `GITHUB_TOKEN`                | `.env`                      | Recommended            | GitHub token (saved after login) |
| `CONSTELLATE_MAX_REPOS`       | `.constellator/config.json` | `100`                  | Maximum repositories to process  |
| `CONSTELLATE_MODEL`           | `.constellator/config.json` | `openai/gpt-4o-mini`   | Primary AI model to use          |
| `CONSTELLATE_FALLBACK_MODELS` | `.constellator/config.json` | `openai/gpt-3.5-turbo` | Fallback AI models               |

## 🔐 Getting a GitHub token

You have three easy options. Pick one:

- **Option A: Device flow (interactive, recommended)**

  - Run: `npx constellator login`
  - Follow the on-screen instructions (opens GitHub in your browser)
  - Constellator saves a short‑lived token in `~/.constellator.json`

- **Option B: GitHub CLI (if you already use `gh`)**

  - Run: `gh auth login` and complete the prompts
  - Constellator detects and uses your CLI token automatically

- **Option C: Personal Access Token (manual)**
  1. Go to GitHub → Settings → Developer settings → Personal access tokens
  2. Choose either:
     - Fine‑grained token: limit to your account, set Repository access to the repos you want Constellator to read
     - Classic token: simplest; scopes below
  3. Scopes to select:
     - Required: `read:user`, `public_repo`
     - Optional (for private repos): `repo`
  4. Copy the token and store it in `.env` like:

```bash
GITHUB_TOKEN=ghp_your_token_here
```

Tips:

- You can create/edit the config interactively with: `npx constellator config`
- To verify auth quickly: `npx constellator login` or run with `--rate-limit` to see API credits
- After successful login, Constellator writes `GITHUB_TOKEN=...` to `.env` in your current directory

### CLI Options

| Option                   | Description                                        | Example                               |
| ------------------------ | -------------------------------------------------- | ------------------------------------- |
| `--name <filename>`      | Custom output filename                             | `--name MY_AWESOME.md`                |
| `--version`              | Print version and exit                             | `--version`                           |
| `--max-repos <n>`        | Override max repositories for this run             | `--max-repos 500`                     |
| `--set KEY=VALUE`        | Override any config key (repeatable)               | `--set CONSTELLATE_MAX_CATEGORIES=60` |
| `--artifacts-dir <path>` | Directory for artifacts (default: `.constellator`) | `--artifacts-dir .cache/constellator` |
| `--min-size <n>`         | Minimum category size in README                    | `--min-size 2`                        |
| `--open`                 | Open generated README on completion (macOS)        | `--open`                              |
| `--batch-size <n>`       | Pass‑1 batch size (default: 4)                     | `--batch-size 6`                      |
| `--timeout <ms>`         | Network timeout per request (default: 30000)       | `--timeout 45000`                     |
| `--rate-limit`           | Print GitHub rate limit before/after the run       | `--rate-limit`                        |
| `-h`, `--help`           | Show help                                          | `--help`                              |
| `login`                  | Interactive authentication setup                   | `npx constellator login`              |
| `logout`                 | Clear stored credentials                           | `npx constellator logout`             |

#### Examples

```bash
# Change output file
npx constellator --name MY_STARS.md

# Run with more repos and stricter README filter
npx constellator --max-repos 500 --min-size 2

# Override a config key without editing files
npx constellator --set CONSTELLATE_MAX_CATEGORIES=60

# Use a custom artifacts directory
npx constellator --artifacts-dir .cache/constellator

# Increase batch size and timeout, and open the file when done
npx constellator --batch-size 6 --timeout 45000 --open

# Print GitHub rate limit before/after
npx constellator --rate-limit
```

## 🎨 Example Output

```markdown
# Awesome – Generated by Constellator

> Categories distilled from your stars via multi‑pass AI. Updated 2025-01-15.

## Table of Contents

- [AI Agents](#ai-agents)
- [Web Development](#web-development)
- [DevOps Tools](#devops-tools)

## AI Agents

### transfinite-ai/agentic (⭐ 15,432)

Advanced AI agent framework for autonomous task execution.

**Tags:** ai, agents, automation, python
**Capabilities:** Task planning, tool integration, multi-step reasoning
```

## 🔧 Development

### Project Structure

```text
constellator/
├── index.tsx              # Main CLI application
├── cli.cjs               # Executable wrapper script
├── .env                  # Environment variables (AI Gateway key only)
├── lib/
│   ├── ai.ts             # AI processing pipeline
│   ├── auth.ts           # GitHub authentication
│   ├── github.ts         # GitHub API client
│   ├── models.ts         # AI model selection
│   ├── schemas.ts        # Data validation schemas
│   └── utils.ts          # Utility functions
├── .constellator/         # Application configuration & data files
│   ├── config.json       # User configuration settings
│   ├── constellator.json  # Processed repository data
│   ├── repos.json        # Raw repository metadata
│   └── category-glossary.json # AI-learned category definitions
├── dist/                 # Compiled JavaScript output
└── package.json          # Package configuration
```

### Running locally (development)

```bash
git clone https://github.com/mislavjc/constellator
cd constellator
pnpm install # or npm/yarn
npx ts-node index.tsx
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Uses [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) for AI processing
- Terminal UI powered by [Ink](https://github.com/vadimdemedes/ink)

## 🐛 Troubleshooting

### Common Issues

#### No starred repositories found

- Verify your GitHub token in `.env` has the correct permissions
- Check that you have starred repositories

#### AI Gateway authentication failed

- Verify your `AI_GATEWAY_API_KEY` in `.env` is correct
- Make sure you're using a valid Vercel AI Gateway key

#### AI Gateway API rate limit exceeded

- Reduce `CONSTELLATE_MAX_REPOS` in `.constellator/config.json` or wait for rate limit reset
- Consider upgrading your Vercel AI Gateway plan

#### Configuration not found

- Run `npx constellator config` to set up your configuration
- Ensure `.constellator/config.json` exists with proper settings
- Make sure `.env` contains `AI_GATEWAY_API_KEY` (and `GITHUB_TOKEN` if not using `gh`)

### Getting Help

- Check the [Issues](https://github.com/mislavjc/constellator/issues) page
- Review the configuration files above
- Ensure both `.env` and `.constellator/config.json` are properly configured

---

Made with ❤️ and powered by AI

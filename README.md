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

- GitHub Personal Access Token with `repo` scope (stored in `.constellator/config.json`)
- Vercel AI Gateway key (stored in `.env` as `AI_GATEWAY_API_KEY`)

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

### Key Files Created:

- **AWESOME.md**: The main output file with your organized repository list
- **.constellator/constellator.json**: Complete processed data with all repository metadata, categories, and AI analysis
- **.constellator/repos.json**: Raw repository data fetched from GitHub
- **.constellator/category-glossary.json**: AI-learned category definitions for consistency across runs

## ⚙️ Configuration

### Configuration Files

Constellator uses two configuration files:

#### 1. Environment Variables (.env)

Only the Vercel AI Gateway API key goes here

```bash
# .env file - only for Vercel AI Gateway
AI_GATEWAY_API_KEY=vck_your_vercel_ai_gateway_key_here
```

#### 2. Application Settings (.constellator/config.json)

All other configuration goes here

```json
{
  "GITHUB_TOKEN": "your_github_personal_access_token_here",
  "CONSTELLATE_MAX_REPOS": "100",
  "CONSTELLATE_MODEL": "openai/gpt-4o-mini",
  "CONSTELLATE_FALLBACK_MODELS": ["openai/gpt-3.5-turbo", "openai/gpt-4"]
}
```

### Configuration Options

| Variable                      | File                        | Default                | Description                     |
| ----------------------------- | --------------------------- | ---------------------- | ------------------------------- |
| `AI_GATEWAY_API_KEY`          | `.env`                      | Required               | Vercel AI Gateway API key       |
| `GITHUB_TOKEN`                | `.constellator/config.json` | Required               | GitHub Personal Access Token    |
| `CONSTELLATE_MAX_REPOS`       | `.constellator/config.json` | `100`                  | Maximum repositories to process |
| `CONSTELLATE_MODEL`           | `.constellator/config.json` | `openai/gpt-4o-mini`   | Primary AI model to use         |
| `CONSTELLATE_FALLBACK_MODELS` | `.constellator/config.json` | `openai/gpt-3.5-turbo` | Fallback AI models              |

### CLI Options

| Option              | Description                      | Example                   |
| ------------------- | -------------------------------- | ------------------------- |
| `--name <filename>` | Custom output filename           | `--name MY_AWESOME.md`    |
| `login`             | Interactive authentication setup | `npx constellator login`  |
| `logout`            | Clear stored credentials         | `npx constellator logout` |

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

**"No starred repositories found"**

- Verify your GitHub token in `.constellator/config.json` has the correct permissions
- Check that you have starred repositories

**"AI Gateway authentication failed"**

- Verify your `AI_GATEWAY_API_KEY` in `.env` is correct
- Make sure you're using a valid Vercel AI Gateway key

**"AI Gateway API rate limit exceeded"**

- Reduce `CONSTELLATE_MAX_REPOS` in `.constellator/config.json` or wait for rate limit reset
- Consider upgrading your Vercel AI Gateway plan

**"Configuration not found"**

- Run `npx constellator config` to set up your configuration
- Ensure `.constellator/config.json` exists with proper settings
- Make sure `.env` contains your `AI_GATEWAY_API_KEY`

### Getting Help

- Check the [Issues](https://github.com/mislavjc/constellator/issues) page
- Review the configuration files above
- Ensure both `.env` and `.constellator/config.json` are properly configured

---

Made with ❤️ and powered by AI

# Nanobanana MCP

A local stdio MCP server for Gemini image generation and generative image editing. It runs on the participant's computer and calls Google's Gemini API directly. It is intentionally `private` in `package.json`, so it cannot be accidentally published to npm.

## Install for a workshop cohort

This repository includes a project-scoped [`.mcp.json`](.mcp.json) for Claude Code. It deliberately maps a dedicated cohort variable to the server's preferred key variable, so a missing cohort key fails instead of inheriting an unrelated personal key.

Install Node.js 22 or newer and Git. Clone the repository, enter it, then install and build it:

```bash
git clone https://github.com/waimakers/nanobanana-mcp.git
cd nanobanana-mcp
npm ci
npm run build
```

Set the cohort key outside the repository. On macOS and Linux with zsh:

```zsh
export NANOBANANA_COHORT_API_KEY="your-dedicated-cohort-key"
claude
```

On Windows PowerShell:

```powershell
$env:NANOBANANA_COHORT_API_KEY = "your-dedicated-cohort-key"
claude
```

Claude Code loads this repository's project-scoped `.mcp.json`; approve that project configuration when prompted. It maps the dedicated cohort variable to `GEMINI_IMAGE_API_KEY`, and configures Flash/1K only for the cohort. The server supports `GEMINI_IMAGE_API_KEY` first and `GEMINI_API_KEY` as a general fallback. It does not read `.env` files and never contains a real key.

To use the server from a different workspace, add an MCP entry with an absolute `dist/index.js` path and the same environment mappings from [`.mcp.json`](.mcp.json). Do not copy a key into the tracked configuration or `environment.template`.

The cohort key is a shared Google API credential. It does not authenticate participants individually, enforce Microsoft sign-in, or allocate individual quotas. Everyone using it can consume the same Google billing project. `list_uploaded_files` and `delete_uploaded_file` operate on files visible to that key, so use them with care and avoid uploading sensitive material.

## Models and defaults

The established default remains `gemini-3-pro-image-preview` at `2K`, preserving existing callers. The historical `nano-banana-pro-preview` option continues to mean that same Pro preview endpoint. No model name silently falls back to another model.

For a cost-conscious workshop default, set both variables before starting the MCP client:

```bash
export NANOBANANA_DEFAULT_MODEL="gemini-3.1-flash-image"
export NANOBANANA_DEFAULT_IMAGE_SIZE="1K"
```

| Model | Status | Sizes |
| --- | --- | --- |
| `gemini-3.1-flash-image` | Stable; fast general-purpose Nano Banana 2 | `0.5K`, `1K`, `2K`, `4K` |
| `gemini-3-pro-image` | Stable; Nano Banana Pro quality | `1K`, `2K`, `4K` |
| `gemini-3.1-flash-lite-image` | Stable; efficient Nano Banana 2 Lite | `1K` |
| `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`, `gemini-2.5-flash-image` | Retained compatibility options | Validated per model |

Sizes and aspect ratios are checked locally before any provider call. Gemini 2.5 Flash Image has fixed approximately-1K output, so the server omits `imageSize` from its provider request. The `get_model_capabilities` tool reports each accepted combination.

Google's current [image generation guide](https://ai.google.dev/gemini-api/docs/image-generation) and [pricing page](https://ai.google.dev/gemini-api/docs/pricing) are the source of truth. Cost estimates returned by this server use provider usage metadata and a dated pricing snapshot; they are estimates, not invoices.

## Tools

- `generate_image`: prompt plus up to five reference images.
- `edit_image`: prompt, input image, and optional mask image.
- `upload_image`, `list_uploaded_files`, `delete_uploaded_file`: Google Files API utilities.
- `get_model_capabilities`: exact accepted model options and active defaults.

Reference images and `maskImage` are generative guidance. Gemini does not expose a pixel-exact inpainting mask, deterministic style strength, or output-encoding switch through this API. For compatibility, `mimeType`, `referenceMode`, and `referenceStrength` are accepted but not forwarded. `seed` is forwarded; `negativeSeed` is never forwarded.

## Boundaries and troubleshooting

The cohort configuration sets `NANOBANANA_WORKSPACE_ROOT` to `.`. Start the client in your exercise workspace; local input and output paths must stay inside it, including symlink targets. Copy reference images into that directory and use paths such as `input.png` or `generated/poster.png`. For a different workspace, configure its absolute root. Installations that omit this variable retain access to the host filesystem. This is an application guard, not an operating-system sandbox.

Existing output files are rejected before generation by default. Choose a new filename, or deliberately set `NANOBANANA_ALLOW_OVERWRITE=1` if overwriting is required. These local settings do not enforce billing or participant access controls: holders of a shared key can use it outside this server.

The server enforces a 60-second request timeout, five references, and 10 MiB per reference. Provider JSON responses have a separate 64 MiB limit for base64-encoded generated images. Existing file references must use a `files/...` name or its full Google Files API URI. HTTPS URL downloads only allow public addresses on port 443, validate the addresses used by the socket, and disable redirects and proxy environment variables. References must have a supported PNG, JPEG, GIF or WebP signature. Provider response bodies, request headers, prompts, local paths, and API keys are not logged or included in provider errors. It never automatically retries a paid image generation call. File uploads use Google’s two-step resumable protocol.

If a request reports no image, Gemini may have blocked or declined it. Try a different prompt; the server does not invent a fallback image. If a configured model/size pair is rejected, use `get_model_capabilities` or choose a supported pair.

Run the local checks without calling Gemini:

```bash
npm test
npm audit --omit=dev
```
